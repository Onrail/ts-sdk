import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DeriveType, Endianness } from "../src/index.js";
import { serialize, deserialize, timestampConversion, timestampItem } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

describe("timestampConversion", () => {
  const wholeSecond = new Date("2030-01-01T00:00:00.000Z");
  const subSecond   = new Date("2030-01-01T00:00:00.500Z"); //fractional second
  const unixSeconds = Math.floor(Date.parse("2030-01-01T00:00:00.500Z") / 1000);

  describe("number-sized (size <= 6)", () => {
    const conv = timestampConversion();
    it("from: floors a fractional second", () => {
      assert.strictEqual(conv.from(subSecond), unixSeconds);
    });
    it("round-trips a whole second", () => {
      assert.deepStrictEqual(conv.to(conv.from(wholeSecond)), wholeSecond);
    });
  });

  describe("bigint-sized (size > 6)", () => {
    const conv = timestampConversion({ size: 32 });
    //regression: previously `BigInt(getTime()/1000)` threw RangeError on any fractional second
    it("from: floors a fractional second instead of throwing", () => {
      assert.strictEqual(conv.from(subSecond), BigInt(unixSeconds));
    });
    it("round-trips a whole second", () => {
      assert.deepStrictEqual(conv.to(conv.from(wholeSecond)), wholeSecond);
    });
  });

  //the conversion delegates wire-fit to serializeNum, so rejection is asserted at the layout
  //  level; previously the double path let the NaN through as the encoded value
  it("rejects an Invalid Date in both domains instead of encoding NaN", () => {
    for (const item of [timestampItem(), timestampItem({ size: 8 })])
      assert.throws(() => serialize(item, new Date(NaN)));
  });

  //truncating division would encode this as count 0, silently moving the instant to the origin;
  //  flooring gives -1, which serializeNum rejects (the bigint path previously truncated, in
  //  disagreement with the double path's Math.floor)
  it("rejects a fractional pre-origin instant in both domains", () => {
    for (const item of [timestampItem(), timestampItem({ size: 8 })])
      assert.throws(() => serialize(item, new Date(-500)), /does not fit/);
  });

  it("rejects a pre-origin date", () => {
    assert.throws(
      () => serialize(timestampItem(), new Date("1960-01-01T00:00:00.000Z")),
      /does not fit/,
    );
  });

  it("an earlier origin makes pre-epoch dates representable", () => {
    const preEpoch = new Date("1960-01-01T00:00:00.000Z");
    const layout = timestampItem({ origin: new Date("1900-01-01T00:00:00.000Z") });
    assert.deepStrictEqual(deserialize(layout, serialize(layout, preEpoch)), preEpoch);
  });

  it("rejects a date beyond the field width", () => {
    assert.throws(
      () => serialize(timestampItem(), new Date("2200-01-01T00:00:00.000Z")),
      /does not fit/,
    );
  });

  it("timestampItem round-trips through a layout", () => {
    const layout = timestampItem({ size: 8 });
    const decoded = deserialize(layout, serialize(layout, subSecond));
    assert.deepStrictEqual(decoded, new Date(unixSeconds * 1000));
  });

  //sentinels like maxUint256 ("no deadline") exceed Date's range; previously they silently
  //  decoded to an Invalid Date, and later to an opaque "Invalid date: <ms>"
  describe("reports a count that has no Date", () => {
    it("bigint-sized", () => {
      assert.throws(
        () => timestampConversion({ size: 32 }).to(2n ** 256n - 1n),
        /uint256 s timestamp count 1157920892373161954235709850086879078532699846656405640394575840079131296399[0-9]+ lands outside/,
      );
    });
    it("number-sized", () => {
      assert.throws(
        () => timestampConversion({ size: 6 }).to(2 ** 46),
        /uint48 s timestamp count 70368744177664 lands outside/,
      );
    });
    it("names the count, not the millisecond product it would have formed", () => {
      assert.throws(() => timestampConversion({ size: 6 }).to(2 ** 46), /count 70368744177664 /);
    });
  });

  describe("saturation sentinels", () => {
    const fieldMax = 0xffff_ffff;
    const noExpiry = timestampConversion({ saturateAs: "forever" });

    it("encodes the sentinel as the field's max", () => {
      assert.strictEqual(noExpiry.from("forever"), fieldMax);
    });

    it("decodes the field's max back to the sentinel", () => {
      assert.strictEqual(noExpiry.to(fieldMax), "forever");
    });

    it("clamps a too-late date instead of throwing", () => {
      assert.strictEqual(noExpiry.from(new Date("2200-01-01T00:00:00.000Z")), fieldMax);
    });

    it("saturation is one-sided: a pre-origin date still throws", () => {
      const item = timestampItem({ saturateAs: "forever" });
      assert.throws(() => serialize(item, new Date("1960-01-01T00:00:00.000Z")), /does not fit/);
    });

    it("names the sentinel in the derived type - both factories alike", () => {
      const item = timestampItem({ saturateAs: "forever" });
      pinEq<DeriveType<typeof item>, Date | "forever">(true);
      pinEq<ReturnType<typeof noExpiry.to>, Date | "forever">(true);
    });

    it("a bigint-sized field decodes any beyond-Date count to the sentinel", () => {
      const conv = timestampConversion({ size: 8, saturateAs: "forever" });
      assert.strictEqual(conv.to(2n ** 63n), "forever");
    });

    it("a NaN sentinel matches by SameValueZero, not ===", () => {
      const conv = timestampConversion({ saturateAs: NaN });
      assert.strictEqual(conv.from(NaN), fieldMax);
    });

    it("a sentinel Date is matched by value, not reference", () => {
      const conv = timestampConversion({ saturateAs: new Date(fieldMax * 1000) });
      assert.strictEqual(conv.from(new Date(fieldMax * 1000)), fieldMax);
    });
  });

  describe("origin and unit", () => {
    it("ms unit round-trips sub-second precision", () => {
      const conv = timestampConversion({ unit: "ms", size: 6 });
      assert.deepStrictEqual(conv.to(conv.from(subSecond)), subSecond);
    });

    it("origin shifts the encoded count", () => {
      const conv = timestampConversion({ origin: new Date("2000-01-01T00:00:00.000Z") });
      assert.strictEqual(conv.from(new Date("2000-01-01T00:01:00.000Z")), 60);
    });

    it("an origin beyond the double path still yields numbers for small fields", () => {
      const origin = new Date(2 ** 52); //|origin| + Date range exceeds the safe integer range
      const conv = timestampConversion({ origin });
      const later = new Date(origin.getTime() + 60_000);
      assert.strictEqual(conv.from(later), 60);
      assert.deepStrictEqual(conv.to(60), later);
    });
  });
});

//the item used to take E through NonNullable, so a maybe-unset endianness came out as always set
describe("timestampItem endianness", () => {
  const maybe = (little: boolean): Endianness | undefined => little ? "little" : undefined;

  it("carries the key exactly when one is given", () => {
    const given = timestampItem({ endianness: "little" });
    const none  = timestampItem();
    const unset = timestampItem({ endianness: maybe(false) });
    pinEq<typeof given.endianness, "little">(true);
    pinEq<keyof typeof none, "binary" | "size" | "custom">(true);
    assert.strictEqual(given.endianness, "little");
    assert(!("endianness" in none));
    assert(!("endianness" in unset));
  });

  it("types a maybe-unset endianness as maybe-present", () => {
    const item = timestampItem({ endianness: maybe(true) });
    pinEq<typeof item extends { readonly endianness: Endianness } ? true : false, false>(true);
    assert.deepStrictEqual(serialize(item, new Date(1000)), Uint8Array.of(1, 0, 0, 0));
  });
});

//regression: the options' types were inferred per property, so `{ size: maybe8 }` inferred S = 8 -
//  Opts' `| undefined` absorbed the undefined - and the item claimed a width the runtime replaced
//  by the default whenever the variable held undefined
describe("timestamp options that may be undefined", () => {
  it("type every outcome", () => {
    const maybeSize = undefined as 8 | undefined;
    const sized = timestampItem({ size: maybeSize });
    const fixed = timestampItem({ size: 8 }), plain = timestampItem();
    const declared = timestampItem({} as { size?: 8 });
    pinEq<typeof sized.size,    4 | 8>(true);
    pinEq<typeof fixed.size,    8>(true);
    pinEq<typeof plain.size,    4>(true);
    pinEq<typeof declared.size, 4 | 8>(true);
    assert.equal(sized.size, 4);
  });
  it("take a sentinel by presence", () => {
    const never     = timestampConversion({ saturateAs: "never" });
    const undef     = timestampConversion({ saturateAs: undefined });
    const maybe     = timestampConversion({ saturateAs: undefined as "never" | undefined });
    const none      = timestampConversion();
    pinEq<ReturnType<typeof never.to>, Date | "never">(true);
    pinEq<ReturnType<typeof undef.to>, Date | undefined>(true);
    pinEq<ReturnType<typeof maybe.to>, Date | "never" | undefined>(true);
    pinEq<ReturnType<typeof none.to>,  Date>(true);
    assert.equal(undef.to(2 ** 32 - 1), undefined);
  });
  it("reject an opts record that may be absent", () => {
    // @ts-expect-error - the item's shape would depend on it
    timestampItem(undefined as { size: 8 } | undefined);
  });
});
