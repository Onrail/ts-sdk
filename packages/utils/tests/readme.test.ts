import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ConstMap, MapLevels, ShapeLike, Brand,
              ExtractTags, PreserveBrand, SameBrand, Get, Identity,
              Ro, DeepRo, ApplyAliases, SuppressExpansion, Simplify } from "../src/index.js";
import { mapTo, entries, valueIndexEntries, range, flatten,
         chunk, zip, column, pickWithOrder, filterIndexes,
         pick, omit, omitUndefined, replace, merge, spread, nest,
         deepOmit, deepReplace, anyKey, fromEntries, constMap, uppercase,
         lowercase, capitalize, uncapitalize, otherCap, stripPrefix, pipe,
         identity, raise, tap, tryOr, map, fallback, ensure, forbid, brand } from "../src/index.js";
import type { Assert } from "./typeAssert.js";
import { pinEq } from "./typeAssert.js";

describe("ReadMe Array Utilities", () => {
  it("type-preserving map", () => {
    const tup = [1, 2, 3] as const;
    const mapped: readonly [string, string, string] = mapTo(tup)(x => x.toString());
    assert.deepEqual(mapped, ["1", "2", "3"]);
    const scalar: string = mapTo(1)(x => x.toString());
    assert.equal(scalar, "1");
  });

  it("entries", () => {
    assert.deepEqual(entries([10, 20, 30]), [[0, 10], [1, 20], [2, 30]]);
    assert.deepEqual(valueIndexEntries(["a", "b"]), [["a", 0], ["b", 1]]);
  });

  it("transformations", () => {
    assert.deepEqual(range(3), [0, 1, 2]);
    assert.deepEqual(flatten([[1, 2], [3]]), [1, 2, 3]);
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(zip([["a", "b"], [1, 2]]), [["a", 1], ["b", 2]]);
    assert.deepEqual(column([["a", 1], ["b", 2]], 0), ["a", "b"]);
    assert.deepEqual(pickWithOrder(["a", "b", "c"], [2, 0]), ["c", "a"]);
    assert.deepEqual(filterIndexes(["a", "b", "c"], [0, 2]), ["a", "c"]);
    assert.deepEqual(filterIndexes(["a", "b", "c"], 1), ["b"]);
    assert.deepEqual(filterIndexes(["a", "b", "c"], 1, true), ["a", "c"]);
  });
});

describe("ReadMe Object Utilities", () => {
  it("shallow operations", () => {
    const picked   = pick({ a: 1, b: 2, c: 3 }, ["a", "b"]);
    const omitted  = omit({ a: 1, b: 2, c: 3 }, "c");
    const defined  = omitUndefined({ a: 1, b: undefined });
    const replaced = replace({ a: 1, b: 2 }, "a", "new");
    const merged   = merge({ a: 1 }, { a: 2, b: 3 });
    const spreaded = spread({ a: 1, n: { b: 2, c: 3 } }, "n");
    const nested   = nest({ a: 1, b: 2, c: 3 }, "n", ["b", "c"]);
    pinEq<Simplify<typeof picked>,   { readonly a: 1, readonly b: 2 }>(true);
    pinEq<Simplify<typeof omitted>,  { readonly a: 1, readonly b: 2 }>(true);
    pinEq<typeof defined,            { readonly a: 1 }>(true);
    pinEq<Simplify<typeof replaced>, { readonly a: "new", readonly b: 2 }>(true);
    pinEq<typeof merged,             { readonly a: 1, readonly b: 3 }>(true);
    pinEq<typeof spreaded,           { readonly a: 1, readonly b: 2, readonly c: 3 }>(true);
    pinEq<Simplify<typeof nested.n>, { readonly b: 2, readonly c: 3 }>(true);
    assert.deepEqual(picked,   { a: 1, b: 2 });
    assert.deepEqual(omitted,  { a: 1, b: 2 });
    assert.deepEqual(defined,  { a: 1 });
    assert.deepEqual(replaced, { a: "new", b: 2 });
    assert.deepEqual(merged,   { a: 1, b: 3 });
    assert.deepEqual(spreaded, { a: 1, b: 2, c: 3 });
    assert.deepEqual(nested,   { a: 1, n: { b: 2, c: 3 } });
  });

  const obj = {
    outer: {
      a: { x: 1, y: 2 },
      b: { x: 3, y: 4 },
    },
  };

  it("deep operations", () => {
    assert.deepEqual(deepOmit(obj, ["outer", anyKey, "y"]),
      { outer: { a: { x: 1 }, b: { x: 3 } } });
    assert.deepEqual(deepReplace(obj, ["outer", anyKey, "y"], 0),
      { outer: { a: { x: 1, y: 0 }, b: { x: 3, y: 0 } } });
    assert.deepEqual(fromEntries([["a", 1], ["b", 2]]), { a: 1, b: 2 });
  });

  it("deep path forms", () => {
    assert.deepEqual(deepOmit(obj, ["outer", "a", ["x", "y"]]),
      { outer: { a: {}, b: { x: 3, y: 4 } } });
    assert.deepEqual(deepOmit(obj, [["outer", "a"], ["outer", "b"]]), { outer: {} });
    assert.deepEqual(
      deepReplace(obj, [[["outer", "a", "x"], 10], [["outer", "b", "x"], 30]]),
      { outer: { a: { x: 10, y: 2 }, b: { x: 30, y: 4 } } },
    );
    const withArray = { a: [{ x: 1, y: 2 }], b: 1 };
    assert.deepEqual(deepOmit(withArray, ["a", anyKey, "x"]), { a: [{ y: 2 }], b: 1 });
    assert.deepEqual(deepOmit(withArray, ["a", 0, "x"]), withArray);
  });

  it("Get distinguishes definitely-present from optional keys", () => {
    type O = { a: 1; b?: 2 };
    pinEq<Get<O, "a">, 1>(true);
    pinEq<Get<O, "b">, undefined>(true);
    pinEq<Get<O, "c">, undefined>(true);
    pinEq<Get<{ a: 1 } | { b: 2 }, "a">, 1 | undefined>(true);
    assert.ok(true);
  });
});

describe("ReadMe Conventions", () => {
  it("inline literals keep their literal types", () => {
    const r: [0, 1, 2] = range(3);
    assert.deepEqual(r, [0, 1, 2]);
  });

  it("mutability helpers pass functions through", () => {
    type Fn = (x: number) => string;
    pinEq<Ro<Fn>, Fn>(true);
    pinEq<DeepRo<{ f: Fn }>, { readonly f: Fn }>(true);
    assert.ok(true);
  });
});

const units = [[
  "si", [
    ["length", "m"],
    ["mass",   "kg"],
    ["speed",  "m/s"],
  ]], [
  "nautical", [
    ["length", "nmi"],
    ["speed",  "kn"],
  ]],
] as const satisfies MapLevels<[string, string, string]>;

const reverseShape = [2, [0, 1]] as const satisfies ShapeLike;

describe("ReadMe Const Maps", () => {
  const unitSymbol = constMap(units);

  it("usage", () => {
    const siLength: "m" = unitSymbol("si", "length");
    assert.equal(siLength, "m");
    assert.equal(unitSymbol("nautical", "speed"), "kn");

    assert.equal(unitSymbol.has("nautical", "mass"), false);
    assert.equal(unitSymbol.get("nautical", "mass"), undefined);

    const siUnit = unitSymbol.subMap("si");
    assert.equal(siUnit("mass"), "kg");
  });

  it("keys are strict, loose input goes through has / get", () => {
    // @ts-expect-error the second key's union depends on the first
    unitSymbol("nautical", "mass");

    const loose: string = "length";
    // @ts-expect-error a widened key is only acceptable to has / get
    unitSymbol("si", loose);

    const val = unitSymbol.get("si", loose);
    pinEq<typeof val, "m" | "kg" | "m/s" | "nmi" | "kn" | undefined>(true);
    assert.equal(val, "m");
  });

  it("custom shapes", () => {
    const systemAndQuantity = constMap(units, reverseShape);
    assert.deepEqual(systemAndQuantity("kn"), ["nautical", "speed"]);

    const systems = constMap(units, [1, 0]);
    assert.deepEqual(systems("length"), ["si", "nautical"]);
    assert.deepEqual(systems("mass"), ["si"]);
  });

  it("bigint and boolean keys stay distinct in both directions", () => {
    const strongTyping = [
      [1n,    "bigint"],
      [1,     "number"],
      [true, "boolean"],
    ] as const;

    const keyType = constMap(strongTyping);
    assert.equal(keyType(1n), "bigint");
    assert.equal(keyType(1), "number");
    assert.equal(keyType(true), "boolean");

    const inverse = constMap(strongTyping, [1, 0]);
    const fromBigint = inverse("bigint");
    pinEq<typeof fromBigint, 1n>(true);
    assert.equal(fromBigint, 1n);
    assert.equal(inverse("number"), 1);
    assert.equal(inverse("boolean"), true);
  });

  it("the documented spec and map types apply", () => {
    const named: ConstMap<typeof units> = unitSymbol;
    const reversed: ConstMap<typeof units, typeof reverseShape> = constMap(units, reverseShape);
    assert.equal(named("nautical", "length"), "nmi");
    assert.deepEqual(reversed("m/s"), ["si", "speed"]);
  });
});

describe("ReadMe String Utilities", () => {
  it("case functions preserve literal types", () => {
    const up: "HELLO" = uppercase("hello");
    const down: "hello" = lowercase("HELLO");
    const cap: "Hello" = capitalize("hello");
    const uncap: "hello" = uncapitalize("Hello");
    const other: "Hello" = otherCap("hello");
    assert.deepEqual([up, down, cap, uncap, other], ["HELLO", "hello", "Hello", "hello", "Hello"]);
  });

  it("prefix stripping preserves literal types", () => {
    const stripped: "1f" = stripPrefix("0x", "0x1f");
    const untouched: "1f" = stripPrefix("0x", "1f");
    assert.deepEqual([stripped, untouched], ["1f", "1f"]);
  });
});

describe("ReadMe Piping", () => {
  it("composition", () => {
    const fn = pipe(
      (n: number) => n + 1,
      tap((n: number) => assert(n > 0)),
      (n: number) => `${n}`,
    );
    assert.equal(fn(3), "4");
    assert.equal(identity(42), 42);
    assert.equal(tryOr(null)((s: string) => JSON.parse(s) as unknown)("nope"), null);
    assert.equal(map(5, (n: number) => n * 2), 10);
    assert.equal(fallback(0)(null), 0);
    const missing: string | undefined = undefined;
    assert.throws(() => missing ?? raise("missing"), { message: "missing" });
  });

  it("assertions", () => {
    assert.equal(ensure(5, (n: number) => n > 0), 5);
    assert.throws(() => ensure(0, (n: number) => n > 0, "must be positive"),
      { message: "must be positive" });
    assert.throws(() => ensure(0, (n: number) => n > 0, n => `${n} is not positive`),
      { message: "0 is not positive" });
    assert.equal(forbid(5, (n: number) => n === 0), 5);
  });
});

//tags accumulate hierarchically
type UserId = Brand<string, "UserId">;
type AdminId = Brand<UserId, "AdminId">;
pinEq<ExtractTags<AdminId>, "UserId" | "AdminId">(true);
type _Covariant = Assert<AdminId extends UserId ? true : false>;

//the tag parameter takes a branded type and inherits its tags
const inherited = brand<UserId>()("abc");
pinEq<ExtractTags<typeof inherited>, "UserId">(true);

//bare Brand is the "some brand" constraint
type _AnyBrand   = Assert<UserId extends Brand ? true : false>;
type _NotABrand  = Assert<string extends Brand ? false : true>;

pinEq<PreserveBrand<string, number>, number>(true);
pinEq<ExtractTags<PreserveBrand<UserId, string>>, "UserId">(true);
pinEq<PreserveBrand<UserId, number>, never>(true);
pinEq<SameBrand<string, number>, true>(true);

describe("ReadMe Branding", () => {
  it("brand is the identity at runtime and brands the inferred type", () => {
    const userId: UserId = brand<"UserId">()("abc");
    assert.equal(userId, "abc");
    const config = brand<"Config">()({ retries: 3, urls: ["a", "b"] });
    pinEq<
      typeof config,
      Brand<{ readonly retries: 3; readonly urls: readonly ["a", "b"] }, "Config">
    >(true);
    assert.deepEqual(config, { retries: 3, urls: ["a", "b"] });
  });
});

//the Identity-wrapped interface is structurally its argument
const _big = { a: 1, b: { c: 2 } } as const;
interface Named extends Identity<typeof _big> {}
type _IdentityIn  = Assert<typeof _big extends Named ? true : false>;
type _IdentityOut = Assert<Named extends typeof _big ? true : false>;

//union expansion suppression
type Letter = "a" | "b" | "c" | "d" | "e" | "f";
interface AllLetters extends SuppressExpansion<Letter> {}
interface Vowels extends SuppressExpansion<"a" | "e"> {}

interface LetterAliases {
  AllLetters: [Letter, AllLetters];
  Vowels: ["a" | "e", Vowels];
}

pinEq<ApplyAliases<LetterAliases, Letter>, keyof AllLetters>(true);
pinEq<ApplyAliases<LetterAliases, "a" | "e" | "f">, keyof Vowels | "f">(true);
//regression: an empty registry collapsed the union to never
pinEq<ApplyAliases<{}, "a" | "b">, "a" | "b">(true);
