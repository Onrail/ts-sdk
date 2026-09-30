import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Brand, ExtractTags } from "../src/branding.js";
import { brand } from "../src/branding.js";
import type { IsAny } from "../src/typing.js";
import type { Assert } from "./typeAssert.js";
import { pinEq } from "./typeAssert.js";

//Brand<any, ...> used to collapse to any (the intersection absorbed the brand), silently
//  turning brand constraints vacuous; any is now demoted to unknown
pinEq<IsAny<Brand<any, "x">>, false>(true);
pinEq<Brand<any, "x">, Brand<unknown, "x">>(true);
type _TagStillChecked1 = Assert<Brand<string, "x"> extends Brand<any, "x"> ? true : false>;
type _TagStillChecked2 = Assert<string extends Brand<any, "x"> ? false : true>;
type _TagStillChecked3 = Assert<Brand<string, "y"> extends Brand<any, "x"> ? false : true>;

//"" and never are neutral elements
pinEq<Brand<string, "">, string>(true);
pinEq<Brand<string, never>, string>(true);

//tags accumulate hierarchically and mixed-in ""s are dropped
pinEq<ExtractTags<Brand<Brand<string, "a">, "b" | "">>, "a" | "b">(true);
type _Hierarchy   = Assert<Brand<Brand<string, "a">, "b"> extends Brand<string, "a"> ? true : false>;

//a bare `Brand` (defaulted params) is the "some branded type": the base dissolves in the
//  intersection but the brand marker survives, so `X extends Brand` gates on brandedness
type _BareRejectsUnbranded = Assert<number extends Brand ? false : true>;
type _BareAcceptsBrands    = Assert<Brand<number, "x"> extends Brand ? true : false>;
type _BareAcceptsStacked   = Assert<Brand<Brand<string, "a">, "b"> extends Brand ? true : false>;

describe("brand", () => {
  it("is the identity at runtime", () => {
    assert.equal(brand<"user">()("abc"), "abc");
  });
});
