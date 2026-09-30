import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Amount, Rational } from "@onrail-xyz/amount";
import { Usd, Usdt, Usdc, Btc, Eth, Sol, Byte, Duration, Tenor, btc,
         eth, sol, usd, usdc, usdt, duration, byte, percentage, tenor } from "../src/units.js";

//guards the manually audited scales/ooms against future edits
describe("unit scales", () => {
  describe("1 human unit → atomic factor", () => {
    const cases = [
      ["Usd",  () => Amount.from(1, Usd ).in("¢"),                       "100"],
      ["Usdt", () => Amount.from(1, Usdt).in("µUSDT"),               "1000000"],
      ["Usdc", () => Amount.from(1, Usdc).in("µUSDC"),               "1000000"],
      ["Btc",  () => Amount.from(1, Btc ).in("satoshi"),           "100000000"],
      ["Eth",  () => Amount.from(1, Eth ).in("wei"),     "1000000000000000000"],
      ["Sol",  () => Amount.from(1, Sol ).in("lamport"),          "1000000000"],
      ["Byte", () => Amount.from(1, Byte).in("byte"),                      "1"],
    ] as const;

    for (const [name, calc, expected] of cases)
      it(`${name}: ${expected}`, () => {
        assert.strictEqual(calc().toString(), expected);
      });
  });

  describe("intermediate units", () => {
    const cases = [
      ["1 Gwei = 1e9 wei",         () => eth(1,     "Gwei").in("wei"),         "1000000000"],
      ["1 lamport = 1e6 µLamport", () => sol(1,  "lamport").in("µLamport"),       "1000000"],
      ["1 kB = 1000 bytes",        () => byte(1,      "kB").in("byte"),              "1000"],
      ["1 KiB = 1024 bytes",       () => byte(1,     "KiB").in("byte"),              "1024"],
      ["1 TiB = 1024^4 bytes",     () => byte(1,     "TiB").in("byte"),     "1099511627776"],
      ["1 byte = 8 bits",          () => byte(1,    "byte").in("bit"),                  "8"],
      ["1 x = 100 %",              () => percentage(1, "x").in("%"),                  "100"],
      ["1 % = 100 bp",             () => percentage(1, "%").in("bp"),                 "100"],
    ] as const;

    for (const [name, calc, expected] of cases)
      it(name, () => {
        assert.strictEqual(calc().toString(), expected);
      });
  });

  describe("Duration units in seconds", () => {
    const cases = [
      ["m", "60"], ["h", "3600"], ["d", "86400"], ["w", "604800"], ["y", "31557600"],
    ] as const;

    for (const [unit, expected] of cases)
      it(`1 ${unit} = ${expected} s`, () => {
        assert.strictEqual(duration(1, unit).in("s").toString(), expected);
      });
  });
});

describe("Duration", () => {
  it("has exact sub-second scales", () => {
    assert.deepStrictEqual(duration(1, "ms").in("s").unwrap(), [1n, 1_000n]);
    assert.deepStrictEqual(duration(1, "µs").in("s").unwrap(), [1n, 1_000_000n]);
    assert.deepStrictEqual(duration(1, "ns").in("s").unwrap(), [1n, 1_000_000_000n]);
    assert.strictEqual(duration("0.001", "s").in("ms").toString(), "1");
  });

  //#7 was a float scale collapsing to 0 when the then-global display precision fell below the
  //  digits it needed; that setting no longer exists, and the fidelity pins remain
  it("scale source is display-precision-independent [#7 regression]", () => {
    assert.deepStrictEqual(Rational.powerOfTen(-9).unwrap(), [1n, 1_000_000_000n]);
    assert.deepStrictEqual(Rational.from(1e-9).unwrap(), [1n, 1_000_000_000n]);
  });
});

describe("Tenor", () => {
  it("counts on the 30/360 basis", () => {
    const cases = [["day", "1"], ["week", "7"], ["month", "30"], ["year", "360"]] as const;
    for (const [unit, expected] of cases)
      assert.strictEqual(tenor(1, unit).in("day").toString(), expected);
  });

  it("uses the market's uppercase codes in the short system", () => {
    assert.strictEqual(tenor(3, "M").in("day").toString(), "90");
    assert.strictEqual(tenor(1, "Y").in("month").toString(), "12");
  });

  it("quotes rates per annum", () => {
    const apr = percentage(5).per(tenor(1, "year"));
    assert.strictEqual(apr.toJSON(), "5 %/year");
    assert.strictEqual(apr.toString(), "5 %/year");
  });

  it("stays disjoint from physical time", () => {
    assert.strictEqual(tenor(1, "year").in("day").toString(), "360");
    assert.strictEqual(duration(1, "julianYear").in("day").toString(), "365.25");
    //day/days name a unit of both kinds, so a bare string cannot pick between them
    assert.throws(() => Amount.parse("30 days", Duration, Tenor), /Could not identify kind/);
  });
});

describe("currency formatting", () => {
  const systems = (amount: { toString(system: string): string }) =>
    (["default", "uniform", "fancy"] as const).map(system => amount.toString(system));

  it("renders each system", () => {
    assert.deepStrictEqual(systems(usd(2)),             ["$2", "2 USD", "$2"]);
    assert.deepStrictEqual(systems(usd("0.02")),        ["2¢", "2 cents", "2¢"]);
    assert.deepStrictEqual(systems(usdt("0.000002")),   ["2 µUSDT", "2 µUSDT", "2 µUSD₮"]);
    assert.deepStrictEqual(systems(usdc(3)),            ["3 USDC", "3 USDC", "3 USDC"]);
    assert.deepStrictEqual(systems(btc(2, "satoshi")),  ["2 satoshis", "2 satoshis", "2 sats"]);
    assert.deepStrictEqual(systems(eth(2, "Gwei")),     ["2 Gwei", "2 Gwei", "2 Gwei"]);
    assert.deepStrictEqual(systems(sol(2, "lamport")),  ["2 lamports", "2 lamports", "2 lamports"]);
  });

  it("pluralizes the atomic units, and not one of them", () => {
    assert.strictEqual(sol(1, "lamport").toString(), "1 lamport");
    assert.strictEqual(sol("0.000000000000002").toString(), "2 µLamports");
    assert.strictEqual(btc(1, "satoshi").toString("fancy"), "1 sat");
  });

  it("parses every capitalization and number of the atomic units", () => {
    for (const str of ["5 lamport", "5 lamports", "5 Lamport", "5 Lamports"])
      assert(Amount.parse(str, Sol).eq(sol(5, "lamport")), str);
    for (const str of ["5 sat", "5 sats", "5 Sat", "5 Sats", "5 Satoshis"])
      assert(Amount.parse(str, Btc).eq(btc(5, "satoshi")), str);
    assert(Amount.parse("5 microLamports", Sol).eq(sol(5, "µLamport")));
  });
});
