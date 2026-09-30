import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kind } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

const units = [{ symbols: [{ symbol: "X" }] }, { symbols: [{ symbol: "mX" }], oom: -3 }] as const;

//regression: the meta symbols were inferred per property, so `{ human: maybeX }` inferred "X" -
//  Opts' `| undefined` absorbed the undefined - and the kind claimed a human unit it lacked
describe("a meta symbol that may be undefined", () => {
  it("types the kind's meta symbol as maybe unset", () => {
    const maybe = kind("Maybe", units, { human: undefined as "X" | undefined });
    const given = kind("Given", units, { human: "X", atomic: "mX" });
    const none  = kind("None",  units);
    pinEq<typeof maybe.human, "X" | undefined>(true);
    pinEq<typeof given.human, "X">(true);
    pinEq<typeof given.atomic, "mX">(true);
    pinEq<"human" extends keyof typeof none ? true : false, false>(true);
    assert.equal(maybe.human, undefined);
  });
});
