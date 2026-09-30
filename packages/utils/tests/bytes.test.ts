import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bytes } from "../src/bytes.js";

describe("bytes", () => {
  it("should check equality", () => {
    assert(bytes.equals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
    assert(!bytes.equals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])));
  });

  it("should zero pad", () => {
    assert.deepStrictEqual(bytes.zpad(new Uint8Array([1, 2, 3]), 5),
      new Uint8Array([0, 0, 1, 2, 3]),
    );
    assert.deepStrictEqual(bytes.zpad(new Uint8Array([1, 2, 3]), 3),
      new Uint8Array([1, 2, 3]),
    );
    assert.deepStrictEqual(bytes.zpad(new Uint8Array([1]), 2, false),
      new Uint8Array([1, 0]),
    );
    assert.throws(() => bytes.zpad(new Uint8Array([1, 2, 3]), 2));
  });

  it("should concat", () => {
    assert.deepStrictEqual(
      bytes.concat(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
      new Uint8Array([1, 2, 3, 4]),
    );
    assert.deepStrictEqual(bytes.concat(), new Uint8Array());
    assert.deepStrictEqual(
      bytes.concat(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2])),
      new Uint8Array([1, 2]),
    );
  });

  it("should always return a fresh array, also for the single argument case", () => {
    const single = new Uint8Array([1, 2]);
    const result = bytes.concat(single);
    single[0] = 9;
    assert.deepStrictEqual(result, new Uint8Array([1, 2]));
  });
});
