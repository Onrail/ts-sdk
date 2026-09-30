import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import type { PickWithOrder, TupleFlatten, Entries, Zip, MapArrayness } from "../src/array.js";
import { mapTo, entries, valueIndexEntries, range, flatten, chunk,
         zip, column, pickWithOrder, filterIndexes, isArray, isUint8Array } from "../src/array.js";
import { pinEq } from "./typeAssert.js";

// Regression: PickWithOrder used to hand back the input tuple's type whenever the indexes were
// a runtime array, and a `number`-typed index in a tuple of indexes lacked the `undefined` an
// out-of-range pick yields
pinEq<PickWithOrder<readonly ["a", "b"], number[]>, ("a" | "b" | undefined)[]>(true);
pinEq<PickWithOrder<readonly ["a", "b"], [0 | 1, number]>, ["a" | "b", "a" | "b" | undefined]>(true);
pinEq<PickWithOrder<readonly ["a", "b"], [0, 5]>, ["a", undefined]>(true);
pinEq<PickWithOrder<string[], [1, 0]>, [string | undefined, string | undefined]>(true);

// Regression: an open-tailed tuple (`[1, ...number[]]`) is a RoTuple, so the walkers entered
// tuple recursion on it and lost the tail - Flatten<[1, ...number[]]> was []. Its length is
// `number` like any array's, so the unprefixed shapes degrade to the array form and the
// Tuple-prefixed ones refuse it
type Open = [1, ...number[]];
pinEq<Flatten<Open>, number[]>(true);
pinEq<Flatten<[[1], ...number[][]]>, number[]>(true);
pinEq<Flatten<[[1], [2, 3]]>, [1, 2, 3]>(true);
pinEq<TupleFlatten<Open>, never>(true);
pinEq<Entries<Open>, [number, number][]>(true);
pinEq<Chunk<Open, 2>, number[][]>(true);
pinEq<TupleChunk<Open, 2>, never>(true);
pinEq<PickWithOrder<readonly ["a", "b"], [0, ...number[]]>, ("a" | "b" | undefined)[]>(true);
pinEq<PickWithOrder<Open, [0, 5]>, [number | undefined, number | undefined]>(true);
pinEq<FilterIndexes<Open, 0>, number[]>(true);
pinEq<Zip<[[1, 2], ...[number, number][]]>, number[][]>(true);

// a union of arrays is examined arm by arm: its length is `number`, so a single IsFixedTuple
// check over the whole union would degrade the tuple arm along with the array
pinEq<Entries<readonly [1, 2] | number[]>, [[0, 1], [1, 2]] | [number, number][]>(true);
pinEq<Flatten<readonly [[1], [2]] | number[][]>, [1, 2] | number[]>(true);
pinEq<PickWithOrder<readonly ["a", "b"], readonly [1] | readonly [0, 1]>, ["b"] | ["a", "b"]>(true);
// filter builds a fresh array, so a readonly input comes back mutable
pinEq<FilterIndexes<readonly number[], 0>, number[]>(true);

describe("mapTo", () => {
  it("preserves open tuple elements", () => {
    const input: [number, ...number[]] = [1, 2, 3];
    const mapped = mapTo(input)(String);
    const second = mapped[1];
    pinEq<typeof mapped, [string, ...string[]]>(true);
    pinEq<typeof second, string | undefined>(true);
    pinEq<MapArrayness<readonly [number, ...number[]], string>, readonly [string, ...string[]]>(true);
    pinEq<MapArrayness<[number, number?], string>, [string, string?]>(true);
    pinEq<MapArrayness<[...number[], number], string>, [...string[], string]>(true);
    assert.deepEqual(mapped, ["1", "2", "3"]);
  });

  it("preserves tuple structure and works on scalars", () => {
    assert.deepEqual(mapTo([1, 2, 3] as const)(x => x.toString()), ["1", "2", "3"]);
    assert.equal(mapTo(1)(x => x.toString()), "1");
  });

  //Array.prototype.map would hand parseInt the index as its radix
  it("calls the callback with the value alone, on arrays as on scalars", () => {
    assert.deepEqual(mapTo(["10", "10", "10"])(parseInt), [10, 10, 10]);
    assert.equal(mapTo("10")(parseInt), 10);
  });
});

describe("entries / valueIndexEntries", () => {
  it("entries pairs index with value", () => {
    assert.deepEqual(entries([10, 20, 30] as const), [[0, 10], [1, 20], [2, 30]]);
  });
  it("valueIndexEntries pairs value with index", () => {
    assert.deepEqual(valueIndexEntries(["a", "b"]), [["a", 0], ["b", 1]]);
  });
});

describe("transformations", () => {
  it("range", () => assert.deepEqual(range(3), [0, 1, 2]));
  it("flatten", () => assert.deepEqual(flatten([[1, 2], [3]]), [1, 2, 3]));
  // Regression: Flatten used to keep a runtime (non-tuple) array as an unflattened element
  // while the runtime spliced it open; it now degrades to a plain array (pinned as `Flatten<[1, string[]]>` below).
  it("flatten splices runtime array elements", () => {
    const arr: string[] = ["a", "b"];
    assert.deepEqual(flatten([1, arr] as const), [1, "a", "b"]);
  });
  it("chunk (last chunk may be short)", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
  it("zip", () => assert.deepEqual(zip([["a", "b"], [1, 2]]), [["a", 1], ["b", 2]]));
  // Regression: zipping nothing used to dereference the missing first row and throw, while
  // Zip<[]> has always been []
  it("zip of no rows is empty", () => assert.deepEqual(zip([]), []));
  it("column", () => assert.deepEqual(column([["a", 1], ["b", 2]], 0), ["a", "b"]));
  // Regression: over runtime rows the element guard rejected the mapped `number` key, typing
  // every element never
  it("column of runtime rows degrades to an array", () => {
    const rows: string[][] = [["a", "b"], ["c", "d"]];
    const col = column(rows, 1);
    pinEq<typeof col, string[]>(true);
    assert.deepEqual(col, ["b", "d"]);
  });
  it("pickWithOrder reorders by index", () => {
    assert.deepEqual(pickWithOrder(["a", "b", "c"], [2, 0]), ["c", "a"]);
  });
  it("pickWithOrder yields undefined for out-of-range indexes (type mirrors runtime)", () => {
    assert.deepEqual(pickWithOrder(["a", "b"], [0, 5]), ["a", undefined]);
  });
  it("pickWithOrder with runtime indexes", () => {
    const indexes: number[] = [1];
    assert.deepEqual(pickWithOrder(["a", "b"] as const, indexes), ["b"]);
  });
});

describe("filterIndexes", () => {
  // Regression: with `exclude` omitted the predicate used to compare a boolean against
  // `undefined` (always true), so every element survived instead of only the picked indexes.
  it("keeps the given indexes by default", () => {
    assert.deepEqual(filterIndexes(["a", "b", "c"], [0, 2]), ["a", "c"]);
    assert.deepEqual(filterIndexes(["a", "b", "c"], [1]), ["b"]);
  });
  it("excludes the given indexes when exclude is true", () => {
    assert.deepEqual(filterIndexes(["a", "b", "c"], [0, 2], true), ["b"]);
  });
  it("explicit exclude=false matches the default", () => {
    assert.deepEqual(filterIndexes(["a", "b", "c"], [0, 2], false), ["a", "c"]);
  });
  // the impl always accepted a bare index, but the signature used to demand an array
  it("accepts a bare index, not just an array", () => {
    assert.deepEqual(filterIndexes(["a", "b", "c"], 1), ["b"]);
    assert.deepEqual(filterIndexes(["a", "b", "c"], 1, true), ["a", "c"]);
  });
  it("narrows the bare-index form at the type level", () => {
    const kept: readonly ["b"] = filterIndexes(["a", "b", "c"], 1);
    const dropped: readonly ["a", "c"] = filterIndexes(["a", "b", "c"], 1, true);
    assert.deepEqual([kept, dropped], [["b"], ["a", "c"]]);
  });
  // Regression: a runtime index set used to claim the full tuple (keep) resp. the empty
  // tuple (remove) at the type level; both now degrade to a plain array.
  it("degrades to a plain array for runtime index sets", () => {
    const indexes: number[] = [0];
    const removed: (1 | 2 | 3)[] = filterIndexes([1, 2, 3], indexes, true);
    assert.deepEqual(removed, [2, 3]);
  });
  it("degrades to a plain array for possible rather than supplied indexes", () => {
    const some = (indexes: (0 | 1)[]) => filterIndexes([10, 20] as const, indexes);
    const one = (index: 0 | 1) => filterIndexes([10, 20] as const, index);
    pinEq<ReturnType<typeof some>, (10 | 20)[]>(true);
    pinEq<ReturnType<typeof one>, (10 | 20)[]>(true);
    assert.deepEqual([some([]), one(0)], [[], [10]]);
  });
});

describe("guards", () => {
  it("isArray", () => {
    assert(isArray([1, 2]));
    assert(!isArray("nope"));
  });
  it("isUint8Array accepts Uint8Arrays and subclasses, across realms", () => {
    assert(isUint8Array(new Uint8Array([1])));
    assert(isUint8Array(Buffer.from([])));
    assert(isUint8Array(runInNewContext("new Uint8Array([1])")));
  });
  it("isUint8Array rejects everything else", () => {
    assert(!isUint8Array([1]));
    assert(!isUint8Array({}));
    assert(!isUint8Array("string"));
    assert(!isUint8Array(123));
    assert(!isUint8Array(null));
    assert(!isUint8Array(undefined));
    assert(!isUint8Array(new Uint16Array(1)));
    assert(!isUint8Array(new DataView(new ArrayBuffer(1))));
    assert(!isUint8Array(runInNewContext("new Int8Array(1)")));
  });
});

// ---- type pins ----

import type { Cartesian, Flatten,
              InnerFlatten, Unflatten, FilterIndexes, Range,
              TupleRange, OfLength, TupleOfLength, Chunk, TupleChunk } from "../src/array.js";

//regression: the L-tuple branch's Flatten used to splice open the bare scalar-scalar pairs,
//  collapsing Cartesian<[1, 2], "x"> to [1, "x", 2, "x"]
pinEq<Cartesian<[1, 2], "x">, [[1, "x"], [2, "x"]]>(true);
pinEq<Cartesian<[1, 2], ["a", "b"]>,
  [[1, "a"], [1, "b"], [2, "a"], [2, "b"]]>(true);
pinEq<Cartesian<1, ["a", "b"]>, [[1, "a"], [1, "b"]]>(true);
//scalar-scalar stays the bare pair (constMap's row building relies on it)
pinEq<Cartesian<1, 2>, [1, 2]>(true);
//nested lhs tuples distribute
pinEq<Cartesian<[[1], [2]], "x">, [[1, "x"], [2, "x"]]>(true);

//a runtime array element degrades the whole flatten to a plain array
pinEq<Flatten<[1, string[]]>, (1 | string)[]>(true);
pinEq<Flatten<[[1, 2], [3]]>, [1, 2, 3]>(true);

//runtime index sets / indeterminate direction degrade to a plain array
pinEq<FilterIndexes<[1, 2, 3], number, true>, (1 | 2 | 3)[]>(true);
pinEq<FilterIndexes<[1, 2, 3], 0, boolean>, (1 | 2 | 3)[]>(true);
pinEq<FilterIndexes<[1, 2, 3], 0 | 2>, [1, 3]>(true);
pinEq<FilterIndexes<[1, 2, 3], 0 | 2, true>, [2]>(true);
pinEq<InnerFlatten<string[][]>, string[][]>(true);
pinEq<Unflatten<string[]>, [string][]>(true);
pinEq<Cartesian<string[], number>, [string, number][]>(true);

//the Tuple-prefixed shapes promise a tuple and yield never for a non-literal input - TupleOfLength
//  used to let TupleRange's never through the infer clause and come out as [], TupleChunk used to
//  recurse without bound
pinEq<TupleRange<number>, never>(true);
pinEq<TupleOfLength<string, number>, never>(true);
pinEq<TupleChunk<[1, 2, 3], number>, never>(true);
pinEq<TupleOfLength<string, 2>, [string, string]>(true);
//a negative or fractional length is no length at all, so both shapes yield never rather than
//  recursing without bound
pinEq<TupleRange<-1>, never>(true);
pinEq<TupleRange<1.5>, never>(true);
pinEq<OfLength<string, -1>, never>(true);
//the unprefixed shapes degrade to plain arrays instead
pinEq<Range<number>, number[]>(true);
pinEq<OfLength<string, number>, string[]>(true);
pinEq<Chunk<[1, 2, 3], number>, (1 | 2 | 3)[][]>(true);

//canaries for the recursion ceilings the README's Limits section quotes (TS 7.0). The exact
//  ceilings depend on the surrounding compilation - Range<996> and a 60-pair Flatten compile in
//  an otherwise empty program but not in this one - so these sit inside the quoted safe zone
pinEq<Range<500>["length"], 500>(true);
pinEq<Flatten<TupleOfLength<[1, 2], 30>>["length"], 60>(true);
