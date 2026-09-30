import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Amount, allocate, kind, sum } from "../src/index.js";

const USDC = kind(
  "USDC",
  [ { symbols: [{ symbol: "USDC" }] }, { symbols: [{ symbol: "µUSDC" }], oom: -6 } ],
  { human: "USDC", atomic: "µUSDC" },
);
const usdc = Amount.ofKind(USDC);

describe("allocate", () => {
  it("splits equally, leftover units to the front", () => {
    const parts = allocate(usdc(1), 3);
    assert.deepStrictEqual(parts.map(p => p.in("atomic")), [333_334n, 333_333n, 333_333n]);
    assert(sum(...parts).eq(usdc(1)));
  });

  it("splits pro-rata by weights, fractional weights included", () => {
    const [a, b] = allocate(usdc(5), [4, 1]);
    assert(a.eq(usdc(4)) && b.eq(usdc(1)));

    const [c, d] = allocate(usdc(1), [0.5, 1.5]);
    assert(c.eq(usdc("0.25")) && d.eq(usdc("0.75")));
  });

  it("gives leftover units to the largest fractional shares, earlier index breaking ties", () => {
    const parts = allocate(usdc("0.0001"), [1, 1, 1]); //100 µUSDC into thirds
    assert.deepStrictEqual(parts.map(p => p.in("atomic")), [34n, 33n, 33n]);

    const uneven = allocate(usdc("0.0001"), [2, 3, 5]); //shares 20, 30, 50 - no leftover
    assert.deepStrictEqual(uneven.map(p => p.in("atomic")), [20n, 30n, 50n]);
  });

  it("zero-weight parts get exactly zero", () => {
    const parts = allocate(usdc(1), [1, 0, 1]);
    assert.deepStrictEqual(parts.map(p => p.in("atomic")), [500_000n, 0n, 500_000n]);
  });

  it("quantizes to an explicit unit", () => {
    const parts = allocate(usdc(5), [1, 1], "USDC");
    assert(parts[0].eq(usdc(3)) && parts[1].eq(usdc(2)));
  });

  it("never rounds the total: a non-whole amount throws, quantizing is the caller's call", () => {
    const dusty = usdc("0.0000015");
    assert.throws(() => allocate(dusty, 2), /not a whole number/);
    const parts = allocate(dusty.floorTo("atomic"), 2);
    assert.deepStrictEqual(parts.map(p => p.in("atomic")), [1n, 0n]);
  });

  it("sums exactly for negative amounts too", () => {
    const parts = allocate(usdc(-1), 3);
    assert(sum(...parts).eq(usdc(-1)));
    assert.deepStrictEqual(parts.map(p => p.in("atomic")), [-333_333n, -333_333n, -333_334n]);
  });

  //a count of 0 or NaN made Array.from produce no parts at all, so the whole amount vanished
  //  from the allocation without a word; the empty weights list did the same
  it("refuses part specs that admit no conserving allocation", () => {
    for (const count of [0, -1, 2.5, NaN, Infinity])
      assert.throws(() => allocate(usdc(1), count), /positive integer count/);
    assert.throws(() => allocate(usdc(1), [] as unknown as [number]), /nonempty weights/);
    assert.throws(() => allocate(usdc(1), [0, 0]), /sum to zero/);
    assert.throws(() => allocate(usdc(1), [1, -1]), /sum to zero/);
  });

  it("allows negative weights, which still conserve", () => {
    const parts = allocate(usdc(1), [-1, 2]);
    assert.deepStrictEqual(parts.map(p => p.in("atomic")), [-1_000_000n, 2_000_000n]);
    assert(sum(...parts).eq(usdc(1)));
  });

  it("returns length-typed tuples for literal counts and weight tuples", () => {
    const [a, b, c] = allocate(usdc(1), 3);        //triple, so destructuring typechecks
    const [d, e] = allocate(usdc(1), [1, 2]);      //pair
    assert(sum(a, b, c).eq(usdc(1)) && sum(d, e).eq(usdc(1)));
  });
});
