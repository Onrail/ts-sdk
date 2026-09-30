import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { createSolanaRpc } from "@solana/kit";
import { base64 } from "@onrail-xyz/utils";
import { serialize } from "@onrail-xyz/binary-layout";
import { Sol } from "@onrail-xyz/common";
import type { Client } from "../src/index.js";
import { getMint, getAccountInfo, getBalance, getDeserializedAccount,
         getAddressLookupTable, getLatestBlockhash, mintAccountLayout,
         addressLookupTableLayout, tokenProgramId, token2022ProgramId,
         systemProgramId, addressLookupTableProgramId, findPda } from "../src/index.js";

// ---- Live client tests (require network) ----

const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
//a PDA with a nonsense seed - certain to hold no account
const nonExistent = findPda("onrail nonexistent sentinel", tokenProgramId);

const client = createSolanaRpc("https://api.mainnet-beta.solana.com");

let hasNetwork = false;
before(async () => {
  hasNetwork = await fetch("https://cloudflare.com", { method: "HEAD" })
    .then(() => true)
    .catch(() => false);
});

const liveTimeout = 30_000; //bound a slow/dead RPC instead of hanging CI indefinitely

describe("client live queries", () => {
  it("getMint reads the USDC mint", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const mint = await getMint(client, usdcMint);
    assert(mint);
    assert.strictEqual(mint.decimals, 6);
    assert.strictEqual(mint.isInitialized, true);
    assert(mint.supply > 0n);
  });

  it("getAccountInfo reads a single account", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const info = await getAccountInfo(client, usdcMint);
    assert(info);
    assert.strictEqual(info.owner, tokenProgramId);
    assert.strictEqual(info.executable, false);
    assert.strictEqual(info.space, 82n);
    assert.strictEqual(info.data.length, 82);
  });

  it("getAccountInfo maps an array (incl. a missing account)", { timeout: liveTimeout },
    async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [existing, missing] = await getAccountInfo(client, [usdcMint, nonExistent]);
      assert(existing);
      assert.strictEqual(missing, undefined);
    },
  );

  it("getBalance returns positive lamports", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const balance = await getBalance(client, usdcMint);
    assert(balance !== undefined && balance > 0n);
  });

  it("getBalance maps an array and reports a missing account as undefined",
    { timeout: liveTimeout }, async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [existing, missing] = await getBalance(client, [usdcMint, nonExistent]);
      assert(existing !== undefined && existing > 0n);
      assert.strictEqual(missing, undefined);
    },
  );

  it("getBalance yields an Amount when given a kind", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const balance = await getBalance(client, usdcMint, Sol);
    assert(balance !== undefined);
    assert(balance.in("SOL").gt(0));
    assert.strictEqual(balance.in("atomic"), await getBalance(client, usdcMint));
  });

  it("getMint returns undefined for a non-existent account", { timeout: liveTimeout },
    async (t) => {
      if (!hasNetwork) return t.skip("no network");
      assert.strictEqual(await getMint(client, nonExistent), undefined);
    },
  );

  it("getDeserializedAccount applies a layout", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const mint = await getDeserializedAccount(client, usdcMint, mintAccountLayout());
    assert(mint);
    assert.strictEqual(mint.decimals, 6);
  });

  it("getLatestBlockhash returns a blockhash and height", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const { blockhash, lastValidBlockHeight } = await getLatestBlockhash(client);
    assert.strictEqual(typeof blockhash, "string");
    assert(blockhash.length > 0);
    assert.strictEqual(typeof lastValidBlockHeight, "bigint");
  });
});

// ---- Owner checks (mocked client) ----

//a client whose every account read answers with the same header and payload
const mockClient = (owner: Address, data: Uint8Array): Client => {
  const value = {
    executable: false,
    owner,
    lamports:   1n,
    space:      BigInt(data.length),
    data:       [base64.encode(data), "base64"],
  };
  const respond = () => ({ send: async () => ({ value }) });
  const respondEach = (addresses: readonly Address[]) =>
    ({ send: async () => ({ value: addresses.map(() => value) }) });
  return { getAccountInfo: respond, getMultipleAccounts: respondEach } as any;
};

const mintBytes = serialize(mintAccountLayout(), {
  mintAuthority:   undefined,
  supply:          0n,
  decimals:        6,
  isInitialized:   true,
  freezeAuthority: undefined,
});

//getMint used to hand any 82 bytes to the mint layout, so a system-owned account shaped like a
//  mint decoded as one
describe("named getters check the owner", () => {
  it("accept either token program", async () => {
    for (const program of [tokenProgramId, token2022ProgramId]) {
      const mint = await getMint(mockClient(program, mintBytes), nonExistent);
      assert.strictEqual(mint?.decimals, 6);
    }
  });

  it("refuse a mint-shaped account another program owns", async () => {
    const client = mockClient(systemProgramId, mintBytes);
    await assert.rejects(() => getMint(client, nonExistent), /owned by 1{5}/);
    //the layout-only form stays unchecked
    const raw = await getDeserializedAccount(client, nonExistent, mintAccountLayout());
    assert.strictEqual(raw?.decimals, 6);
  });
});

const altBytes = serialize(addressLookupTableLayout, {
  deactivationSlot:           2n ** 64n - 1n,
  lastExtendedSlot:           1n,
  lastExtendedSlotStartIndex: 0,
  authority:                  undefined,
  addresses:                  [systemProgramId],
});

describe("named getters batch", () => {
  it("read several lookup tables in one request", async () => {
    const client = mockClient(addressLookupTableProgramId, altBytes);
    const alts = await getAddressLookupTable(client, [nonExistent, nonExistent]);
    assert.strictEqual(alts.length, 2);
    assert.deepStrictEqual(alts.map(alt => alt?.addresses), [[systemProgramId], [systemProgramId]]);
  });

  it("check the owner of every account", async () => {
    const client = mockClient(systemProgramId, altBytes);
    await assert.rejects(() => getAddressLookupTable(client, [nonExistent]), /owned by 1{5}/);
  });
});
