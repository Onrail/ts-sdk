import type { Address, Signature, Base64EncodedWireTransaction,
              KeyPairSigner, Base64EncodedDataResponse, Lamports,
              TransactionMessage, TransactionMessageWithFeePayer,
              TransactionWithLifetime, Blockhash } from "@solana/kit";
import { createSolanaRpc, setTransactionMessageLifetimeUsingBlockhash,
         signTransaction, getBase64EncodedWireTransaction, compileTransaction } from "@solana/kit";
import type { RoArray, MaybeArray, MapArrayness, OptionalArg } from "@onrail-xyz/utils";
import { isArray, mapTo, base64, argOf } from "@onrail-xyz/utils";
import type { Layout, DeriveType } from "@onrail-xyz/binary-layout";
import { deserialize } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import type { AmountOr, AmountOrAtomic } from "@onrail-xyz/common";
import { fromAtomicIfKind } from "@onrail-xyz/common";
import type { MintAccount, TokenAccount,
              DurableNonceAccount, AddressLookupTable } from "./layouting.js";
import { mintAccountLayout, tokenAccountLayout,
         durableNonceAccountLayout, addressLookupTableLayout } from "./layouting.js";
import { minimumBalanceForRentExemption } from "./utils.js";
import { systemProgramId, tokenProgramId,
         token2022ProgramId, addressLookupTableProgramId } from "./constants.js";

export type Client = ReturnType<typeof createSolanaRpc>;
export type TxMsg = TransactionMessage;
export type TxMsgWithFeePayer = TransactionMessage & TransactionMessageWithFeePayer;
export type SignableTx = ReturnType<typeof compileTransaction>;
export type TxWithLifetime = Parameters<typeof compileTransaction>[0] & TransactionWithLifetime;

export type LamportsType<KS extends KindWithAtomic | undefined> = AmountOr<KS, Lamports>;

export type AccountInfo<KS extends KindWithAtomic | undefined = undefined> = {
  executable: boolean;
  owner:      Address;
  lamports:   LamportsType<KS>;
  space:      bigint;
  data:       Uint8Array;
};

export type BlockHashInfo = {
  blockhash:            Blockhash;
  lastValidBlockHeight: bigint;
};

type RpcAccountInfo = Readonly<{
  executable: boolean;
  lamports:   Lamports;
  owner:      Address;
  space:      bigint;
  data:       Base64EncodedDataResponse;
}> | null;

const toAccountInfo = <
  const KS extends KindWithAtomic | undefined = undefined,
>(accInfo: RpcAccountInfo, ...solKind: OptionalArg<KS>): AccountInfo<KS> | undefined =>
  accInfo
  ? { ...accInfo,
      data: base64.decode(accInfo.data[0]),
      lamports: fromAtomicIfKind(accInfo.lamports, ...solKind) as LamportsType<KS>,
    }
  : undefined;

const encb64 = { encoding: "base64" } as const;
const encb64NoData = { ...encb64, dataSlice: { offset: 0, length: 0 } } as const;

export const sendTransaction =
  (client: Client, wireTx: Base64EncodedWireTransaction): Promise<Signature> =>
    client.sendTransaction(wireTx, encb64).send();

export const getAccountInfo = <
  const A  extends MaybeArray<Address>,
  const KS extends KindWithAtomic | undefined = undefined
>(client:     Client,
  addressEs:  A,
  ...solKind: OptionalArg<KS>
): Promise<MapArrayness<A, AccountInfo<KS> | undefined>> =>
  (isArray(addressEs)
    ? client.getMultipleAccounts(addressEs, encb64)
    : client.getAccountInfo(addressEs, encb64)
  ).send().then(res => mapTo(res.value)(accInfo => toAccountInfo(accInfo, ...solKind))) as any;

export const getBalance = <
  const A  extends MaybeArray<Address>,
  const KS extends KindWithAtomic | undefined = undefined
>(client:     Client,
  addressEs:  A,
  ...solKind: OptionalArg<KS>
): Promise<MapArrayness<A, LamportsType<KS> | undefined>> =>
  (isArray(addressEs)
    ? client.getMultipleAccounts(addressEs, encb64NoData)
    : client.getAccountInfo(addressEs, encb64NoData)
  ).send().then(res => mapTo(res.value)(accInfo =>
    accInfo ? fromAtomicIfKind(accInfo.lamports, ...solKind) : undefined
  )) as any;

export const getDeserializedAccount = <
  const A extends MaybeArray<Address>,
  const L extends Layout,
>(client:    Client,
  addressEs: A,
  layout:    L,
): Promise<MapArrayness<A, DeriveType<L> | undefined>> =>
  getAccountInfo(client, addressEs).then(res => mapTo(res)(accInfo =>
    accInfo !== undefined ? deserialize(layout, accInfo.data) : undefined
  )) as any;

const getOwnedAccount = <
  const A extends MaybeArray<Address>,
  const L extends Layout,
>(client:    Client,
  addressEs: A,
  layout:    L,
  owners:    RoArray<Address>,
): Promise<MapArrayness<A, DeriveType<L> | undefined>> =>
  getAccountInfo(client, addressEs).then(res => mapTo(res)(accInfo => {
    if (accInfo === undefined)
      return undefined;

    if (!owners.includes(accInfo.owner))
      throw new Error(`account is owned by ${accInfo.owner}, expected ${owners.join(" or ")}`);

    return deserialize(layout, accInfo.data);
  })) as any;

const tokenPrograms = [tokenProgramId, token2022ProgramId];

export const getMint = <
  const KT extends KindWithAtomic | undefined = undefined,
>(client:       Client,
  mintAddress:  Address,
  ...tokenKind: OptionalArg<KT>
): Promise<MintAccount<KT> | undefined> =>
  getOwnedAccount(client, mintAddress, mintAccountLayout(...tokenKind), tokenPrograms);

export const getTokenAccount = <
  const A  extends MaybeArray<Address>,
  const KT extends KindWithAtomic | undefined = undefined,
  const KS extends KindWithAtomic | undefined = undefined,
>(client:    Client,
  tokenAccs: A,
  ...kinds:  OptionalArg<KT, OptionalArg<KS>>
): Promise<MapArrayness<A, TokenAccount<KT, KS> | undefined>> =>
  getOwnedAccount(client, tokenAccs, tokenAccountLayout(...kinds), tokenPrograms);

export const getTokenBalance = <
  const A  extends MaybeArray<Address>,
  const KT extends KindWithAtomic | undefined = undefined,
>(client:       Client,
  tokenAccs:    A,
  ...tokenKind: OptionalArg<KT>
): Promise<MapArrayness<A, AmountOrAtomic<KT> | undefined>> =>
  getOwnedAccount(client, tokenAccs, tokenAccountLayout(...tokenKind), tokenPrograms)
    .then(res => mapTo(res)(maybeToken =>
      (maybeToken as { amount: AmountOrAtomic<KT> } | undefined)?.amount,
    )) as any;

export const getDurableNonceAccount = <
  const A  extends MaybeArray<Address>,
  const KS extends KindWithAtomic | undefined = undefined,
>(client:    Client,
  addressEs: A,
  ...kind:   OptionalArg<KS>
): Promise<MapArrayness<A, DurableNonceAccount<KS> | undefined>> =>
  getOwnedAccount(client, addressEs, durableNonceAccountLayout(...kind), [systemProgramId]);

export const getAddressLookupTable = <
  const A extends MaybeArray<Address>,
>(client:    Client,
  addressEs: A,
): Promise<MapArrayness<A, AddressLookupTable | undefined>> =>
  getOwnedAccount(client, addressEs, addressLookupTableLayout, [addressLookupTableProgramId]);

export const getLatestBlockhash = (
  client: Client,
): Promise<BlockHashInfo> =>
  client.getLatestBlockhash().send().then(res => res.value);

export const addLifetimeAndSendTx = (
  client:  Client,
  tx:      TxMsgWithFeePayer,
  signers: RoArray<KeyPairSigner>,
): Promise<Signature> =>
  getLatestBlockhash(client)
    .then(blockhash => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx))
    .then(txWithLifetime => sendTx(client, txWithLifetime, signers));

export const sendTx = (
  client:  Client,
  tx:      TxWithLifetime,
  signers: RoArray<KeyPairSigner>,
): Promise<Signature> =>
  signTransaction(signers.map(kp => kp.keyPair), compileTransaction(tx)).then(
    signedTx => client.sendTransaction(getBase64EncodedWireTransaction(signedTx), encb64).send()
  );

// ---- client-bound toolkit ----

export type AccountGetter<T> =
  <const A extends MaybeArray<Address>>(addressEs: A) => Promise<MapArrayness<A, T | undefined>>;

//a member whose return instantiates a DeriveType-backed account alias at the open KS gets a
//  function-type alias of its own: the interface names it only while BoundClient itself is the
//  type, and a toolkit spreading it into an inferred object literal (fork-svm's createCurried)
//  holds the member's type alone, which inferred evaluates partway and prints expanded
export type GetTokenAccount<KS extends KindWithAtomic | undefined> =
  <const KT extends KindWithAtomic | undefined = undefined>(...tokenKind: OptionalArg<KT>) =>
    AccountGetter<TokenAccount<KT, KS>>;
export type GetDurableNonceAccount<KS extends KindWithAtomic | undefined> =
  AccountGetter<DurableNonceAccount<KS>>;

//the functions above with the client bound, and the SOL kind wherever one applies. A kind that
//  varies by account (a token's) or a layout is taken first, so the getter it yields can be kept.
//The interface is what names the members in declarations; inferred, the DeriveType-backed
//  returns print as the expanded machinery
export interface BoundClient<KS extends KindWithAtomic | undefined = undefined> {
  getAccountInfo: AccountGetter<AccountInfo<KS>>;
  getBalance: AccountGetter<LamportsType<KS>>;
  getDeserializedAccount: <const L extends Layout>(layout: L) => AccountGetter<DeriveType<L>>;
  getMint: <const KT extends KindWithAtomic | undefined = undefined>(
    ...tokenKind: OptionalArg<KT>
  ) => (mintAddress: Address) => Promise<MintAccount<KT> | undefined>;
  getTokenAccount: GetTokenAccount<KS>;
  getTokenBalance: <const KT extends KindWithAtomic | undefined = undefined>(
    ...tokenKind: OptionalArg<KT>
  ) => AccountGetter<AmountOrAtomic<KT>>;
  getDurableNonceAccount: GetDurableNonceAccount<KS>;
  getAddressLookupTable: AccountGetter<AddressLookupTable>;
  getLatestBlockhash: () => Promise<BlockHashInfo>;
  minimumBalanceForRentExemption: (size: number) => LamportsType<KS>;
  addLifetimeAndSendTx: (tx: TxMsgWithFeePayer, signers: RoArray<KeyPairSigner>) =>
    Promise<Signature>;
  sendTx: (tx: TxWithLifetime, signers: RoArray<KeyPairSigner>) => Promise<Signature>;
  sendTransaction: (wireTx: Base64EncodedWireTransaction) => Promise<Signature>;
}

export const bindClient = <
  const KS extends KindWithAtomic | undefined = undefined,
>(client: Client, ...solKind: OptionalArg<KS>): BoundClient<KS> => ({
  getAccountInfo:
                 addressEs     => getAccountInfo(client, addressEs, ...solKind),
  getBalance:
                 addressEs     => getBalance(client, addressEs, ...solKind),
  getDeserializedAccount:
    layout    => addressEs     => getDeserializedAccount(client, addressEs, layout),
  getMint:
    (...kind) => mintAddress   => getMint(client, mintAddress, ...kind),
  getTokenAccount:
    (...kind) => tokenAccs     => getTokenAccount(client, tokenAccs, argOf(kind), argOf(solKind)),
  getTokenBalance:
    (...kind) => tokenAccs     => getTokenBalance(client, tokenAccs, ...kind),
  getDurableNonceAccount:
                 addressEs     => getDurableNonceAccount(client, addressEs, ...solKind),
  getAddressLookupTable:
                 addressEs     => getAddressLookupTable(client, addressEs),
  getLatestBlockhash:
                 ()            => getLatestBlockhash(client),
  minimumBalanceForRentExemption:
                 size          => minimumBalanceForRentExemption(size, ...solKind),
  addLifetimeAndSendTx:
                 (tx, signers) => addLifetimeAndSendTx(client, tx, signers),
  sendTx:
                 (tx, signers) => sendTx(client, tx, signers),
  sendTransaction:
                 wireTx        => sendTransaction(client, wireTx),
});
