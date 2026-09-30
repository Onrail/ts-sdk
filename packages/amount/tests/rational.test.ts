import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";

describe("Rational", () => {
  describe("from", () => {
    it("returns same instance for Rational input (immutable optimization)", () => {
      const r = Rational.from(5n, 1n);
      assert.deepStrictEqual(Rational.from(r).unwrap(), [5n, 1n]);
      assert.strictEqual(Rational.from(r), r);
    });

    it("creates from bigint", () => {
      assert.deepStrictEqual(Rational.from(5n).unwrap(), [5n, 1n]);
      assert.deepStrictEqual(Rational.from(-5n).unwrap(), [-5n, 1n]);
    });

    it("creates from fraction", () => {
      assert.deepStrictEqual(Rational.from(5n, 2n).unwrap(), [5n, 2n]);
      assert.deepStrictEqual(Rational.from(-5n, 2n).unwrap(), [-5n, 2n]);
    });

    it("creates from fraction with negative denominator", () => {
      assert.deepStrictEqual(Rational.from(5n, -2n).unwrap(), [-5n, 2n]);
      assert.deepStrictEqual(Rational.from(-5n, -2n).unwrap(), [5n, 2n]);
    });

    it("creates from integer", () => {
      assert.deepStrictEqual(Rational.from(5).unwrap(), [5n, 1n]);
      assert.deepStrictEqual(Rational.from(-5).unwrap(), [-5n, 1n]);
    });

    it("creates from string", () => {
      assert.deepStrictEqual(Rational.from("5").unwrap(), [5n, 1n]);
      assert.deepStrictEqual(Rational.from("0.50").unwrap(), [1n, 2n]);
      assert.deepStrictEqual(Rational.from("-3.50").unwrap(), [-7n, 2n]);
      assert.deepStrictEqual(Rational.from("0.3333333333333333").unwrap(),
        [3333333333333333n, 10000000000000000n],
      );
    });

    it("preserves sign for values in (-1, 0) [regression: 0 int part swallowed the sign]", () => {
      assert.deepStrictEqual(Rational.from("-0.5").unwrap(),       [-1n, 2n]);
      assert.deepStrictEqual(Rational.from("-0.25").unwrap(),      [-1n, 4n]);
      assert.deepStrictEqual(Rational.from("-0.0000005").unwrap(), [-1n, 2000000n]);
      assert.deepStrictEqual(Rational.from("-000.100").unwrap(),   [-1n, 10n]); // leading zeros; trailing frac zeros normalize
      assert.deepStrictEqual(Rational.from("-0.0").unwrap(),       [0n, 1n]);   // -0 is 0
      // the string path must agree with the (already-correct) number path
      assert.deepStrictEqual(Rational.from("-0.5").unwrap(), Rational.from(-0.5).unwrap());
    });

    it("creates from fraction notation string", () => {
      assert.deepStrictEqual(Rational.from("1/3").unwrap(), [1n, 3n]);
      assert.deepStrictEqual(Rational.from("-1/3").unwrap(), [-1n, 3n]);
      assert.deepStrictEqual(Rational.from("6/4").unwrap(), [3n, 2n]);
      assert.deepStrictEqual(Rational.from("1,000/3").unwrap(), [1000n, 3n]);
      assert.deepStrictEqual(Rational.from("1_000_000/1_000").unwrap(), [1000n, 1n]);
      //a zero denominator is structural, not arithmetic — every spelling of zero rejects
      assert.throws(() => Rational.from("1/0"), /Denominator cannot be zero/);
      assert.throws(() => Rational.from("1/00"), /Denominator cannot be zero/);
      assert.throws(() => Rational.from("1/0_000"), /Denominator cannot be zero/);
    });

    it("enforces one thousands-separator flavor per integer [mixing used to parse]", () => {
      assert.deepStrictEqual(Rational.from("12_345").unwrap(), [12345n, 1n]);
      assert.deepStrictEqual(Rational.from("1,000,000").unwrap(), [1000000n, 1n]);
      //each integer of a ratio picks its own flavor
      assert.deepStrictEqual(Rational.from("1,000/1_000").unwrap(), [1n, 1n]);
      const rejected = [
        "1_000,000", "1,000_000", "1__000", "1,,000", "1_0", "1234_567", "1,00,0",
        "_1", "1_", "1,000_000/3", "3/1_000,000",
      ];
      for (const s of rejected)
        assert.throws(() => Rational.from(s), /Invalid rational value/, s);
    });

    it("rejects strings outside the grammar", () => {
      const rejected = [
        "+5", "--5", ".5", "5.", "1/3.5", "1.5/2", "1/2/3", "/3", "1/", "1/-3",
        " 1", "1 ", "0x10", "1e1_0", "1e2,000",
      ];
      for (const s of rejected)
        assert.throws(() => Rational.from(s), /Invalid rational value/, s);
    });

    it("creates from decimal with default precision", () => {
      assert.deepStrictEqual(Rational.from(0.5).unwrap(), [1n, 2n]);
      assert.deepStrictEqual(Rational.from(-0.5).unwrap(), [-1n, 2n]);
      assert.deepStrictEqual(Rational.from(1/3).unwrap(), [1n, 3n]);
    });

    it("falls back to the exact decimal when no compact fraction fits", () => {
      //0.1 + 0.2 needs 17 significant digits, i.e. a denominator past the compaction cap, so it is
      //  kept exactly rather than approximated
      assert.deepStrictEqual(Rational.from(0.1 + 0.2).unwrap(),
        [7500000000000001n, 25000000000000000n],
      );
      for (const v of [0.1 + 0.2, 1 - 0.9])
        assert.strictEqual(Rational.from(v).toNumber(), v, `${v} did not round-trip`);
    });

    it("keeps the decimal that was written rather than chasing the double", () => {
      //a value that prints as a decimal of up to 15 significant digits is read as that decimal,
      //  so the number and string paths always agree on such literals
      assert.deepStrictEqual(Rational.from(1234.56789).unwrap(), [123456789n, 100000n]);
      assert.deepStrictEqual(Rational.from(-1234.56789).unwrap(), [-123456789n, 100000n]);
      assert.deepStrictEqual(Rational.from(12345.6789).unwrap(), [123456789n, 10000n]);

      //these used to come back as unrelated compact fractions that happened to land within half
      //  an ulp of the double (e.g. 682719487.1297 as 682719487 376/2899)
      const literals = [
        "0.333333333333333", "682719487.1297", "7.74359081296", "83982.9302555998",
        "1e-7", "0.000000123456789", "929395.780855656",
      ];
      for (const s of literals)
        assert(Rational.from(Number(s)).eq(Rational.from(s)), s);
    });

    it("recovers deliberate fractions from full-precision doubles", () => {
      //these print with 16+ significant digits, past any decimal literal's round-trip range, and
      //  their compact reading is too accurate to be a coincidence
      assert.deepStrictEqual(Rational.from(1 / 3).unwrap(), [1n, 3n]);
      assert.deepStrictEqual(Rational.from(2 / 3).unwrap(), [2n, 3n]);
      assert.deepStrictEqual(Rational.from(-22 / 7).unwrap(), [-22n, 7n]);
      assert.deepStrictEqual(Rational.from(355 / 113).unwrap(), [355n, 113n]);
      assert.deepStrictEqual(Rational.from(1 / 86400).unwrap(), [1n, 86400n]);
    });

    it("never silently discards a value below the denominator cap", () => {
      for (const v of [1e-11, 1e-18, 5e-7])
        assert.ok(Rational.from(v).sign() !== 0, `${v} collapsed to zero`);

      assert.deepStrictEqual(Rational.from(1e-18).unwrap(), [1n, 10n ** 18n]);
    });

    //regression: integer-valued doubles took a fast path reading the exact binary integer, so
    //  1e23 came back as 99999999999999991611392 while the string spelling gave 10^23
    it("reads an integer past the safe range like any other double", () => {
      assert.deepStrictEqual(Rational.from(1e23).unwrap(), Rational.from("1e23").unwrap());
      assert.deepStrictEqual(Rational.from(2 ** 53).unwrap(), [2n ** 53n, 1n]);
      assert.ok(Rational.from(1).add(1e23).eq(Rational.from("1e23").add(1)));
    });

    it("round-trips values whose double is not the decimal", () => {
      for (const v of [0.1 + 0.2, 1 - 0.9, 0.30000000000000004])
        assert.strictEqual(Rational.from(v).toNumber(), v, `${v} did not round-trip`);
    });

    it("normalizes fractions", () => {
      assert.deepStrictEqual(Rational.from(4n, 2n).unwrap(), [2n, 1n]);
      assert.deepStrictEqual(Rational.from(-4n, 2n).unwrap(), [-2n, 1n]);
      assert.deepStrictEqual(Rational.from(4n, -2n).unwrap(), [-2n, 1n]);
      assert.deepStrictEqual(Rational.from(-4n, -2n).unwrap(), [2n, 1n]);
    });

    it("throws on invalid numbers", () => {
      assert.throws(() => Rational.from(Infinity), /Invalid value/);
      assert.throws(() => Rational.from(-Infinity), /Invalid value/);
      assert.throws(() => Rational.from(Number.NaN), /Invalid value/);
    });

    it("creates from exponent notation", () => {
      assert.deepStrictEqual(Rational.from("1e-7").unwrap(), [1n, 10n ** 7n]);
      assert.deepStrictEqual(Rational.from("1e+21").unwrap(), [10n ** 21n, 1n]);
      assert.deepStrictEqual(Rational.from("1E3").unwrap(), [1000n, 1n]);
      assert.deepStrictEqual(Rational.from("-1.5e-3").unwrap(), [-3n, 2000n]);
      assert.deepStrictEqual(Rational.from("1.25e2").unwrap(), [125n, 1n]);
      //the exponent only offsets the fraction's digit count, so the two compose (and separators
      //  in the integer part survive it): 1234.5e-2 is 12.345, i.e. 12345/1000 reduced
      assert.deepStrictEqual(Rational.from("1,234.5e-2").unwrap(), [2469n, 200n]);
      assert.strictEqual(Rational.from("1,234.5e-2").toNumber(), 12.345);
      //stored exactly; toNumber cannot hand back a denormal (see its own accuracy caveat)
      assert.deepStrictEqual(Rational.from("5e-324").unwrap(), [1n, 2n * 10n ** 323n]);
    });

    it("throws on invalid strings", () => {
      assert.throws(() => Rational.from("1e"), /Invalid rational value/);
      assert.throws(() => Rational.from("e5"), /Invalid rational value/);
      assert.throws(() => Rational.from("1e2.5"), /Invalid rational value/);
      assert.throws(() => Rational.from(""), /Invalid rational value/);
      assert.throws(() => Rational.from("1.2.3"), /Invalid rational value/);
      assert.throws(() => Rational.from("abcd"), /Invalid rational value/);
    });

    it("throws if denominator is zero", () => {
      assert.throws(() => Rational.from(5n, 0n), /Denominator cannot be zero/);
    });
  });

  //toString used to round at a mutable global default precision, silently rendering nonzero
  //  values as "0" — it is now exact and always round-trips through `from`
  describe("toString exactness", () => {
    it("prints terminating expansions as decimals", () => {
      assert.strictEqual(Rational.from(1n, 2n).toString(), "0.5");
      assert.strictEqual(Rational.from(-7n, 4n).toString(), "-1.75");
      assert.strictEqual(Rational.from(1n, 10n ** 18n).toString(), "0.000000000000000001");
      assert.strictEqual(Rational.from(1234567n).toString({ thousandsSep: "," }), "1,234,567");
    });

    it("prints the rest as mixed numbers", () => {
      assert.strictEqual(Rational.from(1n, 3n).toString(), "1/3");
      assert.strictEqual(Rational.from(1000n, 3n).toString(), "333 1/3");
      assert.strictEqual(Rational.from(-1000n, 3n).toString(), "-333 1/3");
      assert.strictEqual(Rational.from(-1n, 3n).toString(), "-1/3");
      assert.strictEqual(
        Rational.from(12_345_678_901n, 7n).toString({ thousandsSep: "," }),
        "1,763,668,414 3/7",
      );
    });

    it("toJSON delegates, so JSON.stringify works [bare bigint fields would throw]", () => {
      assert.strictEqual(JSON.stringify({ r: Rational.from(1000n, 3n) }), '{"r":"333 1/3"}');
      assert.strictEqual(JSON.stringify(Rational.from(1n, 2n)), '"0.5"');
    });

    it("round-trips through from", () => {
      const values = [
        Rational.from(1n, 2n),   Rational.from(1n, 3n),  Rational.from(-1000n, 3n),
        Rational.from(0n),       Rational.from(1n, 10n ** 18n),
        Rational.from(12_345_678_901n, 7n),
      ];
      for (const [i, v] of values.entries()) {
        assert(Rational.from(v.toString()).eq(v), `plain ${i}`);
        assert(Rational.from(v.toString({ thousandsSep: "," })).eq(v), `separated ${i}`);
      }
    });
  });

  describe("mixed-number parsing", () => {
    it("parses the mixed-number form", () => {
      assert.deepStrictEqual(Rational.from("333 1/3").unwrap(), [1000n, 3n]);
      assert.deepStrictEqual(Rational.from("-333 1/3").unwrap(), [-1000n, 3n]);
      assert.deepStrictEqual(Rational.from("1,763,668,414 3/7").unwrap(), [12_345_678_901n, 7n]);
      assert.throws(() => Rational.from("1 1/0"), /Denominator cannot be zero/);
    });

    it("rejects malformed mixed numbers", () => {
      for (const s of ["1.5 3/7", "1 3", "1 3/7 5/9", "1/2 3/7", "1  3/7", "1 -3/7"])
        assert.throws(() => Rational.from(s), /Invalid rational value/, s);
    });
  });

  describe("isInteger", () => {
    it("returns true for integers", () => {
      assert(Rational.from(5n).isInteger());
      assert(Rational.from(-5n).isInteger());
      assert(Rational.from(5).isInteger());
      assert(Rational.from(-5).isInteger());
    });

    it("returns false for non-integers", () => {
      assert(!Rational.from(5n, 2n).isInteger());
      assert(!Rational.from(-5n, 2n).isInteger());
      assert(!Rational.from(0.5).isInteger());
      assert(!Rational.from(-0.5).isInteger());
    });
  });

  describe("decimalPlaces", () => {
    it("counts the exact expansion's decimals, undefined when it does not terminate", () => {
      assert.strictEqual(Rational.from(5n).decimalPlaces(), 0);
      assert.strictEqual(Rational.from(1n, 2n).decimalPlaces(), 1);
      assert.strictEqual(Rational.from(1n, 8n).decimalPlaces(), 3);
      assert.strictEqual(Rational.from(3n, 20n).decimalPlaces(), 2);
      assert.strictEqual(Rational.from(-1n, 4n).decimalPlaces(), 2);
      assert.strictEqual(Rational.from(1n, 3n).decimalPlaces(), undefined);
      assert.strictEqual(Rational.from(1n, 6n).decimalPlaces(), undefined);
    });
  });

  describe("conversion", () => {
    const half = Rational.from(1n, 2n);

    it("toNumber", () => {
      assert.strictEqual(half.toNumber(), 0.5);
    });

    it("is correctly rounded, ties to even", () => {
      //the midpoint between 1 and its successor: mantissa 2^52 is even, so it stays
      assert.strictEqual(Rational.from(2n ** 53n + 1n, 2n ** 53n).toNumber(), 1);
      //the next midpoint up: here the even neighbour is the larger one
      assert.strictEqual(Rational.from(2n ** 53n + 3n, 2n ** 53n).toNumber(), 1 + 2 ** -51);
    });

    it("agrees with IEEE division wherever both terms are exactly representable", () => {
      //a correctly rounded conversion must match the hardware for these, which pins the fast path
      for (const [a, b] of [[7919n, 104729n], [1n, 3n], [(1n << 52n) - 1n, 3n], [5n, 7n]] as const)
        assert.strictEqual(Rational.from(a, b).toNumber(), Number(a) / Number(b), `${a}/${b}`);
    });

    it("takes the same value through the fast and the bigint path", () => {
      //scaling both terms by a power of two keeps them coprime while forcing the bigint path
      for (const [a, b] of [[7919n, 104729n], [1n, 3n], [22n, 7n]] as const)
        assert.strictEqual(
          Rational.from(a << 60n, b << 60n).toNumber(),
          Rational.from(a, b).toNumber(),
          `${a}/${b}`,
        );
    });

    it("reaches the subnormals rather than collapsing to zero", () => {
      assert.strictEqual(Rational.from("5e-324").toNumber(), 5e-324);
      assert.strictEqual(Rational.from(1n, 2n ** 1022n).toNumber(), 2 ** -1022);
      //exactly half of the least subnormal is a tie, and zero is the even side of it
      assert.strictEqual(Rational.from(1n, 2n ** 1075n).toNumber(), 0);
      assert.strictEqual(Rational.from(3n, 2n ** 1076n).toNumber(), 5e-324);
    });

    it("toNumber handles numerator and denominator beyond double range [was NaN]", () => {
      const big = 2n ** 1100n;
      assert.strictEqual(Rational.from(big + 1n, big + 3n).toNumber(), 1);
      assert.strictEqual(Rational.from(big + 1n, 3n * big + 3n).toNumber(), 1 / 3);
      assert.strictEqual(Rational.from(-big - 1n, big + 3n).toNumber(), -1);
      //genuine over/underflow still saturates
      assert.strictEqual(Rational.from(big, 1n).toNumber(), Infinity);
      assert.strictEqual(Rational.from(1n, big).toNumber(), 0);
    });

    it("toString", () => {
      assert.strictEqual(half.toString(), "0.5");
    });

    it("toFixed", () => {
      assert.strictEqual(half.toFixed(2), "0.50");
      assert.strictEqual(half.toFixed(), "1");
      assert.strictEqual(Rational.from( 1n, 3n).toFixed(2), "0.33");
      assert.strictEqual(Rational.from( 4n, 1n).toFixed(2), "4.00");
      assert.strictEqual(Rational.from(-1n, 4n).toFixed(2), "-0.25");
      assert.strictEqual(Rational.from(-5n, 4n).toFixed(2), "-1.25");
      assert.strictEqual(Rational.from(-4n, 1n).toFixed(2), "-4.00");
      assert.strictEqual(Rational.from(-1n, 3n).toFixed(2), "-0.33");
    });

    it("floor", () => {
      assert.strictEqual(half.floor(), 0n);
      assert.strictEqual(Rational.from(3n, 2n).floor(), 1n);
      assert.strictEqual(Rational.from(-1n, 2n).floor(), -1n);
      assert.strictEqual(Rational.from(-5n, 2n).floor(), -3n);
    });

    it("ceil", () => {
      assert.strictEqual(half.ceil(), 1n);
      assert.strictEqual(Rational.from(3n, 2n).ceil(), 2n);
      assert.strictEqual(Rational.from(-1n, 2n).ceil(), 0n);
      assert.strictEqual(Rational.from(-5n, 2n).ceil(), -2n);
    });

    it("round (half away from zero)", () => {
      assert.strictEqual(half.round(), 1n);
      assert.strictEqual(Rational.from(1n, 4n).round(), 0n);
      assert.strictEqual(Rational.from(3n, 2n).round(), 2n);
      assert.strictEqual(Rational.from(-1n, 2n).round(), -1n); // -0.5 -> -1, not 0
      assert.strictEqual(Rational.from(-5n, 2n).round(), -3n); // -2.5 -> -3, not -2
      //symmetric under negation: round(-x) === -round(x)
      for (const [n, d] of [[1n, 2n], [5n, 2n], [3n, 2n], [7n, 4n]] as const)
        assert.strictEqual(Rational.from(n, d).neg().round(), -Rational.from(n, d).round());
    });
  });

  describe("comparison", () => {
    const half = Rational.from(1n, 2n);
    const third = Rational.from(1n, 3n);

    it("equality", () => {
      assert(half.eq(Rational.from(1n, 2n)));
      assert(!half.eq(third));
      assert(half.eq(0.5));
      assert(!half.eq(1n));
    });

    it("inequality", () => {
      assert(!half.ne(Rational.from(1n, 2n)));
      assert(half.ne(third));
    });

    it("greater than", () => {
      assert(half.gt(third));
      assert(!third.gt(half));
      assert(!half.gt(0.5));
      assert(!half.gt(1n));
    });

    it("less than", () => {
      assert(!half.lt(third));
      assert(third.lt(half));
      assert(!half.lt(0.5));
      assert(half.lt(1n));
    });

    it("greater than or equal", () => {
      assert(half.ge(third));
      assert(!third.ge(half));
      assert(half.ge(0.5));
      assert(!half.ge(1n));
    });

    it("less than or equal", () => {
      assert(!half.le(third));
      assert(third.le(half));
      assert(half.le(0.5));
      assert(half.le(1n));
    });

    it("compares a number operand exactly (via Rational.from), not via lossy toNumber()", () => {
      // a value a hair above 1/3 is strictly > the number 1/3 (which CF-recovers to exactly 1/3)
      const justOver = third.add(Rational.from(1n, 10n ** 18n));
      assert(justOver.gt(1 / 3));   // was false under the old toNumber() path
      assert(!justOver.eq(1 / 3));
      assert(justOver.ne(1 / 3));
      // number operand agrees with the same value passed as a Rational
      assert.strictEqual(justOver.gt(1 / 3), justOver.gt(Rational.from(1 / 3)));
    });
  });

  describe("special operations", () => {
    const half = Rational.from(1n, 2n);
    const negHalf = Rational.from(-1n, 2n);

    it("abs", () => {
      assert.deepStrictEqual(half.abs().unwrap(), [1n, 2n]);
      assert.deepStrictEqual(negHalf.abs().unwrap(), [1n, 2n]);
    });

    it("neg", () => {
      assert.deepStrictEqual(half.neg().unwrap(), [-1n, 2n]);
      assert.deepStrictEqual(negHalf.neg().unwrap(), [1n, 2n]);
    });

    it("inv", () => {
      assert.deepStrictEqual(half.inv().unwrap(), [2n, 1n]);
      assert.deepStrictEqual(negHalf.inv().unwrap(), [-2n, 1n]);
      assert.throws(() => Rational.from(0).inv(), /Cannot invert zero/);
    });
  });

  describe("arithmetic", () => {
    const half = Rational.from(1n, 2n);
    const third = Rational.from(1n, 3n);

    it("addition", () => {
      assert.deepStrictEqual(half.add(third).unwrap(), [5n, 6n]);
      assert.deepStrictEqual(half.add(1).unwrap(), [3n, 2n]);
      assert.deepStrictEqual(half.add(1.5).unwrap(), [2n, 1n]);
      assert.deepStrictEqual(half.add(1n).unwrap(), [3n, 2n]);
    });

    it("subtraction", () => {
      assert.deepStrictEqual(half.sub(third).unwrap(), [1n, 6n]);
      assert.deepStrictEqual(half.sub(1).unwrap(), [-1n, 2n]);
      assert.deepStrictEqual(half.sub(1n).unwrap(), [-1n, 2n]);
    });

    it("multiplication", () => {
      assert.deepStrictEqual(half.mul(third).unwrap(), [1n, 6n]);
      assert.deepStrictEqual(half.mul(2).unwrap(), [1n, 1n]);
      assert.deepStrictEqual(half.mul(2.5).unwrap(), [5n, 4n]);
      assert.deepStrictEqual(half.mul(2n).unwrap(), [1n, 1n]);
    });

    it("division", () => {
      assert.deepStrictEqual(half.div(third).unwrap(), [3n, 2n]);
      assert.deepStrictEqual(half.div(2).unwrap(), [1n, 4n]);
      assert.deepStrictEqual(half.div(2.5).unwrap(), [1n, 5n]);
      assert.deepStrictEqual(half.div(2n).unwrap(), [1n, 4n]);
      assert.throws(() => half.div(0), /Cannot divide by zero/);
      assert.throws(() => half.div(0n), /Cannot divide by zero/);
      assert.throws(() => half.div(Rational.from(0n)), /Cannot divide by zero/);
    });

    it("division by a negative keeps the sign on the numerator [d used to go negative]", () => {
      for (const divisor of [-2n, -2, Rational.from(-2n)] as const) {
        const res = half.div(divisor);
        assert.deepStrictEqual(res.unwrap(), [-1n, 4n]);
        assert.strictEqual(res.sign(), -1);
        assert(res.lt(0n));
        assert.strictEqual(res.toFixed(2), "-0.25");
      }
      assert.deepStrictEqual(Rational.from(3n, 2n).div(-3n).unwrap(), [-1n, 2n]);
      assert.deepStrictEqual(Rational.from(-1n, 2n).div(-2n).unwrap(), [1n, 4n]);
    });
  });
});

