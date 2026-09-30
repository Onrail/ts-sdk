import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Amount } from "@onrail-xyz/amount";
import { Sol, sol } from "../src/units.js";
import { fromAtomicIfKind, toAtomicIfAmount } from "../src/utils.js";

describe("fromAtomicIfKind", () => {
  it("passes the atomic count through without a kind", () => {
    assert.strictEqual(fromAtomicIfKind(1_000_000n), 1_000_000n);
  });

  it("reads the count in the kind's atomic unit", () => {
    const amount = fromAtomicIfKind(1_000_000n, Sol);
    assert(Amount.isOfKind(amount, Sol));
    assert(amount.eq(sol("0.001")));
  });
});

describe("toAtomicIfAmount", () => {
  it("passes a bigint through", () => {
    assert.strictEqual(toAtomicIfAmount(1_000_000n), 1_000_000n);
  });

  it("floors an amount to its atomic count", () => {
    assert.strictEqual(toAtomicIfAmount(sol(1)), 1_000_000_000n);
    assert.strictEqual(toAtomicIfAmount(sol("0.0000000015")), 1n);
  });
});
