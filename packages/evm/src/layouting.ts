import { type Address, checksumAddress } from "viem";
import type { Identity, RoUint8Array, RoArray, RoTuple,
              RoNeTuple, RoPair, HeadTail, Opts, OptionalArg, GetOpt, If } from "@onrail-xyz/utils";
import { utf8, hex, bignum, assertDistinct, argOf, mapValues } from "@onrail-xyz/utils";
import type { Conversion, Layout, Struct, DeriveType, Item,
              NumSizeToPrimitive, WithCustom, UnwrapSingleton } from "@onrail-xyz/binary-layout";
import { serialize, deserialize, calcStaticSize, paddingItem,
         unwrapSingleton, isItem, uintItem, switchItem,
         numSizeToPrimitive, timestampItem, withCustom,
         enumItem, hasFixed, customOf, boolItem, utf8Conversion } from "@onrail-xyz/binary-layout";
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

//a generated wire-only field leads with an underscore - `_padding`, `_selector`, `_offset` - which
//  keeps it out of the namespace a spec's own fields are usually spelled in; one spelled there
//  anyway is rejected rather than overwritten
const paddedStruct = <const S extends Struct>(layout: S) => {
  assertDistinct("_padding", ...Object.keys(layout));
  return { _padding: slotPadding(layout), ...layout } as const;
};

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
  mapValues(layout as Struct, paddedSlotLayout) as PaddedFields<S>;

// ---- Value items ----

export const uint256Item = { binary: "uint", size: wordSize } as const;

//an amount on a word; narrower amounts are `amountItem(size, kind)` as anywhere else
export const evmAmountItem =
  <const K extends KindWithAtomic | undefined = undefined>(...kind: OptionalArg<K>) =>
    amountItem(wordSize, ...kind);

//a maxed out deadline is the "never expires" idiom (EIP-2612, EIP-3009), and anything else out
//  that far is not an intended instant either, so the whole high end resolves to the same sentinel;
//  uint32 is the natural range of unix seconds, so "never" encodes as its max, which fits the
//  narrower deadline fields of contracts that pack them
export const deadlineItem =
  timestampItem({ size: wordSize, saturateAs: "infinity", saturateFrom: 2 ** 32 - 1 });
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
//  bare bytes item on a slot (an address, say) is left-padded like everything else. An item in
//  place of the width gives the N bytes their content, read in wire order - so an integer over
//  them must be big-endian, as the default is
type RightPaddedStruct<I extends Item> = { readonly value: I, readonly _padding: SlotPadding };
export type RightPaddedItem<I extends Item> = UnwrapSingleton<RightPaddedStruct<I>>;
export type BytesNItem<N extends number> =
  RightPaddedItem<{ readonly binary: "bytes", readonly size: N }>;

const rightPaddedItem = <I extends Item>(item: I): RightPaddedItem<I> => {
  const size = calcStaticSize(item);
  if (size === null || hasFixed(item))
    throw new Error("a slot item must be statically sized and surface a value");

  if (!Number.isInteger(size) || size < 1 || size > wordSize)
    throw new Error(`bytes${size} is not an ABI type`);

  return unwrapSingleton<RightPaddedStruct<I>>(
    { value: item, _padding: paddingItem(wordSize - size) }
  );
};

export const bytesNItem: {
  <N extends number>(size: N): BytesNItem<N>,
  <const I extends Item>(item: I): RightPaddedItem<I>,
} = (sizeOrItem: number | Item): any =>
  rightPaddedItem(
    typeof sizeOrItem === "number" ? { binary: "bytes", size: sizeOrItem } : sizeOrItem
  );

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

const sigPrefixId = <S extends number>(funcSig: string, size: S): NumSizeToPrimitive<S> => {
  if (size < 1 || size > wordSize)
    throw new Error(`signature prefix size must be within [1, ${wordSize}], got ${size}`);

  return numSizeToPrimitive(bignum.fromBytes(funcSigHashPrefix(funcSig, size)), size);
};

export const selectorLength = 4;
export const selectorOf   = (funcSig: string) => funcSigHashPrefix(funcSig, selectorLength);
export const selectorIdOf = (funcSig: string) => sigPrefixId(funcSig, selectorLength);

export const selectorItem = (funcSig: string) =>
  ({ binary: "bytes", fixed: selectorOf(funcSig) } as const);

export const selectorLayout =
  (funcSig: string) =>
    <const L extends Struct>(layout: L) => {
      assertDistinct("_selector", ...Object.keys(layout));
      return { _selector: selectorItem(funcSig), ...layout } as const;
    };

//the selectors of a set of functions, surfaced by name: sigSwitchItem without the params. An
//  ABI bytes4 is `bytesNItem(selectorEnumItem(...))`
export type SelectorEnumItem<N extends string> = {
  readonly binary: "uint",
  readonly size:   typeof selectorLength,
  readonly custom: Conversion<number, N>,
};

//viewed as an array of S[number]: S's own map is its constraint's while S is open, typing each
//  signature as a bare string
export const selectorEnumItem = <const S extends RoTuple<string>>(
  funcSigs: S,
): SelectorEnumItem<SigNameOf<S[number]>> => {
  const sigs: RoArray<S[number]> = funcSigs;
  return enumItem(sigs.map(sig => [sigNameOf(sig), selectorIdOf(sig)] as const), selectorLength);
};

// ---- Dynamic values ----

//the ABI puts a dynamic value's offset word in the head and its tail - length word, payload,
//  padding - after the whole head. A layout cannot seek: the offset is a fixed word, right only
//  if the tail sits where reading arrives anyway, so the offset is the head's size. A second
//  tail's offset counts the first one's length, which takes an encoding pass
export type AbiOffsetItem = {
  readonly binary: "uint",
  readonly size:   typeof wordSize,
  readonly fixed:  bigint,
};

//known by identity: structurally an offset is any fixed word, which paddedSlotLayout rejects
//  everywhere else
const abiOffsetItems = new WeakSet<Layout>();
const isAbiOffsetItem = (field: Layout): boolean => abiOffsetItems.has(field);

export const abiOffsetItem = (headSize: number): AbiOffsetItem => {
  const item = { ...uint256Item, fixed: BigInt(headSize) };
  abiOffsetItems.add(item);
  return item;
};

export type AbiEncoded<L extends Layout | undefined> =
  L extends Layout ? DeriveType<L> : RoUint8Array;

const lengthSize = 4;
//the payload stays raw bytes in the layout, so its length is at hand to check the padding
//  against; the conversion runs the content layout, if any
const abiTailLayout = {
  lengthPadding: { binary: "bytes", fixed: new Uint8Array(wordSize - lengthSize) },
  item:          { binary: "bytes", size: { binary: "uint", size: lengthSize } },
  postPadding:   { binary: "bytes" },
} as const;

const paddingSizeOf = (dataSize: number) => (wordSize - dataSize % wordSize) % wordSize;

//annotated so declaration emit prints the alias rather than WithCustom's evaluated form
export type AbiTailItem<L extends Layout | undefined> =
  WithCustom<typeof abiTailLayout, AbiEncoded<L>>;

type ContentOpts = Opts<{ layout: Layout }>;

export const abiTailItem = <const O extends ContentOpts = {}>(
  ...[opts]: OptionalArg<O>
): AbiTailItem<GetOpt<O, "layout">> => {
  type L = GetOpt<O, "layout">;
  const content = opts?.layout;

  return withCustom(abiTailLayout, {
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

//recognized by its layout, which survives a conversion composed onto the item
const isAbiTailItem = (field: Layout): boolean =>
  isItem(field) && field.binary === "bytes" && field.layout === abiTailLayout;

//poor man's abi.encode/decode(bytes): a lone dynamic value - a return, say
type AbiEncodedStruct<L extends Layout | undefined> =
  { readonly _offset: AbiOffsetItem, readonly value: AbiTailItem<L> };
export type AbiEncodedBytesItem<L extends Layout | undefined> =
  UnwrapSingleton<AbiEncodedStruct<L>>;

export const abiEncodedBytesItem = <const O extends ContentOpts = {}>(
  ...opts: OptionalArg<O>
): AbiEncodedBytesItem<GetOpt<O, "layout">> =>
  unwrapSingleton<AbiEncodedStruct<GetOpt<O, "layout">>>(
    { _offset: abiOffsetItem(wordSize), value: abiTailItem<O>(...opts) }
  );

const utf8BytesItem = { binary: "bytes", custom: utf8Conversion } as const;

export type AbiStringItem = AbiEncodedBytesItem<typeof utf8BytesItem>;
export const abiStringItem: AbiStringItem = abiEncodedBytesItem({ layout: utf8BytesItem });

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
type ValueOf<I extends Item, Stated extends boolean, V> = If<Stated, V, DeriveType<I>>;

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

//the one dynamic parameter a param list admits, anywhere in it: one whose item is a tail. The
//  offset word in its place is added where the list becomes a struct, the head being known only
//  there. An event's indexed params ride its topics and take no room in the head, and nothing
//  else in a param list says which they are, so the dynamic param states their number
export type DynamicAbiParam<N extends string, T extends string, L extends Layout | undefined> =
  AbiParam<N, T, AbiTailItem<L>, AbiEncoded<L>> & { readonly indexedParams: number };

const isDynamicParam =
  (param: AbiParam): param is AbiParam & { readonly indexedParams?: number } =>
    isAbiTailItem(param.item);

type DynamicParamOpts = Opts<{ layout: Layout, indexedParams: number }>;

const dynamicParam = <N extends string, T extends string, L extends Layout | undefined>(
  name:          N,
  type:          T,
  layout:        L,
  indexedParams: number = 0,
): DynamicAbiParam<N, T, L> => ({
  ...abiParam(name, type, abiTailItem({ layout })),
  indexedParams,
}) as DynamicAbiParam<N, T, L>;

export const bytesParam = <N extends string, const O extends DynamicParamOpts = {}>(
  name: N,
  ...[opts]: OptionalArg<O>
): DynamicAbiParam<N, "bytes", GetOpt<O, "layout">> =>
  dynamicParam(name, "bytes", opts?.layout as GetOpt<O, "layout">, opts?.indexedParams);

export const stringParam = <N extends string, const O extends DynamicParamOpts = {}>(
  name: N,
  ...[opts]: OptionalArg<O>
): DynamicAbiParam<N, "string", GetOpt<O, "layout", typeof utf8BytesItem>> =>
  dynamicParam(
    name,
    "string",
    (opts?.layout ?? utf8BytesItem) as GetOpt<O, "layout", typeof utf8BytesItem>,
    opts?.indexedParams,
  );

const abiHeadSize = (params: RoArray<AbiParam>): number =>
  params.reduce((size, param) => size + (isDynamicParam(param)
    ? wordSize
    : calcStaticSize(paddedSlotLayout(param.item))!
  ), 0);

type OffsetField<P extends RoTuple<AbiParam>> = {
  readonly [E in P[number] as E["item"] extends AbiTailItem<any> ? "_offset" : never]:
    AbiOffsetItem;
};

//the params' items by name, in wire order: a dynamic param's offset word in its place, its tail
//  after the head
export type ParamsStruct<P extends RoTuple<AbiParam>> =
  { readonly [E in P[number] as E["name"]]: E["item"] } & OffsetField<P>;

//`inTopics` leading params - an event's indexed ones - take no room in the head
const paramsStruct = (params: RoArray<AbiParam>, inTopics: number): Struct => {
  const dynamic = params.filter(isDynamicParam);
  if (dynamic.length > 1)
    throw new Error(`${dynamic[1]!.name}: a param list admits one dynamic parameter only`);

  const fields = [
    ...params.map(param => isDynamicParam(param)
      ? ["_offset", abiOffsetItem(abiHeadSize(params.slice(inTopics)))] as const
      : [param.name, param.item] as const),
    ...dynamic.map(param => [param.name, param.item] as const),
  ];
  assertDistinct(...fields.map(([key]) => key));
  return Object.fromEntries(fields);
};

//a struct on its slots: each field padded onto its own, but for a dynamic value's offset word and
//  tail, which already are - the tail last, since it follows the head
type SlotFields<S extends Struct> = {
  readonly [K in keyof S]:
    S[K] extends AbiOffsetItem | AbiTailItem<any> ? S[K] : PaddedSlotLayout<S[K]>;
};

const slotFields = (struct: Struct): Struct => {
  const fields = Object.entries(struct);
  return Object.fromEntries(fields.map(([name, field], i) => {
    if (isAbiOffsetItem(field))
      return [name, field];

    if (!isAbiTailItem(field))
      return [name, paddedSlotLayout(field)];

    if (i !== fields.length - 1)
      throw new Error(`${name}: an abi tail must be the only one, and come last`);

    return [name, field];
  }));
};

export type ParamsLayout<P extends RoTuple<AbiParam>> = SlotFields<ParamsStruct<P>>;

export const paramsLayout = <const P extends RoTuple<AbiParam>>(params: P): ParamsLayout<P> =>
  slotFields(paramsStruct(params, 0)) as ParamsLayout<P>;

// ---- Signature variants: events and errors ----

export type SigVariant<S extends string = string, P extends Struct = Struct> = RoPair<S, P>;
export type SigVariants = RoNeTuple<SigVariant>;

//the params' names become a struct's keys, so a repeat would fold two params into one field;
//  every params list passes through here, which is where it is caught
export const signatureOf = (name: string, params: RoTuple<AbiParam>): string => {
  assertDistinct(...params.map(p => p.name));
  return `${name}(${params.map(p => p.type).join(",")})`;
};

//the name a signature leads with - `signatureOf` read backwards, as far as the name goes; a wide
//  string's name is a wide string
export type SigNameOf<S extends string> =
  S extends `${infer N}(${string}` ? N : string extends S ? string : never;

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
  SigVariant<`${N}(${JoinTypes<P>})`, ParamsStruct<P>>;

//a variant from its name and params, so an event or error is spelled once
export const sigVariant = <
        N extends string,
  const P extends RoTuple<AbiParam>,
>(name: N, ...params: P): SigVariantOf<N, P> => {
  const inTopics = (params as RoArray<AbiParam>).find(isDynamicParam)?.indexedParams ?? 0;
  return [signatureOf(name, params), paramsStruct(params, inTopics)] as any;
};

type SwitchRows = Parameters<typeof switchItem>[2];

type SigRows<IS extends number, V extends SigVariants> = {
  readonly [K in keyof V]:
    V[K] extends SigVariant<infer S, infer P>
    ? readonly [NumSizeToPrimitive<IS>, SigNameOf<S>, SlotFields<P>]
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
      slotFields(params),
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
