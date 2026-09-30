import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Amount, isAmount, scalar } from "../src/amount.js";
import { min, max, sum, compare, clamp } from "../src/aggregating.js";
import type { Kind, DecimalSymbolsOf } from "../src/kind.js";
import { kind, getDecimals, identifyKind } from "../src/kind.js";
import { Rational, tenToThe } from "../src/rational.js";
import { Rate, isRate, invert } from "../src/rate.js";
import { inUnit } from "../src/format.js";

const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "wei"  }]          },
    { symbols: [{ symbol: "Gwei" }], oom:  9 },
    { symbols: [{ symbol: "ETH"  }], oom: 18 } ],
  { human: "ETH", atomic: "wei" },
);

const USD = kind(
  "USD",
  [ { symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }] },
    { symbols: [{ symbol: "c", spacing: "compact" }], oom: -2            } ],
  { human: "$", atomic: "c" },
);

const Duration = kind(
  "Duration",
  [ { symbols: [{ symbol: "second", plural: "seconds" }]                 },
    { symbols: [{ symbol: "minute", plural: "minutes" }], scale:     60n },
    { symbols: [{ symbol: "hour",   plural: "hours"   }], scale:  3_600n },
    { symbols: [{ symbol: "day",    plural: "days"    }], scale: 86_400n } ],
  { human: "second" },
);

const Percentage = scalar(kind(
  "Percentage",
  [ { symbols: [{ symbol: "x"  }]          },
    { symbols: [{ symbol: "%"  }], oom: -2 },
    { symbols: [{ symbol: "bp" }], oom: -4 } ],
  { human: "%" },
));

describe("Amount", () => {
  describe("creation", () => {
    it("creates from number", () => {
      const amount = Amount.from(1, ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 1n]);
      assert.strictEqual(amount.kind.name, "ETH");
    });

    it("creates from bigint", () => {
      const amount = Amount.from(1n, ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 1n]);
      assert.strictEqual(amount.kind.name, "ETH");
    });

    it("creates from Rational", () => {
      const amount = Amount.from(Rational.from(1n, 2n), ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 2n]);
      assert.strictEqual(amount.kind.name, "ETH");
    });

    it("creates from string", () => {
      const amount = Amount.from("1.50", ETH, "wei");
      assert.deepStrictEqual(amount.in("wei").unwrap(), [3n, 2n]);
      assert.strictEqual(amount.kind.name, "ETH");
    });

    it("creates with specific unit", () => {
      const amount = Amount.from(1, ETH, "wei");
      assert.deepStrictEqual(amount.in("wei").unwrap(), [1n, 1n]);
      assert.strictEqual(amount.kind.name, "ETH");
    });

    it("creates with ofKind", () => {
      const amount = Amount.ofKind(ETH)(1);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 1n]);
      assert.strictEqual(amount.kind.name, "ETH");
    });

    it("creates non-decimal kind", () => {
      const amount = Amount.from(90, Duration, "minute");
      assert.deepStrictEqual(amount.in("second").unwrap(), [5400n, 1n]);
    });

    it("creates zero amount", () => {
      const amount = Amount.from(0, ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [0n, 1n]);
      assert.deepStrictEqual(amount.in("atomic"), 0n);
    });

    it("creates negative amount", () => {
      const amount = Amount.from(-1, ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [-1n, 1n]);
      assert.deepStrictEqual(amount.in("atomic"), -tenToThe(18));
    });

    it("creates from negative string", () => {
      const amount = Amount.from("-1.5", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [-3n, 2n]);
    });

    it("creates from very large number", () => {
      const amount = Amount.from(tenToThe(19), ETH, "wei");
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [10n, 1n]);
    });

    it("creates from fractional Rational", () => {
      const amount = Amount.from(Rational.from(1n, 3n), ETH);
      assert.deepStrictEqual(
        amount.in("wei").unwrap(),
        Rational.from(tenToThe(18), 3n).unwrap()
      );
    });

    it("creates with string containing thousands separators", () => {
      const amount = Amount.from("1,000.50", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [2001n, 2n]);
    });

    it("requires unit for non-human kind", () => {
      const NoHuman = kind(
        "NoHuman",
        [{ symbols: [{ symbol: "unit" }] }],
      );
      const amount = Amount.from(1, NoHuman, "unit");
      assert.deepStrictEqual(amount.in("unit").unwrap(), [1n, 1n]);
    });
  });

  describe("instance factories", () => {
    it("zero creates a zero amount of the receiver's kind", () => {
      const amount = Amount.from(5, ETH);
      const z = amount.zero();
      assert.strictEqual(z.kind.name, "ETH");
      assert.deepStrictEqual(z.in("ETH").unwrap(), [0n, 1n]);
      assert(amount.sub(amount).eq(z));
    });

    it("ofSame creates an amount of the receiver's kind in the given unit", () => {
      const amount = Amount.from(1, ETH);
      const o = amount.ofSame(3, "Gwei");
      assert.strictEqual(o.kind.name, "ETH");
      assert.deepStrictEqual(o.in("wei").unwrap(), [3n * tenToThe(9), 1n]);
      assert.deepStrictEqual(amount.ofSame("1.5", "ETH").in("ETH").unwrap(), [3n, 2n]);
    });
  });

  describe("isOfKind", () => {
    //cast rather than annotated: a declared union narrows to its initializer on assignment
    it("narrows amount kind", () => {
      const amt = Amount.from(1, ETH) as Amount<typeof ETH | typeof USD>;
      if (!Amount.isOfKind(amt, ETH))
        throw new Error("unexpected");
      // After narrowing, "wei" should be valid (ETH symbol)
      assert.strictEqual(amt.in("wei").toString(), "1000000000000000000");
    });

    it("returns false for non-matching kind", () => {
      const amt = Amount.from(1, ETH) as Amount<typeof ETH | typeof USD>;
      assert.strictEqual(Amount.isOfKind(amt, USD), false);
    });
  });

  describe("isAmount/isRate", () => {
    it("tell the classes apart without touching the underscored classes", () => {
      type Mixed = Amount<typeof ETH> | Rate<typeof USD, typeof ETH> | Rational;
      const amt: Mixed = Amount.from(1, ETH);
      assert(isAmount(amt) && !isRate(amt));
      if (isAmount(amt))
        assert.strictEqual(amt.in("wei").toString(), "1000000000000000000"); //narrowed to Amount

      const conv: Mixed = Rate.from(3000, USD, ETH);
      assert(isRate(conv) && !isAmount(conv));
      if (isRate(conv))
        assert.strictEqual(conv.in("$", "ETH").toString(), "3000"); //narrowed to Rate

      assert(!isAmount(Rational.from(1n)) && !isRate(Rational.from(1n)));
      assert(!isAmount(1.5 as unknown) && !isRate("1 ETH" as unknown));
    });
  });

  describe("mixed-number parsing", () => {
    it("parses the mixed-number form", () => {
      assert(Amount.parse("2 1/2 hours", Duration).eq(Amount.from(150, Duration, "minute")));
      //prefix-symbol kinds put the fraction after a compact value
      assert(Amount.parse("$1,763,668,414 3/7", USD)
        .eq(Amount.from(12_345_678_901n, USD).div(7)));
    });

    it("rejects malformed mixed numbers", () => {
      assert.throws(() => Amount.parse("1.5 3/7 ETH", ETH));  //integer part must be an integer
      assert.throws(() => Amount.parse("1 3 ETH", ETH));      //second number must be a fraction
      //like decimals, fractions are only allowed in the final unit of a compound amount
      assert.throws(() => Amount.parse("1 1/2 hours 30 minutes", Duration));
    });
  });

  describe("string representation", () => {
    it("default stringification", () => {
      const amount = Amount.from(1, ETH);
      assert.strictEqual(amount.toString(), "1 ETH");
    });

    it("toJSON representation", () => {
      const amount = Amount.from(1, ETH);
      assert.strictEqual(amount.toJSON(), "1 ETH");
    });

    it("ignores what JSON.stringify hands it [toJSON used to declare a ToFixedOptions param, but JSON.stringify calls toJSON(key) with the property key - \"price\", \"0\", or \"\" at the root]", () => {
      const amount = Amount.from(1, ETH);
      assert.strictEqual(amount.toJSON.length, 0);
      assert.strictEqual(JSON.stringify(amount), '"1 ETH"');
      assert.strictEqual(JSON.stringify({ price: amount }), '{"price":"1 ETH"}');
      assert.strictEqual(JSON.stringify([amount]), '["1 ETH"]');
    });

    it("stringification without human unit", () => {
      const Wei = kind(
        "wei",
        [{ symbols: [{ symbol: "wei" }] }],
        { atomic: "wei" },
      );
      const amount = Amount.from(150_000_000n, Wei, "wei");
      assert.strictEqual(amount.toString(), "150,000,000 wei");
    });

    it("non-decimal compound stringification", () => {
      const amount = Amount.from(2, Duration, "hour");
      assert.strictEqual(amount.toString(), "2 hours");

      const amount2 = Amount.from(120, Duration, "minute");
      assert.strictEqual(amount2.toString(), "2 hours");
    });

    it("toJSON is exact and round-trips [used to round at atomic+3 digits]", () => {
      const third = Amount.from(1, ETH).div(3);
      assert.strictEqual(third.toJSON(), "1/3 ETH");
      assert(Amount.parse(third.toJSON(), ETH).eq(third));

      const hairy = Amount.from(12_345_678_901n, ETH).div(7);
      assert.strictEqual(hairy.toJSON(), "1,763,668,414 3/7 ETH");
      assert(Amount.parse(hairy.toJSON(), ETH).eq(hairy));

      const negThird = Amount.from(-1, ETH).div(3);
      assert.strictEqual(negThird.toJSON(), "-1/3 ETH");
      assert(Amount.parse(negThird.toJSON(), ETH).eq(negThird));

      //the unit is the one approximate renders in — the two modes never disagree on it
      assert.strictEqual(Amount.from(0.5, ETH).toJSON(), "0.5 ETH");
      assert.strictEqual(Amount.from(123_456_789n, ETH, "wei").toJSON(), "0.123456789 Gwei");
      assert.strictEqual(Amount.from(15_000n, ETH, "Gwei").toJSON(), "15,000 Gwei");
    });

    it("toJSON is toString(\"exact\") and shares approximate's unit [used to hop units to shave a digit]", () => {
      for (const v of ["0.5", "0.000015", "0.0015", "1234.56789", "0.000000000123456789", "1000000"] as const) {
        const amount = Amount.from(v, ETH);
        assert.strictEqual(amount.toJSON(), amount.toString("exact"));
        assert.strictEqual(amount.toJSON().split(" ").at(-1), amount.toString().split(" ").at(-1));
      }
      //$100.01 used to serialize as "10,001c"
      assert.strictEqual(Amount.from("100.01", USD).toJSON(), "$100.01");
      assert.strictEqual(Amount.from("0.5", USD).toJSON(), "50c");
    });

    it("exact compound renders the tail exactly and round-trips", () => {
      assert.strictEqual(Amount.from("90.5", Duration, "second").toJSON(), "1 minute 30.5 seconds");
      const thirds = Amount.from(1, Duration, "minute").add(Amount.from(1, Duration, "second").div(3));
      assert.strictEqual(thirds.toJSON(), "1 minute 1/3 seconds");
      assert(Amount.parse(thirds.toJSON(), Duration).eq(thirds));
      const mixed = Amount.from(100, Duration, "second").add(Amount.from(1, Duration, "second").div(3));
      assert.strictEqual(mixed.toJSON(), "1 minute 40 1/3 seconds");
      assert(Amount.parse(mixed.toJSON(), Duration).eq(mixed));
    });

    it("keeps the sign outside a prefix symbol [used to emit \"$-100\", which parse rejected]", () => {
      const neg = Amount.from(-100, USD);
      assert.strictEqual(neg.toString(), "-$100");
      assert.strictEqual(neg.toJSON(), "-$100");
      assert(Amount.parse(neg.toJSON(), USD).eq(neg));

      //compactness drops to the postfix cent unit here, where the sign never moved
      const cents = Amount.from(-0.5, USD);
      assert.strictEqual(cents.toJSON(), "-50c");
      assert(Amount.parse(cents.toJSON(), USD).eq(cents));
    });

    it("stringifies zero", () => {
      const amount = Amount.from(0, ETH);
      assert.strictEqual(amount.toString(), "0 ETH");
      assert.strictEqual(amount.toJSON(), "0 ETH");
    });

    it("stringifies negative values", () => {
      const amount = Amount.from(-1, ETH);
      assert.strictEqual(amount.toString(), "-1 ETH");
      assert.strictEqual(amount.toJSON(), "-1 ETH");
    });

    it("stringifies very large values", () => {
      const amount = Amount.from(1_000_000, ETH);
      assert.strictEqual(amount.toString(), "1,000,000 ETH");
    });

    it("stringifies fractional values", () => {
      const amount = Amount.from(1.5, ETH);
      assert.strictEqual(amount.toString(), "1.5 ETH");
    });

    it("stringifies with plural forms", () => {
      const amount1 = Amount.from(1, Duration, "hour");
      assert.strictEqual(amount1.toString(), "1 hour");

      const amount2 = Amount.from(2, Duration, "hour");
      assert.strictEqual(amount2.toString(), "2 hours");
    });

    it("keeps -1 singular in exact rendering [toJSON used to emit \"-1 hours\"]", () => {
      assert.strictEqual(Amount.from(-1, Duration, "hour").toJSON(), "-1 hour");
      //the rounded path compared against +1 only
      assert.strictEqual(inUnit(Duration, Rational.from(-3600n), "hour"), "-1 hour");
      assert.strictEqual(Amount.from(-1, Duration, "hour").toString(), "-1 hour");
    });

    it("stringifies compound non-decimal units", () => {
      const amount = Amount.from(90_000, Duration, "second");
      assert.strictEqual(amount.toString(), "1 day 1 hour");
    });

    it("exact compound keeps the fractional smallest unit [#9 regression]", () => {
      assert.strictEqual(Amount.from("90.5",  Duration, "second").toString("exact"), "1 minute 30.5 seconds");
      assert.strictEqual(Amount.from("90.25", Duration, "second").toString("exact"), "1 minute 30.25 seconds");
      assert.strictEqual(Amount.from("0.5",   Duration, "second").toString("exact"), "0.5 seconds");
    });

    it("units with multiple symbols do not distort compound formatting [#5 regression]", () => {
      const multi = kind("DurMulti", [
        { symbols: [{ symbol: "second", plural: "seconds" }, { symbol: "sec" }] },
        { symbols: [{ symbol: "minute", plural: "minutes" }, { symbol: "min" }], scale: 60n },
        { symbols: [{ symbol: "hour",   plural: "hours"   }, { symbol: "hr"  }], scale: 3600n },
      ]);
      const single = kind("DurSingle", [
        { symbols: [{ symbol: "second", plural: "seconds" }] },
        { symbols: [{ symbol: "minute", plural: "minutes" }], scale: 60n },
        { symbols: [{ symbol: "hour",   plural: "hours"   }], scale: 3600n },
      ]);
      assert.strictEqual(Amount.from(3661, multi, "second").toString("exact"), "1 hour 1 minute 1 second");
      //alternate symbols must never change output vs a single-symbol equivalent (old bug appended "0 sec")
      for (const v of [3661, "3661.5", 90, 7325] as const) {
        assert.strictEqual(Amount.from(v, multi, "second").toString("exact"), Amount.from(v, single, "second").toString("exact"));
        assert.strictEqual(Amount.from(v, multi, "second").toString(),          Amount.from(v, single, "second").toString());
      }
      assert.strictEqual(Amount.from(2, multi, "hr").toString("inUnit", "hr"), "2 hr");
    });

    it("stringifies small fractional amounts", () => {
      const amount = Amount.from(0.001, ETH);
      assert.strictEqual(amount.toString(), "0.001 ETH");
    });

    it("stringifies 0.001 ETH as ETH", () => {
      const amount = Amount.from(0.001, ETH);
      assert.strictEqual(amount.toString(), "0.001 ETH");
    });

    it("stringifies 0.0001 ETH as Gwei", () => {
      const amount = Amount.from(0.0001, ETH);
      assert.strictEqual(amount.toString(), "100,000 Gwei");
    });

    it("approximate formatting is symmetric under negation [used to skip unit promotion]", () => {
      for (const v of ["0.0001", "1234.56789", "1500", "0.000000123", "1"] as const) {
        const pos = Amount.from(v, ETH, "ETH");
        assert.strictEqual("-" + pos.toString(),             pos.mul(-1).toString());
        assert.strictEqual("-" + pos.toString("exact"),    pos.mul(-1).toString("exact"));
      }
    });

    it("exact renders sub-atomic values as they are [precise used to round at atomic+3]", () => {
      const subAtomic = Amount.from(1n, ETH, "wei").div(10_000);
      assert.strictEqual(subAtomic.toString("exact"), "0.0001 wei");
      assert.strictEqual(Amount.from(1n, ETH, "wei").div(-10_000).toString("exact"), "-0.0001 wei");
    });

    it("plural follows the displayed value, not the exact one", () => {
      assert.strictEqual(
        Amount.from("1.0004", Duration, "second").toString("inUnit", "second", { precision: 2 }),
        "1 second",
      );
      assert.strictEqual(Amount.from("0.9999", Duration, "second").toString(), "1 second");
      assert.strictEqual(Amount.from("1.5",    Duration, "second").toString(), "1.5 seconds");
    });

    it("toJSON shows more precision than toString", () => {
      const amount = Amount.from(1.123456789, ETH);
      const json = amount.toJSON();
      const str = amount.toString();
      assert(json.length >= str.length);
    });

    it("toString with explicit approximate mode", () => {
      const amount = Amount.from(1.5, ETH);
      assert.strictEqual(amount.toString("approximate"),                        "1.5 ETH");
      assert.strictEqual(amount.toString("approximate", { thousandsSep: "_" }), "1.5 ETH");
      assert.strictEqual(amount.toString("approximate", { thousandsSep: "" }),  "1.5 ETH");

      const large = Amount.from(1_234.5, ETH);
      assert.strictEqual(large.toString("approximate"),                        "1,235 ETH");
      assert.strictEqual(large.toString("approximate", { thousandsSep: "_" }), "1_235 ETH");
      assert.strictEqual(large.toString("approximate", { thousandsSep: "" }),   "1235 ETH");
    });

    it("toString with exact mode", () => {
      const amount = Amount.from(Rational.from(1_000_123_456_789n, tenToThe(9)), ETH);
      assert.strictEqual(amount.toString("exact"),                        "1,000.123456789 ETH");
      assert.strictEqual(amount.toString("exact", { thousandsSep: "_" }), "1_000.123456789 ETH");
      assert.strictEqual(amount.toString("exact", { thousandsSep: "" }),   "1000.123456789 ETH");
    });

    it("toString with inUnit mode", () => {
      const amount = Amount.from(1, ETH);
      assert.strictEqual(
        amount.toString("inUnit", "Gwei"),
        "1,000,000,000 Gwei"
      );
      assert.strictEqual(
        amount.toString("inUnit", "Gwei", { precision: 0, thousandsSep: "_" }),
        "1_000_000_000 Gwei"
      );
      assert.strictEqual(amount.toString("inUnit", "ETH",  { precision: 2 }), "1 ETH");

      const fractional = Amount.from(1.5, ETH);
      assert.strictEqual(fractional.toString("inUnit", "ETH", { precision: 2 }),      "1.5 ETH");
      assert.strictEqual(fractional.toString("inUnit", "ETH", { precision: "Gwei" }), "1.5 ETH");
    });

    it("toString with inUnit mode using meta-symbols", () => {
      const amount = Amount.from(1n, ETH);
      assert.strictEqual(amount.toString("inUnit", "human", { precision: 2 }), "1 ETH");
      assert.strictEqual(amount.toString("inUnit", "atomic"),   "1,000,000,000,000,000,000 wei");
      assert.strictEqual(amount.toString("inUnit", "standard"), "1,000,000,000,000,000,000 wei");
    });
  });

  describe("conversion", () => {
    it("converts to specific units", () => {
      const amount = Amount.from(1, ETH);
      assert.deepStrictEqual(amount.in("wei").unwrap(), [tenToThe(18), 1n]);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 1n]);
    });

    it("converts to atomic", () => {
      const amount = Amount.from(1, ETH);
      assert.strictEqual(amount.in("atomic"), tenToThe(18));
    });

    it("converts to human", () => {
      const amount = Amount.from(tenToThe(18), ETH, "wei");
      assert.deepStrictEqual(amount.in("human").unwrap(), [1n, 1n]);
    });

    it("converts between kinds via mul", () => {
      const usdPerEth = Rate.from(Rational.from(50_000n, 1n), USD, ETH);
      const amount = Amount.from(1n, ETH);
      const converted = amount.mul(usdPerEth);
      assert.deepStrictEqual(converted.in("human").unwrap(), [50_000n, 1n]);
    });

    it("converts between kinds via div", () => {
      const usdPerEth = Rate.from(Rational.from(50_000n, 1n), USD, ETH);
      const amount = Amount.from(50_000n, USD);
      const converted = amount.div(usdPerEth);
      assert.deepStrictEqual(converted.in("human").unwrap(), [1n, 1n]);
    });

    it("throws on kind mismatch during mul conversion", () => {
      const usdPerEth = Rate.from(Rational.from(50_000n, 1n), USD, ETH);
      const amount = Amount.from(1n, USD);
      // @ts-expect-error - USD amount can't be multiplied by USD/ETH (denominator must match)
      assert.throws(() => amount.mul(usdPerEth), /Kind mismatch: USD vs ETH/);
    });

    it("throws on kind mismatch during div conversion", () => {
      const usdPerEth = Rate.from(Rational.from(50_000n, 1n), USD, ETH);
      const amount = Amount.from(1n, ETH);
      // @ts-expect-error - ETH amount can't be divided by USD/ETH (numerator must match)
      assert.throws(() => amount.div(usdPerEth), /Kind mismatch: ETH vs USD/);
    });

    it("floors to specific unit", () => {
      const amount = Amount.from(1.7, ETH);
      const floored = amount.floorTo("ETH");
      assert.deepStrictEqual(floored.in("ETH"), Rational.from(1));
    });

    it("ceils to specific unit", () => {
      const amount = Amount.from(1.3, ETH);
      const ceiled = amount.ceilTo("ETH");
      assert.deepStrictEqual(ceiled.in("ETH"), Rational.from(2));
    });

    it("floors to atomic unit", () => {
      const value = Rational.from(3n, 2n).mul(tenToThe(18)).add(Rational.from(7n, 10n));
      const amount = Amount.from(value, ETH, "wei");
      const floored = amount.floorTo("wei");
      assert.strictEqual(
        floored.in("atomic"),
        Rational.from(3n, 2n).mul(tenToThe(18)).floor()
      );
    });

    it("ceils to atomic unit", () => {
      const value = Rational.from(3n, 2n).mul(tenToThe(18)).add(Rational.from(3n, 10n));
      const amount = Amount.from(value, ETH, "wei");
      const ceiled = amount.ceilTo("atomic");
      assert.strictEqual(
        ceiled.in("atomic"),
        Rational.from(3n, 2n).mul(tenToThe(18)).floor() + 1n
      );
    });

    it("floors to human unit", () => {
      const amount = Amount.from(1.7, USD);
      const floored = amount.floorTo("human");
      assert.deepStrictEqual(floored.in("human"), Rational.from(1));
    });

    it("ceils to human unit", () => {
      const amount = Amount.from(1.3, USD);
      const ceiled = amount.ceilTo("human");
      assert.deepStrictEqual(ceiled.in("human"), Rational.from(2));
    });

    it("converts non-decimal units", () => {
      const amount = Amount.from(2, Duration, "hour");
      assert.deepStrictEqual(amount.in("minute").unwrap(), [120n, 1n]);
      assert.deepStrictEqual(amount.in("second").unwrap(), [7200n, 1n]);
    });

    it("rounds to specific unit", () => {
      const amount = Amount.from(1.5, ETH);
      const rounded = amount.roundTo("ETH");
      assert.deepStrictEqual(rounded.in("ETH"), Rational.from(2));

      const amount2 = Amount.from(1.4, ETH);
      const rounded2 = amount2.roundTo("ETH");
      assert.deepStrictEqual(rounded2.in("ETH"), Rational.from(1));
    });

    it("rounds to atomic unit", () => {
      const value = Rational.from(3n, 2n).mul(tenToThe(18)).add(Rational.from(5n, 10n));
      const amount = Amount.from(value, ETH, "wei");
      const rounded = amount.roundTo("atomic");
      assert.strictEqual(
        rounded.in("atomic"),
        Rational.from(3n, 2n).mul(tenToThe(18)).floor() + 1n
      );
    });

    it("rounds to human unit", () => {
      const amount = Amount.from(1.5, USD);
      const rounded = amount.roundTo("human");
      assert.deepStrictEqual(rounded.in("human"), Rational.from(2));
    });

    it("converts zero", () => {
      const amount = Amount.from(0, ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [0n, 1n]);
      assert.deepStrictEqual(amount.in("wei").unwrap(), [0n, 1n]);
      assert.strictEqual(amount.in("atomic"), 0n);
    });

    it("converts negative values", () => {
      const amount = Amount.from(-1, ETH);
      assert.deepStrictEqual(amount.in("wei").unwrap(), [-tenToThe(18), 1n]);
      assert.strictEqual(amount.in("atomic"), -tenToThe(18));
    });

    it("converts very large values", () => {
      const amount = Amount.from(tenToThe(19), ETH, "wei");
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [10n, 1n]);
    });

    it("converts fractional values accurately", () => {
      const amount = Amount.from(Rational.from(1n, 3n), ETH);
      const inWei = amount.in("wei");
      assert.deepStrictEqual(inWei.unwrap(), [tenToThe(18), 3n]);
    });

    it("converts between units with different scales", () => {
      const amount = Amount.from(1, Duration, "day");
      assert.deepStrictEqual(amount.in("hour").unwrap(), [24n, 1n]);
      assert.deepStrictEqual(amount.in("minute").unwrap(), [1440n, 1n]);
      assert.deepStrictEqual(amount.in("second").unwrap(), [86400n, 1n]);
    });
  });

  describe("arithmetic", () => {
    it("addition", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(2, ETH);
      const sum = a1.add(a2);
      assert.deepStrictEqual(sum.in("ETH").unwrap(), [3n, 1n]);
    });

    it("subtraction", () => {
      const a1 = Amount.from(2, ETH);
      const a2 = Amount.from(1, ETH);
      const diff = a1.sub(a2);
      assert.deepStrictEqual(diff.in("ETH").unwrap(), [1n, 1n]);
    });

    it("multiplication", () => {
      const amount = Amount.from(2, ETH);
      const product = amount.mul(2);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [4n, 1n]);
    });

    it("division", () => {
      const amount = Amount.from(4, ETH);
      const quotient = amount.div(2);
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [2n, 1n]);
    });

    it("throws on kind mismatch", () => {
      const btc = Amount.from(1, ETH);
      const usd = Amount.from(1, USD);
      // @ts-expect-error | Disallowed by type system but possible at runtime
      assert.throws(() => btc.add(usd), /Kind mismatch: ETH vs USD/);
    });

    it("adds zero", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(0, ETH);
      const sum = a1.add(a2);
      assert.deepStrictEqual(sum.in("ETH").unwrap(), [1n, 1n]);
    });

    it("adds negative values", () => {
      const a1 = Amount.from(5, ETH);
      const a2 = Amount.from(-3, ETH);
      const sum = a1.add(a2);
      assert.deepStrictEqual(sum.in("ETH").unwrap(), [2n, 1n]);
    });

    it("subtracts to negative result", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(2, ETH);
      const diff = a1.sub(a2);
      assert.deepStrictEqual(diff.in("ETH").unwrap(), [-1n, 1n]);
    });

    it("subtracts zero", () => {
      const a1 = Amount.from(5, ETH);
      const a2 = Amount.from(0, ETH);
      const diff = a1.sub(a2);
      assert.deepStrictEqual(diff.in("ETH").unwrap(), [5n, 1n]);
    });

    it("multiplies by zero", () => {
      const amount = Amount.from(5, ETH);
      const product = amount.mul(0);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [0n, 1n]);
    });

    it("multiplies by negative", () => {
      const amount = Amount.from(5, ETH);
      const product = amount.mul(-2);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [-10n, 1n]);
    });

    it("multiplies by Rational", () => {
      const amount = Amount.from(4, ETH);
      const product = amount.mul(Rational.from(3n, 2n));
      assert.deepStrictEqual(product.in("ETH").unwrap(), [6n, 1n]);
    });

    it("multiplies by bigint", () => {
      const amount = Amount.from(2, ETH);
      const product = amount.mul(3n);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [6n, 1n]);
    });

    it("divides by Rational", () => {
      const amount = Amount.from(6, ETH);
      const quotient = amount.div(Rational.from(3n, 2n));
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [4n, 1n]);
    });

    it("divides by bigint", () => {
      const amount = Amount.from(6, ETH);
      const quotient = amount.div(3n);
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [2n, 1n]);
    });

    it("divides by negative", () => {
      const amount = Amount.from(6, ETH);
      const quotient = amount.div(-2);
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [-3n, 1n]);
    });

    it("throws on division by zero", () => {
      const amount = Amount.from(5, ETH);
      assert.throws(() => amount.div(0), /Cannot divide by zero/);
      assert.throws(() => amount.div(0n), /Cannot divide by zero/);
    });

    it("preserves precision in arithmetic", () => {
      const a1 = Amount.from(Rational.from(1n, 3n), ETH);
      const a2 = Amount.from(Rational.from(1n, 3n), ETH);
      const sum = a1.add(a2);
      assert.deepStrictEqual(sum.in("ETH").unwrap(), [2n, 3n]);
    });

    it("throws on kind mismatch in subtraction", () => {
      const btc = Amount.from(1, ETH);
      const usd = Amount.from(1, USD);
      // @ts-expect-error | Disallowed by type system but possible at runtime
      assert.throws(() => btc.sub(usd), /Kind mismatch: ETH vs USD/);
    });
  });

  describe("scalar operations", () => {
    it("multiplies by scalar amount", () => {
      const amount = Amount.from(100, ETH);
      const percentage = Amount.from(50, Percentage, "%");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [50n, 1n]);
    });

    it("multiplies by scalar amount with decimal percentage", () => {
      const amount = Amount.from(100, ETH);
      const percentage = Amount.from(0.5, Percentage, "x");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [50n, 1n]);
    });

    it("multiplies by scalar amount with basis points", () => {
      const amount = Amount.from(100, ETH);
      const percentage = Amount.from(5000, Percentage, "bp");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [50n, 1n]);
    });

    it("divides by scalar amount", () => {
      const amount = Amount.from(50, ETH);
      const percentage = Amount.from(50, Percentage, "%");
      const quotient = amount.div(percentage);
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [100n, 1n]);
    });

    it("divides by scalar amount with decimal percentage", () => {
      const amount = Amount.from(1, ETH);
      const percentage = Amount.from(0.5, Percentage, "x");
      const quotient = amount.div(percentage);
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [2n, 1n]);
    });

    it("multiplies USD by percentage", () => {
      const amount = Amount.from(100, USD);
      const percentage = Amount.from(10, Percentage, "%");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("$").unwrap(), [10n, 1n]);
    });

    it("multiplies Duration by percentage", () => {
      const amount = Amount.from(100, Duration);
      const percentage = Amount.from(25, Percentage, "%");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("second").unwrap(), [25n, 1n]);
    });

    it("preserves precision when multiplying by scalar", () => {
      const amount = Amount.from(Rational.from(1n, 3n), ETH);
      const percentage = Amount.from(50, Percentage, "%");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [1n, 6n]);
    });

    it("preserves precision when dividing by scalar", () => {
      const amount = Amount.from(Rational.from(1n, 3n), ETH);
      const percentage = Amount.from(50, Percentage, "%");
      const quotient = amount.div(percentage);
      assert.deepStrictEqual(quotient.in("ETH").unwrap(), [2n, 3n]);
    });

    it("multiplies by zero scalar", () => {
      const amount = Amount.from(100, ETH);
      const percentage = Amount.from(0, Percentage);
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [0n, 1n]);
    });

    it("multiplies by negative scalar", () => {
      const amount = Amount.from(100, ETH);
      const percentage = Amount.from(-10, Percentage, "%");
      const product = amount.mul(percentage);
      assert.deepStrictEqual(product.in("ETH").unwrap(), [-10n, 1n]);
    });

    it("throws on division by zero scalar", () => {
      const amount = Amount.from(100, ETH);
      const percentage = Amount.from(0, Percentage);
      assert.throws(() => amount.div(percentage), /Cannot divide by zero/);
    });

    it("scalar times and over scalar stay scalar; their ratio is a Rational", () => {
      const product: Amount<typeof Percentage> = Amount.from(10, Percentage).mul(Amount.from(50, Percentage));
      assert.strictEqual(product.toString(), "5 %");
      const quotient: Amount<typeof Percentage> = Amount.from(10, Percentage).div(Amount.from(50, Percentage));
      assert.strictEqual(quotient.toString(), "20 %");
      assert.deepStrictEqual(Amount.from(10, Percentage).ratio(Amount.from(50, Percentage)).unwrap(), [1n, 5n]);
    });
  });

  describe("utility members", () => {
    it("isZero", () => {
      assert(Amount.from(0, ETH).isZero());
      assert(!Amount.from(1, ETH, "wei").isZero());
    });

    it("abs/neg/sign", () => {
      assert(Amount.from(-1.5, ETH).abs().eq(Amount.from(1.5, ETH)));
      assert(Amount.from(1.5, ETH).abs().eq(Amount.from(1.5, ETH)));
      assert(Amount.from(0, ETH).abs().isZero());
      assert(Amount.from(1.5, ETH).neg().eq(Amount.from(-1.5, ETH)));
      assert(Amount.from(-1.5, ETH).neg().eq(Amount.from(1.5, ETH)));
      assert.strictEqual(Amount.from(-1.5, ETH).sign(), -1);
      assert.strictEqual(Amount.from(0, ETH).sign(), 0);
      assert.strictEqual(Amount.from(1.5, ETH).sign(), 1);
    });

    it("min/max/sum over Rationals", () => {
      const half = Rational.from(1n, 2n);
      assert(min(half, 2n, 0.25).eq(Rational.from(1n, 4n)));
      assert(max(half, 2n, 0.25).eq(Rational.from(2n)));
      assert(sum(half, half, 1n).eq(Rational.from(2n)));
      //a possibly-empty collection spreads behind an explicit first operand
      assert(sum(Rational.from(0n), ...([] as Rational[])).eq(Rational.from(0n)));
    });

    it("min/max", () => {
      const a = Amount.from(1, ETH);
      const b = Amount.from(2, ETH);
      const c = Amount.from(3, ETH);
      assert(min(a, b, c).eq(a));
      assert(min(c).eq(c));
      assert(max(a, b, c).eq(c));
      assert(max(b, a).eq(b));
      assert.throws(() => min(a, Amount.from(1, USD)), /Kind mismatch/);
    });

    it("sum", () => {
      const s = sum(Amount.from(1, ETH), Amount.from(2, ETH), Amount.from(3, ETH));
      assert(s.eq(Amount.from(6, ETH)));
      assert(sum(Amount.from(1, ETH)).eq(Amount.from(1, ETH)));
      //an empty sum needs to know its kind, so a dynamic collection spreads behind its zero
      const fees: Amount<typeof ETH>[] = [];
      assert(sum(Amount.from(0, ETH), ...fees).isZero());
      assert.throws(() => sum(Amount.from(1, ETH), Amount.from(1, USD)), /Kind mismatch/);
    });

    it("compare works as a sort comparator, clamp composes min/max", () => {
      const [one, two] = [Amount.from(1, ETH), Amount.from(2, ETH)];
      assert.deepStrictEqual([compare(one, two), compare(two, one), compare(one, one)], [-1, 1, 0]);
      assert.deepStrictEqual(
        [two, one].sort(compare).map(x => x.toString()),
        ["1 ETH", "2 ETH"],
      );
      assert(clamp(Amount.from(5, ETH), one, two).eq(two));
      assert(clamp(Amount.from(0, ETH), one, two).eq(one));
      assert(clamp(Amount.from(1.5, ETH), one, two).eq(Amount.from(1.5, ETH)));

      assert.strictEqual(compare(Rational.from(1n, 2n), 0.5), 0);
      assert(clamp(0.1, Rational.from(1n, 4n), 2n).eq(Rational.from(1n, 4n)));

      const [cheap, dear] = [Amount.from(1, USD).per(ETH), Amount.from(2, USD).per(ETH)];
      assert.strictEqual(compare(cheap, dear), -1);
      assert(clamp(dear.mul(5), cheap, dear).eq(dear));
      // @ts-expect-error | Disallowed by type system but possible at runtime
      assert.throws(() => compare(one, Amount.from(1, USD)), /Kind mismatch/);
    });

    it("min/max/sum over Rates", () => {
      const a = Amount.from(1, USD).per(ETH);
      const b = Amount.from(2, USD).per(ETH);
      const c = Amount.from(3, USD).per(ETH);
      assert(min(a, b, c).eq(a));
      assert(max(a, b, c).eq(c));
      assert(sum(a, b, c).eq(Amount.from(6, USD).per(ETH)));
      assert.throws(() => min(a, Amount.from(1, ETH).per(USD)), /Kind mismatch/);
    });
  });

  describe("ratio", () => {
    it("returns a Rational", () => {
      const a = Amount.from(10, ETH);
      const b = Amount.from(4, ETH);
      assert.deepStrictEqual(a.ratio(b).unwrap(), [5n, 2n]);
    });

    //at a union K the types admit an operand of the other kind; the runtime check is what stops it
    it("throws on a kind mismatch that a union K lets through", () => {
      const ratioOf = <K extends Kind>(a: Amount<K>, b: Amount<K>) => a.ratio(b);
      assert.throws(() => ratioOf<typeof ETH | typeof USD>(Amount.from(1, ETH), Amount.from(2, USD)),
        /Kind mismatch/);
      assert.throws(() =>
        ratioOf<typeof ETH | typeof Percentage>(Amount.from(1, ETH), Amount.from(2, Percentage)),
        /Kind mismatch/);
    });

    it("works with mod for divmod semantics", () => {
      const a = Amount.from(10, ETH);
      const b = Amount.from(3, ETH);
      const remainder = a.mod(b);
      assert.deepStrictEqual(remainder.in("ETH").unwrap(), [1n, 1n]);
    });
  });

  describe("per", () => {
    it("creates conversion from amount and kind", () => {
      const usd = Amount.from(50_000, USD);
      const conv = usd.per(ETH);
      assert.strictEqual(conv.in("$", "ETH").toString(), "50000");
    });

    it("creates conversion from two amounts", () => {
      const usd = Amount.from(50_000, USD);
      const eth = Amount.from(2, ETH);
      const conv = usd.per(eth);
      assert.strictEqual(conv.in("$", "ETH").toString(), "25000");
    });

    it("produces same result as Rate.from", () => {
      const usd = Amount.from(50_000, USD);
      const fromPer = usd.per(ETH);
      const fromConv = Rate.from(usd, ETH);
      assert.strictEqual(
        fromPer.in("$", "ETH").toString(),
        fromConv.in("$", "ETH").toString(),
      );
    });

    it("throws on same kind", () => {
      const eth = Amount.from(1, ETH);
      assert.throws(() => eth.per(ETH), /Must be distinct kinds: ETH vs ETH/);
    });

    //scalar kinds used to be rejected at the type level, which made pure reciprocal
    //  dimensions (APR: Percentage/Duration) unrepresentable
    it("accepts scalar kinds on either side", () => {
      const apr = Amount.from(10, Percentage).per(ETH);
      assert.strictEqual(apr.in("%", "ETH").toString(), "10");

      const dv01 = Amount.from(1, ETH).per(Percentage);
      assert.strictEqual(dv01.in("ETH", "%").toString(), "1");
    });
  });

  describe("comparison", () => {
    it("equality", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(1, ETH);
      const a3 = Amount.from(2, ETH);
      assert(a1.eq(a2));
      assert(!a1.eq(a3));
    });

    it("inequality", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(2, ETH);
      assert(a1.ne(a2));
    });

    it("greater than", () => {
      const a1 = Amount.from(2, ETH);
      const a2 = Amount.from(1, ETH);
      assert(a1.gt(a2));
      assert(!a2.gt(a1));
    });

    it("less than", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(2, ETH);
      assert(a1.lt(a2));
      assert(!a2.lt(a1));
    });

    it("greater than or equal", () => {
      const a1 = Amount.from(2, ETH);
      const a2 = Amount.from(1, ETH);
      const a3 = Amount.from(2, ETH);
      assert(a1.ge(a2));
      assert(!a2.ge(a1));
      assert(a1.ge(a3));
    });

    it("less than or equal", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(2, ETH);
      const a3 = Amount.from(1, ETH);
      assert(a1.le(a2));
      assert(!a2.le(a1));
      assert(a1.le(a3));
    });

    it("compares zero", () => {
      const zero = Amount.from(0, ETH);
      const positive = Amount.from(1, ETH);
      const negative = Amount.from(-1, ETH);
      assert(zero.eq(zero));
      assert(zero.lt(positive));
      assert(zero.gt(negative));
      assert(zero.le(positive));
      assert(zero.ge(negative));
    });

    it("compares negative values", () => {
      const a1 = Amount.from(-1, ETH);
      const a2 = Amount.from(-2, ETH);
      assert(a1.gt(a2));
      assert(a2.lt(a1));
      assert(a1.ge(a2));
      assert(a2.le(a1));
    });

    it("compares across units", () => {
      const a1 = Amount.from(1, ETH);
      const a2 = Amount.from(tenToThe(18), ETH, "wei");
      assert(a1.eq(a2));
    });

    it("compares fractional values", () => {
      const a1 = Amount.from(1.5, ETH);
      const a2 = Amount.from(1.6, ETH);
      assert(a1.lt(a2));
      assert(a2.gt(a1));
    });

    it("throws on kind mismatch", () => {
      const btc = Amount.from(1, ETH);
      const usd = Amount.from(1, USD);
      // @ts-expect-error | Disallowed by type system but possible at runtime
      assert.throws(() => btc.eq(usd), /Kind mismatch: ETH vs USD/);
      // @ts-expect-error | Disallowed by type system but possible at runtime
      assert.throws(() => btc.gt(usd), /Kind mismatch: ETH vs USD/);
    });

    it("compares very close values", () => {
      const a1 = Amount.from(Rational.from(1n, 3n), ETH);
      const a2 = Amount.from(Rational.from(1n, 3n), ETH);
      assert(a1.eq(a2));
      assert(!a1.ne(a2));
    });
  });

  describe("parsing", () => {
    it("parses simple amount string", () => {
      const amount = Amount.parse("1 ETH", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 1n]);
    });

    it("parses amount with wei", () => {
      const amount = Amount.parse(`${tenToThe(18)} wei`, ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 1n]);
    });

    it("parses negative amount", () => {
      const amount = Amount.parse("-1 ETH", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [-1n, 1n]);
    });

    it("parses fractional amount", () => {
      const amount = Amount.parse("1.5 ETH", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [3n, 2n]);
    });

    it("parses ratio amount", () => {
      const amount = Amount.parse("1/3 ETH", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1n, 3n]);
    });

    it("parses compound non-decimal amount", () => {
      const amount = Amount.parse("2 hours 30 minutes", Duration);
      assert.deepStrictEqual(amount.in("second").unwrap(), [9000n, 1n]);
    });

    it("identifies kind from string", () => {
      const kind = identifyKind([ETH, USD], "1 ETH");
      assert.strictEqual(kind?.name, "ETH");
    });

    it("returns undefined for ambiguous kind", () => {
      const Both = kind(
        "Both",
        [
          { symbols: [{ symbol: "ETH" }]                                              },
          { symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }], oom: 2 },
        ],
        { human: "ETH" },
      );
      const result = identifyKind([ETH, Both], "1 ETH");
      assert.strictEqual(result, undefined);
    });

    it("returns all matches when ambiguous allowed", () => {
      const Both = kind(
        "Both",
        [
          { symbols: [{ symbol: "ETH" }] },
        ],
        { human: "ETH" },
      );
      const matches = identifyKind([ETH, Both], "1 ETH", true);
      assert(Array.isArray(matches));
      assert(matches.length === 2);
    });

    it("throws on unparseable string", () => {
      assert.throws(
        () => Amount.parse("invalid", ETH),
        /Expected value|Could not identify kind from string/
      );
    });

    it("parses amount with thousands separators", () => {
      const amount = Amount.parse("1,000 ETH", ETH);
      assert.deepStrictEqual(amount.in("ETH").unwrap(), [1000n, 1n]);
    });

    it("does not mistake Object.prototype members for units", () => {
      assert.strictEqual(identifyKind([ETH], "1 toString"), undefined);
      assert.throws(() => Amount.parse("1 constructor", ETH), /Could not identify kind/);
      assert.throws(
        () => Rate.parse("1 ETH/hasOwnProperty", ETH, USD),
        /Could not identify denominator kind/,
      );
    });

    it("matches symbols by their NFKC form", () => {
      const [micro, mu] = ["\u00b5", "\u03bc"];
      const microKind = kind("MicroKind", [
        { symbols: [{ symbol: "s" }] },
        { symbols: [{ symbol: `${micro}s` }], oom: -6 },
      ], { human: "s" });
      const muKind = kind("MuKind", [
        { symbols: [{ symbol: "s" }] },
        { symbols: [{ symbol: `${mu}s` }], oom: -6 },
      ], { human: "s" });
      assert(Amount.parse(`5 ${mu}s`, microKind).eq(Amount.from("0.000005", microKind, "s")));
      assert(Amount.parse(`5 ${micro}s`, muKind).eq(Amount.from("0.000005", muKind, "s")));
      assert.strictEqual(identifyKind([microKind, ETH], `5 ${mu}s`)?.name, "MicroKind");
      assert(Rate.parse(`1 ETH/${mu}s`, ETH, microKind).eq(Rate.parse(`1 ETH/${micro}s`, ETH, microKind)));

      const Volume = kind("Volume", [{ symbols: [{ symbol: "m³" }] }]);
      const Temp   = kind("Temp",   [{ symbols: [{ symbol: "°C" }] }]);
      assert.strictEqual(Amount.parse("3 m3", Volume).toString(), "3 m³");
      assert.strictEqual(Amount.parse("20 \u2103", Temp).toString(), "20 °C");
    });

    it("rejects a kind that declares two equivalent spellings", () => {
      const [micro, mu] = ["\u00b5", "\u03bc"];
      assert.throws(() => kind("Both", [
        { symbols: [{ symbol: "x" }] },
        { symbols: [{ symbol: `${mu}x` }],    oom: -3 },
        { symbols: [{ symbol: `${micro}x` }], oom: -6 },
      ], { human: "x" }), /is equivalent to/);
      assert.throws(() => kind("Vol", [{ symbols: [{ symbol: "m3" }, { symbol: "m³" }] }]), /is equivalent to/);
    });
  });

  describe("formatting utilities", () => {
    it("formats in specific unit with precision", () => {
      const amount = Amount.from(1.123456789, ETH);
      const stdVal = amount.in("wei");
      const formatted = inUnit(ETH, stdVal, "ETH", 2);
      assert.strictEqual(formatted, "1.12 ETH");
    });

    it("formats with custom thousands separator", () => {
      const amount = Amount.from(1_000_000, ETH);
      const stdVal = amount.in("wei");
      const formatted = inUnit(ETH, stdVal, "ETH", 0, { thousandsSep: "_" });
      assert.strictEqual(formatted, "1_000_000 ETH");
    });

    it("formats zero in unit", () => {
      const amount = Amount.from(0, ETH);
      const stdVal = amount.in("wei");
      const formatted = inUnit(ETH, stdVal, "ETH", 0);
      assert.strictEqual(formatted, "0 ETH");
    });

    it("formats negative in unit", () => {
      const amount = Amount.from(-1, ETH);
      const stdVal = amount.in("wei");
      const formatted = inUnit(ETH, stdVal, "ETH", 0);
      assert.strictEqual(formatted, "-1 ETH");
    });
  });

  describe("powers of ten", () => {
    it("returns 1 for oom 0", () => {
      assert.deepStrictEqual(Rational.powerOfTen(0).unwrap(), [1n, 1n]);
    });

    it("returns positive powers of ten", () => {
      assert.deepStrictEqual(Rational.powerOfTen(1).unwrap(), [10n, 1n]);
      assert.deepStrictEqual(Rational.powerOfTen(2).unwrap(), [100n, 1n]);
      assert.deepStrictEqual(Rational.powerOfTen(3).unwrap(), [1000n, 1n]);
      assert.deepStrictEqual(Rational.powerOfTen(18).unwrap(), [1_000_000_000_000_000_000n, 1n]);
    });

    it("returns negative powers of ten", () => {
      assert.deepStrictEqual(Rational.powerOfTen(-1).unwrap(), [1n, 10n]);
      assert.deepStrictEqual(Rational.powerOfTen(-2).unwrap(), [1n, 100n]);
      assert.deepStrictEqual(Rational.powerOfTen(-3).unwrap(), [1n, 1000n]);
    });

    it("handles large exponents", () => {
      assert.deepStrictEqual(tenToThe(30), 10n**30n);
      assert.deepStrictEqual(Rational.powerOfTen(-30).unwrap(), [1n, 10n**30n]);
    });

    it("handles exponents beyond cache limit", () => {
      assert.deepStrictEqual(tenToThe(50), 10n**50n);
      assert.deepStrictEqual(Rational.powerOfTen(-50).unwrap(), [1n, 10n**50n]);
    });
  });
});

describe("kind validation", () => {
  it("rejects non-positive scales", () => {
    for (const scale of [0n, -5n, Rational.from(-1n, 2n)] as const)
      assert.throws(
        () => kind("Bad", [{ symbols: [{ symbol: "a" }] }, { symbols: [{ symbol: "b" }], scale }]),
        /Unit scales must be positive/,
      );
  });

  //a kind is built at module load, so BigInt's own rejection surfaces before anything can run
  it("rejects non-integer orders of magnitude", () => {
    assert.throws(
      () => kind("Bad", [{ symbols: [{ symbol: "a" }] }, { symbols: [{ symbol: "b" }], oom: 1.5 }]),
      /1\.5 cannot be converted to a BigInt because it is not an integer/,
    );
    assert.throws(() => tenToThe(1.5), /not an integer/);
    assert.throws(() => Rational.powerOfTen(-1.5), /not an integer/);
    assert.throws(() => Rational.powerOfTen(NaN), /not an integer/);
  });

  it("rejects units named like a meta symbol", () => {
    for (const symbol of ["standard", "human", "atomic"] as const)
      assert.throws(
        () => kind("Bad", [{ symbols: [{ symbol: "a" }] }, { symbols: [{ symbol }], oom: -6 }]),
        /reserved symbol/,
      );
  });

  it("rejects systems named like a display mode", () => {
    for (const name of ["approximate", "exact", "inUnit"] as const)
      assert.throws(
        () => kind("Bad", [[name, [{ symbols: [{ symbol: "a" }] }]]]),
        /display mode/,
      );
  });

  it("rejects symbols that could not round-trip through parsing [used to accept them silently]", () => {
    for (const symbol of ["3m", "sq ft", "", "a,b", "a_b", "a.b", "a/b", "-x", "a\tb"])
      assert.throws(
        () => kind("Bad", [{ symbols: [{ symbol }] }]),
        /Invalid unit symbol/,
        JSON.stringify(symbol),
      );
    //plurals are symbols too
    assert.throws(
      () => kind("Bad", [{ symbols: [{ symbol: "a", plural: "2a" }] }]),
      /Invalid unit symbol/,
    );
    //unicode stays fair game
    const Fancy = kind("Fancy", [{ symbols: [{ symbol: "m³" }, { symbol: "µ°€" }] }]);
    assert.ok("µ°€" in Fancy.units);
  });

  it("rejects duplicate symbols within a system, allows sharing across systems", () => {
    assert.throws(
      () => kind("Bad", [{ symbols: [{ symbol: "a" }, { symbol: "a" }] }]),
      /Duplicate symbol/,
    );
    //the same symbol at the same scale in different systems is sharing, not a clash
    const Byte = kind("Byte", [
      ["SI",     [{ symbols: [{ symbol: "byte" }] }, { symbols: [{ symbol: "kB"  }], oom: 3    }]],
      ["binary", [{ symbols: [{ symbol: "byte" }], scale: 1 }, { symbols: [{ symbol: "KiB" }], scale: 1024 }]],
    ]);
    assert.ok("byte" in Byte.units && "KiB" in Byte.units);
  });

  it("a lone unit with explicit scale 1 forms a non-decimal system [exact rendering used to crash]", () => {
    const Single = kind("Single", [{ symbols: [{ symbol: "foo" }], scale: 1n }]);
    assert.strictEqual(Single.systems.default.decimal, false);
    assert.strictEqual(Amount.from("5.5", Single, "foo").toString("exact"), "5.5 foo");
    assert.strictEqual(Amount.from(5, Single, "foo").toString(), "5 foo");
  });

  it("reports missing units instead of crashing on undefined", () => {
    const NoHuman = kind("NoHuman", [{ symbols: [{ symbol: "q" }] }]);
    // @ts-expect-error | Disallowed by type system but possible at runtime
    assert.throws(() => Amount.from(1, NoHuman), /has no unit human/);
  });

  it("rejects a repeated system name", () => {
    assert.throws(
      () => kind("Bad", [
        ["a", [{ symbols: [{ symbol: "x" }] }]],
        ["a", [{ symbols: [{ symbol: "y" }], scale: 2n }]],
      ] as const),
      /Duplicate system/,
    );
  });

  //an explicit empty plural used to be skipped silently, leaving a symbol the type declares
  //  and the runtime lacks
  it("rejects an empty plural like any empty symbol", () => {
    assert.throws(
      () => kind("Bad", [{ symbols: [{ symbol: "x", plural: "" }] }]),
      /Invalid unit symbol/,
    );
  });

  //regression: a shared symbol kept the first system's record wholesale, so a decimal system
  //  declared second lost its oom and getDecimals called the unit non-decimal
  it("merges a shared symbol's decimal metadata whichever system declares it first", () => {
    const Time = kind("Time", [
      ["compound", [{ symbols: [{ symbol: "s" }] }, { symbols: [{ symbol: "min" }], scale: 60n }]],
      ["decimal",  [{ symbols: [{ symbol: "s" }], oom: 0 }, { symbols: [{ symbol: "ms" }], oom: -3 }]],
    ]);
    assert.strictEqual(getDecimals(Time, { of: "s", in: "ms" }), 3);
  });

  it("isOfKind takes only a kind the union spells", () => {
    const picked = Amount.parse("1.5 ETH", ETH, USD);
    // @ts-expect-error | a kind the union does not spell
    Amount.isOfKind(picked, Duration);
    assert.strictEqual(Amount.isOfKind(picked, USD), false);
  });

  //regression: isOfKind took a name, which narrowed a bare Amount<Kind> to never - a name
  //  alone cannot rebuild a kind, the kind object can
  it("isOfKind narrows a bare-kind amount to any kind given", () => {
    const bare = Amount.parse("1.5 ETH", ETH, USD) as Amount<Kind>;
    assert.strictEqual(Amount.isOfKind(bare, Duration), false);
    if (!Amount.isOfKind(bare, ETH))
      throw new Error("unexpected");
    const narrowed: Amount<typeof ETH> = bare;
    assert.strictEqual(narrowed.in("wei").toString(), "1500000000000000000");
  });

  it("getDecimals rejects non-decimal units", () => {
    // @ts-expect-error | Disallowed by type system but possible at runtime
    assert.throws(() => getDecimals(Duration, { of: "second", in: "minute" }), /is not decimal/);
    assert.strictEqual(getDecimals(ETH), 18);
    assert.strictEqual(getDecimals(ETH, { of: "ETH", in: "Gwei" }), 9);
  });
});

describe("Multi-system kinds", () => {
  const inch = Rational.from(254n, tenToThe(4));

  const Length = kind(
    "Length",
    [
      ["metric", [
        { symbols: [{ symbol: "m"  }]           },
        { symbols: [{ symbol: "cm" }], oom:  -2 },
        { symbols: [{ symbol: "mm" }], oom:  -3 },
        { symbols: [{ symbol: "km" }], oom:   3 },
      ]],
      ["imperial", [
        { symbols: [{ symbol: "in" }], scale: inch              },
        { symbols: [{ symbol: "ft" }], scale: inch.mul(12)      },
        { symbols: [{ symbol: "yd" }], scale: inch.mul(36)      },
        { symbols: [{ symbol: "mi" }], scale: inch.mul(36*1760) },
      ]],
    ],
    { human: "m" },
  );

  it("creates kind with multiple systems", () => {
    assert.strictEqual(Length.name, "Length");
    assert.deepStrictEqual(Object.keys(Length.systems).sort(), ["imperial", "metric"]);
  });

  it("has all symbols from all systems in units", () => {
    assert.ok("m" in Length.units);
    assert.ok("cm" in Length.units);
    assert.ok("ft" in Length.units);
    assert.ok("mi" in Length.units);
  });

  it("tracks which symbols belong to which system", () => {
    assert.ok(Length.systems.metric.symbols.includes("m"));
    assert.ok(Length.systems.metric.symbols.includes("cm"));
    assert.ok(Length.systems.imperial.symbols.includes("ft"));
    assert.ok(Length.systems.imperial.symbols.includes("mi"));
  });

  it("tracks decimal flag per system", () => {
    assert.strictEqual(Length.systems.metric.decimal, true);
    assert.strictEqual(Length.systems.imperial.decimal, false);

    // Type-level verification: DecimalSymbolsOf only includes metric (decimal) symbols
    const _oomSymbols: DecimalSymbolsOf<typeof Length> = "m";
    const _oomSymbols2: DecimalSymbolsOf<typeof Length> = "km";
    // @ts-expect-error - "ft" is imperial (non-decimal), not in DecimalSymbolsOf
    const _notOom: DecimalSymbolsOf<typeof Length> = "ft";
  });

  it("precision-as-symbol allowed for oom units", () => {
    // Use a value with decimals to show precision effect (toFixedPoint strips trailing zeros)
    const len = Amount.from("1.2345", Length, "m");
    // precision as symbol: calculates decimals from oom difference
    // m (oom=0) with precision "cm" (oom=-2) → 0-(-2)=2 decimals → rounds to 1.23
    assert.strictEqual(len.toString("inUnit", "m", { precision: "cm" }), "1.23 m");
    // km (oom=3) with precision "m" (oom=0) → 3-0=3 decimals
    assert.strictEqual(len.toString("inUnit", "km", { precision: "m" }), "0.001 km");
    // numeric precision works for any unit
    assert.strictEqual(len.toString("inUnit", "ft", { precision: 2 }), "4.05 ft");
  });

  it("precision-as-symbol rejects non-oom symbols at type level", () => {
    const len = Amount.from(1, Length, "m");
    // Type-level verification only - never executed at runtime
    if (false as boolean) {
      // @ts-expect-error - "in" is not an oom symbol (imperial is non-decimal)
      len.toString("inUnit", "m", { precision: "in" });
      // @ts-expect-error - "ft" is non-decimal, so NO symbol precision allowed
      len.toString("inUnit", "ft", { precision: "cm" });
    }
  });

  it("formats using (default) metric system", () => {
    const amount = Amount.from(1500, Length, "m");
    assert.strictEqual(amount.toString("approximate"), "1.5 km");
  });

  it("renders zero in the requested system [used to fall back to the kind default]", () => {
    const zero = Amount.from(0, Length, "m");
    assert.strictEqual(zero.toString(), "0 m");
    assert.strictEqual(zero.toString("imperial"), "0 in");
    assert.strictEqual(zero.toJSON(), "0 m");
  });

  it("formats using imperial system (compound)", () => {
    const fiveTen = Amount.from(5, Length, "ft").add(Amount.from(10, Length, "in"));
    assert.strictEqual(fiveTen.toString("approximate", { system: "imperial" }), "1 yd 2 ft 10 in");
    assert.strictEqual(fiveTen.toString("imperial"), "1 yd 2 ft 10 in");

    const twoMiles = Amount.from(2, Length, "mi");
    assert.strictEqual(twoMiles.toString("imperial"), "2 mi");
    assert.strictEqual(twoMiles.toString("imperial", { thousandsSep: "_" }), "2 mi");
  });

  it("converts between systems", () => {
    const height = Amount.from(1.78, Length, "m");
    const inFeet = height.in("ft");
    assert.strictEqual(inFeet.toFixed(2), "5.84");

    const inInches = height.in("in");
    assert.strictEqual(inInches.toFixed(1), "70.1");
  });

  it("throws on conflicting scales for same symbol", () => {
    assert.throws(() => kind(
      "BadKind",
      [
        ["sys1", [{ symbols: [{ symbol: "X" }] }]],
        ["sys2", [{ symbols: [{ symbol: "X" }], scale: 2n }]],
      ],
    ), /conflicting scales/);
  });

  it("rejects non-primary system without scale/oom at type level", () => {
    // Type-level verification only - no runtime check needed
    if (false as boolean) {
      kind(
        "BadKind",
        // @ts-expect-error - only the first system can omit oom/scale
        [
          ["primary", [{ symbols: [{ symbol: "X" }] }]],
          ["secondary", [{ symbols: [{ symbol: "Y" }] }]],
        ],
      );
    }
  });
});

describe("kind-generic consumers", () => {
  //the kind-preserving mul/div overloads return the class type, so open-K chains keep K
  //  alive [they used to return the distributive alias, which defers to a conditional and
  //  erases K to its constraint at the next method call]
  it("scalar arithmetic chains keep an open kind parameter alive", () => {
    const compound = <K extends Kind>(amt: Amount<K>): Amount<K> =>
      amt.mul(3).div(2).add(amt);

    assert.ok(compound(Amount.from(5, ETH)).eq(Amount.from("12.5", ETH)));
    assert.ok(compound(Amount.from(2, USD)).eq(Amount.from(5, USD)));
  });

  it("conversion scalar ops and inv keep open kind parameters alive", () => {
    //inv erases at an open kind, so the swap goes through the shipped kind-surgery function
    const halveInverted = <NK extends Kind, DK extends Kind>(
      conv: Rate<NK, DK>,
    ): Rate<DK, NK> => invert(conv.div(2));

    const price = Rate.from(3000, USD, ETH);
    assert.ok(halveInverted(price).inv().mul(2).eq(price));
  });
});
