import type { Address, Lamports } from "@solana/kit";
import type { Identity, RoArray, RoUint8Array, OptionalArg } from "@onrail-xyz/utils";
import { argOf, restOf, valueIndexEntries, utf8 } from "@onrail-xyz/utils";
import type { WithCustom, NumberSize,
              CustomizableBytes, Conversion, Item,
              Layout, Struct, DeriveType, UnwrapSingleton } from "@onrail-xyz/binary-layout";
import { customizableBytes, boolItem, enumItem,
         setEndianness, unwrapSingleton,
         utf8Conversion, paddingItem, isItem,
         withCustom, deserialize, calcStaticSize } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { amountItem, hashItem } from "@onrail-xyz/common";
import { base58 } from "./encoding.js";
import { type DiscriminatorType, discriminatorOf } from "./utils.js";
import { zeroAddress, addressSize } from "./constants.js";

export const littleEndian = <const L extends Layout>(layout: L) => setEndianness(layout, "little");

export const bumpItem = { binary: "uint", size: 1 } as const satisfies Item;

export const u64Item = { binary: "uint", size: 8, endianness: "little" } as const satisfies Item;

//annotated, not `satisfies`: only an annotation gives the value the `Conversion` reference as
//  its type, and that reference is what survives into every item embedding it
export const addressConversion: Conversion<RoUint8Array, Address> = {
  to:   (encoded: RoUint8Array) => base58.encode(encoded) as Address,
  from: (address: Address     ) => base58.decode(address),
};

const _addressItem = {
  binary: "bytes",
  size:   addressSize,
  custom: addressConversion,
} as const;
export interface AddressItem extends Identity<typeof _addressItem> {}
export const addressItem: AddressItem = _addressItem;

export const lamportsConversion: Conversion<bigint, Lamports> = {
  to:   (lamports: bigint  ) => lamports as Lamports,
  from: (lamports: Lamports) => lamports,
};

const kitLamportsItem = {
  ...u64Item,
  custom: lamportsConversion,
} as const satisfies Item;

//spread-override instead of littleEndian(): running SetEndianness over the (kind-conditional)
//  AmountItem type blows the instantiation depth in downstream DeriveTypes
export const svmAmountItem = <
  const K extends KindWithAtomic | undefined = undefined,
        S extends number = 8,
>(...args: OptionalArg<K, OptionalArg<S>>) =>
  ({ ...amountItem((args[1] ?? 8) as S, argOf(args)), endianness: "little" } as const);

export type LamportsItem<KS extends KindWithAtomic | undefined> =
  KS extends KindWithAtomic ? ReturnType<typeof svmAmountItem<KS>> : typeof kitLamportsItem;

export const lamportsItem = <
  const KS extends KindWithAtomic | undefined = undefined,
>(...[solKind]: OptionalArg<KS>): LamportsItem<KS> =>
  (solKind ? svmAmountItem(solKind) : kitLamportsItem) as any;

const vecLengthItem = { binary: "uint", size: 4, endianness: "little" } as const;

export const vecBytesItem = <
  const P extends CustomizableBytes = undefined,
>(...spec: OptionalArg<P>) =>
  customizableBytes({ size: vecLengthItem }, ...spec);

export const vecArrayItem = <const L extends Layout>(layout: L) =>
  ({ binary: "array", length: vecLengthItem, layout } as const);

const discriminatorItem = (type: DiscriminatorType, name: string) => ({
  binary: "bytes",
  fixed:  discriminatorOf(type, name),
} as const);

//annotated, with S pinned by explicit instantiation: an inferred return here emits
//  unwrapSingleton's type machinery fully evaluated, and evaluated emit has no alias identity
//  for a consumer's checker to cache on. The explicit S matters too - left to inference it
//  binds the fresh object literal type, which is merely equivalent to the alias the annotation
//  names, not identical, and the mapped types inside unwrapSingleton only relate identical
//  instantiations (TS2719)
type Discriminator = ReturnType<typeof discriminatorItem>;
type DiscriminatedItemStruct<I extends Item> =
  { readonly _discriminator: Discriminator, readonly value: I };
type DiscriminatedItem<I extends Item> = UnwrapSingleton<DiscriminatedItemStruct<I>>;

const discriminatedItem = <const I extends Item>(
  type: DiscriminatorType,
  name: string,
  item: I,
): DiscriminatedItem<I> =>
  unwrapSingleton<DiscriminatedItemStruct<I>>(
    { _discriminator: discriminatorItem(type, name), value: item }
  );

const discriminatedStruct = <const S extends Struct>(
  type:   DiscriminatorType,
  name:   string,
  layout: S,
//a generated wire-only field leads with an underscore, which keeps it out of the namespace a
//  layout's own fields are spelled in
) => ({ _discriminator: discriminatorItem(type, name), ...layout } as const);

type DiscriminatedLayout<L extends Layout> =
  L extends Item
  ? DiscriminatedItem<L>
  : L extends Struct
  ? keyof L extends never //an empty struct degenerates to the bare discriminator
    ? Discriminator
    : ReturnType<typeof discriminatedStruct<L>>
  : never;
const discriminatedLayout = <const L extends Layout>(
  type:   DiscriminatorType,
  name:   string,
  layout: L,
): DiscriminatedLayout<L> => (
  isItem(layout)
  ? discriminatedItem(type, name, layout as Item)
  : Object.keys(layout).length === 0
  ? discriminatorItem(type, name)
  : discriminatedStruct(type, name, layout as Struct)
) as any;

const discriminatedLayoutOf =
  (type: DiscriminatorType) =>
    <const L extends Layout>(name: string, layout: L) =>
      discriminatedLayout(type, name, layout);

export const accountLayout     = discriminatedLayoutOf("account");
export const instructionLayout = discriminatedLayoutOf("instruction");
export const eventLayout       = discriminatedLayoutOf("event");

export const cEnumItem = <const E extends RoArray<string>>(names: E, size: NumberSize = 1) =>
  enumItem(valueIndexEntries(names), { size, endianness: "little" });

//an option whose body keeps its space when absent, holding a default - Solana's fixed-size
//  account formats spell their options this way, with whichever tag width their encoding uses
const baseDefaultOptionLayout = <const L extends Layout>(layout: L, tagSize: NumberSize) => ({
  isSome: boolItem({ size: tagSize, endianness: "little" }),
  value:  { binary: "bytes", layout },
} as const);
type BaseDefaultOption<L extends Layout> =
  DeriveType<ReturnType<typeof baseDefaultOptionLayout<L>>>;

//annotated so declaration emit prints the alias rather than WithCustom's evaluated form
type _DefaultOptionItem<L extends Layout> =
  WithCustom<ReturnType<typeof baseDefaultOptionLayout<L>>, DeriveType<L> | undefined>;

const _defaultOptionItem = <const L extends Layout>(
  layout:       L,
  defaultValue: DeriveType<L>,
  tagSize:      NumberSize,
): _DefaultOptionItem<L> => withCustom(baseDefaultOptionLayout(layout, tagSize), {
  //annotated: inferred, this return emits the deferred DeriveType conditional fully evaluated
  //  (see discriminatedItem); the cast is sound - BaseDefaultOption<L>["value"] equals
  //  DeriveType<L> at every concrete L, but tsc can't reduce it at an open L
  to:   (obj: BaseDefaultOption<L>): DeriveType<L> | undefined =>
          obj.isSome ? obj.value as DeriveType<L> : undefined,
  from: (value: DeriveType<L> | undefined) =>
          ( value === undefined
            ? { isSome: false, value: defaultValue }
            : { isSome: true,  value               }
          ) as BaseDefaultOption<L>,
});

//an empty interface inheriting the impl's inferred shape: a nominal symbol that declaration
//  emit prints by name at every embedding, with none of the shape spelled out by hand -
//  see DeclarationEmit.md
export interface DefaultOptionItem<L extends Layout>
  extends ReturnType<typeof _defaultOptionItem<L>> {}

export const defaultOptionItem: <const L extends Layout>(
  layout:       L,
  defaultValue: DeriveType<L>,
  tagSize:      NumberSize,
) => DefaultOptionItem<L> = _defaultOptionItem;

//see https://docs.rs/solana-program-option/latest/solana_program_option/enum.COption.html -
//  `#[repr(C)]`, hence the 4-byte tag, and packed as zeros when absent
export const cOptionItem = <const L extends Layout>(layout: L): DefaultOptionItem<L> => {
  const size = calcStaticSize(layout);
  if (size === null)
    throw new Error("COption: the body must be of static size");

  return defaultOptionItem(layout, deserialize(layout, new Uint8Array(size)), 4);
};

export const cOptionAddressItem = cOptionItem(addressItem);

export const cOptionLamportsItem = <
  const KS extends KindWithAtomic | undefined = undefined,
>(...solKind: OptionalArg<KS>) =>
  cOptionItem(lamportsItem(...solKind));

export const mintAccountLayout = <
  const KT extends KindWithAtomic | undefined = undefined,
>(...tokenKind: OptionalArg<KT>) => ({
  mintAuthority:   cOptionAddressItem,
  supply:          svmAmountItem(...tokenKind),
  decimals:        { binary: "uint", size: 1 },
  isInitialized:   boolItem(),
  freezeAuthority: cOptionAddressItem,
} as const);

export type MintAccount<KT extends KindWithAtomic | undefined = undefined> =
  DeriveType<ReturnType<typeof mintAccountLayout<KT>>>;

//TODO implement support/layouts for token2022 mint extensions

export const initStates = ["Uninitialized", "Initialized"] as const;

export const tokenStates = [...initStates, "Frozen"] as const;

export const tokenAccountLayout = <
  const KT extends KindWithAtomic | undefined = undefined,
  const KS extends KindWithAtomic | undefined = undefined,
>(...kinds: OptionalArg<KT, OptionalArg<KS>>) => ({
  mint:            addressItem,
  owner:           addressItem,
  amount:          svmAmountItem(argOf(kinds)),
  delegate:        cOptionAddressItem,
  state:           cEnumItem(tokenStates),
  isNative:        cOptionLamportsItem(argOf(restOf(kinds))),
  delegatedAmount: svmAmountItem(argOf(kinds)),
  closeAuthority:  cOptionAddressItem,
} as const);

export type TokenAccount<
  KT extends KindWithAtomic | undefined = undefined,
  KS extends KindWithAtomic | undefined = undefined,
> = DeriveType<ReturnType<typeof tokenAccountLayout<KT, KS>>>;

//see https://github.com/solana-program/system/blob/main/clients/js/src/generated/accounts/nonce.ts
//Rust's state is `Uninitialized | Initialized(Data)`, but the account is allocated at the
//  initialized size either way, so the three data fields read as zeros while the state is
//  Uninitialized - as Kit's own decoder reads them
const nonceVersion = ["Legacy", "Current"] as const;
export const durableNonceAccountLayout = <
  const KS extends KindWithAtomic | undefined = undefined,
>(...solKind: OptionalArg<KS>) => ({
  version:              cEnumItem(nonceVersion, 4),
  state:                cEnumItem(initStates,   4),
  authority:            addressItem,
  blockhash:            hashItem,
  lamportsPerSignature: lamportsItem(...solKind),
} as const satisfies Struct);

export type DurableNonceAccount<KS extends KindWithAtomic | undefined = undefined> =
  DeriveType<ReturnType<typeof durableNonceAccountLayout<KS>>>;

//see https://github.com/solana-program/address-lookup-table/blob/main/program/src/state.rs#L64
const assumeInitializedAltItem = {
  binary: "uint", size: 4, endianness: "little", fixed: 1,
} as const satisfies Item;

//see https://github.com/solana-program/address-lookup-table/blob/main/program/src/state.rs#L20
export const addressLookupTableLayout = {
  _state:                     assumeInitializedAltItem,
  deactivationSlot:           u64Item,
  lastExtendedSlot:           u64Item,
  lastExtendedSlotStartIndex: { binary: "uint", size: 1 },
  //bincode's Option in the fixed-size header: a 1-byte tag
  authority:                  defaultOptionItem(addressItem, zeroAddress, 1),
  _alignmentPadding:          paddingItem(2),
  addresses:                  { binary: "array", layout: addressItem },
} as const satisfies Struct;

export type AddressLookupTable = DeriveType<typeof addressLookupTableLayout>;

//actual impl: https://github.com/anza-xyz/solana-sdk/blob/master/offchain-message/src/lib.rs#L162
//DO NOT TRUST THE OUTDATED PROPOSAL:
//  https://docs.solanalabs.com/proposals/off-chain-message-signing
//leading 0xff is a raw byte, not a codepoint — encoding the string via utf8 would yield 0xc3 0xbf
const signingDomain = Uint8Array.from([0xff, ...utf8.encode("solana offchain")]); //16 bytes
const messageFormats = ["RestrictedAscii", "LimitedUtf8", "ExtendedUtf8"] as const;
export type OffchainMessageFormat = (typeof messageFormats)[number];
const offchainMessageFrame = {
  signingDomain: { binary: "bytes", fixed: signingDomain },
  headerVersion: { binary: "uint", size: 1, fixed: 0 },
  messageFormat: enumItem(valueIndexEntries(messageFormats)),
  message:       { ...vecBytesItem(utf8Conversion),
                   size: { binary: "uint", size: 2, endianness: "little" } },
} as const;

type OffchainMessage = DeriveType<typeof offchainMessageFrame>;

//what the format admits, as the Rust decoder checks it: a message is never empty, the two
//  limited formats stop at what fits a ledger entry, RestrictedAscii is printable ASCII, and
//  ExtendedUtf8 stops where the two-byte length does, the frame's own 20 bytes deducted
const ledgerLimit = 1212;
const extendedLimit = 65535 - 20;
const checkOffchainMessage = (value: OffchainMessage): OffchainMessage => {
  const { messageFormat, message } = value;
  const size = utf8.encode(message).length;
  if (size === 0)
    throw new Error("offchain message must not be empty");

  const limit = messageFormat === "ExtendedUtf8" ? extendedLimit : ledgerLimit;
  if (size > limit)
    throw new Error(`${messageFormat} offchain message exceeds ${limit} bytes: ${size}`);

  if (messageFormat === "RestrictedAscii" && !/^[\x20-\x7e]*$/.test(message))
    throw new Error("RestrictedAscii offchain message must be printable ASCII");

  return value;
};

export const offchainMessageLayout =
  withCustom(offchainMessageFrame, { to: checkOffchainMessage, from: checkOffchainMessage });
