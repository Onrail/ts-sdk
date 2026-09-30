import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Ro, DeepRo, Mutable, DeepMutable, RoUint8Array } from "../src/typing.js";
import { pinEq } from "./typeAssert.js";

type Fn = (x: number) => string;

//functions used to be mapped like objects, which leaves an empty object type behind
pinEq<Ro<Fn>, Fn>(true);
pinEq<Mutable<Fn>, Fn>(true);
pinEq<DeepRo<{ f: Fn }>, { readonly f: Fn }>(true);
pinEq<DeepMutable<{ readonly f: Fn }>, { f: Fn }>(true);

declare const addrBrand: unique symbol;
type Address<S extends string = string> = S & { readonly [addrBrand]: "Address" };

//a branded primitive is an intersection, so it used to be mapped like an object: the result
//  expanded the base's members and no longer assigned back to the brand it came from
pinEq<Ro<Address>, Address>(true);
pinEq<Mutable<Address>, Address>(true);
pinEq<DeepRo<{ o: Address<"abc"> }>, { readonly o: Address<"abc"> }>(true);
pinEq<DeepMutable<{ readonly o: Address }>, { o: Address }>(true);

pinEq<Ro<{ a: 1 }>, { readonly a: 1 }>(true);
pinEq<DeepRo<{ a: { b: 1 } }>, { readonly a: { readonly b: 1 } }>(true);
pinEq<DeepRo<{ a: Uint8Array }>, { readonly a: RoUint8Array }>(true);
pinEq<DeepMutable<DeepRo<{ a: { b: 1 } }>>, { a: { b: 1 } }>(true);

describe("mutability helpers", () => {
  it("compiles", () => { assert.ok(true); });
});
