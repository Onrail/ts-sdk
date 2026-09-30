# @onrail-xyz/fork-svm

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/fork-svm.svg)](https://www.npmjs.com/package/@onrail-xyz/fork-svm)

Anvil for Solana: a local SVM fork with lazy account fetching. Built on [LiteSVM](https://github.com/LiteSVM/litesvm) and [@solana/kit](https://www.npmjs.com/package/@solana/kit).

## Why?

Testing Solana programs is painful. Your options:

* **solana-test-validator**
  - Slow startup
  - Separate process
  - Must pre-declare every account to clone
  - State doesn't persist nicely between test runs
* **LiteSVM**
  - Fast and in-process
  - But no transparent forking
  - Manual account setup for everything
* **Just use devnet**
  - Slow, flaky, funds-limited, rate-limited
  - No state manipulation

Meanwhile, EVM developers have had Anvil and Hardhat for years — local nodes that lazily fork state from mainnet/testnet, allow time manipulation, and provide a drop-in RPC.

This package brings that experience to Solana:

```typescript
const fork = new ForkSvm("https://api.mainnet-beta.solana.com");

// Load the program under test
fork.addProgramFromFile(programId, "./target/deploy/my_program.so");

// Read and modify any account
const acc = await fork.getAccount(someAddress);
fork.setAccount(someAddress, { ...acc, data: modifiedData });

// Accounts are fetched lazily - no upfront cloning
// Works with both legacy and v0 transactions (including ALTs)
const tx = await buildSomeTransaction();
await fork.sendTransaction(tx); // fetches what it needs automatically

// Or use through the supported RPC-compatible subset
const rpc = fork.createForkRpc();
await rpc.getBalance(myWallet).send(); // works with existing code ...
await myProgramSdk.doSomething(rpc, ...); //... including the program's own sdk

// Snapshot and restore
const snapshot = fork.save();
// ... run destructive tests ...
fork.load(snapshot);

// Persist to disk for reproducible CI
await writeToDisc("./fixtures/my-test", snapshot);
```

So what you get is a local VM that hydrates itself from upstream on first read. Each account arrives as the upstream's *current* state at the moment it is first touched and is kept from then on, so two accounts fetched at different times may never have coexisted upstream, and the clock, sysvars and built-in programs are LiteSVM's own rather than the upstream's. A snapshot therefore reproduces exactly the inputs a run saw, which is what tests need; it is not the chain's state at a slot, which would take a snapshot-capable account source.

## Install

```bash
npm install @onrail-xyz/fork-svm \
  @onrail-xyz/utils @onrail-xyz/binary-layout \
  @onrail-xyz/amount @onrail-xyz/common @onrail-xyz/svm \
  @solana/kit @solana/rpc-spec
```

The `@onrail-xyz/*` packages and the `@solana/*` libraries are peer dependencies — install them alongside `fork-svm` (recent pnpm/npm auto-install peers). Peering keeps a single shared `utils` (which anchors the SDK's branded types) and one set of `@solana/*` versions across the consuming app. Node and TypeScript floors are [SDK-wide](https://github.com/Onrail/ts-sdk#requirements).

### Native binaries and supported platforms

`fork-svm` does not ship or rebuild Onrail-maintained native binaries. It vendors LiteSVM's JavaScript loader and raw binding declarations so it can place its own readonly, `@solana/kit`-native wrapper directly over the bindings; the native binaries themselves come from [LiteSVM's official platform packages](https://github.com/LiteSVM/litesvm/blob/bee0fd29642ee1b6a2f16792d1827fcf91471287/crates/node-litesvm/package.json), declared as optional dependencies and pinned to the same LiteSVM version as that loader.

The current package includes LiteSVM binaries for:

| OS    | Architectures | C library   |
|-------|---------------|-------------|
| macOS | x64, arm64    | —           |
| Linux | x64, arm64    | glibc, musl |

Windows is not currently supported. Use WSL on a supported Linux architecture.

## Quick Start

```typescript
import { ForkSvm } from "@onrail-xyz/fork-svm";

// Create a network fork
const fork = new ForkSvm("https://api.mainnet-beta.solana.com");

// Or create an empty local SVM (no upstream)
const localSvm = new ForkSvm();

// Fund a test wallet
const wallet = address("...");
await fork.airdrop(wallet, 10_000_000_000n); // 10 SOL - see utils below for nicer amount spec

// Send transactions
await fork.sendTransaction(tx).then(meta => {
  console.log(meta.logs()); // transaction logs
  console.log(meta.computeUnitsConsumed()); // CU used
});

// Get account data (fetched from upstream if not cached)
const account = await fork.getAccount(someAddress);
```

## Core API

### Constructor

```typescript
new ForkSvm(url?: string); // RPC URL to fork from (undefined = empty local SVM)

// The VM is LiteSVM's standard environment: builtins, sysvars and the default programs
// (SPL Token, ATA, ...) are always present.
```

### Transactions

```typescript
// Send a transaction (modifies state)
const meta = await fork.sendTransaction(tx);
meta.signature();           // transaction signature
meta.logs();                // program logs
meta.computeUnitsConsumed();
meta.returnData();          // program return data
meta.innerInstructions();   // CPI instructions

// Simulate executes nothing, but it does hydrate the fork with the tx's accounts as a side effect
const simMeta = await fork.simulateTransaction(tx);

// Retrieve a previously sent transaction
const retrieved = fork.getTransaction(signatureBytes);
```

A sent transaction resolves to a `TransactionMetadata` — `innerInstructions()` yields `InnerInstruction`s of `CompiledInstruction`s, `returnData()` a `TransactionReturnData` — and a failed one rejects with a `FailedTransactionMetadata`, whose `err()` is a `TransactionErrorFieldless`, `TransactionErrorInstructionError`, `TransactionErrorDuplicateInstruction`, `TransactionErrorInsufficientFundsForRent` or `TransactionErrorProgramExecutionTemporarilyRestricted`. An instruction error, in turn, is an `InstructionErrorFieldless`, `InstructionErrorCustom` or `InstructionErrorBorshIo` (`InstructionErrorBorshIO` being LiteSVM's own alias for the last).

### Account Management

```typescript
// Get account(s) - fetches from upstream if not cached
const acc = await fork.getAccount(address);
const accs = await fork.getAccount([addr1, addr2, addr3]);

// Set account state verbatim (no rent top-up - createAccount from createCurried funds by default)
fork.setAccount(address, {
  owner: programId,
  lamports: 1_000_000_000n,
  data: new Uint8Array([...]),
  executable: false,
  space: 100n,
});

// Airdrop SOL (creates account if needed)
await fork.airdrop(address, lamports);

// Load a program from bytes or file
fork.addProgram(programId, programBytes);
fork.addProgramFromFile(programId, "./target/deploy/my_program.so");
```

`setAccount` takes a `RoAccountInfo`, and a snapshot holds `AccountInfo`s — the same account shape, readonly and not.

### Clock

```typescript
// Get full clock state
const clock = fork.getClock();
// => { timestamp, slot, epoch, epochStartTimestamp, leaderScheduleEpoch }

// Set any subset of clock fields
fork.setClock({ timestamp: new Date("2025-06-01") });
fork.setClock({ slot: 300_000_000n });
fork.setClock({ timestamp: new Date("2025-06-01"), slot: 300_000_000n });

// Convenience shortcuts
fork.latestTimestamp(); // Date
fork.latestSlot();      // bigint

// Sync to current network time (requires RPC)
await fork.advanceToNow();

// Blockhash management
fork.latestBlockhash(); // current blockhash
fork.expireBlockhash(); // expire current, generate new
```

### Snapshots

A snapshot holds every account the fork knows (fetched, set, or touched by a transaction — an added program's program data account included), the clock, and the current blockhash with the number of expirations that lead to it. LiteSVM's own accounts — built-in and default programs, sysvars — are not part of it: a transaction that writes to one of those (a transfer to a program account, say) is not carried across, and a load restores them to LiteSVM's defaults. Loading rebuilds the VM from scratch, so transaction history is cleared too: a transaction sent after the save can be sent again after the load. A snapshot that fails to load leaves the fork as it was.

```typescript
// Save current state
const snapshot = fork.save();

// Restore state
fork.load(snapshot);

// Create new fork from snapshot
const newFork = ForkSvm.load(snapshot);

// ...or one that keeps fetching from an upstream for whatever the snapshot lacks
const lazyFork = ForkSvm.load(snapshot, "https://api.mainnet-beta.solana.com");
```

### Disk Persistence

Persist snapshots to disk for reproducible tests that don't depend on network state:

```typescript
import { writeToDisc, readFromDisc } from "@onrail-xyz/fork-svm";

// Save a snapshot after fetching the required accounts
await writeToDisc("./fixtures/my-scenario", fork.save());

// Later (or in CI), load from disk - no RPC calls needed
const snapshot = await readFromDisc("./fixtures/my-scenario");
const fork = ForkSvm.load(snapshot);
```

Snapshots do not record the RPC url, so a restored fork is offline unless one is passed to `ForkSvm.load(snapshot, url)`, and accounts the snapshot lacks read as non-existent. That keeps provider credentials out of committed fixtures, and it makes an incomplete fixture fail the same way on every machine instead of quietly reaching out to the network.

This is invaluable for:
- **Reproducible CI** — tests run against a fixed snapshot, not the live network
- **Offline development** — work without network access once state is captured
- **Debugging** — save state at a specific point and replay transactions against it

### RPC-compatible adapter

For code that expects a standard Solana RPC, create an adapter implementing the subset below:

```typescript
const rpc = fork.createForkRpc();

// Works with existing RPC-based code
const balance = await rpc.getBalance(address).send();
const account = await rpc.getAccountInfo(address, { encoding: "base64" }).send();
const blockhash = await rpc.getLatestBlockhash().send();

// Transactions go through the fork
await rpc.sendTransaction(wireTransaction, { encoding: "base64" }).send();
```

Supported methods: `getAccountInfo`, `getMultipleAccounts`, `getBalance`, `getLatestBlockhash`, `sendTransaction`, `simulateTransaction`, `getTransaction` — i.e. everything [`@onrail-xyz/svm`](https://github.com/Onrail/ts-sdk/blob/main/packages/svm/src/client.ts)'s client uses. The returned object is typed as a full `@solana/kit` RPC, so calling anything outside that list type-checks but throws `Unsupported method` at runtime. Options are honored, admitted or refused, never silently ignored: `encoding` must be `"base64"`, `dataSlice` slices, `minContextSlot` is checked against the fork's slot; `commitment`, `skipPreflight`, `preflightCommitment` and `maxRetries` are admitted without effect, since a local VM has one commitment and no preflight; anything else (`sigVerify`, `replaceRecentBlockhash`, requested post-accounts) throws `Unsupported option`. Fields a fork cannot know (fees, pre/post balances, rewards, the transaction itself) are throwing getters on the object that holds them, so the read of the field itself throws rather than handing back a plausible-looking lie. `getLatestBlockhash` reports `lastValidBlockHeight` as the largest `u64`: a fork's blockhash expires when `expireBlockhash()` is called, never by height. `getTransaction` reports the slot and time the transaction actually ran at, recorded when it was sent.

Failed simulations and recorded transactions expose Solana RPC error values in `err`: a fieldless error name or a variant object such as `{ InstructionError: [1, { Custom: 42 }] }`. Recorded transactions use the same value in `meta.status.Err`. Instruction indices, account indices and custom error codes are numbers. The direct `ForkSvm` transaction methods still reject with `FailedTransactionMetadata`.

## Utilities

### `createCurried`

Extends svm's [`bindClient`](https://github.com/Onrail/ts-sdk/blob/main/packages/svm/README.md#bound-client), bound to the fork's RPC, with the fork's own mutators, and optionally integrates with [`@onrail-xyz/amount`](https://github.com/Onrail/ts-sdk/blob/main/packages/amount/README.md) for type-safe, human-readable amounts (see [`@onrail-xyz/common`](https://github.com/Onrail/ts-sdk/blob/main/packages/common/src/units.ts) for `Sol`, `sol`, and `usdc`):

```typescript
import { createCurried } from "@onrail-xyz/fork-svm";
import { Sol, sol, usdc } from "@onrail-xyz/common";

const {
  minimumBalanceForRentExemption,
  getAccountInfo,
  getDeserializedAccount,
  getMint,
  getTokenAccount,
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
} = createCurried(fork, Sol); // Sol kind for typed amounts (optional)

// Now with nicer ergonomics
await airdrop(wallet, sol(0.1));
const balance = await getBalance(wallet); // Amount<Sol>
const ata = createAta(wallet, usdcMint, usdc(100));
await createAndSendTx(instructions, feePayer, additionalSigners, alts);
```

Three members differ from their svm counterparts: `getBalance` and `getTokenBalance` read an account the fork lacks as zero rather than `undefined`, and `sendTx` takes the fee payer apart from the other signers and returns the executed transaction's metadata rather than its signature.

### `assertTxSuccess`

Unwraps a transaction result, failing with a clear message if it errors:

```typescript
import { assertTxSuccess } from "@onrail-xyz/fork-svm";

const meta = await assertTxSuccess(fork.sendTransaction(tx));
// throws with logs if tx fails
```

## The `liteSvm` layer

`ForkSvm` is built on a readonly, `@solana/kit`-native wrapper over the vendored LiteSVM bindings, and that wrapper is exported too, under the `liteSvm` namespace — use it directly when forking is not wanted and a bare in-process SVM is enough:

```typescript
import { liteSvm } from "@onrail-xyz/fork-svm";

const svm = new liteSvm.LiteSVM();
const clock: liteSvm.Clock = svm.getClock();
```

The namespace also carries the raw litesvm value types the wrapper's signatures name (`Rent`, `EpochSchedule`, `SlotHash`, ...). It is a namespace rather than a flat export because both layers define a `Clock`, and they are not the same type: `ForkSvm`'s carries a `Date` timestamp, litesvm's a raw unix one. The types `ForkSvm`'s own API hands back — `TransactionMetadata`, its error taxonomy, the account shapes — are exported at the top level as well, so ordinary use never needs this namespace.

## Comparison

| Feature                | ForkSvm                   | solana-test-validator | LiteSVM (Node) |
|------------------------|---------------------------|-----------------------|----------------|
| In-process             | ✅                        | ❌                    | ✅             |
| Lazy forking           | ✅                        | ❌ (explicit --clone) | ❌             |
| State manipulation     | ✅                        | ❌                    | ✅             |
| Snapshots              | ✅                        | ❌                    | ❌             |
| RPC-compatible adapter | ✅ (7 methods, see above) | ✅                    | ❌             |
