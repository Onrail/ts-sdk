import type { Address, Instruction,
              TransactionMessage, TransactionMessageWithFeePayer } from "@solana/kit";
import { AccountRole, pipe, createTransactionMessage, isOffCurveAddress,
         setTransactionMessageFeePayer, appendTransactionMessageInstructions } from "@solana/kit";
import type { RoArray, RoPair, RoUint8Array,
              MaybeArray, If, AnyExtend, OptionalArg } from "@onrail-xyz/utils";
import { isArray, bytes, utf8 } from "@onrail-xyz/utils";
import type { Layout, DeriveType } from "@onrail-xyz/binary-layout";
import { serialize } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { fromAtomicIfKind } from "@onrail-xyz/common";
import { base58 } from "./encoding.js";
import { sha256 } from "./hashing.js";
import type { LamportsType } from "./client.js";
import { associatedTokenProgramId, tokenProgramId,
         systemProgramId, emptyAccountSize, lamportsPerByte } from "./constants.js";

//since it's a very common SVM pattern to have a utf8 string as the first seed, we encode this
//  convention. To protect against an Address being accidentally encoded as utf8 (because
//  the @solana/kit Address type is just a branded string type), we enforce on the type level
//  that one can't pass an Address (or a union type that inclues an Address) as the first seed.
export type Seed<S = string> = RoUint8Array | S;
export type RefuseAddress<S extends Seed> = If<AnyExtend<S, Address>, never, S>;

export function findPdaAndBump<S extends Seed>(
  firstSeed: RefuseAddress<S>,
  ...args:   [...Seed<Address>[], programId: Address]
): [Address, number] {
  const programId = args.pop() as Address;
  const seedsBytes = bytifySeeds(firstSeed, args as RoArray<Seed<Address>>);
  for (let bump = 255; bump >= 0; --bump) {
    const candidate = toAddress(calcRawPda(seedsBytes, bump, programId));
    if (isOffCurveAddress(candidate))
      return [candidate, bump];
  }
  //P(reaching this) << P(cosmic ray mucking up the computation) - but Solana throws too
  throw new Error("Unable to find a viable bump seed");
}

export const findPda = <S extends Seed>(
  firstSeed: RefuseAddress<S>,
  ...args:   [...Seed<Address>[], programId: Address]
): Address =>
  findPdaAndBump(firstSeed, ...args)[0];

export const findAta = (addresses: {
  owner:         Address;
  mint:          Address;
  tokenProgram?: Address | undefined;
}): Address =>
  findPda(
    new Uint8Array(0), //no string seed - only address seeds
    addresses.owner,
    addresses.tokenProgram ?? tokenProgramId,
    addresses.mint,
    associatedTokenProgramId
  );

export function calcPda<S extends Seed>(
  firstSeed: RefuseAddress<S>,
  ...args:   [...Seed<Address>[], bump: number, programId: Address]
): Address {
  const additionalSeeds = args.slice(0, -2) as RoArray<Seed<Address>>;
  const [bump, programId] = args.slice(-2) as [number, Address];
  if (!Number.isInteger(bump) || bump < 0 || bump > 255)
    throw new Error(`bump must be an integer in [0, 255], got ${bump}`);

  const address = toAddress(calcRawPda(bytifySeeds(firstSeed, additionalSeeds), bump, programId));
  //a PDA is off-curve by definition; a bump that lands on the curve is a wrong bump, and the
  //  one check this costs is nothing next to the search calcPda exists to skip
  if (!isOffCurveAddress(address))
    throw new Error(`bump ${bump} does not yield an off-curve address for these seeds`);

  return address;
}

export const isOffCurve = (rawAddress: RoUint8Array) =>
  isOffCurveAddress(toAddress(rawAddress));

//limits enforced by the Solana runtime
const maxSeedLength = 32;
const maxUserSeeds = 15;

const bytifySeeds = (firstSeed: Seed, additionalSeeds: RoArray<Seed<Address>>) => {
  const seeds = [
    typeof firstSeed === "string" ? utf8.encode(firstSeed) : firstSeed as RoUint8Array,
    ...additionalSeeds.map(seed => typeof seed === "string" ? base58.decode(seed) : seed),
  ];

  for (const seed of seeds)
    if (seed.length > maxSeedLength)
      throw new Error(`Seed exceeds maximum length of ${maxSeedLength} bytes: ${seed.length}`);

  if (seeds.length > maxUserSeeds)
    throw new Error(`Seed count exceeds maximum of ${maxUserSeeds}`);

  return bytes.concat(...seeds) as RoUint8Array;
};

const pdaStrConst = utf8.encode("ProgramDerivedAddress");
const calcRawPda = (seedsBytes: RoUint8Array, bump: number, programId: Address) =>
  sha256(bytes.concat(
    seedsBytes,
    new Uint8Array([bump]),
    base58.decode(programId),
    pdaStrConst,
  ));

const toAddress = (rawAddress: RoUint8Array): Address =>
  base58.encode(rawAddress) as Address;

// ----

const discriminatorTypeConverter = {
  instruction: "global",
  account:     "account",
  event:       "event",
  anchor:      "anchor",
} as const;
export type DiscriminatorType = keyof typeof discriminatorTypeConverter;

export const discriminatorLength = 8;
export const discriminatorOf = (type: DiscriminatorType, name: string) =>
  sha256(utf8.encode(`${discriminatorTypeConverter[type]}:${name}`))
    .subarray(0, discriminatorLength);

//see here: https://github.com/solana-foundation/anchor/blob/master/lang/src/event.rs
//Why they chose to use little endian here, when all other discriminators are big endian is
//  entirely beyond me.
export const anchorEmitCpiDiscriminator = discriminatorOf("anchor", "event").reverse();

// ----

//the standard rent parameters, unchanged since genesis: 3480 lamports per byte-year, exemption
//  at two years, 128 bytes of per-account overhead. A cluster with other parameters wants the
//  RPC's getMinimumBalanceForRentExemption instead
export const minimumBalanceForRentExemption = <
  const KS extends KindWithAtomic | undefined = undefined,
>(size: number, ...solKind: OptionalArg<KS>): LamportsType<KS> => {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`account size must be a non-negative integer, got ${size}`);

  return fromAtomicIfKind(BigInt(emptyAccountSize + size) * lamportsPerByte, ...solKind) as any;
};

// ----

export type Ix = Required<Instruction>;
export const composeIx = <const L extends Layout>(
  addrRoles:      RoArray<RoPair<Address, AccountRole>>,
  layout:         L,
  params:         DeriveType<L>,
  programAddress: Address,
) => ({
  accounts: addrRoles.map(([address, role]) => ({ address, role })),
  data: serialize(layout, params),
  programAddress,
} as const satisfies Ix);

export const feePayerTxFromIxs = (
  ixs:     MaybeArray<Ix>,
  payer:   Address,
  version: "legacy" | 0 = "legacy",
): TransactionMessage & TransactionMessageWithFeePayer =>
  pipe(
    createTransactionMessage({ version }),
    tx => setTransactionMessageFeePayer(payer, tx),
    tx => appendTransactionMessageInstructions(isArray(ixs) ? ixs : [ixs], tx),
  );

export function composeCreateAtaIx(
  addresses:  { payer:         Address;
                owner:         Address;
                mint:          Address;
                tokenProgram?: Address | undefined;
              },
  idempotent: boolean = true,
): Ix {
  const ata = findAta(addresses);
  const tokenProgram = addresses.tokenProgram ?? tokenProgramId;

  const accounts = [
    [addresses.payer, AccountRole.WRITABLE_SIGNER],
    [ata,             AccountRole.WRITABLE       ],
    [addresses.owner, AccountRole.READONLY       ],
    [addresses.mint,  AccountRole.READONLY       ],
    [systemProgramId, AccountRole.READONLY       ],
    [tokenProgram,    AccountRole.READONLY       ],
  ] as const;

  return composeIx(
    accounts,
    { binary: "uint", size: 1 }, //see https://docs.rs/spl-associated-token-account-interface/latest/spl_associated_token_account_interface/instruction/enum.AssociatedTokenAccountInstruction.html
    idempotent ? 1 : 0,
    associatedTokenProgramId,
  );
}
