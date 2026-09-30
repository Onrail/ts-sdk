import assert from "node:assert";
import type { Address, Lamports, KeyPairSigner, AddressesByLookupTableAddress } from "@solana/kit";
import { pipe, createTransactionMessage,
         setTransactionMessageFeePayer,
         appendTransactionMessageInstructions,
         compressTransactionMessageUsingAddressLookupTables } from "@solana/kit";
import type { RoArray, RoUint8Array,
              MaybeArray, MapArrayness, Opts, OptionalArg } from "@onrail-xyz/utils";
import { zip, mapTo, throwOnUndefined, argOf } from "@onrail-xyz/utils";
import { serialize, deserialize, calcStaticSize } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic, KindWithDecimalHumanAndAtomic } from "@onrail-xyz/amount";
import { Amount, getDecimals, sameKind } from "@onrail-xyz/amount";
import { type AmountOrAtomic, fromAtomicIfKind } from "@onrail-xyz/common";
import type { Ix, TokenAccount, LamportsType, TxMsgWithFeePayer } from "@onrail-xyz/svm";
import { base58,
         addressLookupTableLayout, tokenProgramId,
         nativeMint, findAta, mintAccountLayout,
         tokenAccountLayout, bindClient, systemProgramId } from "@onrail-xyz/svm";
import { ForkSvm, TransactionMetadata, FailedTransactionMetadata } from "./forkSvm.js";

export const assertTxSuccess = async (txResult: Promise<TransactionMetadata>) => {
  try {
    return await txResult;
  } catch (error) {
    if (error instanceof FailedTransactionMetadata)
      assert.fail(`tx should succeed but failed with error:\n${error.toString()}`);

    throw error;
  }
};

export const createCurried = <const KS extends KindWithAtomic | undefined = undefined>(
  forkSvm: ForkSvm,
  ...args: OptionalArg<KS>
) => {
  const [solKind] = args;
  const client = bindClient(forkSvm.createForkRpc(), ...args);
  const { minimumBalanceForRentExemption, addLifetimeAndSendTx } = client;
  const inLamports = (lamports: LamportsType<KS>) =>
    (solKind ? (lamports as Amount<KS & KindWithAtomic>).in("atomic") : lamports) as Lamports;

  const airdrop = (
    address:  Address,
    lamports: LamportsType<KS>,
  ) => forkSvm.airdrop(address, inLamports(lamports));

  //a fork answers for every address, so a balance it has no account for is zero
  const getBalance = <const A extends MaybeArray<Address>>(address: A) =>
    client.getBalance(address).then(
      b => mapTo(b)(v => v ?? fromAtomicIfKind(0n, ...args))
    ) as Promise<MapArrayness<A, LamportsType<KS>>>;

  const getTokenBalance =
    <const KT extends KindWithAtomic | undefined = undefined>(
      ...tokenKind: OptionalArg<KT>
    ) =>
      <const A extends MaybeArray<Address>>(tokenAccs: A) =>
        client.getTokenBalance(...tokenKind)(tokenAccs).then(
          b => mapTo(b)(v => v ?? fromAtomicIfKind(0n, ...tokenKind))
        ) as Promise<MapArrayness<A, AmountOrAtomic<KT>>>;

  const createAccount = (
    address:   Address,
    opts?:     Opts<{
                data:      RoUint8Array,
                programId: Address,
                lamports:  LamportsType<KS>,
              }>
   ) => {
    const {
      data      = new Uint8Array(),
      programId = systemProgramId,
      lamports  = minimumBalanceForRentExemption(data.length),
    } = opts ?? {};

    forkSvm.setAccount(address, {
      owner:      programId,
      executable: false,
      lamports:   inLamports(lamports),
      space:      BigInt(data.length),
      data,
    });
  };

  type MintOpts<KT extends KindWithAtomic | undefined = undefined> =
    Opts<{ mintAuthority: Address }> & (
      KT extends KindWithAtomic
      ?      { supply: Amount<KT>; decimals?: never  }
      : Opts<{ supply: bigint;     decimals:  number }>
    );

  const createMint = <const KT extends KindWithDecimalHumanAndAtomic | undefined = undefined>(
    address: Address,
    opts?:   MintOpts<KT>
  ) => {
    let { mintAuthority, supply, decimals } = opts ?? {};

    if (typeof supply === "undefined" || typeof supply === "bigint") {
      supply   ??= 0n;
      decimals ??= 9;
    }
    else {
      decimals = getDecimals(supply.kind);
      supply = supply.in("atomic");
    }

    createAccount(address, {
      data: serialize(mintAccountLayout(), {
        mintAuthority,
        supply,
        decimals,
        isInitialized:   true,
        freezeAuthority: undefined
      }),
      programId: tokenProgramId,
    });
  };

  //the native mint's balance is SOL, so it must be denominated in solKind when one is set
  type Balance<M extends Address, KT extends KindWithAtomic | undefined> =
    M extends typeof nativeMint ? AmountOrAtomic<KS> : AmountOrAtomic<KT>;

  const createTokenAccount = <
    const M extends Address,
    const KT extends KindWithAtomic | undefined = undefined,
  >(
    address: Address,
    mint:    M,
    owner:   Address,
    balance: Balance<M, KT>,
  ) => {
    const balanceKind = typeof balance === "bigint"
      ? undefined
      : (balance as Amount<KindWithAtomic>).kind;

    if (mint === nativeMint &&
        (solKind ? !balanceKind || !sameKind(balanceKind, solKind) : balanceKind !== undefined))
      throw new Error(
        `native mint balance must be ${solKind ? `an Amount of kind ${solKind.name}` : "Lamports"}`
      );

    const tokenAccountSize = calcStaticSize(tokenAccountLayout())!;
    const rentExempt = minimumBalanceForRentExemption(tokenAccountSize);
    //the guard above establishes that balance and rentExempt share solKind - untrackable by tsc
    const solBalance = (
      mint !== nativeMint
      ? rentExempt
      : solKind
      ? (rentExempt as Amount<KindWithAtomic>).add(balance as Amount<KindWithAtomic>)
      : (rentExempt as bigint) + (balance as bigint)
    ) as LamportsType<KS>;

    createAccount(address, {
      data: serialize(
        tokenAccountLayout(balanceKind as KT, argOf(args)), {
          mint,
          owner,
          amount:          balance,
          state:           "Initialized",
          isNative:        mint === nativeMint ? rentExempt : undefined,
          delegate:        undefined,
          delegatedAmount: fromAtomicIfKind(0n, balanceKind),
          closeAuthority:  undefined,
          //unknown-mediated: the kind-generic fields (amount, isNative, delegatedAmount) are
          //  unresolved conditionals under KT/KS, which defeats the structural-overlap check
        } as unknown as TokenAccount<KT, KS>
      ),
      programId: tokenProgramId,
      lamports: solBalance,
    });
  };

  const createAta = <
    const M extends Address,
    const KT extends KindWithAtomic | undefined = undefined,
  >(
    owner:   Address,
    mint:    M,
    balance: Balance<M, KT>
  ) => {
    const ata = findAta({ owner, mint });
    createTokenAccount(ata, mint, owner, balance);
    return ata;
  };

  const createTx = async (
    instructions: RoArray<Ix>,
    feePayer:     Address | KeyPairSigner,
    alts:         RoArray<Address> = [],
  ) => {
    const altDict =
      zip([alts, await forkSvm.getAccount(alts)])
      .reduce<AddressesByLookupTableAddress>((acc, [altAddr, altInfo]) => {
          acc[altAddr] = deserialize(
            addressLookupTableLayout,
            throwOnUndefined(altInfo?.data)
          ).addresses as Address[];
          return acc;
        },
        {}
      );

    const feePayerAddress = typeof feePayer === "string" ? feePayer : feePayer.address;

    return pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(feePayerAddress, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
      (tx) => compressTransactionMessageUsingAddressLookupTables(tx, altDict),
    );
  };

  const sendTx = async (
    tx:                TxMsgWithFeePayer,
    feePayer:          KeyPairSigner,
    additionalSigners: RoArray<KeyPairSigner> = [],
  ) => {
    const signature = await addLifetimeAndSendTx(tx, [feePayer, ...additionalSigners]);
    const txMetadata = forkSvm.getTransaction(base58.decode(signature));
    if (!txMetadata)
      throw new Error(`Transaction ${signature} not found`);

    if ("err" in txMetadata)
      throw new Error(`Transaction failed: ${txMetadata.toString()}`);

    return txMetadata;
  };

  const createAndSendTx = (
    instructions:      RoArray<Ix>,
    feePayer:          KeyPairSigner,
    additionalSigners: RoArray<KeyPairSigner> = [],
    alts:              RoArray<Address> = [],
  ) =>
    createTx(instructions, feePayer, alts).then(tx => sendTx(tx, feePayer, additionalSigners));

  return {
    ...client,
    getBalance,
    getTokenBalance,
    airdrop,
    createAccount,
    createMint,
    createTokenAccount,
    createAta,
    createTx,
    sendTx,
    createAndSendTx,
  };
};

