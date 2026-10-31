//Every code example in README.md lives here first: the README shows nothing this suite
//  doesn't execute, so the two can't drift apart silently.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { DeriveType } from "@onrail-xyz/binary-layout";
import { serialize, deserialize } from "@onrail-xyz/binary-layout";
import type { Amount } from "@onrail-xyz/amount";
import { Rate } from "@onrail-xyz/amount";
import type { SolKind, UsdKind, DurationKind } from "../src/index.js";
import { amountItem, rateItem, linearTransform, fromAtomicIfKind,
         toAtomicIfAmount, Sol, Usd, Duration, sol, usd, duration } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

describe("README: layout items", () => {
  it("amountItem is a plain uint without a kind and derives an Amount with one", () => {
    assert.deepEqual(amountItem(4), { binary: "uint", size: 4 });
    assert.deepEqual(amountItem(32), { binary: "uint", size: 32 });
    pinEq<DeriveType<ReturnType<typeof amountItem<4>>>, number>(true);
    pinEq<DeriveType<ReturnType<typeof amountItem<32>>>, bigint>(true);

    const accountLayout = {
      balance: amountItem(8, Sol),
      timeout: amountItem(4, Duration, "second"),
    };
    pinEq<DeriveType<typeof accountLayout>, {
      readonly balance: Amount<SolKind>,
      readonly timeout: Amount<DurationKind>,
    }>(true);
    const account = { balance: sol(1), timeout: duration(5, "min") };
    const decoded = deserialize(accountLayout, serialize(accountLayout, account));
    assert(decoded.balance.eq(account.balance));
    assert(decoded.timeout.eq(account.timeout));
  });

  it("linearTransform squeezes an amount into fewer bytes", () => {
    const item = amountItem(4, Sol, linearTransform("stored", 1_000));
    assert.equal(serialize(item, sol(1)).toHex(), (1_000_000).toString(16).padStart(8, "0"));
  });

  it("rateItem wraps an amountItem or builds the same item from scratch", () => {
    const priceItem = rateItem(amountItem(8, Usd, "¢"), Sol);
    pinEq<DeriveType<typeof priceItem>, Rate<UsdKind, SolKind>>(true);
    const fromScratch = rateItem(8, Usd, "¢", Sol);
    const price = Rate.from(usd(150), sol(1));
    assert.deepEqual(serialize(fromScratch, price), serialize(priceItem, price));
    assert.equal(serialize(priceItem, price).toHex(), (15_000).toString(16).padStart(16, "0"));
  });
});

describe("README: utilities", () => {
  it("converts between atomic bigints and amounts only when given a kind", () => {
    assert.equal(fromAtomicIfKind(1_000_000n), 1_000_000n);
    const amount = fromAtomicIfKind(1_000_000n, Sol);
    pinEq<typeof amount, Amount<SolKind>>(true);
    assert(amount.eq(sol(0.001)));

    assert.equal(toAtomicIfAmount(1_000_000n), 1_000_000n);
    assert.equal(toAtomicIfAmount(sol(1)), 1_000_000_000n);
  });
});
