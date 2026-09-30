import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Merge, FromEntries } from "../src/object.js";
import { pick, omit, omitUndefined, replace, merge,
         spread, nest, deepOmit, deepReplace, anyKey, fromEntries } from "../src/object.js";
import { pinEq } from "./typeAssert.js";
import { zip } from "../src/array.js";

//the property merge exists for: it is built from mapped types, so it stays deferred over an open
//  type parameter, where an object spread would materialize it against its constraint - leaking
//  the constraint's optional keys and widening the caller's literals
const openParam = <const O extends { readonly x?: number } = {}>(opts?: O) =>
  merge({ a: 1 } as const, opts);
pinEq<ReturnType<typeof openParam<{ readonly x: 2 }>>,
      { readonly a: 1, readonly x: 2 }>(true);
//(a bare `typeof openParam` collapses O to its constraint, not its default, so spell the default)
pinEq<ReturnType<typeof openParam<{}>>, { readonly a: 1 }>(true);

// Regression: Merge used to drop every colliding fallback key outright, so an optional
// preferred key hid the fallback value that shows through it when absent
pinEq<Merge<{ a?: 1 }, { a: string }>, { a: 1 | string }>(true);
pinEq<
  Merge<{ readonly a?: 1 }, { a?: string }>,
  { readonly a?: 1 | string }>(true);
pinEq<
  Merge<{ a: 1 }, { a: 2, b: 3 }>,
  { a: 1, b: 3 }>(true);
pinEq<
  Merge<{ a?: 1 | undefined, readonly b: 2 }, { readonly a: string, b?: 3, c?: boolean }>,
  { a: 1 | undefined | string, readonly b: 2, c?: boolean }>(true);

describe("pick / omit", () => {
  it("pick keeps the given keys", () => {
    assert.deepEqual(pick({ a: 1, b: 2, c: 3 }, ["a", "b"]), { a: 1, b: 2 });
    assert.deepEqual(pick({ a: 1, b: 2 }, "a"), { a: 1 });
  });
  it("omit drops the given keys", () => {
    assert.deepEqual(omit({ a: 1, b: 2, c: 3 }, "c"), { a: 1, b: 2 });
    assert.deepEqual(omit({ a: 1, b: 2, c: 3 }, ["b", "c"]), { a: 1 });
  });
  // Regression: pick used to materialize requested-but-absent keys as undefined-valued
  // properties, contradicting Pick's preserved optionality.
  it("pick leaves absent keys absent", () => {
    const partial = { a: 1 } as { a: 1; b?: 2 };
    assert.deepEqual(Reflect.ownKeys(pick(partial, ["a", "b"])), ["a"]);
  });
  //regression: a runtime key array or a union key claimed the whole key set; the selection is
  //  exact only for a literal key or a fixed tuple of them
  it("accept runtime key arrays, with the selected keys optional", () => {
    const keys: ("a" | "b" | "c")[] = ["a", "b"];
    const picked = pick({ a: 1, b: 2, c: 3 }, keys);
    pinEq<typeof picked, { readonly a?: 1; readonly b?: 2; readonly c?: 3 }>(true);
    assert.deepEqual(picked, { a: 1, b: 2 });
    assert.deepEqual(omit({ a: 1, b: 2, c: 3 }, keys), { c: 3 });
    const either = "a" as "a" | "b";
    const one = pick({ a: 1, b: 2 }, either);
    pinEq<typeof one, { readonly a?: 1; readonly b?: 2 }>(true);
    const exact = pick({ a: 1, b: 2, c: 3 }, ["a", "b"]);
    pinEq<typeof exact, { readonly a: 1; readonly b: 2 }>(true);
    const swapped = replace({ a: 1, b: 2 }, either, "new");
    pinEq<typeof swapped, { readonly a: 1 | "new"; readonly b: 2 | "new" }>(true);
    const nested = nest({ a: 1, b: 2, c: 3 }, "n", keys);
    pinEq<typeof nested, { n: { readonly a?: 1; readonly b?: 2; readonly c?: 3 } }>(true);
    void [one, exact, swapped, nested];
  });
});

describe("omitUndefined", () => {
  it("drops undefined-valued keys and keeps every other falsy value", () => {
    assert.deepEqual(omitUndefined({ a: 1, b: undefined, c: null, d: 0, e: "" }),
      { a: 1, c: null, d: 0, e: "" });
  });

  it("covers symbol keys and leaves the input untouched", () => {
    const sym = Symbol("sym");
    const obj = { [sym]: undefined, a: 1 };
    assert.deepEqual(Reflect.ownKeys(omitUndefined(obj)), ["a"]);
    assert.equal(sym in obj, true, "input must be untouched");
  });

  it("spreads over a base record without clobbering it", () => {
    const base = { a: 1, b: 2 };
    assert.deepEqual({ ...base, ...omitUndefined({ b: undefined }) }, { a: 1, b: 2 });
  });
});

describe("replace / merge / spread / nest", () => {
  it("replace swaps a value", () => {
    assert.deepEqual(replace({ a: 1, b: 2 }, "a", "new"), { a: "new", b: 2 });
  });
  it("merge is left-biased", () => {
    assert.deepEqual(merge({ a: 1 }, { a: 2, b: 3 }), { a: 1, b: 3 });
  });
  it("merge lets the fallback show through an absent optional key", () => {
    const preferred: { a?: 1 } = {};
    const merged = merge(preferred, { a: "fallback" });
    pinEq<typeof merged, { a: 1 | "fallback" }>(true);
    assert.deepEqual(merged, { a: "fallback" });
  });
  //merge is the spread, so a preferred key holding undefined wins like any other value. It used
  //  to be dropped instead, which let the fallback show through a required `X | undefined` key
  //  typed as never holding it; omitUndefined restores that behavior with a type to match
  it("merge writes an undefined-valued preferred key over the fallback", () => {
    const required = merge({ a: undefined as 1 | undefined }, { a: "fallback" });
    pinEq<typeof required, { readonly a: 1 | undefined }>(true);
    assert.deepEqual(required, { a: undefined });
    const skipped = merge(omitUndefined({ a: undefined as 1 | undefined }), { a: "fallback" });
    pinEq<typeof skipped, { readonly a: 1 | "fallback" }>(true);
    assert.deepEqual(skipped, { a: "fallback" });
  });
  it("spread flattens a nested object", () => {
    assert.deepEqual(spread({ a: 1, n: { b: 2, c: 3 } }, "n"), { a: 1, b: 2, c: 3 });
  });
  it("nest groups keys under a new key", () => {
    assert.deepEqual(nest({ a: 1, b: 2, c: 3 }, "n", ["b", "c"]), { a: 1, n: { b: 2, c: 3 } });
  });
  it("nest may reuse a nested key as the new key", () => {
    assert.deepEqual(nest({ a: 1, b: 2 }, "b", "b"), { a: 1, b: { b: 2 } });
  });
  // Regression: spread/nest collisions used to be typed as intersections (spread's whole
  // result collapsed to never on unit-typed clashes) while the runtime shadowed; they are
  // now rejected at the signature.
  it("spread/nest reject collisions and non-object spreads at compile time", () => {
    // @ts-expect-error - nested "a" collides with the outer "a"
    const bannedCollision = () => spread({ a: 1, n: { a: 2 } }, "n");
    // @ts-expect-error - "n" does not hold a plain object
    const bannedPrimitive = () => spread({ a: 1, n: 2 }, "n");
    // @ts-expect-error - new key "a" collides with the remaining outer "a"
    const bannedNest = () => nest({ a: 1, b: 2 }, "a", "b");
    // Regression: IsPlain used to answer "some union member is plain" (and went indeterminate
    // on object|primitive unions), so union-typed fields slipped through SpreadableKeys.
    const mixedPrim = { a: 1, n: { b: 2 } } as { a: 1; n: { b: 2 } | string };
    // @ts-expect-error - "n" may hold a primitive at runtime
    const bannedMixedPrimitive = () => spread(mixedPrim, "n");
    const mixedArr = { a: 1, n: { b: 2 } } as { a: 1; n: { b: 2 } | readonly number[] };
    // @ts-expect-error - "n" may hold an array at runtime
    const bannedMixedArray = () => spread(mixedArr, "n");
    void [bannedCollision, bannedPrimitive, bannedNest, bannedMixedPrimitive, bannedMixedArray];
  });
});

//regression: the path types entered arrays and primitives by name while the runtime left them
//  alone, and a final anyKey claimed to delete array elements the runtime keeps
pinEq<
  DeepOmit<{ a: [{ x: 1; y: 2 }] }, ["a", "0", "x"]>,
  { a: [{ x: 1; y: 2 }] }>(true);
pinEq<
  DeepOmit<{ a: [{ x: 1; y: 2 }] }, ["a", typeof anyKey, "x"]>,
  { a: [{ y: 2 }] }>(true);
pinEq<
  DeepOmit<{ a: [1, 2] }, ["a", typeof anyKey]>,
  { a: [1, 2] }>(true);
pinEq<
  DeepOmit<{ a: 5 }, ["a", "x"]>,
  { a: 5 }>(true);
pinEq<
  DeepReplace<{ a: [{ x: 1 }] }, ["a", "0", "x"], 9>,
  { a: [{ x: 1 }] }>(true);
pinEq<
  DeepReplace<{ a: [1, 2] }, ["a", typeof anyKey], 9>,
  { a: [9, 9] }>(true);
pinEq<
  DeepReplace<{ a: 1 }, string[], 9>,
  unknown>(true);

describe("deepOmit", () => {
  it("removes a nested key without mutating the input", () => {
    const obj = { a: 1, n: { b: 2, c: 3 } };
    assert.deepEqual(deepOmit(obj, ["n", "c"]), { a: 1, n: { b: 2 } });
    assert.deepEqual(obj, { a: 1, n: { b: 2, c: 3 } }, "input must be untouched");
  });

  it("removes multiple keys at the leaf level", () => {
    assert.deepEqual(deepOmit({ a: 1, n: { b: 2, c: 3, d: 4 } }, ["n", ["b", "c"]]),
      { a: 1, n: { d: 4 } });
  });

  it("applies several independent paths", () => {
    assert.deepEqual(deepOmit({ a: 1, b: 2, c: 3 }, [["a"], ["c"]]), { b: 2 });
  });

  it("removes several root keys via a single-path list", () => {
    assert.deepEqual(deepOmit({ b: 1, c: 2, d: 3 }, [[["b", "c"]]]), { d: 3 });
  });

  it("is a no-op when the path does not exist", () => {
    assert.deepEqual(deepOmit({ a: 1 } as any, ["x", "y"]), { a: 1 });
  });

  // Regression: the anyKey walk used to build a fresh object that was never written back into
  // the result tree, so the omission silently vanished and the key stayed in place.
  it("anyKey removes a key from every child (mid-path)", () => {
    const obj = {
      outer: {
        a: { x: 1, drop: 2 },
        b: { x: 3, drop: 4 },
      },
    };
    assert.deepEqual(deepOmit(obj, ["outer", anyKey, "drop"]),
      { outer: { a: { x: 1 }, b: { x: 3 } } });
    assert.equal(obj.outer.a.drop, 2, "input must be untouched");
  });

  it("anyKey works at the root level", () => {
    assert.deepEqual(deepOmit({ a: { x: 1, drop: 2 }, b: { x: 3, drop: 4 } }, [anyKey, "drop"]),
      { a: { x: 1 }, b: { x: 3 } });
  });

  // Regression: anyKey used to spread primitives into {} instead of passing them through.
  it("anyKey leaves primitive values untouched", () => {
    assert.deepEqual(deepOmit({ a: 5, b: { x: 1, y: 2 } }, [anyKey, "x"]), { a: 5, b: { y: 2 } });
  });

  // Regression: the anyKey walk went through Object.entries and silently dropped
  // symbol-keyed entries from the result.
  it("anyKey preserves symbol-keyed entries", () => {
    const sym = Symbol("sym");
    const obj = { [sym]: { x: 1, y: 2 }, b: { x: 3 } };
    assert.deepEqual(deepOmit(obj, [anyKey, "x"]), { [sym]: { y: 2 }, b: {} });
  });

  it("anyKey as the last element removes all keys at that level", () => {
    assert.deepEqual(deepOmit({ n: { a: 1, b: 2 }, m: 3 }, ["n", anyKey]), { n: {}, m: 3 });
  });

  // Regression: paths used to mangle arrays into plain objects ({ '0': ..., '1': ... }).
  it("anyKey traverses arrays; named keys and deletions leave them untouched", () => {
    const obj = { a: [{ x: 1, y: 2 }, { x: 3 }], b: 1 };
    assert.deepEqual(deepOmit(obj, ["a", anyKey, "x"]), { a: [{ y: 2 }, {}], b: 1 });
    assert.deepEqual(deepOmit(obj, ["a", 0, "x"]), obj);
    assert.deepEqual(deepOmit(obj, ["a", "x"]), obj);
  });

  it("accepts runtime (non-tuple) paths", () => {
    const path: string[] = ["n", "c"];
    assert.deepEqual(deepOmit({ a: 1, n: { b: 2, c: 3 } }, path), { a: 1, n: { b: 2 } });
    const paths: string[][] = [["a"], ["n", "b"]];
    assert.deepEqual(deepOmit({ a: 1, n: { b: 2, c: 3 } }, paths), { n: { c: 3 } });
  });
});

describe("deepReplace", () => {
  it("replaces a nested value without mutating the input", () => {
    const obj = { a: 1, n: { b: 2, c: 3 } };
    assert.deepEqual(deepReplace(obj, ["n", "b"], "new"), { a: 1, n: { b: "new", c: 3 } });
    assert.deepEqual(obj, { a: 1, n: { b: 2, c: 3 } }, "input must be untouched");
  });

  it("replaces several keys via a keys-tuple last element", () => {
    assert.deepEqual(deepReplace({ n: { b: 2, c: 3, d: 4 } }, ["n", ["b", "c"]], 0),
      { n: { b: 0, c: 0, d: 4 } });
  });

  it("is a no-op for absent keys (does not create them)", () => {
    assert.deepEqual(deepReplace({ a: 1 } as any, ["x"], 5), { a: 1 });
  });

  it("anyKey replaces every value resp. every array element", () => {
    const obj = { users: { alice: { role: "admin" }, bob: { role: "user" } } };
    assert.deepEqual(deepReplace(obj, ["users", anyKey, "role"], "member"),
      { users: { alice: { role: "member" }, bob: { role: "member" } } });
    assert.deepEqual(deepReplace({ a: [1, 2, 3] }, ["a", anyKey], 0), { a: [0, 0, 0] });
  });

  it("applies several replacements at once", () => {
    assert.deepEqual(deepReplace({ a: 1, n: { b: 2 } }, [[["a"], 10], [["n", "b"], 20]]),
      { a: 10, n: { b: 20 } });
  });
});

describe("fromEntries", () => {
  it("builds a typed object from entries", () => {
    assert.deepEqual(fromEntries([["a", 1], ["b", 2]] as const), { a: 1, b: 2 });
  });

  //a runtime array may hold any subset of its keys' union
  it("makes literal keys optional over a runtime array", () => {
    const keys: ("a" | "b")[] = ["a"];
    const partial = fromEntries(keys.map(k => [k, 1] as const));
    pinEq<typeof partial, { a?: 1; b?: 1 }>(true);
    assert.deepEqual(partial, { a: 1 });
    const widened = fromEntries([] as (readonly [string, number])[]);
    pinEq<typeof widened, Record<string, number>>(true);
  });

  it("retains the complete key set supplied by a tuple", () => {
    const result = fromEntries(zip([["a", "b"], [1, 2]]));
    pinEq<typeof result, { a: 1; b: 2 }>(true);
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it("does not assume independent union keys cover their union", () => {
    const make = (a: "a" | "b", b: "a" | "b") => fromEntries([[a, 1], [b, 2]]);
    pinEq<ReturnType<typeof make>, { a?: 1 | 2; b?: 1 | 2 }>(true);
    assert.deepEqual(make("a", "a"), { a: 2 });
    assert.deepEqual(make("a", "b"), { a: 1, b: 2 });
  });

  it("keeps known keys required beside an uncertain key or open tail", () => {
    const make = (key: "a" | "b") => fromEntries([["a", 1], [key, "x"]]);
    pinEq<ReturnType<typeof make>, { a: 1 | "x"; b?: "x" }>(true);
    assert.deepEqual(make("a"), { a: "x" });
    assert.deepEqual(make("b"), { a: 1, b: "x" });

    const fromOpen = (entries: readonly [readonly ["a", number], ...["b", string][]]) =>
      fromEntries(entries);
    pinEq<ReturnType<typeof fromOpen>, { a: number; b?: string }>(true);
    assert.deepEqual(fromOpen([["a", 1]]), { a: 1 });
    assert.deepEqual(fromOpen([["a", 1], ["b", "x"]]), { a: 1, b: "x" });

    pinEq<FromEntries<[...["b", string][], ["a", number]]>,
      { a: number; b?: string }>(true);
    pinEq<FromEntries<[["a", number], ...["a" | "b", string][]]>,
      { a: number | string; b?: string }>(true);
    pinEq<FromEntries<[["a", 1], ...[string, string][]]>["a"], 1 | string>(true);
    pinEq<FromEntries<[[1, "a"], ["1", "b"]]>[1], "a" | "b">(true);
  });

  it("preserves alternatives and non-string keys", () => {
    const key = Symbol();
    const result = fromEntries([[key, 1], [2, "b"]]);
    pinEq<typeof result, { [key]: 1; 2: "b" }>(true);
    assert.deepEqual(result, { [key]: 1, 2: "b" });
    assert.deepEqual(fromEntries([[1, "a"], ["1", "b"]]), { "1": "b" });
    pinEq<FromEntries<[["a", 1], ["b", 2]] | [["b", 3], ["a", 4]]>,
      { a: 1; b: 2 } | { b: 3; a: 4 }>(true);
    pinEq<FromEntries<[readonly ["a", 1] | readonly ["b", 2]]>,
      { a?: 1; b?: 2 }>(true);
    pinEq<FromEntries<["a", 1][] | ["b", 2][]>, { a?: 1 } | { b?: 2 }>(true);
    pinEq<FromEntries<(["a", 1] | ["b", 2])[]>, { a?: 1; b?: 2 }>(true);
  });
});

// ---- Get ----

import type { Get, TrueKeys } from "../src/object.js";

pinEq<Get<{ readonly a: 1 }, "a">, 1>(true);
pinEq<Get<{ a: 1 }, "b">, undefined>(true);
//deliberate divergence from runtime access: an optional key is not *definitely* present,
//  so it counts as absent (binary-layout's Has* discriminators rely on this)
pinEq<Get<{ a?: 1 }, "a">, undefined>(true);
pinEq<Get<{ a: undefined }, "a">, undefined>(true);
//the Record clause distributes the lookup over object unions
pinEq<Get<{ a: 1 } | { b: 2 }, "a">, 1 | undefined>(true);

// ---- TrueKeys ----

pinEq<TrueKeys<{ a: true, b: false, c: true }>, "a" | "c">(true);
pinEq<TrueKeys<{ a: false }>, never>(true);
pinEq<TrueKeys<{}>, never>(true);
//an indeterminate boolean collapses to included
pinEq<TrueKeys<{ a: boolean, b: false }>, "a">(true);

// ---- OmitUndefined ----

import type { OmitUndefined } from "../src/object.js";
import type { Opts } from "../src/typing.js";

pinEq<OmitUndefined<{ a: 1 }>, { a: 1 }>(true);
pinEq<OmitUndefined<{ a: 1 | undefined }>, { a?: 1 }>(true);
pinEq<OmitUndefined<{ a: undefined, b: 1 }>, { b: 1 }>(true);
//regression: an any-valued key used to vanish, though the runtime keeps any value but undefined
pinEq<OmitUndefined<{ a: any, b: unknown }>, { a?: any, b?: unknown }>(true);
pinEq<OmitUndefined<{ a: never }>, { a: never }>(true);
pinEq<
  OmitUndefined<Opts<{ a: 1, b: 2 }>>,
  { readonly a?: 1, readonly b?: 2 }>(true);

// ---- DeepOmit / DeepReplace ----

import type { DeepOmit, DeepReplace } from "../src/object.js";

//regression: the keys-tuple form with a path prefix used to silently no-op at the type
//  level (the CoalescePath infer pattern lacked its rest element)
pinEq<
  DeepOmit<{ a: { b: 1, c: 2, d: 3 } }, ["a", ["b", "c"]]>, { a: { d: 3 } }>(true);
//regression: the list branch used to re-parse each path as a potential list, so the
//  single-path-list encoding for several root keys resolved to the wrong interpretation
pinEq<
  DeepOmit<{ b: 1, c: 2, d: 3 }, [[["b", "c"]]]>, { d: 3 }>(true);
//a one-element list of a plain path also parses as a single path targeting several root
//  keys, so the list interpretation has to win
pinEq<
  DeepOmit<{ a: { b: 1, c: 2 }, b: 3 }, [["a", "b"]]>, { a: { c: 2 }, b: 3 }>(true);
pinEq<
  DeepOmit<{ n: { a: 1, b: 2 }, m: 3 }, ["n", typeof anyKey]>, { n: {}, m: 3 }>(true);
pinEq<
  DeepOmit<{ a: readonly [{ x: 1, y: 2 }, { x: 3 }] }, ["a", typeof anyKey, "x"]>,
  { a: readonly [{ y: 2 }, {}] }>(true);
//a runtime (non-tuple) path could have reached anything: the result is unknown, not the input
//  type it used to claim
pinEq<DeepOmit<{ a: 1 }, string[]>, unknown>(true);

pinEq<
  DeepReplace<{ a: 1, n: { b: 2 } }, ["n", "b"], "x">, { a: 1, n: { b: "x" } }>(true);
pinEq<
  DeepReplace<{ n: { b: 2, c: 3, d: 4 } }, ["n", ["b", "c"]], 0>, { n: { b: 0, c: 0, d: 4 } }>(true);
pinEq<
  DeepReplace<{ a: readonly [1, 2] }, ["a", typeof anyKey], 0>, { a: readonly [0, 0] }>(true);
