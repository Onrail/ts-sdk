import type { Address, Hex } from "viem";
import type { RoUint8Array, RoArray, StrRecord, Simplify, DeepRo } from "@onrail-xyz/utils";
import { bytes, hex, utf8 } from "@onrail-xyz/utils";
import type { Layout, Item, DeriveType } from "@onrail-xyz/binary-layout";
import { serialize } from "@onrail-xyz/binary-layout";
import { hashItem } from "@onrail-xyz/common";
import { keccak256 } from "./hashing.js";
import type { BytesNItem } from "./layouting.js";
import { wordSize, abiAddressItem, abiBoolItem, uint256Item, bytesNItem } from "./layouting.js";

// ---- EIP-712 Types ----

export type Eip712Field = { readonly name: string; readonly type: string };

//the value a field of the given Solidity type takes in a composed message; struct-typed fields
//  would need the whole `types` record to resolve and are not covered. A type known only as
//  `string` takes any of them, so the message of an unknown field list is a record of values
type Eip712Value<T extends string> =
  string extends T
  ? Address | boolean | bigint | RoUint8Array | string
  : T extends "address"
  ? Address
  : T extends "bool"
  ? boolean
  : T extends `uint${number}` | `int${number}`
  ? bigint
  : T extends `bytes${number}` | "bytes"
  ? RoUint8Array
  : T extends "string"
  ? string
  : never;

//the message a struct's field list describes, so a struct is spelled once; the bare spelling
//  is the message of some field list, which every derived message is assignable to
export type Eip712Message<F extends RoArray<Eip712Field> = RoArray<Eip712Field>> =
  { readonly [E in F[number] as E["name"]]: Eip712Value<E["type"]> };

const domainSeparatorFields = [
  { name: "name",              type: "string"  },
  { name: "version",           type: "string"  },
  { name: "chainId",           type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt",              type: "bytes32" },
] as const;
type DomainSeparatorField = typeof domainSeparatorFields[number];
type DomainSeparatorFieldName = DomainSeparatorField["name"];

//every field is optional: a domain uses whichever subset it declares
export type Eip712Domain = Partial<Eip712Message<typeof domainSeparatorFields>>;

export type Eip712Data<Message = StrRecord> = {
  readonly types:       StrRecord<RoArray<Eip712Field>>;
  readonly primaryType: string;
  readonly domain:      Eip712Domain;
  readonly message:     DeepRo<Message>;
};

export type ViemTypedData<T> =
  T extends RoUint8Array
  ? Hex
  : T extends object
  ? { readonly [K in keyof T]: ViemTypedData<T[K]> }
  : T;

//viem spells bytes values as hex where this package speaks bytes: every bytes leaf of domain and
//  message is converted so that consumers hand the result straight to signTypedData/hashTypedData
export const toViemTypedData = <T>(value: T): ViemTypedData<T> => (
  value instanceof Uint8Array
  ? hex.encode(value, true)
  : Array.isArray(value)
  ? value.map(toViemTypedData)
  : typeof value === "object" && value !== null
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toViemTypedData(v)]))
  : value
) as ViemTypedData<T>;

// ---- encodeData ----
// A struct's encodeData puts each atomic field on a word, in field order, so a layout spelled
//   from the field list serializes a message to exactly those bytes and reads one back - which
//   is how a message is derived from data that already has a word-per-field layout. A dynamic
//   (`bytes`, `string`), array or struct-typed field takes a word too, but holding a hash this
//   layout does not compute, so such a field is rejected. Values ride at word width: a `uint8`
//   field's range is its composer's to keep.

const int256Item = { binary: "int", size: wordSize } as const;

type WordItem<T extends string> =
  T extends "bool"
  ? typeof abiBoolItem
  : T extends "address"
  ? typeof abiAddressItem
  : T extends `uint${number}`
  ? typeof uint256Item
  : T extends `int${number}`
  ? typeof int256Item
  : T extends `bytes${infer N extends number}`
  ? BytesNItem<N>
  : never;

const wordItem = (type: string): Item => {
  if (type === "bool")
    return abiBoolItem;
  if (type === "address")
    return abiAddressItem;
  if (/^uint\d+$/.test(type))
    return uint256Item;
  if (/^int\d+$/.test(type))
    return int256Item;

  const bytesN = /^bytes(\d+)$/.exec(type);
  if (bytesN !== null)
    return bytesNItem(Number(bytesN[1]));

  throw new Error(`EIP-712 type '${type}' has no encodeData word - only atomic types are encoded`);
};

export type Eip712EncodeDataLayout<F extends RoArray<Eip712Field>> =
  { readonly [E in F[number] as E["name"]]: WordItem<E["type"]> };

export const eip712EncodeDataLayout =
  <const F extends RoArray<Eip712Field>>(fields: F): Eip712EncodeDataLayout<F> =>
    Object.fromEntries(fields.map(f => [f.name, wordItem(f.type)])) as Eip712EncodeDataLayout<F>;

// ---- Domain Separator ----

//the domain's type as viem derives it - the fields present, in the standard's order - so a message
//  composed with it hashes identically on both sides
export const eip712DomainType = (domain: Eip712Domain) =>
  domainSeparatorFields.filter(f => domain[f.name] !== undefined);

const associatedLayoutItem = {
  name:              hashItem,
  version:           hashItem,
  chainId:           { binary: "uint", size: wordSize },
  verifyingContract: abiAddressItem,
  salt:              hashItem,
} as const satisfies Record<DomainSeparatorFieldName, Layout>;

const hashString = (s: string) => keccak256(utf8.encode(s));

const typeString = (fields: RoArray<DomainSeparatorFieldName>) =>
  "EIP712Domain("
  + domainSeparatorFields //enforces correct order (iterating over fields would not)
    .filter(dsf => fields.includes(dsf.name))
    .map(dsf => `${dsf.type} ${dsf.name}`)
    .join(",")
  + ")";

const typeHash = (fields: RoArray<DomainSeparatorFieldName>) => hashString(typeString(fields));

const typeHashItem = (fields: RoArray<DomainSeparatorFieldName>) =>
  ({ binary: "bytes", fixed: typeHash(fields) } as const);

//record key order is wire order, so keys are inserted in domainSeparatorFields order; the
//  type is orderless either way (record types carry no key order)
type SeparatorLayout<F extends DomainSeparatorFieldName> = Simplify<
  { readonly typeHash: ReturnType<typeof typeHashItem> } &
  { readonly [K in F]: typeof associatedLayoutItem[K] }
>;

const separatorLayout =
  <const F extends RoArray<DomainSeparatorFieldName>>(fields: F): SeparatorLayout<F[number]> => ({
    typeHash: typeHashItem(fields),
    ...Object.fromEntries(
      domainSeparatorFields //enforces correct order (iterating over fields would not)
        .filter(dsf => fields.includes(dsf.name))
        .map(dsf => [dsf.name, associatedLayoutItem[dsf.name]]),
    ),
  } as any);

const matchesHash =
  <const L extends Layout>(layout: L, candidate: DeriveType<L>, expected: RoUint8Array) =>
    bytes.equals(keccak256(serialize(layout, candidate)), expected);

// ---- Domain Resolution ----

// Reconstructs the domain of tokens that only expose DOMAIN_SEPARATOR() by brute-forcing the
// version field against the on-chain hash. Covers the { name, chainId, verifyingContract } domain
// with an optional version, i.e. everything that follows EIP-2612's reference implementation.

const typicalDomainFields = ["name", "chainId", "verifyingContract"] as const;
const unversionedLayout   = separatorLayout(typicalDomainFields);
const versionedLayout     = separatorLayout([...typicalDomainFields, "version"]);

const guessDomainSeparatorVersion = (
  known:           DeriveType<typeof unversionedLayout>,
  domainSeparator: RoUint8Array,
  guesses:         RoArray<string>,
) => {
  for (const version of guesses)
    if (matchesHash(versionedLayout, { ...known, version: hashString(version) }, domainSeparator))
      return version;

  throw new Error("Could not determine domain separator version");
};

//reconstructs the EIP-712 domain from on-chain data, guesses the version if needed
export const guessEip712Domain = (
  name:              string,
  verifyingContract: Address,
  chainId:           bigint,
  domainSeparator:   RoUint8Array,
  versionGuesses:    RoArray<string> = ["1", "2", "0"],
) => {
  const known = { name: hashString(name), chainId, verifyingContract } as const;
  return {
    name,
    ...(matchesHash(unversionedLayout, known, domainSeparator)
      ? {}
      : { version: guessDomainSeparatorVersion(known, domainSeparator, versionGuesses) }
    ),
    chainId,
    verifyingContract,
  } as const;
};
