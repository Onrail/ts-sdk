import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripPrefix } from "../src/string.js";

describe("stripPrefix", () => {
  it("should strip the prefix, and only where it is one", () => {
    assert.strictEqual(stripPrefix("0x", "0x1234"),   "1234");
    assert.strictEqual(stripPrefix("0x", "12340x"), "12340x");
    assert.strictEqual(stripPrefix("0x", "120x34"), "120x34");
    assert.strictEqual(stripPrefix("0x",     "0x"),       "");
    assert.strictEqual(stripPrefix(  "",   "1234"),   "1234");
  });

  it("should degrade to string for non-literal inputs", () => {
    const dynamic: string = "0x99".slice(0);
    const stripped: string = stripPrefix("0x", dynamic);
    assert.strictEqual(stripped, "99");
  });
});
