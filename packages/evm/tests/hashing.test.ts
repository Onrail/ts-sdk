import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { utf8, hex } from "@onrail-xyz/utils";
import { keccak256, sha3_256 } from "../src/hashing.js";

//guards the re-export surface: a noble upgrade that moves a subpath or renames/redefines an
//  algorithm has to fail here rather than in a dependent package
describe("hashing re-exports", () => {
  const input = utf8.encode("abc");

  it("should agree with node:crypto", () => {
    assert.deepStrictEqual(sha3_256(input),
      new Uint8Array(createHash("sha3-256").update(input).digest()),
    );
  });

  it("should hash keccak with the pre-standardization padding", () => {
    //keccak256 is not sha3_256 - node has no keccak, so the ubiquitous empty input vector serves
    assert.strictEqual(hex.encode(keccak256(new Uint8Array())),
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    assert.notDeepStrictEqual(keccak256(input), sha3_256(input));
  });
});
