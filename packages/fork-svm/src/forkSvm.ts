import type { Address, Transaction, RpcApi, RpcTransport,
              RpcPlan, Signature, Base64EncodedWireTransaction } from "@solana/kit";
import { DEFAULT_RPC_CONFIG, createSolanaRpc,
         createRpc, createSolanaRpcApi, getTransactionDecoder } from "@solana/kit";
import { isJsonRpcPayload } from "@solana/rpc-spec";
import type { RoArray, RoUint8Array, MaybeArray, Function } from "@onrail-xyz/utils";
import { zip, mapTo, isArray, chunk, throwOnUndefined, base64, unixTime } from "@onrail-xyz/utils";
import { deserialize } from "@onrail-xyz/binary-layout";
import { base58, addressItem, addressLookupTableLayout,
         rpcMaxMultipleAccounts, bpfLoaderUpgradeableProgramId,
         addressSize, signatureSize, maxTxSize } from "@onrail-xyz/svm";
import type { AccountInfo, RoAccountInfo } from "./liteSvm.js";
import { LiteSVM, TransactionMetadata, FailedTransactionMetadata } from "./liteSvm.js";
import { transactionErrorToRpc } from "./rpcErrors.js";
import { builtInSet, sysvarSet, defProgSet,
         kitAccountToLiteSvmAccount,
         liteSvmAccountToKitAccount,
         emptyAccountInfo, decodeCompiledTransactionMessage } from "./details.js";

//the closure of what ForkSvm hands back: the two results, what reading a successful one yields, and
//  the error taxonomy a failed one carries - all reachable from its own surface, so all nameable
//  without reaching into `liteSvm`. The two error tiers follow the order of the unions `err()`
//  declares, outer before inner.
export { TransactionMetadata, FailedTransactionMetadata,
         InnerInstruction, CompiledInstruction, TransactionReturnData,
         TransactionErrorFieldless, TransactionErrorInstructionError,
         TransactionErrorDuplicateInstruction, TransactionErrorInsufficientFundsForRent,
         TransactionErrorProgramExecutionTemporarilyRestricted,
         InstructionErrorFieldless, InstructionErrorCustom,
         InstructionErrorBorshIo, type InstructionErrorBorshIO } from "./liteSvm.js";

//the account shape ForkSvm stores and hands back, in Snapshot and setAccount
export type { AccountInfo, RoAccountInfo } from "./liteSvm.js";

type Rpc = ReturnType<typeof createSolanaRpc>;

export type Clock = {
  timestamp:           Date;
  slot:                bigint;
  epoch:               bigint;
  epochStartTimestamp: bigint;
  leaderScheduleEpoch: bigint;
};

export type Snapshot = {
  accounts:    Record<Address, AccountInfo | null>;
  clock:       Clock;
  blockhash:   string;
  expirations: number;
};

//the slot and time a transaction executed at, recorded when it was sent: the VM keeps the
//  history but not the clock it ran under, and the current clock is no substitute
type SentAt = { slot: bigint; blockTime: number };

//a fork's blockhash expires when `expireBlockhash` is called, never by height, so the lifetime
//  the adapter reports is the largest one a u64 can spell
const neverByHeight = 2n ** 64n - 1n;

//an upgradeable program's bytecode lives in a separate program data account, whose address the
//  program account holds after its 4-byte state tag
const programDataAddressOf = (acc: RoAccountInfo | null): Address | undefined =>
  acc?.executable && acc.owner === bpfLoaderUpgradeableProgramId
  ? deserialize(addressItem, acc.data.subarray(4, 4 + addressSize))
  : undefined;

//what LiteSVM's standard environment brings along - never fetched upstream, never snapshotted -
//  the program data accounts of its upgradeable programs included
const specialAddressesOf = (liteSvm: LiteSVM): Set<Address> => {
  const programIds = builtInSet.union(sysvarSet).union(defProgSet);
  const programData = [...programIds]
    .map(id => programDataAddressOf(liteSvm.getAccount(id)))
    .filter(addr => addr !== undefined);
  return programIds.union(new Set(programData));
};
let specialAddresses: Set<Address> | undefined;

export class ForkSvm {
  private rpc: Rpc | undefined;
  private liteSvm: LiteSVM;
  private known: Set<Address>;
  private expirations: number;
  private sent: Map<string, SentAt>;

  constructor(url?: string) {
    this.rpc         = url !== undefined ? createSolanaRpc(url) : undefined;
    this.liteSvm     = new LiteSVM();
    this.known       = new Set();
    this.expirations = 0;
    this.sent        = new Map();
    specialAddresses ??= specialAddressesOf(this.liteSvm);
  }

  static load(snapshot: Snapshot, url?: string) {
    const forkSvm = new ForkSvm(url);
    forkSvm.load(snapshot);
    return forkSvm;
  }

  save(): Snapshot {
    const accounts = Object.fromEntries(
      [...this.known.keys()].map(addr => [addr, this.liteSvm.getAccount(addr)])
    );
    return {
      accounts,
      clock:       this.getClock(),
      blockhash:   this.liteSvm.latestBlockhash(),
      expirations: this.expirations,
    };
  }

  //a fresh VM rather than a reset of the current one: LiteSVM's surface has no way to clear the
  //  transaction history or to set a blockhash, but it derives each blockhash from its
  //  predecessor starting from a fixed genesis hash, so the saved one is reached by expiring
  //  the fresh VM's blockhash the recorded number of times. The replacement is built in full
  //  before anything is committed: a snapshot that fails to restore leaves the instance as it was
  load(snapshot: Snapshot) {
    const liteSvm = new LiteSVM();
    for (let i = 0; i < snapshot.expirations; ++i)
      liteSvm.expireBlockhash();

    if (liteSvm.latestBlockhash() !== snapshot.blockhash)
      throw new Error(
        `snapshot blockhash ${snapshot.blockhash} is not where ${snapshot.expirations} ` +
        `expirations from LiteSVM's genesis lead (a different native version?)`
      );

    const known = new Set<Address>();
    const write = (addr: Address, acc: AccountInfo | null) => {
      liteSvm.setAccount(addr, acc ?? emptyAccountInfo);
      known.add(addr);
    };

    //executables are restored last so that the program data accounts they are loaded from
    //  (which are not themselves executable) are already in place
    const executables = [] as [Address, AccountInfo | null][];
    for (const [addr, acc] of Object.entries(snapshot.accounts))
      if (acc && acc.executable)
        executables.push([addr as Address, acc]);
      else
        write(addr as Address, acc);

    ForkSvm.applyClock(liteSvm, snapshot.clock);

    for (const [addr, acc] of executables)
      write(addr, acc);

    this.liteSvm     = liteSvm;
    this.known       = known;
    this.expirations = snapshot.expirations;
    this.sent        = new Map();
  }

  setRpc(url: string | undefined) {
    this.rpc = url !== undefined ? createSolanaRpc(url) : undefined;
  }

  latestTimestamp = () =>
    this.getClock().timestamp;

  latestSlot = () =>
    this.getClock().slot;

  getTransaction = (signature: RoUint8Array) =>
    this.liteSvm.getTransaction(signature as Uint8Array);

  latestBlockhash = () =>
    this.liteSvm.latestBlockhash();

  expireBlockhash = () => {
    this.liteSvm.expireBlockhash();
    ++this.expirations;
  };

  getClock(): Clock {
    const liteClock = this.liteSvm.getClock();
    return {
      timestamp:           unixTime.toDate(liteClock.unixTimestamp),
      slot:                liteClock.slot,
      epoch:               liteClock.epoch,
      epochStartTimestamp: liteClock.epochStartTimestamp,
      leaderScheduleEpoch: liteClock.leaderScheduleEpoch,
    };
  }

  setClock(clock: Partial<Clock>) {
    ForkSvm.applyClock(this.liteSvm, clock);
  }

  private static applyClock(liteSvm: LiteSVM, clock: Partial<Clock>) {
    const cur = liteSvm.getClock();
    const {
      timestamp           = unixTime.toDate(cur.unixTimestamp),
      slot                = cur.slot,
      epoch               = cur.epoch,
      epochStartTimestamp = cur.epochStartTimestamp,
      leaderScheduleEpoch = cur.leaderScheduleEpoch,
    } = clock;
    cur.unixTimestamp       = BigInt(unixTime.fromDate(timestamp));
    cur.slot                = slot;
    cur.epoch               = epoch;
    cur.epochStartTimestamp = epochStartTimestamp;
    cur.leaderScheduleEpoch = leaderScheduleEpoch;
    liteSvm.setClock(cur);
  }

  async advanceToNow() {
    if (this.rpc) {
      const [slot, epochInfo] = await Promise.all([
        this.rpc.getSlot().send(),
        this.rpc.getEpochInfo().send(),
      ]);

      const blockTime = await this.rpc.getBlockTime(slot).send();
      this.setClock({
        timestamp:           unixTime.toDate(blockTime),
        slot,
        epoch:               epochInfo.epoch,
        //approximated via the 400 ms slot time target (exact value would cost extra RPC calls)
        epochStartTimestamp: blockTime - epochInfo.slotIndex * 2n / 5n,
        leaderScheduleEpoch: epochInfo.epoch + 1n,
      });
    }
  }

  async sendTransaction(tx: Transaction): Promise<TransactionMetadata> {
    this.checkTxSize(tx);
    await this.fetchUnfetchedOfTx(tx);
    const result = this.liteSvm.sendTransaction(tx);
    this.recordSent(result);
    if (result instanceof TransactionMetadata)
      return result;

    throw result;
  }

  private recordSent(result: TransactionMetadata | FailedTransactionMetadata) {
    const meta = result instanceof TransactionMetadata ? result : result.meta();
    this.sent.set(base58.encode(meta.signature()), {
      slot:      this.latestSlot(),
      blockTime: unixTime.fromDate(this.latestTimestamp()),
    });
  }

  async simulateTransaction(tx: Transaction): Promise<TransactionMetadata> {
    this.checkTxSize(tx);
    await this.fetchUnfetchedOfTx(tx);
    const result = this.liteSvm.simulateTransaction(tx);
    if (result instanceof FailedTransactionMetadata)
      throw result;

    return result.meta();
  }

  async getAccount<const A extends MaybeArray<Address>>(addressEs: A) {
    await this.fetchUnfetched(isArray(addressEs) ? addressEs : [addressEs]);
    return mapTo(addressEs)(addr => this.liteSvm.getAccount(addr))
  }

  async airdrop(address: Address, lamports: bigint): Promise<TransactionMetadata> {
    await this.getAccount(address);
    const result = this.liteSvm.airdrop(address, lamports);
    if (result === null)
      throw new Error(`Airdrop of ${lamports} lamports to ${address} produced no result`);

    this.recordSent(result);
    if (result instanceof TransactionMetadata)
      return result;

    throw result;
  }

  addProgram(programId: Address, programBytes: RoUint8Array): void {
    this.liteSvm.addProgram(programId, programBytes as Uint8Array);
    this.trackProgram(programId);
  }

  addProgramFromFile = (programId: Address, path: string): void => {
    this.liteSvm.addProgramFromFile(programId, path);
    this.trackProgram(programId);
  };

  //the loader puts the bytecode in a program data account of its own, which a snapshot must
  //  carry and no fetch may overwrite
  private trackProgram(programId: Address): void {
    this.known.add(programId);
    const programData = programDataAddressOf(this.liteSvm.getAccount(programId));
    if (programData !== undefined)
      this.known.add(programData);
  }

  setAccount(address: Address, acc: RoAccountInfo | null): void {
    this.liteSvm.setAccount(address, acc ?? emptyAccountInfo);
    this.known.add(address);
  }

  createForkRpc() {
    const baseTransport = this.createForkTransport();
    const baseApi = createSolanaRpcApi(DEFAULT_RPC_CONFIG);
    //an unavailable field is a throwing getter on the object that holds it, so the read of the
    //  field itself throws - a value standing in for the field would answer truthiness,
    //  typeof and Array.isArray with something, and only a later property read could object
    const isUnavailable = (value: unknown): value is { __feature: string } =>
      typeof value === "object" && value !== null &&
      "__unavailable" in value && value.__unavailable === true &&
      "__feature" in value && typeof value.__feature === "string";
    //Kit upcasts error codes and indices to bigint despite declaring them as number.
    //  All numeric fields inside err/Err are u8/u32, so restore their declared representation.
    const wrapResponse = (value: any, inError = false): any =>
      inError && typeof value === "bigint"
      ? Number(value)
      : value === null || value === undefined || typeof value !== "object"
      ? value
      : Array.isArray(value)
      ? value.map(v => wrapResponse(v, inError))
      : Object.entries(value).reduce((wrapped, [key, val]) => {
          if (isUnavailable(val))
            Object.defineProperty(wrapped, key, {
              enumerable: true,
              get: () => { throw new Error(`${val.__feature} is not provided by ForkSvm`); },
            });
          else
            wrapped[key] = wrapResponse(val, inError || key === "err" || key === "Err");
          return wrapped;
        }, {} as any);

    //we wrap the api to transform our unavailable fields into proxies that throw when accessed
    const wrappedApi = new Proxy(baseApi, {
      defineProperty() {
        return false;
      },
      deleteProperty() {
        return false;
      },
      get(target, prop, receiver) {
        const originalPlanGetter = Reflect.get(target, prop, receiver);
        if (typeof originalPlanGetter !== 'function')
          return originalPlanGetter;

        return function(...args: unknown[]) {
          const originalPlan = originalPlanGetter(...args) as RpcPlan<any>;

          return {
            ...originalPlan,
            execute: async (options: Parameters<typeof originalPlan.execute>[0]) => {
              const response = await originalPlan.execute(options);
              return response === null
                ? null
                : (response && typeof response === 'object' &&
                  'value' in response && 'context' in response)
                ? { context: response.context, value: wrapResponse(response.value) }
                : wrapResponse(response);
            },
          };
        };
      },
    }) as RpcApi<any>;

    return createRpc({
      api: wrappedApi,
      transport: baseTransport,
    });
  }

  //see https://solana.com/docs/rpc/http
  private createForkTransport(): RpcTransport {
    const responseWithContext = <const T>(value: T) =>
      ({ value, context: { apiVersion: "3.0.11", slot: Number(this.latestSlot()) } } as const);

    const transactionDecoder = getTransactionDecoder();

    const decodeWireTransaction = (wireTx: Base64EncodedWireTransaction): Transaction =>
      transactionDecoder.decode(base64.decode(wireTx));

    const transactionMetadataToMeta =
      (result: TransactionMetadata | FailedTransactionMetadata) => {
        const succeeded = result instanceof TransactionMetadata;
        const meta = succeeded
          ? result
          : result.meta();

        const err = succeeded
          ? null
          : transactionErrorToRpc(result.err());

        const status = succeeded
          ? { Ok: null }
          : { Err: err };

        const returnData = succeeded
          ? ((result: TransactionMetadata) => {
              const rd = result.returnData();
              return {
                programId: base58.encode(rd.programId()),
                data:      [base64.encode(rd.data()), "base64"],
              }
            })(result)
          : null;

        const innerInstructions = succeeded
          ? ((result: TransactionMetadata) => {
              const innerInstructions = result.innerInstructions();
              return innerInstructions.length > 0
                ? innerInstructions.map((inner: any[], index: number) => ({
                    index,
                    instructions: inner.map((inst: any) => {
                      const compiled = inst.instruction();
                      return {
                        programIdIndex: compiled.programIdIndex(),
                        accounts:       Array.from(compiled.accounts()),
                        data:           base58.encode(compiled.data()),
                        stackHeight:    inst.stackHeight(),
                      };
                    }),
                  }))
                : null;
            })(result)
          : null;

        return {
          logMessages:          meta.logs(),
          computeUnitsConsumed: meta.computeUnitsConsumed(),
          err,
          innerInstructions,
          status,
          ...(returnData !== null && { returnData }),
        };
      };

    //magic value that createForkRpc's api wrapper turns into a proxy that throws when accessed
    const unavailable = (feature: string) => ({
      __unavailable: true as const,
      __feature: feature,
    });

    const transactionMetadataToRpcResponse =
      (signature: Signature, result: TransactionMetadata | FailedTransactionMetadata) => {
        const at = this.sent.get(signature);
        const slot = at?.slot ?? unavailable("slot");
        const blockTime = at?.blockTime ?? unavailable("blockTime");
        const transaction = unavailable("transaction");
        const meta = {
          fee:               unavailable("fee"),
          preBalances:       unavailable("preBalances"),
          postBalances:      unavailable("postBalances"),
          preTokenBalances:  unavailable("preTokenBalances"),
          postTokenBalances: unavailable("postTokenBalances"),
          rewards:           unavailable("rewards"),
          ...transactionMetadataToMeta(result),
        };
        return { slot, blockTime, transaction, meta };
      };

    //A local VM has one commitment and no preflight or retries, so those options are admitted
    //  without effect; an option that would change the answer and is not implemented is refused
    //  rather than silently ignored. minContextSlot is a lower bound on the context slot, which
    //  is the fork's current slot.
    const admittedEverywhere = ["commitment", "minContextSlot"];
    type Config = { encoding?: unknown; minContextSlot?: unknown };
    const checkConfig = (method: string, admitted: RoArray<string>, config?: Config) => {
      for (const key of Object.keys(config ?? {}))
        if (!admitted.includes(key) && !admittedEverywhere.includes(key))
          throw new Error(`Unsupported option for ${method}: ${key}`);

      if (config?.encoding !== "base64" && config?.encoding !== undefined)
        throw new Error(`Unsupported encoding: ${config.encoding}, expected "base64"`);

      const minContextSlot = config?.minContextSlot;
      if (typeof minContextSlot === "bigint" && minContextSlot > this.latestSlot())
        throw new Error(`Minimum context slot has not been reached: ${minContextSlot}`);
    };
    //for the common signature: the config follows the method's one positional argument
    const withConfig =
      <F extends Function>(method: string, admitted: RoArray<string>, f: F) =>
        (val: Parameters<F>[0], config?: Config): ReturnType<F> => {
          checkConfig(method, admitted, config);
          return f(val, config) as ReturnType<F>;
        };

    type DataSlice = { offset: number; length: number };
    const sliceData = (dataSlice: DataSlice | undefined) =>
      (acc: AccountInfo | null) =>
        acc && dataSlice
        ? { ...acc, data: acc.data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length) }
        : acc;

    const supportedMethods = {
      getAccountInfo: withConfig("getAccountInfo", ["encoding", "dataSlice"],
        (address: Address, config?: { dataSlice?: DataSlice }) =>
          this.getAccount(address)
            .then(sliceData(config?.dataSlice))
            .then(liteSvmAccountToKitAccount)
            .then(responseWithContext)
      ),

      getMultipleAccounts: withConfig("getMultipleAccounts", ["encoding", "dataSlice"],
        (addresses: RoArray<Address>, config?: { dataSlice?: DataSlice }) =>
          this.getAccount(addresses)
            .then(accs => accs.map(sliceData(config?.dataSlice)).map(liteSvmAccountToKitAccount))
            .then(responseWithContext)
      ),

      getBalance: withConfig("getBalance", [],
        (address: Address) =>
          this.getAccount(address)
            .then(account => account?.lamports ?? 0n)
            .then(responseWithContext)
      ),

      getLatestBlockhash: (config?: Config) => {
        checkConfig("getLatestBlockhash", [], config);
        return Promise.resolve(
          responseWithContext({
            blockhash:            this.latestBlockhash(),
            lastValidBlockHeight: neverByHeight,
          })
        );
      },

      sendTransaction: withConfig("sendTransaction",
        ["encoding", "skipPreflight", "preflightCommitment", "maxRetries"],
        (wireTx: Base64EncodedWireTransaction) =>
          this.sendTransaction(decodeWireTransaction(wireTx))
            .then(meta => base58.encode(meta.signature()) as Signature)
      ),

      simulateTransaction: withConfig("simulateTransaction", ["encoding", "innerInstructions"],
        (wireTx: Base64EncodedWireTransaction, config?: { innerInstructions?: boolean }) =>
          this.simulateTransaction(decodeWireTransaction(wireTx))
            .catch(error => {
              if (error instanceof FailedTransactionMetadata)
                return error;

              throw error;
            })
            .then(transactionMetadataToMeta)
            .then(meta => ({
              err:           meta.err,
              logs:          meta.logMessages,
              unitsConsumed: meta.computeUnitsConsumed,
              returnData:    meta.returnData ?? null,
              ...(config?.innerInstructions && { innerInstructions: meta.innerInstructions }),
            }))
            .then(responseWithContext)
      ),

      getTransaction: withConfig("getTransaction", ["encoding", "maxSupportedTransactionVersion"],
        (signature: Signature) => {
          const result = this.getTransaction(base58.decode(signature));
          return Promise.resolve(
            result
            ? transactionMetadataToRpcResponse(signature, result)
            : null
          );
        }
      ),
    } as Record<string, (...args: any[]) => Promise<any>>;

    return function <TResponse>(transportConfig: Parameters<RpcTransport>[0]): Promise<TResponse> {
      const { payload } = transportConfig;

      if (!isJsonRpcPayload(payload))
        throw new Error(`Unsupported payload: ${payload}`);

      const method = supportedMethods[payload.method];

      if (method === undefined)
        throw new Error(`Unsupported method: ${payload.method}`);

      if (!Array.isArray(payload.params))
        throw new Error(`Unexpected params: ${JSON.stringify(payload.params)}`);

      return method(...payload.params)
        .then((result: any) => ({ jsonrpc: "2.0", result, id: 1 as number })) as Promise<TResponse>;
    };
  }

  private checkTxSize(tx: Transaction): void {
    const size = 1 + Object.keys(tx.signatures).length * signatureSize + tx.messageBytes.length;
    if (size > maxTxSize)
      throw new Error(`Transaction is too large: ${size}/${maxTxSize} bytes`);
  }

  private async fetchUnfetchedOfTx(tx: Transaction): Promise<void> {
    const decompiledTx = decodeCompiledTransactionMessage(tx.messageBytes);
    const accounts = decompiledTx.staticAccounts;
    if (decompiledTx.version === 0 && decompiledTx.addressTableLookups !== undefined) {
      const addressTableLookups = decompiledTx.addressTableLookups!;
      await this.fetchUnfetched(addressTableLookups!.map(lt => lt.lookupTableAddress));
      for (const lt of addressTableLookups) {
        const { lookupTableAddress: altAddr, readonlyIndexes, writableIndexes } = lt;
        const accInfo = this.liteSvm.getAccount(altAddr);
        if (!accInfo)
          throw new Error(`Couldn't find lookup table: ${altAddr}`);

        const { addresses } = deserialize(addressLookupTableLayout, accInfo.data);
        accounts.push(...[...writableIndexes, ...readonlyIndexes].map(
          i => throwOnUndefined(
            addresses[i],
            `Out of bounds index: ${i} for lookup table: ${altAddr}`
          )
        ));
      }
    }
    return this.fetchUnfetched(accounts);
  }

  private async fetchUnfetched(addresses: RoArray<Address>): Promise<void> {
    //a transaction can name the same address both statically and through a lookup table
    const unfetchedAddresses = [...new Set(addresses)].filter(addr => this.isUnfetched(addr));
    if (unfetchedAddresses.length === 0)
      return;

    const fetched = zip([await this.fetchFromUpstream(unfetchedAddresses), unfetchedAddresses]);

    const unfetchedUpgradable = fetched
      .map(([acc, pId]) => [programDataAddressOf(acc), pId] as const)
      .filter((pair): pair is readonly [Address, Address] =>
        pair[0] !== undefined && this.isUnfetched(pair[0]));

    if (unfetchedUpgradable.length > 0) {
      const bytecode = zip([
        await this.fetchFromUpstream(unfetchedUpgradable.map(([bytecodeAddr]) => bytecodeAddr)),
        ...zip(unfetchedUpgradable)
      ]);

      const missing = bytecode.filter(([acc]) => !acc);
      if (missing.length > 0) {
        const str = missing.map(([, bcAddr, pId]) => `(${pId}, ${bcAddr})`).join(", ");
        throw new Error(`Couldn't find bytecode account for (pId, bytecodeAddr): ${str}`);
      }

      //liteSvm requires that we set the bytecode account before setting the programId account
      //  (because it implicitly invokes the bpf upgradeable loader)
      for (const [bcAcc, bcAddr] of bytecode)
        this.cacheFetched(bcAddr, bcAcc);
    }

    for (const [acc, addr] of fetched)
      this.cacheFetched(addr, acc);
  }

  //an account that became known while the fetch was in flight (via a concurrent fetch, a
  //  transaction, or an explicit set) must not be reverted to its upstream state
  private cacheFetched(address: Address, acc: AccountInfo | null): void {
    if (this.isUnfetched(address))
      this.setAccount(address, acc);
  }

  private async fetchFromUpstream(addresses: RoArray<Address>): Promise<(AccountInfo | null)[]> {
    if (addresses.length === 0)
      return [];

    //if we don't have an RPC, we assume that uncached accounts don't exist
    if (!this.rpc)
      return addresses.map(() => null);

    const enc = { encoding: "base64" } as const;
    const rpc = this.rpc;
    const fetchBatch = (batch: RoArray<Address>) =>
      batch.length > 1
      ? rpc.getMultipleAccounts(batch as Address[], enc).send().then(res => res.value)
      : rpc.getAccountInfo(batch[0]!, enc).send().then(res => [res.value]);

    return Promise.all(chunk(addresses, rpcMaxMultipleAccounts).map(fetchBatch))
      .then(batches => batches.flat().map(kitAccountToLiteSvmAccount));
  }

  private isUnfetched(address: Address) {
    return !specialAddresses!.has(address) && !this.known.has(address);
  }
}
