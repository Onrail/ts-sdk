import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { utf8 } from "@onrail-xyz/utils";
import { sha256 } from "../src/hashing.js";

//guards the re-export surface: a noble upgrade that moves a subpath or renames/redefines an
//  algorithm has to fail here rather than in a dependent package
describe("hashing re-exports", () => {
  it("should agree with node:crypto", () => {
    const input = utf8.encode("abc");
    assert.deepStrictEqual(sha256(input),
      new Uint8Array(createHash("sha256").update(input).digest()),
    );
  });
});
