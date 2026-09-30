import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonParse, jsonStringify } from "@onrail-xyz/utils";
import { Amount, Rational, kind, compare, amountCodec } from "../src/index.js";

const Duration = kind("Duration",
  [ { symbols: [{ symbol: "second", plural: "seconds" }] },
    { symbols: [{ symbol: "minute", plural: "minutes" }], scale: 60n },
    { symbols: [{ symbol: "hour", plural: "hours" }], scale: 3600n },
    { symbols: [{ symbol: "day", plural: "days" }], scale: 86400n } ], { human: "second" });
const seconds = (value: string) => Amount.from(value, Duration, "second");

const Usd = kind("USD",
  [ { symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }] },
    { symbols: [{ symbol: "c", spacing: "compact" }], oom: -2 } ], { human: "$", atomic: "c" });

describe("approximate compound rendering", () => {
  //rounded to whole smallest units before the decomposition, so no part rounds into the next
  it("carries a tail that rounds up", () => {
    assert.equal(seconds("119.6").toString(), "2 minutes");
    assert.equal(seconds("3599.7").toString(), "1 hour");
    assert.equal(seconds("86399.9").toString(), "1 day");
  });

  it("drops a tail that rounds to nothing", () => {
    assert.equal(seconds("60.4").toString(), "1 minute");
    assert.equal(seconds("3600.4").toString(), "1 hour");
  });

  it("keeps significant digits in the smallest unit alone, unless they reach the next", () => {
    assert.equal(seconds("1.5").toString(), "1.5 seconds");
    assert.equal(seconds("59.9996").toString(), "1 minute");
    assert.equal(seconds("-119.6").toString(), "-2 minutes");
  });

  it("leaves exact mode exact", () => {
    assert.equal(seconds("119.6").toString("exact"), "1 minute 59.6 seconds");
  });
});

describe("approximate decimal rendering", () => {
  it("renders a reading that rounds into the next unit in that unit", () => {
    assert.equal(Amount.from("0.9996", Usd).toString(), "$1");
    assert.equal(Amount.from("0.999", Usd).toString(), "99.9c");
  });
});

describe("unit symbols with digits", () => {
  const Usdt0 = kind("USDT0",
    [ { symbols: [{ symbol: "USDT0" }] }, { symbols: [{ symbol: "µUSDT0" }], oom: -6 } ],
    { human: "USDT0", atomic: "µUSDT0" });

  //a postfix symbol ends at the next space, so digits may continue it
  it("admits digits after the first character of a postfix symbol", () => {
    const amount = Amount.from(5, Usdt0);
    assert.equal(amount.toString(), "5 USDT0");
    assert(Amount.parse("5 USDT0", Usdt0).eq(amount));
    assert(Amount.parse("5,000,000 µUSDT0", Usdt0).eq(amount));
  });

  it("rejects a leading digit, and any digit in a prefix symbol", () => {
    assert.throws(() => kind("X", [{ symbols: [{ symbol: "1INCH" }] }]), /Invalid unit symbol/);
    assert.throws(() => kind("X", [{ symbols: [{ symbol: "$1", position: "prefix" }] }]),
      /Invalid unit symbol/);
  });
});

describe("compare", () => {
  it("orders amounts and rationals without subtracting", () => {
    const amounts = ["3", "1", "2"].map(s => seconds(s));
    assert.deepEqual(amounts.sort(compare).map(a => a.toString()),
      ["1 second", "2 seconds", "3 seconds"]);
    assert.equal(compare(Rational.from(1n, 3n), Rational.from(1n, 2n)), -1);
    assert.equal(compare(2n, Rational.from(4n, 2n)), 0);
    assert.throws(() => compare(seconds("1"), Amount.from(1, Usd) as any), /Kind mismatch/);
  });
});

describe("Rational.add", () => {
  //reduced against gcd(d1, d2) only, which must agree with the full normalization
  it("agrees with the normalized cross-product sum", () => {
    const denominators = [1n, 2n, 3n, 4n, 6n, 7n, 10n, 12n, 100n, 7919n, 10n ** 18n, 2n ** 64n];
    for (const d1 of denominators)
      for (const d2 of denominators)
        for (const [n1, n2] of [[1n, 1n], [-3n, 5n], [7n, -7n], [0n, 11n], [123456789n, -1n]]) {
          const lhs = Rational.from(n1!, d1);
          const rhs = Rational.from(n2!, d2);
          const expected = Rational.from(n1! * d2 + n2! * d1, d1 * d2);
          assert.deepEqual(lhs.add(rhs).unwrap(), expected.unwrap(), `${lhs} + ${rhs}`);
        }
  });
});

describe("amountCodec", () => {
  it("takes a single candidate kind as well as a list", () => {
    const codecs = [amountCodec(Usd)];
    const json = jsonStringify(Amount.from(5, Usd), codecs);
    const decoded = jsonParse(json, codecs) as Amount<typeof Usd>;
    assert(decoded.eq(Amount.from(5, Usd)));
  });
});
