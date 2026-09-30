import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertDistinct, assertEqual } from "../src/assertions.js";

describe("assertDistinct", () => {
  it("should throw an error if values are NOT distinct", () => {
    assert.throws(() => assertDistinct(1, 2, 3, 1));
  });

  it("should NOT throw an error if values are distinct (references)", () => {
    assert.doesNotThrow(() => assertDistinct({}, {}, {}));
    assert.strictEqual(assertDistinct(1, 2, 3), undefined);
  });

  it("should report symbols instead of failing to stringify them", () => {
    // Regression: joining symbols threw a TypeError.
    const sym = Symbol("dup");
    assert.throws(() => assertDistinct(sym, sym), /Symbol\(dup\)/);
  });
});

describe("assertEqual", () => {
  it("should throw an error if values are NOT equal (shallow)", () => {
    assert.throws(() => assertEqual(1, 2));
    assert.throws(() => assertEqual({}, {}));
  });

  it("should throw an error with a custom message", () => {
    assert.throws(() => assertEqual(1, 2, "custom"), /custom/);
  });

  it("should report symbols instead of failing to stringify them", () => {
    // Regression: template interpolation of a symbol threw a TypeError.
    assert.throws(() => assertEqual(Symbol("a"), Symbol("b")), /Symbol\(a\)/);
  });

  it("should NOT throw an error if values are equal (shallow)", () => {
    const ref = {};
    assert.doesNotThrow(() => assertEqual(ref, ref));
    assert.strictEqual(assertEqual(1, 1), undefined);
  });
});

