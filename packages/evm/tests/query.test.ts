import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { RoUint8Array } from "@onrail-xyz/utils";
import { bignum } from "@onrail-xyz/utils";
import { serialize } from "@onrail-xyz/binary-layout";
import type { QueryCall, QueryResult } from "../src/query.js";
import { createQuery } from "../src/query.js";
import { erc20 } from "../src/erc20.js";
import { wordSize, selectorOf, addressItem,
         evmAmountItem, paddedSlotLayout, selectorLayout } from "../src/layouting.js";
import { probeNetwork, query, liveTimeout, token, usdcTreasury } from "./live.js";
import { pinEq } from "./typeAssert.js";

const usdc = erc20(token);
const balanceOfLayout =
  selectorLayout("balanceOf(address)")({ owner: paddedSlotLayout(addressItem) });

//pulling more than the treasury ever approved to itself is guaranteed to revert
const revertingCall = {
  to:   token,
  data: ["transferFrom(address,address,uint256) returns (bool)",
         [usdcTreasury, usdcTreasury, 10n ** 30n]],
} as const;

// ---- Retry scope (no network) ----

//regression: call data was encoded inside the reorg retry, so a malformed argument cost three
//  block lookups and surfaced as a failed canonical block, the actual error only in its cause
describe("query retry", () => {
  it("rejects a malformed argument at once, without resolving a block or retrying", async () => {
    let getBlocks = 0;
    const stub = {
      getBlock: async () => { ++getBlocks; throw new Error("unreachable"); },
      request:  async () => { throw new Error("unreachable"); },
    } as unknown as Parameters<typeof createQuery>[0];
    const call = { to: token, data: [balanceOfLayout, { owner: "0xnot-an-address" }, evmAmountItem()] };

    await assert.rejects(createQuery(stub)([call as any]), /when sizing field 'owner'/);
    assert.equal(getBlocks, 0);
  });
});

// ---- Result typing (no network) ----

//the runtime wraps whenever the flag is truthy, so the result type must follow the value the
//  type actually knows: a literal true wraps, false or absent is bare, and a widened boolean
//  (a computed flag, an annotated QueryCall) is the union - the last used to be typed bare
describe("query result typing", () => {
  it("wraps, bares or unions the result according to what the type knows of allowFailure", () => {
    const abi = ["decimals() view returns (uint8)", []] as const;
    type Bare = number;
    type Wrapped = { success: true; data: number } | { success: false; data: RoUint8Array };

    type Call<F = never> =
      { to: Address; data: typeof abi } & ([F] extends [never] ? {} : { allowFailure: F });

    pinEq<QueryResult<Call>, Bare>(true);
    pinEq<QueryResult<Call<true>>, Wrapped>(true);
    pinEq<QueryResult<Call<false>>, Bare>(true);
    pinEq<QueryResult<Call<boolean>>, Bare | Wrapped>(true);
    pinEq<QueryResult<QueryCall<typeof abi>>, Bare | Wrapped>(true);
    pinEq<QueryResult<readonly [Call<boolean>]>, readonly [Bare | Wrapped]>(true);
    assert.ok(true);
  });
});

// ---- Live query tests (require network) ----

let hasNetwork = false;
before(async () => { hasNetwork = await probeNetwork(); });

describe("query", () => {
  it("returns a bare result for a single call plus block meta", { timeout: liveTimeout },
    async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [decimals, blockNumber, blockHash, timestamp] = await query(usdc.decimals());
      assert.strictEqual(decimals, 6);
      assert.strictEqual(typeof blockNumber, "bigint");
      assert.strictEqual(blockHash.length, 32);
      assert.ok(timestamp instanceof Date);
    },
  );

  it("handles an empty batch", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const [results] = await query([]);
    assert.deepStrictEqual(results, []);
  });

  it("mixes raw bytes, layout triples, and abi signatures in one batch",
    { timeout: liveTimeout }, async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [[raw, viaLayout, viaAbi]] = await query([
        { to: token, data: serialize(balanceOfLayout, { owner: usdcTreasury }) },
        { to: token, data: [balanceOfLayout, { owner: usdcTreasury }, evmAmountItem()] },
        { to: token, data: ["balanceOf(address) view returns (uint256)", [usdcTreasury]] },
      ] as const);
      assert.strictEqual(raw.length, wordSize);
      assert.strictEqual(bignum.fromBytes(raw), viaLayout);
      assert.strictEqual(viaLayout, viaAbi);
    },
  );

  it("surfaces a revert without poisoning the rest of the batch", { timeout: liveTimeout },
    async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [[failed, decimals]] = await query([
        { ...revertingCall, allowFailure: true },
        usdc.decimals(),
      ] as const);
      assert.strictEqual(failed.success, false);
      //revert reason is returned verbatim, i.e. abi encoded Error(string)
      assert.deepStrictEqual(failed.data.subarray(0, 4), selectorOf("Error(string)"));
      assert.strictEqual(decimals, 6);
    },
  );

  it("throws on a revert that is not opted into", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    await assert.rejects(() => query([revertingCall] as const), /reverted/);
  });

  it("pins the batch to a single block", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const [[latest], , blockHash] = await query([usdc.balanceOf(usdcTreasury)], "latest");
    //re-querying by the returned hash must reproduce the exact same state
    const [pinned] = await query([usdc.balanceOf(usdcTreasury)], blockHash);
    assert.strictEqual(pinned, latest);
    //...and querying by hash yields the results only, without block meta
    assert.strictEqual((await query(usdc.decimals(), blockHash)) as unknown, 6);
  });

  it("resolves the finalized tag to a block at or below latest", { timeout: liveTimeout },
    async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [, finalized] = await query([], "finalized");
      const [, latest] = await query([], "latest");
      assert.ok(finalized <= latest, `${finalized} > ${latest}`);
    },
  );
});
