import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hex, utf8, base64, bignum } from "../src/encoding.js";

describe("hex", () => {
  it("should strip the prefix, and only where it is one", () => {
    assert.strictEqual(hex.stripPrefix("0x1234"), "1234");
    assert.strictEqual(hex.stripPrefix("12340x"), "12340x");
    assert.strictEqual(hex.stripPrefix("120x34"), "120x34");
    assert.strictEqual(hex.stripPrefix("0x"), "");
  });

  it("should validate", () => {
    assert(hex.isValid("0x1234"));
    assert(hex.isValid("1234"));
    assert(!hex.isValid("0xGHIJ"));
    assert(!hex.isValid("GHIJ"));
  });

  it("isValid agrees with decode at the edges", () => {
    // Regression: isValid used to accept odd-length (which decode rejects) and reject
    // empty/\"0x\" (which decode accepts). isValid must be true iff decode won't throw.
    for (const s of ["", "0x", "ff", "0xff", "f0f", "0xf", "abc", "0xGHIJ"]) {
      let decodes = true;
      try { hex.decode(s); } catch { decodes = false; }
      assert.strictEqual(hex.isValid(s), decodes, `isValid/decode disagree on ${JSON.stringify(s)}`);
    }
  });

  it("should decode", () => {
    assert.deepStrictEqual(hex.decode("0x48656c6c6f20576f726c6421"),
      new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33]),
    );
    assert.deepStrictEqual(hex.decode("48656c6c6f20576f726c6421"),
      new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33]),
    );
  });

  it("should encode from Uint8Array", () => {
    assert.strictEqual(
      hex.encode(
        new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33]),
      ),
      "48656c6c6f20576f726c6421",
    );
    assert.strictEqual(
      hex.encode(
        new Uint8Array([
          72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33,
        ]),
        true,
      ),
      "0x48656c6c6f20576f726c6421",
    );
  });
});

describe("utf8", () => {
  it("should decode", () => {
    assert.strictEqual(utf8.decode(new Uint8Array([116, 101, 115, 116])), "test");
  });

  it("should encode", () => {
    assert.deepStrictEqual(utf8.encode("test"), new Uint8Array([116, 101, 115, 116]));
  });

  //a leading U+FEFF is content, not a byte order mark to strip
  it("round-trips a leading U+FEFF", () => {
    assert.strictEqual(utf8.decode(utf8.encode("\uFEFFabc")), "\uFEFFabc");
  });
});

describe("base64", () => {
  it("should validate", () => {
    assert(base64.isValid("dGVzdA=="));
    assert(!base64.isValid("dGVzdA"));
    assert(!base64.isValid("dGVzdA==="));
  });

  it("isValid agrees with decode at the edges", () => {
    // Regression: isValid used to accept final quanta with non-zero trailing bits (which decode
    // rejects). isValid must be true iff decode won't throw. The whitespace cases pin the gate
    // over Uint8Array.fromBase64, which accepts them.
    for (const s of [
      "", "dGVzdA==", "dGVzdB==", "SGVsbG8=", "SGVsbG9=", "SGVsbG8", "SGVsbG8=\n", "dGVzd?==",
      "A===", "AA==", "AB==", "AAA=", "AAB=", "AAAA", "A", "SGVs bG8=", "\tSGVsbG8=",
    ]) {
      let decodes = true;
      try { base64.decode(s); } catch { decodes = false; }
      assert.strictEqual(base64.isValid(s), decodes,
        `isValid/decode disagree on ${JSON.stringify(s)}`,
      );
    }
  });

  it("keeps a rejected payload out of its error message", () => {
    const huge = "?".repeat(10_000);
    assert.throws(() => base64.decode(huge), (e: Error) => e.message.length < 200);
  });

  it("should encode", () => {
    assert.strictEqual(base64.encode(utf8.encode("test")), "dGVzdA==");
    assert.strictEqual(base64.encode(new Uint8Array([72, 101, 108, 108, 111])),
      "SGVsbG8=",
    );
  });
});

describe("bignum", () => {
  it("should convert from hex", () => {
    assert.strictEqual(bignum.fromHex("0x1234"), 4660n);
    assert.strictEqual(bignum.fromHex("0x", true), 0n);
    assert.strictEqual(bignum.fromHex("", true), 0n);
    assert.throws(() => bignum.fromHex("0x"));
    assert.throws(() => bignum.fromHex(""));
  });

  it("should read hex regardless of the prefix", () => {
    //an unprefixed string used to reach BigInt() unchanged and hence be read as decimal
    assert.strictEqual(bignum.fromHex("1234"), 4660n);
    assert.strictEqual(bignum.fromHex("0b101"), 0x0b101n);
    assert.throws(() => bignum.fromHex("0o17"));
    assert.throws(() => bignum.fromHex(" 12 "));
  });

  //BigInt() trims whitespace on its own, which would admit it at the end but not the start
  it("should reject whitespace on either side", () => {
    for (const input of ["ff ", "ff\n", " ff", "\tff", "0x ff", "f f"])
      assert.throws(() => bignum.fromHex(input), /Invalid hex/, JSON.stringify(input));
    assert.strictEqual(bignum.fromHex("f"), 15n);
  });

  it("should convert to hex", () => {
    assert.strictEqual(bignum.toHex(4660n), "1234");
    assert.strictEqual(bignum.toHex(4660n, true), "0x1234");
    assert.strictEqual(bignum.toHex(1n), "01");
    assert.strictEqual(bignum.toHex(0n), "00");
  });

  it("fromHex inverts toHex", () => {
    for (const value of [0n, 1n, 18n, 255n, 4660n, 2n ** 256n - 1n])
      for (const prefix of [false, true])
        assert.strictEqual(bignum.fromHex(bignum.toHex(value, prefix)), value);
  });

  it("should convert from bytes", () => {
    assert.strictEqual(bignum.fromBytes(new Uint8Array([0x12, 0x34])), 4660n);
    assert.strictEqual(bignum.fromBytes(new Uint8Array([0, 0, 1])), 1n);
    assert.strictEqual(bignum.fromBytes(new Uint8Array(), true), 0n);
    assert.throws(() => bignum.fromBytes(new Uint8Array()));
  });

  it("fromBytes agrees with fromHex on long inputs", () => {
    for (const length of [1, 31, 32, 33, 256, 4096]) {
      const input = new Uint8Array(length).map((_, i) => (i * 131 + 7) & 0xff);
      assert.strictEqual(bignum.fromBytes(input), bignum.fromHex(hex.encode(input)));
    }
  });

  it("toBytes allocates the requested length exactly", () => {
    assert.deepStrictEqual(bignum.toBytes(0x1234n), new Uint8Array([0x12, 0x34]));
    assert.deepStrictEqual(bignum.toBytes(0x1234n, 2), new Uint8Array([0x12, 0x34]));
    assert.deepStrictEqual(bignum.toBytes(0x1234n, 4), new Uint8Array([0, 0, 0x12, 0x34]));
    assert.deepStrictEqual(bignum.toBytes(0n, 1), new Uint8Array([0]));
    assert.throws(() => bignum.toBytes(0x1234n, 1), /Can't fit/);
    const long = 2n ** 1000n - 1n;
    assert.strictEqual(bignum.fromBytes(bignum.toBytes(long, 200)), long);
  });

  it("should reject negative values instead of emitting garbage", () => {
    // Regression: toHex(-255n) used to yield "0-ff" (and toBytes then failed cryptically).
    for (const value of [-1n, -255n]) {
      assert.throws(() => bignum.toHex(value), /negative/);
      assert.throws(() => bignum.toBytes(value, 32), /negative/);
    }
  });

  it("should convert to bytes", () => {
    assert.deepStrictEqual(bignum.toBytes(4660n), new Uint8Array([0x12, 0x34]));
    assert.deepStrictEqual(bignum.toBytes(4660), new Uint8Array([0x12, 0x34]));
    assert.deepStrictEqual(bignum.toBytes(4660n, 4),
      new Uint8Array([0x00, 0x00, 0x12, 0x34]),
    );
    assert.throws(() => bignum.toBytes(4660n, 1));
  });

  it("should convert to number", () => {
    assert.strictEqual(bignum.toNumber(4660n), 4660);
    assert.throws(() =>
      bignum.toNumber(BigInt(Number.MAX_SAFE_INTEGER + 1)),
    );
    assert.throws(() =>
      bignum.toNumber(BigInt(Number.MIN_SAFE_INTEGER - 1)),
    );
  });

  it("should convert from number", () => {
    assert.strictEqual(bignum.fromNumber(4660), 4660n);
    assert.throws(() => bignum.fromNumber(Number.MIN_SAFE_INTEGER - 1));
    assert.throws(() => bignum.fromNumber(Number.MAX_SAFE_INTEGER + 1));
  });
});
