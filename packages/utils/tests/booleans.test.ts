import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IsAny, IsNever, IsUnion, IsLiteral, Not, And, Or, Xor } from "../src/typing.js";
import { pinEq } from "./typeAssert.js";

//IsAny must survive a *bounded* parameter: the familiar `0 extends 1 & T` idiom silently answers
//  false whenever the constraint rules the intersection out - `1 & T` reduces to never under
//  `T extends object` or `T extends string` - which is exactly where carve-outs need it
type AtObjectBound<T extends object> = IsAny<T>;
type AtStringBound<T extends string> = IsAny<T>;
pinEq<IsAny<any>, true>(true);
pinEq<IsAny<unknown>, false>(true);
pinEq<IsAny<never>, false>(true);
pinEq<IsAny<boolean>, false>(true);
pinEq<AtObjectBound<any>, true>(true);
pinEq<AtStringBound<any>, true>(true);
pinEq<AtObjectBound<{ a: 1 }>, false>(true);

//IsNever must not distribute: a naked `T extends never` short-circuits to never
pinEq<IsNever<never>, true>(true);
pinEq<IsNever<true>, false>(true);
pinEq<IsNever<true | never>, false>(true);

pinEq<IsUnion<1 | 2>, true>(true);
pinEq<IsUnion<boolean>, true>(true);
pinEq<IsUnion<1>, false>(true);
pinEq<IsUnion<never>, never>(true);

declare const sym: unique symbol;
pinEq<IsLiteral<"a"> | IsLiteral<""> | IsLiteral<1> | IsLiteral<2n> | IsLiteral<true>, true>(true);
pinEq<IsLiteral<null> | IsLiteral<undefined> | IsLiteral<typeof sym>, true>(true);
pinEq<IsLiteral<string> | IsLiteral<number> | IsLiteral<bigint> | IsLiteral<boolean> | IsLiteral<symbol>, false>(true);
pinEq<IsLiteral<`a${string}`> | IsLiteral<`${number}`> | IsLiteral<Uppercase<string>>, false>(true);
pinEq<IsLiteral<1 | 2>, false>(true);
pinEq<IsLiteral<{ readonly x: 1 }> | IsLiteral<readonly []>, false>(true);
pinEq<IsLiteral<never>, false>(true);

pinEq<Not<true>, false>(true);
pinEq<Not<false>, true>(true);
pinEq<Not<boolean>, boolean>(true);

pinEq<And<true, true>, true>(true);
pinEq<And<true, false>, false>(true);
pinEq<And<[true, true, true]>, true>(true);
pinEq<And<[true, false, true]>, false>(true);
pinEq<And<[]>, true>(true); //neutral element
pinEq<And<[true, true], false>, false>(true); //R folds in one more operand
//three-valued: an indeterminate operand propagates in either form, unless absorbed
pinEq<And<true, boolean>, boolean>(true);
pinEq<And<[true, boolean]>, boolean>(true);
pinEq<And<[false, boolean]>, false>(true); //false absorbs
//which slot holds the indeterminate operand must not matter
pinEq<And<boolean, true>, And<true, boolean>>(true);

pinEq<Or<false, false>, false>(true);
pinEq<Or<false, true>, true>(true);
pinEq<Or<[false, true]>, true>(true);
pinEq<Or<[false, false]>, false>(true);
pinEq<Or<[]>, false>(true); //neutral element
pinEq<Or<[boolean]>, boolean>(true);
pinEq<Or<[true, boolean]>, true>(true); //true absorbs
pinEq<Or<boolean, false>, Or<false, boolean>>(true);

pinEq<Xor<true, false>, true>(true);
pinEq<Xor<true, true>, false>(true);
pinEq<Xor<false, false>, false>(true);
pinEq<Xor<[true, false, true]>, false>(true);
pinEq<Xor<[true]>, true>(true); //single operand is identity
pinEq<Xor<[true, false], true>, false>(true);
pinEq<Xor<[]>, false>(true); //neutral element, like And's true and Or's false
//three-valued like And/Or, and identically across the tuple, binary and unary spellings - the
//  tuple form used to collapse an indeterminate operand to true, the unary form to false, while
//  the binary form propagated it (by distributing over the bare operand)
pinEq<Xor<[true, boolean]>, boolean>(true);
pinEq<Xor<true, boolean>, boolean>(true);
pinEq<Xor<boolean>, boolean>(true);
pinEq<Xor<[boolean]>, boolean>(true);
pinEq<Xor<boolean, true>, Xor<true, boolean>>(true);
pinEq<Xor<true>, true>(true); //unary is the identity in the binary spelling too

//A spread can hide operands, but a fixed absorber on either side still decides And/Or.
pinEq<And<[true, ...boolean[]]>, boolean>(true);
pinEq<And<[true, ...boolean[]], false>, false>(true);
pinEq<And<[...boolean[], false]>, false>(true);
pinEq<And<[false, ...boolean[]]>, false>(true);
pinEq<And<true[]>, true>(true);
pinEq<And<false[]>, boolean>(true); //the empty array yields true
pinEq<And<boolean[]>, boolean>(true);
pinEq<Or<[false, ...boolean[]]>, boolean>(true);
pinEq<Or<[false, ...boolean[]], true>, true>(true);
pinEq<Or<[...boolean[], true]>, true>(true);
pinEq<Or<[true, ...boolean[]]>, true>(true);
pinEq<Or<false[]>, false>(true);
pinEq<Or<true[]>, boolean>(true); //the empty array yields false
pinEq<Or<boolean[]>, boolean>(true);
pinEq<Xor<[false, ...boolean[]]>, boolean>(true);
pinEq<Xor<[true, ...false[]]>, true>(true);
pinEq<Xor<[...false[], true]>, true>(true);
pinEq<Xor<[true, ...false[], true]>, false>(true);
pinEq<Xor<true[]>, boolean>(true); //unknown parity
pinEq<Xor<false[]>, false>(true);
pinEq<Xor<boolean[]>, boolean>(true);

//Keep the alternatives correlated while peeling their elements.
pinEq<And<[false, boolean] | [boolean, false]>, false>(true);
pinEq<Or<[true, boolean] | [boolean, true]>, true>(true);
pinEq<Xor<[true, true] | [false]>, false>(true);

describe("boolean algebra types", () => {
  it("compiles", () => { assert.ok(true); });
});
