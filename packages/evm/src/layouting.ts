import { type Address, checksumAddress } from "viem";
import type { Identity, RoUint8Array, RoTuple,
              RoNeTuple, RoPair, HeadTail, Opts, OptionalArg } from "@onrail-xyz/utils";
import { utf8, hex, bignum, assertDistinct, argOf } from "@onrail-xyz/utils";
import type { Conversion, Layout, Struct, DeriveType, Item,
              NumSizeToPrimitive, WithCustom, UnwrapSingleton } from "@onrail-xyz/binary-layout";
import { serialize, deserialize,
         calcStaticSize, paddingItem, unwrapSingleton,
         isItem, uintItem, switchItem, numSizeToPrimitive,
         timestampItem, withCustom, hasFixed, customOf, boolItem } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { type AmountOr, amountItem, hashItem } from "@onrail-xyz/common";
import { keccak256 } from "./hashing.js";

// ---- Padding ----

export const wordSize = 32;
export const addressSize = 20;

//sub-word layouts are left-padded onto one slot - the ABI's alignment for every static type but
//  bytesN, which `bytesNItem` spells at word width, right-padded; whole-word ones (a signature's
//  three words) are already slot-aligned and pass with empty padding
const slotPadding = (layout: Layout) => {
  const size = calcStaticSize(layout);
  if (size === null || (size > wordSize && size % wordSize !== 0))
    throw new Error("layout must have a static size of at most one word or of whole words");

  return paddingItem(size > wordSize ? 0 : wordSize - size);
};

//the ABI sign-extends a negative value across its slot, which a fixed padding cannot do, so a
//  signed value takes the word's own width on the wire and narrows back to the primitive its
//  declared width surfaces. The conversion rejects a value the declared width cannot hold,
//  coming or going: the wider wire item would pass it silently either way
type SignedSlot = Readonly<{ binary: "int"; size: typeof wordSize }>;
export type SignedSlotItem<I extends Item> = WithCustom<SignedSlot, DeriveType<I>>;

const signedSlotLayout = { binary: "int", size: wordSize } as const satisfies SignedSlot;

const signedSlotItem = <const I extends Item>(item: I): SignedSlotItem<I> => {
  const size = calcStaticSize(item)!;
  const bound = 1n << BigInt(size * 8 - 1);
  const checkBound = (wide: bigint) => {
    if (wide < -bound || wide >= bound)
      throw new Error(`${wide} does not fit a signed ${size * 8}-bit slot`);

    return wide;
  };
  const narrow = (word: bigint) => numSizeToPrimitive(checkBound(word), size) as DeriveType<I>;
  const widen = (value: unknown) => checkBound(BigInt(value as number | bigint));

  //the item's own conversion speaks its declared width, so the widening wraps it on both sides
  //  rather than composing through `withCustom`, which only appends
  const own = customOf(item);
  return withCustom(signedSlotLayout, own === undefined
    ? { to: narrow, from: widen }
    : { to:   (word: bigint) => own.to(narrow(word)) as DeriveType<I>,
        from: (value: DeriveType<I>) => widen(own.from(value)) },
  ) as SignedSlotItem<I>;
};

//annotated: inferring this return would make declaration emit inline unwrapSingleton's fully
//  evaluated type machinery (recursion unrolled, alias identity - and with it instantiation
//  caching - lost), which downstream checkers then re-evaluate per instantiation. The
//  annotation is a conditional over the item's signedness, which neither branch's value can
//  satisfy while I is open, hence the cast in paddedItem
type SlotPadding = ReturnType<typeof paddingItem>;
type PaddedStruct<I extends Item> = { readonly _padding: SlotPadding, readonly item: I };
type ZeroPaddedItem<I extends Item> = UnwrapSingleton<PaddedStruct<I>>;

type PaddedItem<I extends Item> =
  I extends { binary: "int" } ? SignedSlotItem<I> : ZeroPaddedItem<I>;

//a slot surfaces exactly the item's value, so an item that surfaces none - one of fixed value,
//  `as` included, since `as` carries `fixed` by construction - has no slot form: it would leave
//  the padded struct with nothing to unwrap to
const paddedItem = <const I extends Item>(item: I): PaddedItem<I> => {
  if (calcStaticSize(item) === null || hasFixed(item))
    throw new Error("a slot item must be statically sized and surface a value");

  return (item.binary === "int"
    ? signedSlotItem(item)
    : unwrapSingleton({ _padding: slotPadding(item), item })
  ) as PaddedItem<I>;
};

//a generated wire-only field leads with an underscore - `_padding`, `_selector` - which keeps
//  it out of the namespace a spec's own fields are spelled in
const paddedStruct = <const S extends Struct>(layout: S) =>
  ({ _padding: slotPadding(layout), ...layout } as const);

export type PaddedSlotLayout<T extends Struct | Item> =
  T extends Item
  ? PaddedItem<T>
  : T extends Struct
  ? ReturnType<typeof paddedStruct<T>>
  : never;

export const paddedSlotLayout =
  <const T extends Struct | Item>(layoutOrItem: T): PaddedSlotLayout<T> =>
    (isItem(layoutOrItem)
      ? paddedItem(layoutOrItem)
      : paddedStruct(layoutOrItem)
    ) as PaddedSlotLayout<T>;

export type PaddedFields<S extends Struct> = { readonly [K in keyof S]: PaddedSlotLayout<S[K]> };

//every field on a slot of its own: the ABI's static parameter list, EIP-712's encodeData
export const paddedFields = <const S extends Struct>(layout: S): PaddedFields<S> =>
  Object.fromEntries(
    Object.entries(layout).map(([name, field]) => [name, paddedSlotLayout(field)]),
  ) as PaddedFields<S>;

// ---- Value items ----

export const uint256Item = { binary: "uint", size: wordSize } as const;

//an amount on a word; narrower amounts are `amountItem(size, kind)` as anywhere else
export const evmAmountItem =
  <const K extends KindWithAtomic | undefined = undefined>(...kind: OptionalArg<K>) =>
    amountItem(wordSize, ...kind);

//a maxed out deadline is the "never expires" idiom (EIP-2612, EIP-3009), and anything else out
//  that far is not an intended instant either, so the whole high end resolves to the same sentinel
export const deadlineItem = timestampItem({ size: wordSize, saturateAs: "infinity" });
export type Deadline = DeriveType<typeof deadlineItem>;

export const evmTimestampItem = timestampItem({ size: wordSize });

//annotated, not `satisfies`: only an annotation gives the value the `Conversion` reference as
//  its type, and that reference is what survives into every item embedding it.
//  The surfaced spelling is EIP-55, which is what viem's own decoders return: a lowercase one
//  would make the same word decode to two strings that compare unequal
export const addressConversion: Conversion<RoUint8Array, Address> = {
  to:   (encoded: RoUint8Array) => checksumAddress(hex.encode(encoded, true)),
  from: (addr:    Address     ) => hex.decode(addr),
};

const _addressItem = {
  binary: "bytes",
  size:   addressSize,
  custom: addressConversion,
} as const;
export interface AddressItem extends Identity<typeof _addressItem> {}
export const addressItem: AddressItem = _addressItem;

//an address and a bool on their ABI words
export const abiAddressItem = paddedSlotLayout(addressItem);
export const abiBoolItem    = paddedSlotLayout(boolItem());

//the ABI's `bytesN`, the one static type it pads on the right: spelled at word width, where a
//  bare bytes item on a slot (an address, say) is left-padded like everything else
const rightPaddedBytesLayout = <N extends number>(size: N) => ({
  value:    { binary: "bytes", size },
  _padding: paddingItem(wordSize - size),
} as const);
export type BytesNItem<N extends number> =
  UnwrapSingleton<ReturnType<typeof rightPaddedBytesLayout<N>>>;

export const bytesNItem = <N extends number>(size: N): BytesNItem<N> => {
  if (!Number.isInteger(size) || size < 1 || size > wordSize)
    throw new Error(`bytes${size} is not an ABI type`);

  return unwrapSingleton(rightPaddedBytesLayout(size));
};

// ---- Signatures ----

export const signatureSize = 65;
export const signatureItem = { binary: "bytes", size: signatureSize } as const;

const vItem = { binary: "uint", size: 1 } as const;
//v is the recovery id in its legacy spelling, 27 + yParity
const vBase = 27;
const yParityBit = 0x80;

export const signatureLayout    = { r: hashItem, s: hashItem, v: vItem } as const;
export const abiSignatureLayout = { v: paddedSlotLayout(vItem), r: hashItem, s: hashItem } as const;

export const abiSignatureItem = withCustom(abiSignatureLayout, {
  to:   (words): RoUint8Array     => serialize  (signatureLayout, words),
  from: (signature: RoUint8Array) => deserialize(signatureLayout, signature),
});

export const compactSignatureItem = withCustom({ r: hashItem, yParityAndS: hashItem }, {
  to: ({ r, yParityAndS }): RoUint8Array => {
    const s = Uint8Array.from(yParityAndS);
    s[0] = yParityAndS[0]! & ~yParityBit;
    const yParity = yParityAndS[0]! >= yParityBit ? 1 : 0;
    return serialize(signatureLayout, { r, s, v: vBase + yParity });
  },
  from: (signature: RoUint8Array) => {
    const { r, s, v } = deserialize(signatureLayout, signature);
    //the form has one bit for the parity: v must be that bit's legacy spelling, and s must
    //  leave the bit free, as a canonical (low) s does
    if (v !== vBase && v !== vBase + 1)
      throw new Error(`v must be ${vBase} or ${vBase + 1}, got ${v}`);

    if (s[0]! >= yParityBit)
      throw new Error("s has its top bit set (not a low s), so it has no compact form");

    const yParityAndS = Uint8Array.from(s);
    yParityAndS[0] = s[0]! | (v - vBase) * yParityBit;
    return { r, yParityAndS };
  },
});

// ---- Function selectors ----

const funcSigHashPrefix = (funcSig: string, size: number) =>
  keccak256(utf8.encode(funcSig)).subarray(0, size);

export const selectorLength = 4;
export const selectorOf = (funcSig: string) => funcSigHashPrefix(funcSig, selectorLength);

export const selectorItem = (funcSig: string) =>
  ({ binary: "bytes", fixed: selectorOf(funcSig) } as const);

export const selectorLayout =
  (funcSig: string) =>
    <const L extends Struct>(layout: L) =>
      ({ _selector: selectorItem(funcSig), ...layout } as const);

// ---- A single dynamic value ----

//poor man's abi.encode/decode(bytes): handles a single dynamic value - a trailing argument, or a
//  lone return - whose payload therefore follows the whole head. `offset` is that head's size,
//  its own word included - hence the default, a lone argument - and is the argument's index times
//  the word size only where every preceding argument occupies exactly one slot
const lengthSize = 4;
export type AbiEncoded<L extends Layout | undefined> =
  L extends Layout ? DeriveType<L> : RoUint8Array;

//the payload stays raw bytes in the layout, so its length is at hand to check the padding
//  against; the conversion runs the content layout, if any
const abiEncodedLayout = (offset: number) => ({
  offset:        { ...uint256Item, fixed: BigInt(offset) },
  lengthPadding: { binary: "bytes", fixed: new Uint8Array(wordSize - lengthSize) },
  item:          { binary: "bytes", size: { binary: "uint", size: lengthSize } },
  postPadding:   { binary: "bytes" },
} as const);

const paddingSizeOf = (dataSize: number) => (wordSize - dataSize % wordSize) % wordSize;

//annotated so declaration emit prints the alias rather than WithCustom's evaluated form
export type AbiEncodedBytesItem<L extends Layout | undefined> =
  WithCustom<ReturnType<typeof abiEncodedLayout>, AbiEncoded<L>>;

type AbiEncodedOpts = Opts<{ layout: Layout, offset: number }>;
//the content layout, read off the whole record: one that may be undefined - or absent, where the
//  record's own type declares it optional - types as either payload
type ContentOf<O extends AbiEncodedOpts> = "layout" extends keyof O ? O["layout"] : undefined;

export const abiEncodedBytesItem = <const O extends AbiEncodedOpts = {}>(
  ...[opts]: OptionalArg<O>
): AbiEncodedBytesItem<ContentOf<O>> => {
  type L = ContentOf<O>;
  const layout = abiEncodedLayout(opts?.offset ?? wordSize);
  const content = opts?.layout;

  return withCustom(layout, {
    to: (wrapped) => {
      const { item, postPadding } = wrapped;
      if (postPadding.length !== paddingSizeOf(item.length) || postPadding.some(b => b !== 0))
        throw new Error(`abi-encoded bytes: expected ${paddingSizeOf(item.length)} padding bytes`);

      return (content !== undefined ? deserialize(content, item) : item) as AbiEncoded<L>;
    },
    from: (value: AbiEncoded<L>) => {
      const item = content !== undefined ? serialize(content, value) : value as RoUint8Array;
      return { item, postPadding: new Uint8Array(paddingSizeOf(item.length)) };
    },
  });
};

// ---- Parameters ----

//`__valueType` is a phantom, never set, carrying the item's surfaced type, which the item's
//  DeriveType does not reduce to while an amount's kind is still open - the kinded params state
//  it as AmountOrAtomic<K>. A string key rather than a symbol brand: a consumer's spread or Omit
//  of a param expands the alias, and an expanded private symbol cannot be named in their
//  declarations.
//spelled member by member rather than as Readonly<{...}>: an alias whose body is another alias
//  reference emits under the inner name, expanded
export type AbiParam<
  N extends string = string,
  T extends string = string,
  I extends Item   = Item,
  V                = unknown,
> = {
  readonly name:         N;
  readonly type:         T;
  readonly item:         I;
  readonly __valueType?: V;
};

//the surfaced type is the item's, or stated up front where `DeriveType<I>` does not reduce - an
//  amount at an open kind. The switch is on a boolean rather than on V itself: a check type
//  that is always a literal resolves eagerly, where a check on V would stay deferred whenever V
//  is open (a stated AmountOrAtomic<K>), and a deferred conditional in parameter position
//  admits nothing
type ValueOf<I extends Item, Stated extends boolean, V> = Stated extends true ? V : DeriveType<I>;

type ParamFactory<Stated extends boolean, V> =
  <N extends string, T extends string, const I extends Item>(name: N, type: T, item: I) =>
    AbiParam<N, T, I, ValueOf<I, Stated, V>>;

//the zero-argument overload exists because a type argument cannot be given without giving them
//  all: `abiParam<V>()` takes V alone and leaves the rest to inference
type AbiParamFn = ParamFactory<false, "ignored"> & { <V>(): ParamFactory<true, V> };

export const abiParam: AbiParamFn = ((...args: [string, string, Item] | []) =>
  args.length === 0
  ? (name: string, type: string, item: Item) => ({ name, type, item })
  : { name: args[0], type: args[1], item: args[2] }
) as AbiParamFn;

export type AbiParamValue<A extends AbiParam> = A extends { __valueType?: infer V } ? V : never;

type ParamOfFactory<Stated extends boolean, V> =
  <T extends string, const I extends Item>(type: T, item: I) =>
    <N extends string>(name: N) => AbiParam<N, T, I, ValueOf<I, Stated, V>>;

//the same door one level up: `paramOf<V>()(type, item)` fixes the pair with a stated type
type ParamOfFn = ParamOfFactory<false, "ignored"> & { <V>(): ParamOfFactory<true, V> };

export const paramOf: ParamOfFn = ((...args: [string, Item] | []) =>
  args.length === 0
  ? (type: string, item: Item) => (name: string) => ({ name, type, item })
  : (name: string) => ({ name, type: args[0], item: args[1] })
) as ParamOfFn;

export const addressParam = paramOf("address", addressItem);

//the item's width is the domain's range, independent of the ABI type the slot is spelled as: a
//  uint64 amount the contract holds rides a `uint256` word, and the 8-byte item is what rejects
//  a value the contract could not hold. Without a kind the value is what that width derives,
//  as the item's own DeriveType would say
export const amountParam = <
        N extends string,
        T extends string,
  const K extends KindWithAtomic | undefined = undefined,
        S extends number = typeof wordSize,
>(name: N, type: T, ...args: OptionalArg<K, OptionalArg<S>>) =>
  abiParam<AmountOr<K, NumSizeToPrimitive<S>>>()
    (name, type, amountItem((args[1] ?? wordSize) as S, argOf(args)));

//the one dynamic parameter a function spec admits. Its offset is a constant - the parameter
//  count's word, since the whole head precedes the tail - but the payload can only follow the
//  head, so bundling offset and payload into one item confines it to the last position, which
//  `contractFromSpec` enforces and where it builds the item, the count being known only there
export type DynamicAbiParam<N extends string, L extends Layout | undefined> =
  AbiParam<N, "bytes", AbiEncodedBytesItem<L>, AbiEncoded<L>> &
  { readonly dynamic: { readonly layout: L } };

//`bytes` as a function's last parameter - raw, or the serialization of `layout`. The item is a
//  placeholder built at offset zero; `contractFromSpec` rebuilds it once the parameter list
//  fixes the head's size, which the type does not depend on
export const trailingBytesParam = <
        N extends string,
  const L extends Layout | undefined = undefined,
>(name: N, ...layout: OptionalArg<L>): DynamicAbiParam<N, L> => ({
  ...abiParam(name, "bytes", abiEncodedBytesItem({ layout: argOf(layout) })),
  dynamic: { layout: argOf(layout) },
}) as DynamicAbiParam<N, L>;

// ---- Signature variants: events and errors ----

export type SigVariant<S extends string = string, P extends Struct = Struct> = RoPair<S, P>;
export type SigVariants = RoNeTuple<SigVariant>;

//the params' names become a struct's keys, so a repeat would fold two params into one field;
//  every params list passes through here, which is where it is caught
export const signatureOf = (name: string, params: RoTuple<AbiParam>): string => {
  assertDistinct(...params.map(p => p.name));
  return `${name}(${params.map(p => p.type).join(",")})`;
};

//the name a signature leads with - `signatureOf` read backwards, as far as the name goes
export type SigNameOf<S extends string> = S extends `${infer N}(${string}` ? N : never;

export const sigNameOf = <S extends string>(funcSig: S): SigNameOf<S> => {
  const open = funcSig.indexOf("(");
  if (open < 1)
    throw new Error(`not a function signature: ${funcSig}`);

  return funcSig.slice(0, open) as SigNameOf<S>;
};

type JoinTypes<P extends RoTuple<AbiParam>> =
  P extends HeadTail<P, infer H, infer R>
  ? R extends readonly [] ? H["type"] : `${H["type"]},${JoinTypes<R>}`
  : "";

export type SigVariantOf<N extends string, P extends RoTuple<AbiParam>> =
  SigVariant<`${N}(${JoinTypes<P>})`, { readonly [E in P[number] as E["name"]]: E["item"] }>;

//a variant from its name and params, so an event or error is spelled once
export const sigVariant = <
        N extends string,
  const P extends RoTuple<AbiParam>,
>(name: N, ...params: P): SigVariantOf<N, P> =>
  [signatureOf(name, params), Object.fromEntries(params.map(p => [p.name, p.item]))] as any;

type SwitchRows = Parameters<typeof switchItem>[2];

type SigRows<IS extends number, V extends SigVariants> = {
  readonly [K in keyof V]:
    V[K] extends SigVariant<infer S, infer P>
    ? readonly [NumSizeToPrimitive<IS>, SigNameOf<S>, PaddedFields<P>]
    : never
};

//the infer binding resolves SigRows once: switchItem's return mentions its R both as keyof R
//  and as R[K], and an unbound SigRows would be re-derived per mention
type SigRowsBound<IS extends number, V extends SigVariants> =
  SigRows<IS, V> extends infer R extends SwitchRows ? R : never;

//sigSwitchItem's curried return, named so partial applications (parsing's error/event switch
//  items and any downstream ones) declaration-emit as one alias reference: emitted in evaluated
//  form instead, every consumer instantiation re-evaluates the whole switch typing per variant
export type SigSwitcher<IS extends number, T extends string> =
  <const V extends SigVariants>(variants: V) =>
    ReturnType<typeof switchItem<T, ReturnType<typeof uintItem<IS, {}>>, SigRowsBound<IS, V>, {}>>;

const sigPrefixId = <S extends number>(funcSig: string, size: S): NumSizeToPrimitive<S> => {
  if (size < 1 || size > wordSize)
    throw new Error(`signature prefix size must be within [1, ${wordSize}], got ${size}`);

  return numSizeToPrimitive(bignum.fromBytes(funcSigHashPrefix(funcSig, size)), size);
};

//a switch over signature-derived ids, decoding the abi-encoded params of the matched variant.
//  The tag surfaces the signature's own name, Solidity's spelling included - a consumer wanting
//  its discriminants to read uniformly folds the case on its own side, where the convention is:
//  custom errors off revert data (idSize 4 - the selector is all the wire carries), events off
//  topic0 concatenated with the remaining topics and the data - so an event's struct is in
//  wire order, indexed params first, which `sigVariant`'s param order is only when they lead
//  the declaration. topic0 carries the whole hash, so events take idSize 32; a shorter prefix
//  would only trade away collision headroom
export const sigSwitchItem = <
  IS extends number,
  T  extends string,
>(idSize: IS, tag: T): SigSwitcher<IS, T> =>
  <const V extends SigVariants>(variants: V) =>
    switchItem(tag, uintItem(idSize), (variants as SigVariants).map(([funcSig, params]) => [
      sigPrefixId(funcSig, idSize),
      sigNameOf(funcSig),
      paddedFields(params),
    ] as const) as unknown as SigRowsBound<IS, V>);

// ---- Storage slots ----

//value-type keys only - string/bytes keys are hashed unpadded. The key's JS type says which
//  value type it is and so how Solidity pads it to the word: an integer (a negative one in two's
//  complement, i.e. sign-extended) and a bool right-aligned, an address right-aligned, a bytesN
//  left-aligned - a full word is itself
export type MappingKey = bigint | number | boolean | Address | RoUint8Array;

export const mappingSlot = (key: MappingKey, declareSlot: bigint): bigint => {
  const buf = new Uint8Array(2 * wordSize);
  if (typeof key === "bigint" || typeof key === "number") {
    const int = BigInt(key);
    if (int < -(1n << 255n) || int >= (1n << 256n))
      throw new Error(`mapping key ${int} does not fit a word`);

    buf.set(bignum.toBytes(int < 0n ? int + (1n << 256n) : int, wordSize));
  }
  else if (typeof key === "boolean")
    buf[wordSize - 1] = key ? 1 : 0;
  else if (typeof key === "string") {
    //viem's Address is any `0x${string}`, so a hex-spelled bytesN would otherwise pass for one
    const address = hex.decode(key);
    if (address.length !== addressSize)
      throw new Error(`a string mapping key is an address, got ${address.length} bytes - ` +
                      `pass a bytesN key as a Uint8Array`);

    buf.set(address, wordSize - addressSize);
  }
  else {
    if (key.length > wordSize)
      throw new Error("mapping key must not exceed one word");

    buf.set(key, 0);
  }
  buf.set(bignum.toBytes(declareSlot, wordSize), wordSize);
  return bignum.fromBytes(keccak256(buf));
};

export const keccakSlot = (slot: bigint): bigint =>
  bignum.fromBytes(keccak256(bignum.toBytes(slot, wordSize)));
