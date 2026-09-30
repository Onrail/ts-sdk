//Every code example in README.md lives here first: the README shows nothing this suite
//  doesn't execute, so the two can't drift apart silently. Prose claims with a checkable
//  consequence (parsing rules, rounding mode, unit promotion, ...) are pinned alongside.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Identity } from "@onrail-xyz/utils";
import { jsonStringify, jsonParse } from "@onrail-xyz/utils";
import type { Kind, KindWithHuman,
              KindWithAtomic, KindWithDecimalHumanAndAtomic,
              SymbolsOf, KindUnitSymbols, ResolvedSymbolOf,
              AmountFromArgs, Rationalish, ToFixedOptions, ThousandsSep } from "../src/index.js";
import { Amount, Rate, Rational, kind, scalar, tenToThe, getUnit,
         getDecimals, identifyKind, isAmount, isRate, kindOf,
         numKindOf, denKindOf, invert, min, max, sum, clamp,
         compare, allocate, amountCodec, rateCodec, rationalCodec } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

// ---- Fixtures: the kinds the README defines, spelled as it spells them ----

const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "ETH"  }] },
    { symbols: [{ symbol: "Gwei" }], oom:  -9 },
    { symbols: [{ symbol: "wei"  }], oom: -18 },
  ],
  { human: "ETH", atomic: "wei" }
);
const eth = Amount.ofKind(ETH);

//the Symbol Options spelling — a superset of Quick Start's `$`-only USD
const USD = kind(
  "USD",
  [ { symbols: [
      { symbol: "$", spacing: "compact", position: "prefix" },
      { symbol: "USD" },
    ]},
    { symbols: [
      { symbol: "¢", spacing: "compact" },
      { symbol: "c", spacing: "compact" },
      { symbol: "cent", plural: "cents" },
    ], oom: -2 },
  ],
  { human: "$", atomic: "¢" },
);
const usd = Amount.ofKind(USD);

const BTC = kind(
  "BTC",
  [ { symbols: [{ symbol: "BTC" }] },
    { symbols: [{ symbol: "sat" }], oom: -8 } ],
  { human: "BTC", atomic: "sat" },
);

const USDC = kind(
  "USDC",
  [ { symbols: [{ symbol: "USDC"  }] },
    { symbols: [{ symbol: "µUSDC" }], oom: -6 } ],
  { human: "USDC", atomic: "µUSDC" },
);
const usdc = Amount.ofKind(USDC);

const Duration = kind(
  "Duration",
  [ { symbols: [{ symbol: "second", plural: "seconds" }] },
    { symbols: [{ symbol: "minute", plural: "minutes" }], scale:    60n },
    { symbols: [{ symbol: "hour",   plural: "hours"   }], scale:  3600n },
    { symbols: [{ symbol: "day",    plural: "days"    }], scale: 86400n },
  ]
);
const duration = Amount.ofKind(Duration);

const Percentage = scalar(kind(
  "Percentage",
  [ { symbols: [{ symbol: "x"   }] },
    { symbols: [{ symbol: "%"   }], oom: -2 },
    { symbols: [{ symbol: "bps" }], oom: -4 },
  ],
  { human: "%" }
));
const percent = Amount.ofKind(Percentage);

const inch = Rational.from(254n, 10000n);
const Length = kind(
  "Length",
  [
    ["metric", [
      { symbols: [{ symbol: "m"  }] },
      { symbols: [{ symbol: "cm" }], oom: -2 },
      { symbols: [{ symbol: "km" }], oom:  3 },
    ]],
    ["imperial", [
      { symbols: [{ symbol: "in" }], scale: inch },
      { symbols: [{ symbol: "ft" }], scale: inch.mul(12) },
      { symbols: [{ symbol: "mi" }], scale: inch.mul(63360) },
    ]],
  ],
);
const height = Amount.from(1.78, Length, "m");

// ---- Why? ----

describe("README: why", () => {
  it("runs the pitch", () => {
    const timeout = duration(30, "seconds");
    assert.equal(timeout.toString(), "30 seconds");

    const maxTransfer = eth(1.5);
    assert.equal(maxTransfer.toJSON(), "1.5 ETH");

    const ethPrice = usd(3_000).per(ETH);
    const maxInUsd = maxTransfer.mul(ethPrice);
    assert(maxInUsd.eq(usd(4_500)));

    const amount = eth(2);
    assert.equal(amount.in("atomic"), 2_000_000_000_000_000_000n);
    assert(amount.mul(1.02).eq(eth(2.04)));
  });
});

// ---- Quick Start ----

describe("README: quick start", () => {
  it("creates, converts, and does arithmetic", () => {
    const balance = eth(1.5);
    assert(balance.in("ETH").eq(Rational.from(1.5)));
    assert(balance.in("Gwei").eq(1_500_000_000n));
    assert.equal(balance.in("atomic"), 1_500_000_000_000_000_000n);

    assert.equal(balance.mul(2).toString(), "3 ETH");
    assert.equal(balance.add(eth(1)).toString(), "2.5 ETH");

    assert(Amount.parse("25 Gwei", ETH).eq(eth(25, "Gwei")));
  });

  it("converts between kinds", () => {
    const USD = kind(
      "USD",
      [{ symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }] }],
      { human: "$" }
    );
    const usd = Amount.ofKind(USD);

    const ethPrice = usd(3000).per(ETH);
    assert.equal(eth(0.5).mul(ethPrice).toString(), "$1,500");
  });
});

// ---- Rational ----

describe("README: Rational", () => {
  it("constructs from every spelling", () => {
    assert(Rational.from(5).eq(5n));
    assert(Rational.from(0.5).eq(Rational.from(1n, 2n)));
    assert.deepEqual(Rational.from(5n, 2n).unwrap(), [5n, 2n]);
    assert(Rational.from("1.5").eq(Rational.from(3n, 2n)));
    assert(Rational.from("1/3").eq(Rational.from(1n, 3n)));
    assert(Rational.from("333 1/3").eq(Rational.from(1000n, 3n)));
  });

  it("mod is floored: the result carries the divisor's sign", () => {
    assert(Rational.from(-7).mod(3).eq(2n));
    assert(Rational.from(7).mod(-3).eq(-2n));
    assert.equal(-7n % 3n, -1n);
  });

  it("powerOfTen takes either sign, tenToThe only non-negative exponents", () => {
    assert(Rational.powerOfTen(3).eq(1000n));
    assert(Rational.powerOfTen(-3).eq(Rational.from(1n, 1000n)));
    assert.equal(tenToThe(3), 1000n);
    assert.throws(() => tenToThe(-1));
  });

  it("toString is exact and round-trips; toFixed is for fixed precision", () => {
    assert.equal(Rational.from(1n, 2n).toString(), "0.5");
    assert.equal(Rational.from(1000n, 3n).toString(), "333 1/3");
    for (const r of [Rational.from(1n, 2n), Rational.from(1000n, 3n), Rational.from(-1n, 7n)])
      assert(Rational.from(r.toString()).eq(r));

    assert.notEqual(Rational.from(1n, tenToThe(30)).toString(), "0");
    assert.equal(Rational.from(1n, 3n).toFixed(2), "0.33");
  });
});

// ---- Kind ----

describe("README: Kind", () => {
  it("identifyKind picks the covering kind, getUnit resolves meta symbols", () => {
    assert.equal(identifyKind([ETH, USD, BTC], "1.5 ETH"), ETH);
    assert.equal(identifyKind([ETH, USD, BTC], "$5"), USD);
    assert.equal(getUnit(ETH, "atomic").symbol, "wei");
    assert.equal(getUnit(ETH, "human").symbol, "ETH");
    assert.equal(getUnit(ETH, "standard").symbol, "ETH");
    assert(getUnit(ETH, "Gwei").scale.eq(Rational.powerOfTen(-9)));
  });

  it("the standard unit may only claim oom 0, scale 1, or nothing", () => {
    kind("A", [{ symbols: [{ symbol: "a" }], oom: 0 }]);
    kind("B", [{ symbols: [{ symbol: "b" }], scale: 1 }]);
    // @ts-expect-error the first unit is the standard unit — scale 1 by definition
    kind("C", [{ symbols: [{ symbol: "c" }], oom: 5 }]);
  });

  it("formats per symbol options", () => {
    const amt = usd(100);
    assert.equal(amt.toString(),                "$100");
    assert.equal(amt.toString("inUnit", "USD"), "100 USD");
    assert.equal(amt.toString("inUnit", "c"),   "10,000c");
    assert.equal(usd(50, "c").toString(),       "50¢");
  });

  it("multi-system kinds format per system", () => {
    assert.equal(height.toString(),           "1.78 m");
    assert.equal(height.toString("imperial"), "5 ft 10 in");
    assert.equal(Amount.parse("5 hours 10 minutes 1 second", Duration).toString("exact"), "5 hours 10 minutes 1 second");

    //a zero renders in the human unit (standard without one) where the system has it, else in its smallest
    assert.equal(height.zero().toString(),           "0 m");
    assert.equal(height.zero().toString("imperial"), "0 in");
    assert.equal(duration(0, "hours").toString(),    "0 seconds");
  });

  it("human and atomic give kind-generic code a uniform interface", () => {
    function humanValue<K extends KindWithHuman>(amount: Amount<K>): Rational {
      return amount.in("human");
    }
    function toChainFormat<K extends KindWithAtomic>(amount: Amount<K>): bigint {
      return amount.in("atomic");
    }
    assert(humanValue(eth(1.5)).eq(Rational.from(1.5)));
    assert(humanValue(usd(50, "¢")).eq(Rational.from(0.5)));
    assert.equal(toChainFormat(eth(1.5)), 1_500_000_000_000_000_000n);
    assert.equal(toChainFormat(usd(1.5)), 150n);

    //human is the construction default and zero's display unit; a non-zero value picks its own
    assert(usd(0.5).eq(usd(50, "¢")));
    assert.equal(usd(0).toString(), "$0");
    assert.equal(usd(0.5).toString(), "50¢");

    assert.equal(getDecimals(ETH), 18);
    assert.equal(getDecimals(ETH, { of: "ETH", in: "Gwei" }), 9);
    const pinned: KindWithDecimalHumanAndAtomic = ETH;
    void pinned;
  });
});

// ---- Amount ----

describe("README: Amount", () => {
  it("creates, parses, converts, rounds", () => {
    assert(Amount.from(1.5, ETH).eq(eth(1.5)));
    assert(Amount.from(1.5, ETH, "Gwei").eq(eth(1.5, "Gwei")));
    assert(Amount.from("1,000.5", ETH).eq(eth(1000.5)));

    assert(Amount.parse("1.5 ETH", ETH).eq(eth(1.5)));
    assert(Amount.parse("2 hours 30 minutes", Duration).eq(duration(150, "minutes")));
    assert(Amount.parse("2 1/2 hours", Duration).eq(duration(150, "minutes")));
    const picked = Amount.parse("1.5 ETH", ETH, USD, BTC);
    pinEq<typeof picked, Amount<typeof ETH | typeof USD | typeof BTC>>(true);
    assert(Amount.isOfKind(picked, ETH) && picked.eq(eth(1.5)));

    const amt = eth("1.5", "wei");
    pinEq<ReturnType<typeof amt.in<"ETH">>, Rational>(true);
    pinEq<ReturnType<typeof amt.in<"atomic">>, bigint>(true);
    assert.equal(amt.in("atomic"), 1n);
    assert(amt.in("wei").eq(Rational.from(3n, 2n)));  //the unit by name stays exact
    assert(amt.in("human").eq(Rational.from(15n, tenToThe(19))));

    const x = eth("1.5", "Gwei");
    assert(x.floorTo("Gwei").eq(eth(1, "Gwei")));
    assert(x.ceilTo("Gwei").eq(eth(2, "Gwei")));
    assert(x.roundTo("Gwei").eq(eth(2, "Gwei")));
  });

  it("reads doubles the way they were most plausibly written", () => {
    assert(Amount.from(1234.56789, ETH).eq(Amount.from("1234.56789", ETH)));
    assert.equal(Rational.from(1 / 3).toString(), "1/3");
    assert(Rational.from(1 / 3).mul(3).eq(1n));
    assert.equal(Rational.from(0.1 + 0.2).toString(), "0.30000000000000004");
  });

  it("parses en-US number strings and nothing else", () => {
    assert(Amount.from("1,000.5", ETH).eq(eth(1000.5)));
    assert(Amount.from("1_000.5", ETH).eq(eth(1000.5)));
    assert.throws(() => Amount.from("1.000,5", ETH));
    assert.throws(() => Amount.from("1,00", ETH));
    assert.throws(() => Amount.from("1,000_000", ETH));
    assert(Amount.from("1.000", ETH).eq(eth(1)));
  });

  it("rounds half away from zero", () => {
    assert.equal(Rational.from(0.5).round(),   1n);
    assert.equal(Rational.from(-0.5).round(), -1n);
    assert(eth("0.5", "Gwei").roundTo("Gwei").eq(eth(1, "Gwei")));
    assert(eth("-0.5", "Gwei").roundTo("Gwei").eq(eth(-1, "Gwei")));
    assert(Math.round(-0.5) === 0);
  });

  it("does arithmetic, comparison, aggregation, and kind conversion", () => {
    const [a, b] = [eth(3), eth(2)];
    assert(a.add(b).eq(eth(5)) && a.sub(b).eq(eth(1)) && a.mul(2).eq(eth(6)) && a.div(2).eq(eth(1.5)));
    assert(a.mod(b).eq(eth(1)) && a.neg().abs().eq(a));
    const ratio = a.ratio(b);
    pinEq<typeof ratio, Rational>(true);
    assert(ratio.eq(Rational.from(3n, 2n)));

    assert(a.gt(b) && a.ge(b) && b.lt(a) && b.le(a) && a.ne(b) && !a.eq(b));
    assert(!a.isZero() && a.sign() === 1 && eth(0).isZero());

    const c = eth(1);
    assert(min(a, b, c).eq(c) && max(a, b).eq(a) && sum(a, b, c).eq(eth(6)));
    const fees: Amount<typeof ETH>[] = [];
    assert(sum(eth(0), ...fees).eq(eth(0)));
    assert(clamp(eth(10), c, a).eq(a));
    assert.deepEqual([a, c, b].sort(compare), [c, b, a]);

    assert(a.zero().eq(eth(0)));
    assert(a.ofSame(2, "Gwei").eq(eth(2, "Gwei")));

    const usdPerEth = usd(3000).per(ETH);
    const inUsd = a.mul(usdPerEth);
    pinEq<typeof inUsd, Amount<typeof USD>>(true);
    assert(inUsd.eq(usd(9000)));
    const backInEth = inUsd.div(usdPerEth);
    pinEq<typeof backInEth, Amount<typeof ETH>>(true);
    assert(backInEth.eq(a));
  });

  it("allocates by largest remainder without leaking dust", () => {
    const thirds = allocate(usdc(1), 3);
    pinEq<typeof thirds["length"], 3>(true);
    assert.deepEqual(thirds.map(p => p.toJSON()), ["0.333334 USDC", "0.333333 USDC", "0.333333 USDC"]);
    assert(sum(...thirds).eq(usdc(1)));

    const total = usdc(10);
    assert.deepEqual(allocate(total, [4, 1]).map(p => p.toJSON()), ["8 USDC", "2 USDC"]);
    assert.deepEqual(allocate(usdc(5), [1, 1], "USDC").map(p => p.toJSON()), ["3 USDC", "2 USDC"]);
    assert.throws(() => allocate(usdc("0.5"), [1, 1], "USDC"), /not a whole number/);
  });
});

// ---- Formatting ----

describe("README: formatting", () => {
  it("renders the formatting block verbatim", () => {
    const amt = Amount.from("1234.56789", ETH);
    assert.equal(amt.toString(),                 "1,235 ETH");
    assert.equal(amt.toString("exact"),          "1,234.56789 ETH");
    assert.equal(amt.toString("inUnit", "Gwei"), "1,234,567,890,000 Gwei");
    assert.equal(amt.toString("inUnit", "ETH", { precision: 2 }), "1,234.57 ETH");
    assert.equal(amt.toString("inUnit", "ETH", { precision: 6, trimZeros: false }), "1,234.567890 ETH");
    assert.equal(amt.toString("inUnit", "ETH", { precision: "Gwei", trimZeros: false }), "1,234.567890000 ETH");
    assert.equal(amt.toString("approximate", { thousandsSep: "_" }), "1_235 ETH");
    assert.equal(height.toString("imperial"), "5 ft 10 in");

    const opts: ToFixedOptions = { thousandsSep: "_", trimZeros: false };
    const sep: ThousandsSep = opts.thousandsSep;
    void sep;
  });

  it("both modes share a unit and differ only in digits", () => {
    assert.equal(eth(0.5).toJSON(), "0.5 ETH");
    assert.equal(eth(15_000, "Gwei").toString(), "15,000 Gwei");
    assert.equal(eth(15_000, "Gwei").toJSON(),   "15,000 Gwei");
    assert.equal(eth(1_500_000, "Gwei").toString(),  "0.002 ETH");
    assert.equal(eth(1_500_000, "Gwei").toJSON(),    "0.0015 ETH");
    assert.equal(eth(1).div(3).toJSON(), "1/3 ETH");
    assert.equal(usd(12_345_678_901n).div(7).toJSON(), "$1,763,668,414 3/7");
    const mixed = duration(100, "seconds").add(duration(1, "second").div(3));
    assert.equal(mixed.toJSON(), "1 minute 40 1/3 seconds");
    assert.equal(mixed.toString("exact"), mixed.toJSON());
  });

  it("toJSON round-trips through parse; Rate.toJSON finds the natural denominator", () => {
    const roundTrips = <K extends Kind>(a: Amount<K>) => Amount.parse(a.toJSON(), kindOf(a)).eq(a);
    for (const a of [eth(1.5), eth(1).div(3), eth(12_345_678_901n).div(7)])
      assert(roundTrips(a));
    for (const a of [usd("100.01"), usd(0.5), usd(1).div(3)])
      assert(roundTrips(a));

    const perDay = usd(100).per(Amount.parse("1 day", Duration));
    assert.equal(perDay.toJSON(), "$100/day");
    assert(perDay.in("¢", "second").eq(Rational.from(25n, 216n)));
    assert(Rate.parse(perDay.toJSON(), USD, Duration).eq(perDay));

    const price = usd(3000).per(ETH);
    assert.equal(price.toJSON(), "$3,000/ETH");
    assert.equal(price.toJSON().split("/")[1], price.toString().split("/")[1]);
  });
});

// ---- Rate ----

describe("README: Rate", () => {
  it("creates from ratios and amounts, rejects a matching pair", () => {
    assert(Rate.from(3000, USD, ETH).eq(usd(3_000).per(ETH)));
    const [usdAmount, ethAmount] = [usd(6000), eth(2)];
    assert(Rate.from(usdAmount, ethAmount).eq(usdAmount.per(ethAmount)));
    assert(Rate.from(usdAmount, ethAmount).eq(Rate.from(3000, USD, ETH)));

    assert.throws(() => Rate.from(1, ETH, ETH), /distinct kinds/);
    // @ts-expect-error the numeric form needs human units on both kinds
    assert.throws(() => Rate.from(1, Duration, ETH), /has no unit human/);
    assert(usd(1).per(duration(1, "day")).eq(Rate.parse("1 USD/day", USD, Duration)));
  });

  it("parses, converts, rounds, and does arithmetic", () => {
    const rate = Rate.parse("3000 USD/ETH", USD, ETH);
    assert(Rate.parse("1/2 BTC/ETH", BTC, ETH).in("BTC", "ETH").eq(Rational.from(1n, 2n)));
    assert(rate.in("USD", "ETH").eq(3000n));

    const odd = Rate.from(Rational.from("3000.7"), USD, ETH);
    assert(odd.floorTo("USD", "ETH").in("USD", "ETH").eq(3000n));
    assert(odd.ceilTo("USD", "ETH").in("USD", "ETH").eq(3001n));
    assert(odd.roundTo("USD", "ETH").in("USD", "ETH").eq(3001n));

    const spread = Rate.from(5, USD, ETH);
    assert(rate.add(spread).in("USD", "ETH").eq(3005n));
    assert(rate.sub(spread).in("USD", "ETH").eq(2995n));
    assert(rate.mul(2).in("USD", "ETH").eq(6000n) && rate.div(2).in("USD", "ETH").eq(1500n));
    assert(rate.neg().abs().eq(rate) && rate.neg().sign() === -1 && !rate.isZero());

    const inverted = rate.inv();
    pinEq<typeof inverted, Rate<typeof ETH, typeof USD>>(true);
    assert(inverted.in("ETH", "USD").eq(Rational.from(1n, 3000n)));

    const usdToEth = rate;
    const ethToBtc = Rate.from(20, ETH, BTC);
    const usdToBtc = usdToEth.combine(ethToBtc);
    pinEq<typeof usdToBtc, Rate<typeof USD, typeof BTC>>(true);
    assert(usdToBtc.in("USD", "BTC").eq(60_000n));
    const roundTrip = usdToEth.cancel(usdToEth.inv());
    pinEq<typeof roundTrip, Rational>(true);
    assert(roundTrip.eq(1n));
  });

  it("formats the numerator per its kind's display options", () => {
    const rate = Rate.from(3000, USD, ETH);
    assert.equal(rate.toString(),                     "$3,000/ETH");
    assert.equal(rate.toString({ numSymbol: "USD" }), "3,000 USD/ETH");
    assert.equal(rate.inv().toString(),               "0.000333 ETH/$");
  });
});

// ---- Scalar Kinds ----

describe("README: scalar kinds", () => {
  it("multiplies and divides amounts by dimensionless quantities", () => {
    const fee = percent(10);
    const total = usd(1000);
    assert.equal(total.mul(fee).toString(), "$100");
    assert.equal(total.div(fee).toString(), "$10,000");
    const product = percent(10).mul(percent(50));
    pinEq<typeof product, Amount<typeof Percentage>>(true);
    assert.equal(product.toString(), "5 %");
    const quotient = percent(10).div(percent(50));
    pinEq<typeof quotient, Amount<typeof Percentage>>(true);
    assert.equal(quotient.toString(), "20 %");
    const ratio = percent(10).ratio(percent(50));
    pinEq<typeof ratio, Rational>(true);
    assert(ratio.eq(Rational.from(1n, 5n)));
  });

  it("the standard unit is the plain multiplier — the other way round blows up by 100", () => {
    const Upside = scalar(kind(
      "Upside",
      [ { symbols: [{ symbol: "%" }] },
        { symbols: [{ symbol: "x" }], oom: 2 } ],
      { human: "%" },
    ));
    assert.equal(usd(1000).mul(Amount.from(10, Upside)).toString(), "$10,000");
  });

  it("composes into rates", () => {
    const apr = percent(5).per(Amount.parse("365 days", Duration));
    pinEq<typeof apr, Rate<typeof Percentage, typeof Duration>>(true);
    assert(duration(365, "days").mul(apr).eq(percent(5)));
  });
});

// ---- Type Narrowing ----

describe("README: type narrowing", () => {
  it("narrows kind unions by kind", () => {
    const amt = Amount.parse("1 ETH", ETH, USD);
    if (Amount.isOfKind(amt, ETH)) {
      pinEq<typeof amt, Amount<typeof ETH>>(true);
      assert(amt.in("wei").eq(tenToThe(18)));
    } else
      assert.fail("expected ETH");

    const rate = Math.random() < 2 ? Rate.from(3000, USD, ETH).inv() : Rate.from(3000, USD, ETH);
    if (Rate.hasNum(rate, ETH)) {
      pinEq<typeof rate, Rate<typeof ETH, typeof USD>>(true);
      assert(rate.in("Gwei", "$").eq(Rational.from(tenToThe(9), 3000n)));
    } else
      assert.fail("expected ETH numerator");
    assert(Rate.hasDen(rate, USD));
  });

  it("isAmount/isRate keep exactly the matching constituents", () => {
    const value: Amount<typeof ETH> | Rate<typeof USD, typeof ETH> | Rational = eth(1);
    if (isAmount(value)) {
      pinEq<typeof value, Amount<typeof ETH>>(true);
      assert.equal(value.toString(), "1 ETH");
    } else
      assert.fail("expected an amount");
    assert(!isRate(value));

    const unknownValue: unknown = Rate.from(1, USD, ETH);
    if (isAmount(unknownValue))
      pinEq<typeof unknownValue, Amount<Kind>>(true);
    if (isRate(unknownValue)) {
      pinEq<typeof unknownValue, Rate<Kind, Kind>>(true);
      assert.equal(unknownValue.toString(), "$1/ETH");
    } else
      assert.fail("expected a rate");
  });
});

// ---- Kind-Generic Code ----

describe("README: kind-generic code", () => {
  it("works without casts", () => {
    const afterFee = <K extends KindWithAtomic>(amount: Amount<K>, fee: Amount<typeof Percentage>) =>
      amount.sub(amount.mul(fee)).floorTo("atomic");
    const net = afterFee(eth(1), percent(10));
    pinEq<typeof net, Amount<typeof ETH>>(true);
    assert(net.eq(eth(0.9)));
    assert(afterFee(usd(1), percent(10)).eq(usd(0.9)));
  });

  it("kind erases at an open K; zero/ofSame and the free functions read it exactly", () => {
    const generic = <K extends KindWithAtomic>(amount: Amount<K>, rate: Rate<K, typeof USD>) => {
      // @ts-expect-error the constraint is not assignable to K
      const erased: K = amount.kind;
      const exact:  K = kindOf(amount);
      const z: Amount<K> = amount.zero();
      const o: Amount<K> = amount.ofSame(1, "atomic");
      const num: K = numKindOf(rate);
      const den: typeof USD = denKindOf(rate);
      const swapped: Rate<typeof USD, K> = invert(rate);
      // @ts-expect-error KindWithAtomic admits only "atomic" and "standard"
      amount.floorTo("ETH");
      return { erased, exact, z, o, num, den, swapped };
    };
    const r = generic(eth(1), Rate.from(1, ETH, USD));
    assert.equal(r.exact, ETH);
    assert(r.z.eq(eth(0)) && r.o.eq(eth(1, "wei")));
    assert.equal(r.num, ETH);
    assert.equal(r.den, USD);
    assert(r.swapped.eq(Rate.from(1, USD, ETH)));
  });

  it("the symbol type family is what the constraint promises", () => {
    pinEq<SymbolsOf<typeof ETH>, "ETH" | "Gwei" | "wei" | "standard" | "human" | "atomic">(true);
    pinEq<SymbolsOf<KindWithAtomic>, "standard" | "atomic">(true);
    pinEq<KindUnitSymbols<typeof ETH>, "ETH" | "Gwei" | "wei">(true);
    pinEq<ResolvedSymbolOf<typeof ETH, "atomic">, "wei">(true);
    pinEq<AmountFromArgs<typeof ETH>, [kind: typeof ETH, unitSymbol: SymbolsOf<typeof ETH>]>(true);

    const ofKind = <K extends Kind>(value: Rationalish | string, ...args: AmountFromArgs<K>) =>
      Amount.from(value, ...args);
    assert(ofKind(1, ETH, "Gwei").eq(eth(1, "Gwei")));

    //from takes an open K and a union-typed kind directly
    const direct = <K extends Kind>(value: Rationalish, kind: K, unitSymbol: SymbolsOf<K>) =>
      Amount.from(value, kind, unitSymbol);
    assert(direct(1, ETH, "Gwei").eq(eth(1, "Gwei")));
    const either = (Math.random() < 2 ? ETH : USD) as typeof ETH | typeof USD;
    const atomicOfEither = Amount.from(1, either, "atomic");
    pinEq<typeof atomicOfEither, Amount<typeof ETH | typeof USD>>(true);
    assert.equal(atomicOfEither.in("atomic"), 1n);
    // @ts-expect-error "wei" is not a symbol of every union member
    Amount.from(1, either, "wei");
  });
});

describe("README: JSON codecs", () => {
  const codecs = [amountCodec([ETH, USD]), rateCodec(USD, ETH), rationalCodec];

  it("round-trips amounts through jsonStringify/jsonParse", () => {
    const json = jsonStringify({ balance: eth(1).div(3) }, codecs);
    assert.equal(json, '{"balance":{"$type":"Amount","value":{"kind":"ETH","value":"1/3 ETH"}}}');

    const back = jsonParse(json, codecs) as { balance: Amount<typeof ETH> };
    assert(back.balance.eq(eth(1).div(3)));
  });

  it("encoding is total; decoding outside the candidate kinds throws", () => {
    const usdOnly = [amountCodec([USD])];
    const json = jsonStringify(eth(1), usdOnly);
    assert.throws(() => jsonParse(json, usdOnly), /No candidate kind named "ETH"/);
  });
});

// ---- Limitations ----

describe("README: IntelliSense & best practice", () => {
  it("the Identity interface wrap and the Token/token idiom", () => {
    const _Token = kind(
      "Token",
      [ { symbols: [{ symbol: "TOK"  }] },
        { symbols: [{ symbol: "µTOK" }], oom:  -6 } ],
      { human: "TOK", atomic: "µTOK" },
    );
    interface TokenKind extends Identity<typeof _Token> {}
    const Token = _Token as TokenKind;
    type Token = Amount<typeof Token>;
    const token = Amount.ofKind(Token);

    function transfer(amount: Token) {
      const transferCost = token(1);
      return amount.sub(transferCost);
    }
    assert(transfer(token(5)).eq(token(4)));
    assert.equal(token("1.5").in("atomic"), 1_500_000n);
  });
});

describe("README: symbol characters", () => {
  it("rejects symbols that could not round-trip through parsing", () => {
    for (const symbol of ["", "-x", "3m", "sq ft", "a,b", "a_b", "a.b", "a/b"])
      assert.throws(() => kind("Bad", [{ symbols: [{ symbol }] }]), /Invalid unit symbol/, symbol);
    assert.throws(() => kind("Bad", [{ symbols: [{ symbol: "m3", position: "prefix" }] }]),
      /Invalid unit symbol/);
    assert.doesNotThrow(() => kind("Fine", [{ symbols: [{ symbol: "USDT0" }] }]));
  });

  it("reserves the meta symbols and the display-mode names", () => {
    for (const symbol of ["standard", "human", "atomic"] as const)
      assert.throws(() => kind("Bad", [{ symbols: [{ symbol: "a" }] }, { symbols: [{ symbol }], oom: -1 }]), /reserved/);
    for (const system of ["approximate", "exact", "inUnit"] as const)
      assert.throws(() => kind("Bad", [[system, [{ symbols: [{ symbol: "a" }] }]]]), /display mode/);
  });

  it("takes unicode in stride", () => {
    const Fancy = kind("Fancy", [{ symbols: [
      { symbol: "$" }, { symbol: "€" }, { symbol: "¥" }, { symbol: "m³" }, { symbol: "µs" }, { symbol: "°C" },
    ]}]);
    assert.equal(Amount.parse("3 m³", Fancy).toString("inUnit", "°C"), "3 °C");
    assert.equal(Amount.parse("5 \u03bcs", Fancy).toString("inUnit", "µs"), "5 µs");
    assert.equal(Amount.parse("20 \u2103", Fancy).toString("inUnit", "°C"), "20 °C");
    assert.equal(Amount.parse("3 m3", Fancy).toString("inUnit", "m³"), "3 m³");
    assert.throws(() => kind("Bad", [{ symbols: [{ symbol: "m3" }, { symbol: "m³" }] }]), /is equivalent to/);
  });
});

describe("README: performance", () => {
  it("composing a non-terminating fraction keeps every digit; roundTo collapses it", () => {
    const daily = Rational.from(7301n, 7300n);
    let carried = eth(1);
    let collapsed = eth(1);
    for (let i = 0; i < 10_000; ++i) {
      carried   = carried.mul(daily);
      collapsed = collapsed.mul(daily).roundTo("atomic");
    }
    const denominatorBits = carried.in("ETH").unwrap()[1].toString(2).length;
    assert(127_000 < denominatorBits && denominatorBits < 130_000, `${denominatorBits} bits`);
    assert(collapsed.in("wei").isInteger());
    assert.equal(carried.toString(), collapsed.toString());
    assert.equal(carried.toString(), "3.93 ETH");
  });
});
