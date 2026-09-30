import type { Abi, AbiStateMutability, Address, Hex, PublicClient, ParseAbi,
              ContractFunctionName, ContractFunctionArgs, ContractFunctionReturnType } from "viem";
import { multicall3Abi, encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import type { RoUint8Array, RoArray, RoPair } from "@onrail-xyz/utils";
import { type MaybeArray, isArray,
         isUint8Array, throwOnNullish, hex, unixTime } from "@onrail-xyz/utils";
import type { Layout, DeriveType } from "@onrail-xyz/binary-layout";
import { serialize, deserialize } from "@onrail-xyz/binary-layout";
import type { SigNameOf } from "./layouting.js";
import { sigNameOf } from "./layouting.js";

// ---- ABI string type utilities ----
//signatures omit the `function` keyword: "balanceOf(address) view returns (uint256)"

//viem couldn't be bothered to think about the order of their type parameters and what their users
//  actually need, so we have to drag in AbiStateMutability when we don't care about it
type ViemResolve<A extends Abi, N extends ContractFunctionName<A>, T extends "params" | "return"> =
  T extends "params"
  ? ContractFunctionArgs<A, AbiStateMutability, N>
  : ContractFunctionReturnType<A, AbiStateMutability, N>;

type AbiResolve<S extends string, T extends "params" | "return"> =
  string extends S
  ? T extends "params"
    ? RoArray
    : unknown
  : ParseAbi<[`function ${S}`]> extends infer A extends Abi
  ? SigNameOf<S> extends infer N extends ContractFunctionName<A>
    ? ViemResolve<A, N, T>
    : never
  : never;

type AbiParameters<S extends string> = AbiResolve<S, "params">;

export type QueryAbiReturn<S extends string> = AbiResolve<S, "return">;

export type QueryAbiPair<S extends string = string> = RoPair<S, AbiParameters<S>>;

export type QueryLayoutTriple<CL extends Layout = Layout, RL extends Layout = Layout> =
  readonly [CL, DeriveType<CL>, RL];

export type QueryCallData = RoUint8Array | QueryLayoutTriple | QueryAbiPair;

// ---- QueryCall ----

export type QueryCall<D extends QueryCallData = QueryCallData> =
  { readonly to: Address; readonly data: D; readonly allowFailure?: boolean };

type _CheckCall<C> =
  C extends { data: infer D }
  ? D extends RoUint8Array
    ? RoUint8Array
    : D extends QueryLayoutTriple<infer CL extends Layout, infer RL extends Layout>
    ? QueryLayoutTriple<CL, RL>
    : D extends QueryAbiPair<infer S extends string>
    ? QueryAbiPair<S>
    : never
  : never;

type CheckCall<C> = Omit<C, "data"> & { data: _CheckCall<C> };

type CheckCalls<A> =
  A extends RoArray<QueryCall>
  ? { [K in keyof A]: CheckCall<A[K]> }
  : CheckCall<A>;

// ---- Result type mapping ----

type ResultOf<D> =
  D extends RoUint8Array                                       ? RoUint8Array      :
  D extends QueryLayoutTriple<Layout, infer RL extends Layout> ? DeriveType<RL>    :
  D extends QueryAbiPair<infer S extends string>               ? QueryAbiReturn<S> :
  never;

type WrappedResult<C extends QueryCall> =
  { success: true; data: ResultOf<C["data"]> } | { success: false; data: RoUint8Array };

type ByAllowFailure<F, C extends QueryCall> =
  F extends true ? WrappedResult<C> : ResultOf<C["data"]>; //intentional distribution

type CallResult<C> = C extends QueryCall ? ByAllowFailure<C["allowFailure"], C> : never;

export type QueryResult<A extends MaybeArray<QueryCall>> =
  A extends RoArray<QueryCall>
  ? { [K in keyof A]: CallResult<A[K]> }
  : CallResult<A>;

export type QueryResultWithMeta<A extends MaybeArray<QueryCall>> =
  [QueryResult<A>, bigint, RoUint8Array, Date];

// ---- Runtime encoding/decoding ----

const viemAbi = (sig: string) => ({
  abi:          parseAbi([`function ${sig}` as string]) as Abi,
  functionName: sigNameOf(sig),
} as const);

const encodeCallData = (data: QueryCallData): Hex =>
  !Array.isArray(data)
  ? hex.encode(data as RoUint8Array, true)
  : typeof data[0] === "string"
  ? encodeFunctionData({ ...viemAbi(data[0]), args: data[1] })
  : hex.encode(serialize(data[0], data[1]), true)

const decodeResult = (data: QueryCallData, returnData: Hex) =>
  !Array.isArray(data)
  ? hex.decode(returnData)
  : typeof data[0] === "string"
  ? decodeFunctionResult({ ...viemAbi(data[0]), data: returnData })
  : deserialize(data[2], hex.decode(returnData));

const processResult = (
  call: QueryCall,
  raw: ViemResolve<typeof multicall3Abi, "aggregate3", "return">[number],
) => {
  const { success, returnData } = raw;
  const data = success ? decodeResult(call.data, returnData) : hex.decode(returnData);

  if (!raw.success && !call.allowFailure)
    throw new Error(`Call to ${call.to} reverted: ${hex.encode(data as RoUint8Array, true)}`);

  return call.allowFailure ? { success, data } : data;
};

// ---- createQuery ----

//Multicall3's deterministic deployment puts it at the same address on nearly every chain, but a
//  few (zkSync and friends) deviate, hence the chain config takes precedence when it has an entry
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const multicall3Of = (viemClient: PublicClient) =>
  viemClient.chain?.contracts?.multicall3?.address ?? CANONICAL_MULTICALL3;

const encodeAggregate3 = (calls: RoArray<QueryCall>): Hex =>
  encodeFunctionData({
    abi:          multicall3Abi,
    functionName: "aggregate3",
    args:         [calls.map(c => ({
                    target:       c.to,
                    allowFailure: true,
                    callData:     encodeCallData(c.data),
                  }))],
  });

async function aggregate3(viemClient: PublicClient, callData: Hex, blockHash: Hex) {
  const returnData = await viemClient.request({
    method: "eth_call",
    params: [
      { to: multicall3Of(viemClient), data: callData },
      { blockHash, requireCanonical: true },
    ],
  });

  return decodeFunctionResult({
    abi:          multicall3Abi,
    functionName: "aggregate3",
    data:         returnData,
  });
}

const MAX_RETRIES = 3;

export type BlockSpec<S extends "hash" | "ref" = "hash" | "ref"> =
  S extends "hash"
  ? RoUint8Array
  : bigint | "latest" | "finalized";

//resolves a block tag or number to a canonical block hash, retrying whenever the batch does not
//  come back, which is what a reorged-out block looks like from here
async function resolveBlock(
  viemClient: PublicClient,
  callData:   Hex,
  block:      BlockSpec<"ref">,
) {
  const blockIdentifier = typeof block === "bigint" ? { blockNumber: block } : { blockTag: block };
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; ++attempt) {
    const blockInfo = await viemClient.getBlock(blockIdentifier);

    const blockHash = throwOnNullish(blockInfo.hash, "Block hash is null (pending block)");

    const results = await aggregate3(viemClient, callData, blockHash)
      .catch(error => { lastError = error; return undefined; });
    if (results === undefined)
      continue;

    return {
      results,
      blockInfo: {
        number:    blockInfo.number,
        hash:      hex.decode(blockHash),
        timestamp: unixTime.toDate(blockInfo.timestamp),
      },
    };
  }
  throw new Error(
    `Querying canonical block failed ${MAX_RETRIES} times in a row`,
    { cause: lastError },
  );
}

const _query = async (
  viemClient: PublicClient,
  callS:      MaybeArray<QueryCall>,
  block:      BlockSpec,
) => {
  const multi = isArray(callS);
  const calls = multi ? callS : [callS];
  //encoded before any block is resolved: a malformed argument is the caller's error, which the
  //  reorg retry must neither repeat nor report as a failed block
  const callData = encodeAggregate3(calls);

  return (isUint8Array(block)
    ? aggregate3(viemClient, callData, hex.encode(block, true))
    : resolveBlock(viemClient, callData, block)
  ).then(raw => {
    const [results,         blockInfo] = "results" in raw
        ? [raw.results, raw.blockInfo]
        : [raw,             undefined];

    const result = multi
      ? calls.map((c, i) => processResult(c, results[i]!))
      : processResult(calls[0]!, results[0]!);

    return blockInfo
      ? [result, blockInfo.number, blockInfo.hash, blockInfo.timestamp]
      : result;
  });
};

export type Query = ReturnType<typeof createQuery>;

export const createQuery = (viemClient: PublicClient) => {
  //query by blockhash -> only get actual result
  function query<const A extends MaybeArray<QueryCall>>(
    callS: A & CheckCalls<A>,
    block: BlockSpec<"hash">,
  ): Promise<QueryResult<A>>;
  //query by block ref -> get result + meta
  function query<const A extends MaybeArray<QueryCall>>(
    callS:  A & CheckCalls<A>,
    block?: BlockSpec<"ref">, //default = "latest"
  ): Promise<QueryResultWithMeta<A>>;
  //convenience overload to allow both
  function query<const A extends MaybeArray<QueryCall>>(
    callS: A & CheckCalls<A>,
    block: BlockSpec,
  ): Promise<QueryResult<A> | QueryResultWithMeta<A>>;
  //impl
  function query<const A extends MaybeArray<QueryCall>>(
    callS: A & CheckCalls<A>,
    block: BlockSpec = "latest",
  ) {
    return _query(viemClient, callS, block);
  }

  return query;
};
