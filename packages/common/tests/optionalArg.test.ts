import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DeriveType } from "@onrail-xyz/binary-layout";
import type { Amount } from "@onrail-xyz/amount";
import type { AmountOrAtomic } from "../src/index.js";
import { fromAtomicIfKind, amountItem, Usdc } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

type UsdcKind = typeof Usdc;

//regression: declared `kind?: K`, a kind variable typed `UsdcKind | undefined` inferred K = Usdc -
//  the `?` absorbed the undefined - and the result claimed an Amount the runtime did not return
describe("a kind that may be absent", () => {
  it("fromAtomicIfKind types the union the runtime returns", () => {
    const maybeKind = undefined as UsdcKind | undefined;
    const passed = fromAtomicIfKind(1n, maybeKind);
    const given  = fromAtomicIfKind(1n, Usdc);
    const none   = fromAtomicIfKind(1n);
    pinEq<typeof passed, AmountOrAtomic<UsdcKind | undefined>>(true);
    pinEq<AmountOrAtomic<UsdcKind | undefined>, Amount<UsdcKind> | bigint>(true);
    pinEq<typeof given,  Amount<UsdcKind>>(true);
    pinEq<typeof none,   bigint>(true);
    assert.equal(passed, 1n);
  });
  it("amountItem derives the union", () => {
    const item = amountItem(8, undefined as UsdcKind | undefined);
    pinEq<DeriveType<typeof item>, Amount<UsdcKind> | bigint>(true);
  });
});
