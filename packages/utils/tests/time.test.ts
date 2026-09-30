import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkedDate, unixTime, dateRangeMs, msPerSecond } from "../src/time.js";

const maxMs = dateRangeMs;

describe("unixTime.toDate", () => {
  it("should convert number and bigint seconds alike", () => {
    assert.strictEqual(unixTime.toDate(1700000000).getTime(), 1700000000000);
    assert.strictEqual(unixTime.toDate(1700000000n).getTime(), 1700000000000);
    assert.strictEqual(unixTime.toDate(0).getTime(), 0);
    assert.strictEqual(unixTime.toDate(-1).getTime(), -1000);
  });

  it("should throw instead of yielding an Invalid Date", () => {
    assert.throws(() => unixTime.toDate(maxMs / 1000 + 1), /out of Date range/);
    assert.throws(() => unixTime.toDate(-maxMs / 1000 - 1), /out of Date range/);
    //the "no deadline" sentinel: Number() overflows past the range rather than saturating
    assert.throws(() => unixTime.toDate(2n ** 256n - 1n), /out of Date range/);
    assert.throws(() => unixTime.toDate(NaN), /out of Date range/);
  });

  it("should accept the exact range boundaries", () => {
    assert.strictEqual(unixTime.toDate(maxMs / 1000).getTime(), maxMs);
    assert.strictEqual(unixTime.toDate(-maxMs / 1000).getTime(), -maxMs);
  });
});

describe("unixTime.fromDate", () => {
  it("should floor to whole seconds", () => {
    assert.strictEqual(unixTime.fromDate(new Date(1700000000_999)), 1700000000);
    assert.strictEqual(unixTime.fromDate(new Date(1700000000_000)), 1700000000);
  });

  it("should floor towards -infinity for pre-epoch dates", () => {
    assert.strictEqual(unixTime.fromDate(new Date(-1)), -1);
    assert.strictEqual(unixTime.fromDate(new Date(-1000)), -1);
    assert.strictEqual(unixTime.fromDate(new Date(-1001)), -2);
  });

  it("should throw on an Invalid Date instead of returning NaN", () => {
    assert.throws(() => unixTime.fromDate(new Date("nonsense")), /Invalid date/);
  });

  it("should round-trip whole seconds", () => {
    for (const seconds of [0, 1, -1, 1700000000, -1700000000])
      assert.strictEqual(unixTime.fromDate(unixTime.toDate(seconds)), seconds);
  });
});

describe("checkedDate", () => {
  it("should accept ms numbers and parseable strings", () => {
    assert.strictEqual(checkedDate(1700000000000).getTime(), 1700000000000);
    assert.strictEqual(checkedDate("2023-11-14T22:13:20.000Z").getTime(), 1700000000000);
  });

  it("should round-trip an ISO string (snapshot serialization)", () => {
    const date = new Date(1700000000_123);
    assert.strictEqual(checkedDate(date.toISOString()).getTime(), date.getTime());
  });

  it("should throw instead of yielding an Invalid Date", () => {
    assert.throws(() => checkedDate("nonsense"), /Invalid date/);
    assert.throws(() => checkedDate(maxMs + 1), /Invalid date/);
    assert.throws(() => checkedDate(NaN), /Invalid date/);
  });
});

describe("Date range constants", () => {
  it("either bound itself is a valid Date", () => {
    assert.strictEqual(new Date(dateRangeMs).getTime(), dateRangeMs);
    assert.strictEqual(new Date(-dateRangeMs).getTime(), -dateRangeMs);
  });

  it("one step beyond either bound is an Invalid Date", () => {
    assert.ok(isNaN(new Date(dateRangeMs + 1).getTime()));
    assert.ok(isNaN(new Date(-dateRangeMs - 1).getTime()));
  });

  it("msPerSecond matches unixTime's own scaling", () => {
    assert.strictEqual(unixTime.toDate(1).getTime(), msPerSecond);
  });
});
