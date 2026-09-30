import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bignum } from "@onrail-xyz/utils";
import type { DeriveType } from "@onrail-xyz/binary-layout";
import { serialize, deserialize } from "@onrail-xyz/binary-layout";
import { Amount, Rate, Rational, kind, toDecimalUnits } from "@onrail-xyz/amount";
import { Usd, Btc, Eth, Sol, sol } from "../src/units.js";
import { amountItem, rateItem, linearTransform } from "../src/layouting.js";

// ---- amountItem baseline tests ----

describe("amountItem", () => {
  it("round-trips a value using atomic unit", () => {
    const layout = amountItem(4, Usd, "¢");
    const amount = Amount.from(500, Usd, "¢"); // 500 cents = 5 USD
    const encoded = serialize(layout, amount);
    assert.deepStrictEqual(encoded, bignum.toBytes(500, 4));
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded.in("$").toString(), "5");
  });

  it("round-trips a value using human unit", () => {
    const layout = amountItem(4, Usd, "$");
    const amount = Amount.from(50, Usd);
    const encoded = serialize(layout, amount);
    assert.deepStrictEqual(encoded, bignum.toBytes(50, 4));
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded.in("$").toString(), "50");
  });

  it("round-trips with default atomic unit (KindWithAtomic)", () => {
    const layout = amountItem(4, Btc);
    const amount = Amount.from(1, Btc); // 1 BTC = 100_000_000 satoshi
    const encoded = serialize(layout, amount);
    assert.deepStrictEqual(encoded, bignum.toBytes(100_000_000, 4));
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded.in("BTC").toString(), "1");
  });

  it("round-trips with a transform", () => {
    // stored value * 100 = converted value in USD
    const layout = amountItem(4, Usd, "$", linearTransform("stored", 100));
    const amount = Amount.from(500, Usd); // 500 USD => stored as 5
    const encoded = serialize(layout, amount);
    assert.deepStrictEqual(encoded, bignum.toBytes(5, 4));
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded.in("$").toString(), "500");
  });

  it("round-trips bigint for large sizes", () => {
    const layout = amountItem(32, Eth, "wei");
    const amount = Amount.from(1, Eth); // 1 ETH = 10^18 wei
    const encoded = serialize(layout, amount);
    assert.deepStrictEqual(encoded, bignum.toBytes(10n ** 18n, 32));
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded.in("ETH").toString(), "1");
  });

  it("plain uint without kind", () => {
    const layout = amountItem(4);
    const encoded = serialize(layout, 42);
    assert.deepStrictEqual(encoded, bignum.toBytes(42, 4));
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded, 42);
  });

  it("with a CustomConversion object", () => {
    const custom = {
      to:   (val: number) => `${val * 3}`,
      from: (val: string) => Math.floor(Number(val) / 3),
    };
    const layout = amountItem(4, custom);
    const encoded = serialize(layout, "99");
    assert.deepStrictEqual(encoded, bignum.toBytes(33, 4)); // from: 99 / 3 = 33
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded, "99"); // to: 33 * 3 = "99"
  });

  //regression: the transform-only overload returned `AmountItem<S, R>`, which read its R as a
  //  kind or its absence - a conversion returning undefined was typed as a plain uint, one
  //  returning a Kind object as an Amount of it
  it("derives exactly what a transform returns, whatever it looks like", () => {
    type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
    const toUndefined = amountItem(1, { to: () => undefined, from: () => 0 });
    const toKind      = amountItem(1, { to: () => Sol,       from: () => 0 });
    const pin: [
      Mutual<DeriveType<typeof toUndefined>, undefined>,
      Mutual<DeriveType<typeof toKind>, typeof Sol>,
    ] = [true, true];
    assert.ok(pin);
    assert.strictEqual(deserialize(toUndefined, new Uint8Array([0])), undefined);
    assert.strictEqual(deserialize(toKind, new Uint8Array([0])), Sol);
  });

  it("with a sized factory function", () => {
    const factory = (size: number) => ({
      to:   (val: number) => `${val}@${size}`,
      from: (val: string) => Number(val.split("@")[0]!),
    });
    const layout = amountItem(4, factory);
    const encoded = serialize(layout, "7@4");
    assert.deepStrictEqual(encoded, bignum.toBytes(7, 4)); // from: "7@4" => 7
    const decoded = deserialize(layout, encoded);
    assert.strictEqual(decoded, "7@4"); // to: 7 => "7@4"
  });
});

describe("amountItem boundaries", () => {
  it("floors sub-field precision instead of rounding", () => {
    //an amountItem's field is an integer, so anything finer than its unit is lost
    assert.deepStrictEqual(
      serialize(amountItem(4, Usd, "$"), Amount.from("5.99", Usd)),
      bignum.toBytes(5, 4),
    );
    assert.deepStrictEqual(
      serialize(amountItem(4, Usd, "¢"), Amount.from("5.999", Usd)),
      bignum.toBytes(599, 4),
    );
  });

  it("throws when the value exceeds the field width", () => {
    assert.throws(
      () => serialize(amountItem(1, Usd, "¢"), Amount.from(1000, Usd, "¢")),
      /does not fit in u8/,
    );
  });

  it("reports an overflow past the safe-integer range as a width overflow too", () => {
    assert.throws(
      () => serialize(amountItem(4, Eth, "wei"), Amount.from(1, Eth)),
      /does not fit in u32/,
    );
  });

  it("stores a negative amount through an offset transform", () => {
    //y = x - 10 with x the stored value: -$5 is stored as 5
    const layout = amountItem(4, Usd, "$", linearTransform("stored", 1, -10));
    const encoded = serialize(layout, Amount.from(-5, Usd));
    assert.deepStrictEqual(encoded, bignum.toBytes(5, 4));
    assert(deserialize(layout, encoded).eq(Amount.from(-5, Usd)));
  });

  it("throws on a negative amount in an unsigned field", () => {
    for (const value of ["-5", "-0.5"]) //-0.5 floors to -1, so it must not slip through as 0
      assert.throws(
        () => serialize(amountItem(4, Usd, "$"), Amount.from(value, Usd)),
        /does not fit in u32/,
      );
  });
});

describe("amountItem at a union kind", () => {
  const trancheUnits = (symbol: string) =>
    toDecimalUnits([[0, [{ symbol }]], [-6, [{ symbol: `µ${symbol}` }]]]);
  const Senior = kind("Senior", trancheUnits("T"), { human: "T", atomic: "µT" });
  const Junior = kind("Junior", trancheUnits("T"), { human: "T", atomic: "µT" });
  type TrancheKind = typeof Senior | typeof Junior;
  const atomicItem = (tranche: TrancheKind) => amountItem(8, tranche);
  const humanItem  = (tranche: TrancheKind) => amountItem(8, tranche, "human");

  it("rejects an amount of another member, though the two share every symbol", () => {
    const junior = Amount.from(5, Junior);
    assert.throws(() => serialize(atomicItem(Senior), junior), /Kind mismatch/);
    assert.throws(() => serialize(humanItem(Senior), junior), /Kind mismatch/);
  });

  it("rejects a unit symbol the kind lacks when the item is built", () => {
    assert.throws(() => amountItem(4, Usd, "dollar" as "$"), /Kind Usd has no unit dollar/);
  });

  it("rejects a rate whose numerator is another member", () => {
    const item = rateItem(atomicItem(Senior), Sol);
    assert.throws(() => serialize(item, Rate.from(Amount.from(5, Junior), sol(1))), /Kind mismatch/);
  });

  it("encodes an amount of the member it was built with", () => {
    const encoded = serialize(atomicItem(Senior), Amount.from(5, Senior));
    assert.deepStrictEqual(encoded, bignum.toBytes(5_000_000, 8));
  });
});

// ---- rateItem tests ----

describe("rateItem", () => {
  const usd50kPerBtc = Rate.from(Amount.from(50_000, Usd), Amount.from(1, Btc));

  describe("wrapping an amountItem (overloads 1 & 2)", () => {
    it("to: deserializes bytes into a valid conversion", () => {
      const numItem = amountItem(4, Usd, "$");
      const layout = rateItem(numItem, Btc);

      // 50000 USD/BTC — numItem stores USD in human units, so raw value is 50000
      const conv = deserialize(layout, bignum.toBytes(50_000, 4));
      assert.strictEqual(conv.in("$", "BTC").toString(), "50000");
    });

    it("from: serializes a conversion back to bytes", () => {
      const numItem = amountItem(4, Usd, "$");
      const layout = rateItem(numItem, Btc);

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(50_000, 4));
    });

    //the flooring of amountItem applies to the numerator, so a sub-unit rate stores as 0
    it("from: floors a rate below the numerator's resolution", () => {
      const layout = rateItem(amountItem(4, Usd, "$"), Btc);
      const halfUsdPerBtc = Rate.from(Amount.from("0.5", Usd), Amount.from(1, Btc));

      assert.deepStrictEqual(serialize(layout, halfUsdPerBtc), bignum.toBytes(0, 4));
    });

    it("round-trips with default human denominator unit", () => {
      const numItem = amountItem(4, Usd, "$");
      const layout = rateItem(numItem, Btc);

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(50_000, 4));
      const decoded = deserialize(layout, encoded);
      assert.strictEqual(decoded.in("$", "BTC").toString(), "50000");
    });

    it("round-trips with explicit denominator unit", () => {
      const numItem = amountItem(4, Usd, "$");
      const layout = rateItem(numItem, Btc, "BTC");

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(50_000, 4));
      const decoded = deserialize(layout, encoded);
      assert.strictEqual(decoded.in("$", "BTC").toString(), "50000");
    });
  });

  describe("size-based (overloads 3 & 4)", () => {
    it("to: deserializes bytes into a valid conversion", () => {
      const layout = rateItem(4, Usd, "$", Btc, "BTC");

      const conv = deserialize(layout, bignum.toBytes(50_000, 4));
      assert.strictEqual(conv.in("$", "BTC").toString(), "50000");
    });

    it("from: serializes a conversion back to bytes", () => {
      const layout = rateItem(4, Usd, "$", Btc, "BTC");

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(50_000, 4));
    });

    it("round-trips without transform", () => {
      const layout = rateItem(4, Usd, "$", Btc, "BTC");

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(50_000, 4));
      const decoded = deserialize(layout, encoded);
      assert.strictEqual(decoded.in("$", "BTC").toString(), "50000");
    });

    it("round-trips with default human denominator", () => {
      const layout = rateItem(4, Usd, "$", Btc);

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(50_000, 4));
      const decoded = deserialize(layout, encoded);
      assert.strictEqual(decoded.in("$", "BTC").toString(), "50000");
    });

    it("round-trips with a transform", () => {
      // stored value * 100 = actual conversion ratio
      const layout = rateItem(4, Usd, "$", Btc, "BTC", linearTransform("stored", 100));

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(500, 4)); // 50000 / 100 = 500 stored
      const decoded = deserialize(layout, encoded);
      assert.strictEqual(decoded.in("$", "BTC").toString(), "50000");
    });

    it("takes the transform in the denominator unit's place", () => {
      const layout = rateItem(4, Usd, "$", Btc, linearTransform("stored", 100));

      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(500, 4));
      assert.strictEqual(deserialize(layout, encoded).in("$", "BTC").toString(), "50000");
    });

    it("round-trips with atomic numerator unit", () => {
      const layout = rateItem(4, Usd, "¢", Btc, "BTC");

      // 50,000 USD/BTC — stored as 5,000,000 cents/BTC
      const encoded = serialize(layout, usd50kPerBtc);
      assert.deepStrictEqual(encoded, bignum.toBytes(5_000_000, 4));
      const decoded = deserialize(layout, encoded);
      assert.strictEqual(decoded.in("$", "BTC").toString(), "50000");
    });
  });
});

// ---- linearTransform tests ----

describe("linearTransform", () => {
  describe("3-param (returns SizedTransformFunc)", () => {
    it("stored mode: to = val * m, from = val / m", () => {
      const tf = linearTransform("stored", 100)(4);
      assert.strictEqual(tf.to(5).toString(), "500");
      assert.strictEqual(tf.from(Rational.from(500)), 5);
    });

    it("converted mode: to = val / m, from = val * m", () => {
      const tf = linearTransform("converted", 100)(4);
      assert.strictEqual(tf.to(500).toString(), "5");
      assert.strictEqual(tf.from(Rational.from(5)), 500);
    });

    it("stored mode with offset b: to = val * m + b", () => {
      const tf = linearTransform("stored", 10, 3)(4);
      assert.strictEqual(tf.to(7).toString(), "73"); // 7*10 + 3
      assert.strictEqual(tf.from(Rational.from(73)), 7); // (73-3)/10
    });

    it("converted mode with offset b: to = (val - b) / m", () => {
      const tf = linearTransform("converted", 10, 3)(4);
      assert.strictEqual(tf.to(73).toString(), "7"); // (73-3)/10
      assert.strictEqual(tf.from(Rational.from(7)), 73); // 7*10 + 3
    });
  });

  describe("4-param (returns TransformFunc directly)", () => {
    it("stored mode: equivalent to 3-param version", () => {
      const tf = linearTransform(4, "stored", 100);
      assert.strictEqual(tf.to(5).toString(), "500");
      assert.strictEqual(tf.from(Rational.from(500)), 5);
    });

    it("converted mode: equivalent to 3-param version", () => {
      const tf = linearTransform(4, "converted", 100);
      assert.strictEqual(tf.to(500).toString(), "5");
      assert.strictEqual(tf.from(Rational.from(5)), 500);
    });

    it("stored mode with offset b", () => {
      const tf = linearTransform(4, "stored", 10, 3);
      assert.strictEqual(tf.to(7).toString(), "73");
      assert.strictEqual(tf.from(Rational.from(73)), 7);
    });

    it("converted mode with offset b", () => {
      const tf = linearTransform(4, "converted", 10, 3);
      assert.strictEqual(tf.to(73).toString(), "7");
      assert.strictEqual(tf.from(Rational.from(7)), 73);
    });

    it("4-param round-trips through amountItem identically to 3-param", () => {
      const layout3 = amountItem(4, Usd, "$", linearTransform("stored", 100));
      const layout4 = amountItem(4, Usd, "$", linearTransform(4, "stored", 100));
      const amount = Amount.from(500, Usd);

      const enc3 = serialize(layout3, amount);
      const enc4 = serialize(layout4, amount);
      assert.deepStrictEqual(enc3, enc4);

      const dec3 = deserialize(layout3, enc3);
      const dec4 = deserialize(layout4, enc4);
      assert.strictEqual(dec3.in("$").toString(), dec4.in("$").toString());
    });
  });
});
