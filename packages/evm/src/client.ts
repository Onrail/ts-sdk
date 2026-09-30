import type { Address, AccessList, Hex } from "viem";
import type { RoUint8Array, RoArray, RoTuple, Function, OptionalArg } from "@onrail-xyz/utils";
import { hex, argOf } from "@onrail-xyz/utils";
import type { Layout, Struct } from "@onrail-xyz/binary-layout";
import { serialize, isItem, isOmitted, calcStaticSize } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { type AmountOrAtomic, toAtomicIfAmount } from "@onrail-xyz/common";
import type { AbiParam, AbiParamValue, DynamicAbiParam, PaddedSlotLayout } from "./layouting.js";
import { wordSize, selectorLayout,
         paddedSlotLayout, abiEncodedBytesItem, signatureOf } from "./layouting.js";
import type { QueryLayoutTriple } from "./query.js";

//the marker `trailingBytesParam` sets, read only here - nothing outside the spec builder asks
//  whether a param is the dynamic one
const isDynamicParam = (param: AbiParam): param is DynamicAbiParam<string, Layout | undefined> =>
  "dynamic" in param;

//the default spans the whole domain, so the bare `ContractTx` takes an amount of any kind
export type ContractTx<K extends KindWithAtomic | undefined = KindWithAtomic | undefined> = {
  to:          Address;
  from?:       Address;
  value?:      AmountOrAtomic<K>;
  data:        RoUint8Array;
  accessList?: AccessList;
};

export type ViemTx = {
  readonly to:          Address;
  readonly data:        Hex;
  readonly account?:    Address;
  readonly value?:      bigint;
  readonly accessList?: AccessList;
};

//viem spells call data as hex and values as bigint where this package speaks bytes and amounts,
//  and calls the sender `account` because it also accepts a whole Account: every field is
//  converted so that consumers hand the result straight to sendTransaction/estimateGas
export const toViemTx = (tx: ContractTx): ViemTx => ({
  to:   tx.to,
  data: hex.encode(tx.data, true),
  ...(tx.from       !== undefined && { account:    tx.from                    }),
  ...(tx.value      !== undefined && { value:      toAtomicIfAmount(tx.value) }),
  ...(tx.accessList !== undefined && { accessList: tx.accessList              }),
});

// ---- Contract spec builder ----
// A spec is a tuple of `abiFunction` rows, [name, params, composer, outputLayout | undefined]. The
//   signature and the input layout - each param left-padded onto its ABI slot - derive from the
//   params; the composer turns positional args into the params object, which methods also accept
//   directly, and exists for the parameter names, which nothing else can carry.
// Solidity overloads share an ABI name, so a row whose method key must differ from it names
//   both, key first: `["safeTransferFromWithData", "safeTransferFrom"]`.
// Read calls (outputLayout defined) return a layout triple for the query system.
// Write calls (outputLayout undefined) return pre-serialized call data; who sends it is the
//   transaction's business, not the spec's.
// Every param is static but for a trailing `trailingBytesParam`, whose offset the parameter
//   count fixes; two dynamic params would need offsets computed from the tails ahead of them,
//   which is an encoding pass rather than a layout.

export type ParamsStruct<P extends RoTuple<AbiParam>> =
  { readonly [E in P[number] as E["name"]]: E["item"] };

//each param's field of the call's layout: static ones left-padded onto their slot, a trailing
//  dynamic one already ABI-shaped (offset, length, payload, padding)
export type ParamsLayout<P extends RoTuple<AbiParam>> = {
  readonly [E in P[number] as E["name"]]:
    E extends { readonly dynamic: object } ? E["item"] : PaddedSlotLayout<E["item"]>;
};

//the params' values, positionally and by name
type ParamValues<P extends RoTuple<AbiParam>> =
  { [K in keyof P]: P[K] extends AbiParam ? AbiParamValue<P[K]> : never };
export type ParamsRecord<P extends RoTuple<AbiParam>> =
  { readonly [E in P[number] as E["name"]]: AbiParamValue<E> };

export type FuncName = string | readonly [key: string, abiName: string];
export type FuncKey<N extends FuncName> =
  N extends readonly [infer K extends string, string] ? K : N;

export type FuncSpec<
  N extends FuncName            = FuncName,
  P extends RoTuple<AbiParam>   = RoTuple<AbiParam>,
  C extends Function<any>       = Function<any>,
  R extends Layout | undefined  = Layout | undefined,
> = readonly [N, P, C, R];
type ContractSpec = RoTuple<FuncSpec>;

//the composer is contextually typed from the params, so it is written with names only
export const abiFunction = <
  const N extends FuncName,
  const P extends RoTuple<AbiParam>,
        C extends (...args: ParamValues<P>) => ParamsRecord<P>,
  const R extends Layout | undefined = undefined,
>(name: N, params: P, composer: C, ...output: OptionalArg<R>): FuncSpec<N, P, C, R> =>
  [name, params, composer, argOf(output)];

type ReadResult<P extends RoTuple<AbiParam>, OL extends Layout> = {
  readonly to:   Address;
  readonly data: QueryLayoutTriple<ParamsLayout<P>, OL>;
};

type WriteResult = Readonly<{
  to:   Address;
  data: Uint8Array;
}>;

//object form first, positional form last: `infer` (and `Parameters`/`ReturnType`) bind to an
//  overloaded function's last signature, and the positional signature is the one reflection
//  needs — the object form's parameter is just the params' derived type, recoverable from them
//  without going through the function type
type ContractMethodOf<P extends RoTuple<AbiParam>, OL, C extends Function<any>> =
  OL extends Layout
  ? ((params: ParamsRecord<P>) => ReadResult<P, OL>) &
    ((...args: Parameters<C>) => ReadResult<P, OL>)
  : ((params: ParamsRecord<P>) => WriteResult) &
    ((...args: Parameters<C>) => WriteResult);

export type ContractMethods<S extends RoTuple<any>> = {
  readonly [E in S[number] as E extends FuncSpec<infer N> ? FuncKey<N> : never]:
    E extends FuncSpec<FuncName, infer P, infer C, infer OL>
    ? ContractMethodOf<P, OL, C>
    : never;
};

function resolveArgs(
  layout:   Struct,
  composer: Function<any>,
  args:     RoArray,
): unknown {
  //For 0 or 2+ args, it's unambiguously the composer (positional) form.
  //For a single object arg, it's ambiguous only when the layout has exactly one non-omitted
  //  field — the arg could be the object form { name: value } or a struct passed positionally.
  //  We assume object form if the object has exactly one key matching that field's name.
  //  For 2+ non-omitted fields, a single arg must be object form (positional would have multiple).
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    let nonOmittedCount = 0;
    let firstName: string | undefined;
    for (const [name, field] of Object.entries(layout)) {
      if (isItem(field) && isOmitted(field))
        continue;
      if (++nonOmittedCount > 1)
        return args[0];
      firstName = name;
    }
    //single non-omitted field: assume object form if the object has exactly one matching key
    const keys = Object.keys(args[0]);
    if (keys.length === 1 && keys[0] === firstName)
      return args[0];
  }
  return composer(...args);
}

export const contractFromSpec = <const S extends ContractSpec>(
  contract: Address,
  spec:     S,
): ContractMethods<S> => {
  const result: Record<string, Function<any>> = {};
  for (const [name, params, composer, outputLayout] of spec) {
    const [key, abiName] = typeof name === "string" ? [name, name] : name;
    const sig = signatureOf(abiName, params);
    const dynamicIndex = params.findIndex(isDynamicParam);
    //a second dynamic param cannot be last either, so the one check covers both
    if (dynamicIndex >= 0 && dynamicIndex !== params.length - 1)
      throw new Error(`${sig}: a dynamic parameter must be the only one, and come last`);

    //the dynamic payload follows the whole head, which is not one word per preceding param:
    //  a static tuple param spans as many slots as it has members
    const staticFields = params.filter(param => !isDynamicParam(param))
      .map(param => paddedSlotLayout(param.item));
    const headSize = staticFields.reduce((sum, field) => sum + calcStaticSize(field)!, wordSize);

    let staticIndex = 0;
    const inputLayout = Object.fromEntries(params.map(param => [
      param.name,
      isDynamicParam(param)
      ? abiEncodedBytesItem({ layout: param.dynamic.layout, offset: headSize })
      : staticFields[staticIndex++]!,
    ]));
    const layout = selectorLayout(sig)(inputLayout);

    const method = (...args: any[]) => ({
      to:   contract,
      data: outputLayout !== undefined
        ? [layout, resolveArgs(inputLayout, composer, args), outputLayout]
        : serialize(layout, resolveArgs(inputLayout, composer, args) as any),
    });
    //shape-dispatching methods would report length 0; stamp the positional arity so it stays
    //  observable, e.g. for arity-driven call batching
    Object.defineProperty(method, "length", { value: composer.length });
    if (Object.hasOwn(result, key))
      throw new Error(`duplicate method key: ${key}`);

    result[key] = method;
  }
  return result as any;
};
