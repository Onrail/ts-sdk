import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Lamports } from "@solana/kit";
import { address, getAddressEncoder } from "@solana/kit";
import { base64 } from "@onrail-xyz/utils";
import { bpfLoaderUpgradeableProgramId, systemProgramId } from "@onrail-xyz/svm";
import { ForkSvm } from "../src/forkSvm.js";
import type { AccountInfo } from "../src/index.js";
import { writeToDisc, readFromDisc } from "../src/io.js";

//the fork's lazy fetching is exercised against a local JSON-RPC mock - no network access
type UpstreamAccount = {
  executable: boolean;
  owner:      Address;
  lamports:   number;
  data:       Uint8Array;
};

const upstreamSlot = 400_000_000;
const upstreamBlockTime = 1_780_000_000;

const toRpcAccount = (acc: UpstreamAccount) => ({
  executable: acc.executable,
  owner:      acc.owner,
  lamports:   acc.lamports,
  space:      acc.data.length,
  data:       [base64.encode(acc.data), "base64"],
  rentEpoch:  0,
});

class MockRpc {
  readonly accounts = new Map<Address, UpstreamAccount>();
  readonly calls = [] as { method: string, params: unknown }[];
  //answering a method late lets a transaction land while its fetch is still in flight
  delayedMethod: string | undefined = undefined;
  private server: Server;
  private port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: string) => body += chunk);
      req.on("end", () => {
        const payload = JSON.parse(body) as { id: unknown, method: string, params: any };
        this.calls.push({ method: payload.method, params: payload.params });
        const respond = () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: this.answer(payload) }));
        };
        if (payload.method === this.delayedMethod)
          setTimeout(respond, 50);
        else
          respond();
      });
    });
  }

  private answer(payload: { method: string, params: any }): unknown {
    const context = { apiVersion: "3.0.0", slot: upstreamSlot };
    const value = (addr: Address) => {
      const acc = this.accounts.get(addr);
      return acc ? toRpcAccount(acc) : null;
    };
    switch (payload.method) {
      case "getAccountInfo":      return { context, value: value(payload.params[0]) };
      case "getMultipleAccounts": return { context, value: payload.params[0].map(value) };
      case "getSlot":             return upstreamSlot;
      case "getBlockTime":        return upstreamBlockTime;
      case "getEpochInfo":        return {
        absoluteSlot: upstreamSlot,
        blockHeight:  upstreamSlot,
        epoch:        925,
        slotIndex:    100,
        slotsInEpoch: 432_000,
      };
      default: throw new Error(`mock rpc: unexpected method ${payload.method}`);
    }
  }

  async listen() {
    await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  close() {
    this.server.close();
  }

  get url() {
    return `http://127.0.0.1:${this.port}/`;
  }

  countOf(method: string) {
    return this.calls.filter(call => call.method === method).length;
  }
}

const wallet = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const absent = address("11111111111111111111111111111112");
const programId = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
//the program data account address as stored in the programId account of an upgradeable program
const programData = address("6zWKmL8pQqPvpNBUcXBKf6nSBnhZ8CQY1TnLLmnGpMLK");

describe("lazy forking", () => {
  let mock: MockRpc;
  let fork: ForkSvm;

  before(async () => {
    mock = new MockRpc();
    await mock.listen();
  });

  after(() => mock.close());

  beforeEach(() => {
    mock.accounts.clear();
    mock.calls.length = 0;
    mock.delayedMethod = undefined;
    mock.accounts.set(wallet, {
      executable: false,
      owner:      systemProgramId,
      lamports:   12_345_678,
      data:       new Uint8Array(),
    });
    fork = new ForkSvm(mock.url);
  });

  it("fetches an unknown account from upstream on first access", async () => {
    const acc = await fork.getAccount(wallet);
    assert.strictEqual(acc?.lamports, 12_345_678n);
    assert.strictEqual(mock.countOf("getAccountInfo"), 1);
  });

  it("does not re-fetch an account it already has", async () => {
    await fork.getAccount(wallet);
    await fork.getAccount(wallet);
    assert.strictEqual(mock.countOf("getAccountInfo"), 1);
  });

  it("caches the absence of an account that doesn't exist upstream", async () => {
    assert.strictEqual(await fork.getAccount(absent), null);
    assert.strictEqual(await fork.getAccount(absent), null);
    assert.strictEqual(mock.countOf("getAccountInfo"), 1);
  });

  it("batches a multi-address read into a single deduplicated getMultipleAccounts", async () => {
    const accs = await fork.getAccount([wallet, absent, wallet]);
    assert.strictEqual(accs[0]?.lamports, 12_345_678n);
    assert.strictEqual(accs[1], null);
    assert.strictEqual(accs[2]?.lamports, 12_345_678n);
    assert.strictEqual(mock.countOf("getMultipleAccounts"), 1);
    assert.strictEqual(mock.countOf("getAccountInfo"), 0);
    assert.deepStrictEqual((mock.calls[0]?.params as unknown[])[0], [wallet, absent]);
  });

  it("never fetches builtins, sysvars or default programs", async () => {
    assert(await fork.getAccount(systemProgramId));
    assert.strictEqual(mock.calls.length, 0);
  });

  it("treats every account as absent when no upstream is configured", async () => {
    const local = new ForkSvm();
    assert.strictEqual(await local.getAccount(wallet), null);
    assert.strictEqual(mock.calls.length, 0);
  });

  it("also pulls the program data account of an upgradeable program", async () => {
    mock.accounts.set(programId, {
      executable: true,
      owner:      bpfLoaderUpgradeableProgramId,
      lamports:   1_000_000,
      //UpgradeableLoaderState::Program { programdata_address }
      data:       new Uint8Array([
        2, 0, 0, 0,
        ...getAddressEncoder().encode(programData),
      ]),
    });
    //the program data account is missing upstream, which is how the second fetch shows up
    await assert.rejects(
      () => fork.getAccount(programId),
      new RegExp(`Couldn't find bytecode account.*${programId}, ${programData}`),
    );
    assert.strictEqual(mock.countOf("getAccountInfo"), 2);
  });

  //a fetch that resolves after a transaction has already touched the account must not
  //  silently revert it to its upstream state
  it("does not overwrite state that changed while a fetch was in flight", async () => {
    mock.delayedMethod = "getMultipleAccounts";
    await Promise.all([
      fork.airdrop(wallet, 1_000_000n),
      fork.getAccount([wallet, absent]),
    ]);
    assert.strictEqual((await fork.getAccount(wallet))?.lamports, 12_345_678n + 1_000_000n);
  });

  it("adopts the upstream clock on advanceToNow", async () => {
    await fork.advanceToNow();
    const clock = fork.getClock();
    assert.strictEqual(clock.slot, BigInt(upstreamSlot));
    assert.strictEqual(clock.epoch, 925n);
    assert.strictEqual(clock.timestamp.getTime(), upstreamBlockTime * 1000);
    //100 slots into the epoch at the 400ms slot time target
    assert.strictEqual(clock.epochStartTimestamp, BigInt(upstreamBlockTime - 40));
  });

  it("includes lazily fetched accounts in a snapshot and restores them without an rpc", async () => {
    await fork.getAccount([wallet, absent]);
    const snapshot = fork.save();
    assert.strictEqual(snapshot.accounts[wallet]?.lamports, 12_345_678n);
    //the absent account is recorded as such so a restored fork doesn't re-fetch it either
    assert.strictEqual(snapshot.accounts[absent], null);

    const callsBefore = mock.calls.length;
    const restored = ForkSvm.load(snapshot);
    assert.strictEqual((await restored.getAccount(wallet))?.lamports, 12_345_678n);
    assert.strictEqual(await restored.getAccount(absent), null);
    assert.strictEqual(mock.calls.length, callsBefore);
  });

  //the url used to be a setting, so save() aliased it and setRpc retroactively altered snapshots
  it("does not carry the rpc url into the snapshot", async () => {
    await fork.getAccount(wallet);
    const snapshot = fork.save();
    assert(!("url" in snapshot));

    const offline = ForkSvm.load(snapshot);
    const callsBefore = mock.calls.length;
    assert.strictEqual(await offline.getAccount(absent), null);
    assert.strictEqual(mock.calls.length, callsBefore);

    mock.accounts.set(absent, {
      executable: false,
      owner:      systemProgramId,
      lamports:   42,
      data:       new Uint8Array(),
    });
    const lazy = ForkSvm.load(snapshot, mock.url);
    assert.strictEqual((await lazy.getAccount(absent))?.lamports, 42n);
  });
});

describe("disk persistence", () => {
  let dir: string;
  let fork: ForkSvm;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "forkSvm-"));
    fork = new ForkSvm();
  });

  const cleanups = [] as string[];
  after(() => Promise.all(cleanups.map(d => rm(d, { recursive: true, force: true }))));

  const snapshotDir = () => {
    const path = join(dir, "snapshot");
    cleanups.push(dir);
    return path;
  };

  //writeToDisc used to race its own mkdir, so writing into a fresh directory failed with ENOENT
  it("creates the target directory", async () => {
    const path = snapshotDir();
    await fork.airdrop(wallet, 10n ** 9n);
    await writeToDisc(path, fork.save());
    assert.deepStrictEqual((await readdir(path)).sort(), ["accounts", "meta.json"]);
  });

  //the airdropped wallet has no data, whose empty base64 encoding used to survive the read
  //  as a string, making the resulting snapshot unloadable
  it("round-trips a snapshot", async () => {
    const path = snapshotDir();
    await fork.airdrop(wallet, 10n ** 9n);
    fork.setClock({ timestamp: new Date("2025-06-01T00:00:00Z"), slot: 123n });
    const data = new Uint8Array([1, 2, 3, 250]);
    fork.setAccount(absent, {
      executable: false,
      owner:      systemProgramId,
      lamports:   777n as Lamports,
      space:      BigInt(data.length),
      data,
    } satisfies AccountInfo);
    const snapshot = fork.save();

    await writeToDisc(path, snapshot);
    const read = await readFromDisc(path);

    assert.strictEqual(read.blockhash, snapshot.blockhash);
    assert.strictEqual(read.clock.timestamp.getTime(), snapshot.clock.timestamp.getTime());
    assert.strictEqual(read.clock.slot, 123n);
    assert.strictEqual(read.accounts[wallet]?.lamports, 10n ** 9n);
    assert.deepStrictEqual(read.accounts[absent]?.data, data);

    const restored = ForkSvm.load(read);
    assert.strictEqual((await restored.getAccount(wallet))?.lamports, 10n ** 9n);
    assert.deepStrictEqual((await restored.getAccount(absent))?.data, data);
  });

  //accounts of a previous snapshot in the same directory must not resurface
  it("prunes account files that the new snapshot doesn't contain", async () => {
    const path = snapshotDir();
    await fork.airdrop(wallet, 10n ** 9n);
    await fork.getAccount(absent);
    fork.setAccount(absent, {
      executable: false,
      owner:      systemProgramId,
      lamports:   777n as Lamports,
      space:      0n,
      data:       new Uint8Array(),
    });
    await writeToDisc(path, fork.save());
    assert.strictEqual((await readdir(join(path, "accounts"))).length, 2);

    const trimmed = await readFromDisc(path);
    delete trimmed.accounts[absent];
    await writeToDisc(path, trimmed);

    assert.strictEqual((await readdir(join(path, "accounts"))).length, 1);
    assert.deepStrictEqual(Object.keys((await readFromDisc(path)).accounts), [wallet]);
  });

  it("reports a directory that isn't a snapshot", async () => {
    const path = snapshotDir();
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "meta.json"), "{}");
    await assert.rejects(() => readFromDisc(path), /has no blockhash\/clock/);
  });
});
