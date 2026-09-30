import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { utf8 } from "@onrail-xyz/utils";
import { base58 } from "../src/encoding.js";

describe("base58", () => {
  it("should encode", () => {
    assert.strictEqual(base58.encode(utf8.encode("test")), "3yZe7d");
    assert.strictEqual(base58.encode(new Uint8Array([72, 101, 108, 108, 111])),
      "9Ajdvzr",
    );
  });

  it("should round-trip leading zero bytes", () => {
    const leadingZeros = new Uint8Array([0, 0, 1]);
    assert.strictEqual(base58.encode(leadingZeros), "112");
    assert.deepStrictEqual(base58.decode("112"), leadingZeros);
  });

  it("should reject ambiguous characters", () => {
    for (const c of ["0", "O", "I", "l"])
      assert.throws(() => base58.decode(`11${c}`));
  });
});
