import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { constMap } from "../src/constMap.js";
import { pinEq } from "./typeAssert.js";

const sample = [[
  "Mainnet", [
    ["Ethereum",       1n],
    ["Bsc",           56n],
    ["Polygon",      137n],
  ]], [
  "Testnet", [
    ["Ethereum",       5n],
    ["Sepolia", 11155111n],
  ]],
] as const;

describe("constMap default shape", () => {
  const chainId = constMap(sample);

  it("looks up by (network, chain) with literal value types", () => {
    const mainnetEth = chainId("Mainnet", "Ethereum");
    const testnetSepolia = chainId("Testnet", "Sepolia");
    assert.equal(mainnetEth, 1n);
    assert.equal(testnetSepolia, 11155111n);
    //per-lookup narrowing is the point; ReturnType<typeof chainId> instantiates the key
    //  params instead and only ever yields the values reachable from that instantiation
    pinEq<typeof mainnetEth, 1n>(true);
    pinEq<typeof testnetSepolia, 11155111n>(true);
  });

  it("has / get for present and absent keys", () => {
    assert.equal(chainId.has("Mainnet", "Ethereum"), true);
    assert.equal(chainId.has("Mainnet", "Solana" as any), false);
    assert.equal(chainId.get("Mainnet", "Ethereum"), 1n);
    assert.equal(chainId.get("Mainnet", "Solana" as any), undefined);
  });

  it("subMap fixes the first key", () => {
    const testnet = chainId.subMap("Testnet");
    assert.equal(testnet("Sepolia"), 11155111n);
    assert.equal(testnet("Ethereum"), 5n);
  });

  it("explicit default shapes match the implicit one", () => {
    for (const shape of [[[0, 1], 2], [[0, 1], [2]]] as const)
      assert.equal(constMap(sample, shape)("Testnet", "Sepolia"), 11155111n);
  });
});

describe("constMap default shape is one-to-one", () => {
  //regression: the type read the flat spec as it is (a leaf of `1 | 2`) while the runtime grouped
  //  the repeated key into [1, 2]; the spec is now rejected under the default shape
  it("rejects a repeated key path", () => {
    assert.throws(() => constMap([["a", 1], ["a", 2]] as const), /key path repeats at a/);
    assert.deepEqual(constMap([["a", 1], ["a", 2]] as const, [0, 1])("a"), [1, 2]);
  });
});

describe("constMap custom shapes", () => {
  it("value-expanding shape [[0,1],[0,1,2]] returns the full row", () => {
    const full = constMap(sample, [[0, 1], [0, 1, 2]]);
    assert.deepEqual(full("Testnet", "Sepolia"), ["Testnet", "Sepolia", 11155111n]);
  });

  it("one-to-many shape [0,1] maps network -> chains", () => {
    assert.deepEqual(constMap(sample, [0, 1])("Testnet"), ["Ethereum", "Sepolia"]);
  });

  it("reverse shape [2,0] maps chainId -> network (bigint key)", () => {
    assert.equal(constMap(sample, [2, 0])(1n), "Mainnet");
  });

  it("reverse shape [2,[0,1]] maps chainId -> [network, chain]", () => {
    const networkAndChain = constMap(sample, [2, [0, 1]]);
    assert.deepEqual(networkAndChain(1n), ["Mainnet", "Ethereum"]);
    assert.deepEqual(networkAndChain(11155111n), ["Testnet", "Sepolia"]);
  });

  it("shape [1,0] maps chain -> networks (one-to-many, deduped)", () => {
    const networksForChain = constMap(sample, [1, 0]);
    assert.deepEqual(networksForChain("Ethereum"), ["Mainnet", "Testnet"]);
    assert.deepEqual(networksForChain("Sepolia"), ["Testnet"]);
    assert.deepEqual(networksForChain("Bsc"), ["Mainnet"]);
  });
});

describe("constMap duplicate leaf values", () => {
  // Regression: the type level deduplicates leaf value rows while the runtime used to keep
  // every row, so a key whose rows all carry the same value was typed as a singleton (and even
  // unwrapped to a scalar) while actually yielding an array of repeats.
  const repeated = [[
    "a", [
      ["x", 1],
      ["y", 1],
    ]], [
    "b", [
      ["x", 2],
      ["y", 3],
    ]],
  ] as const;

  it("collapses repeats within a key group", () => {
    const m = constMap(repeated, [0, 2]);
    assert.deepEqual(m("a"), [1]);
    assert.deepEqual(m("b"), [2, 3]);
  });

  it("unwraps to a scalar when dedup makes all leaves singletons", () => {
    const m = constMap(repeated, [0, 0]);
    const a: "a" = m("a");
    assert.equal(a, "a");
    assert.equal(m("b"), "b");
  });

  it("compares multi-column leaf rows structurally", () => {
    const m = constMap(repeated, [0, [2, 2]]);
    const a: readonly [readonly [1, 1]] = m("a");
    assert.deepEqual(a, [[1, 1]]);
    assert.deepEqual(m("b"), [[2, 2], [3, 3]]);
  });

  // Regression: dedup used to keep the *last* occurrence at the type level and the *first* at
  // runtime. Repeats within a key group are contiguous - and the two agree - whenever the value
  // column encloses the key column; a value column *inside* the key column interleaves them, and
  // the group then came out in opposite orders at the two levels.
  const deployments = [[
    "Mainnet", [
      ["Ethereum", ["Usdc", "Usdt"]],
      ["Polygon",  ["Usdc"]],
    ]], [
    "Testnet", [
      ["Ethereum", ["Usdc"]],
    ]],
  ] as const;

  it("keeps the first occurrence when repeats are non-contiguous", () => {
    const chains = constMap(deployments, [2, 1])("Usdc");
    pinEq<typeof chains, ["Ethereum", "Polygon"]>(true);
    assert.deepEqual(chains, ["Ethereum", "Polygon"]);
  });
});

describe("constMap get / has over asymmetric sub-maps", () => {
  // Regression: the loose-input signatures went through `keyof` on the union of sub-maps, which
  // yields only their *common* keys - so a value reachable only via a branch-specific key was
  // missing from get's return type (get("Mainnet", "Bsc") was typed 1n | 5n | undefined while
  // actually returning 56n), and level keys of differing types collapsed to never.
  it("get's return covers values behind branch-specific keys", () => {
    const bsc = constMap(sample).get("Mainnet", "Bsc");
    pinEq<typeof bsc, 1n | 56n | 137n | 5n | 11155111n | undefined>(true);
    assert.equal(bsc, 56n);
  });

  it("keeps loose keys callable when sub-maps key on different types", () => {
    const hetero = constMap([["a", [[1, "one"]]], ["b", [["k", "kay"]]]]);
    const val = hetero.get("b", "k");
    pinEq<typeof val, "one" | "kay" | undefined>(true);
    assert.equal(val, "kay");
    assert.equal(hetero.get("a", 1), "one");
    assert.equal(hetero.has("b", 1), false);
  });

  it("reaches through three levels", () => {
    const deep = constMap(
      [["x", [["p", [["u", 1]]]]], ["y", [["q", [["v", 2]]], ["r", [["w", 3]]]]]],
    );
    const w = deep.get("y", "r", "w");
    pinEq<typeof w, 1 | 2 | 3 | undefined>(true);
    assert.equal(w, 3);
  });
});

describe("constMap membership", () => {
  //regression: lookups indexed a plain object and took `!== undefined` as presence, so an
  //  inherited name counted as a key and a nullish leaf as a missing one
  it("does not answer to inherited property names", () => {
    const m = constMap([["a", 1]]);
    assert.equal(m.has("toString"), false);
    assert.equal(m.get("toString"), undefined);
    assert.equal(m.has("a"), true);
  });

  it("keeps nullish leaves and reports their keys present", () => {
    const m = constMap([["n", null], ["u", undefined]]);
    assert.equal(m("n"), null);
    assert.equal(m.has("n"), true);
    assert.equal(m.has("u"), true);
    assert.equal(m.has("x" as any), false);
  });

  it("reports nullish leaves present below the first level", () => {
    const m = constMap([["a", [["u", undefined], ["n", null]]]]);
    assert.equal(m("a", "u"), undefined);
    assert.equal(m("a", "n"), null);
    assert.equal(m.has("a", "u"), true);
    assert.equal(m.has("a", "x" as any), false);
    assert.equal(m.has("x" as any, "u"), false);
  });
});

describe("constMap key column limit", () => {
  it("supports four key columns and rejects a fifth", () => {
    const four = constMap([["a", [["b", [["c", [["d", 1]]]]]]]]);
    assert.equal(four("a", "b", "c", "d"), 1);
    assert.equal(four.has("a", "b", "c", "d"), true);
    assert.equal(four.has("a", "b", "c", "x" as any), false);
    assert.throws(
      () => constMap([["a", [["b", [["c", [["d", [["e", 1]]]]]]]]]]),
      /more than 4 key columns/,
    );
  });
});

describe("constMap key-type disambiguation", () => {
  // Regression: keys used to be stored/looked up via key.toString(), so bigint/boolean keys
  // collapsed onto their string/number twins at runtime (1n vs 1, true vs "true") while the type
  // kept them distinct — a soundness hole. They must stay distinct at runtime too.
  it("distinguishes bigint from same-magnitude number keys", () => {
    const m = constMap([[1n, "from-bigint"], [1, "from-number"]]);
    assert.equal(m(1n), "from-bigint");
    assert.equal(m(1), "from-number");
  });

  it("distinguishes number from same-text string keys", () => {
    const m = constMap([[1, "from-number"], ["1", "from-string"]]);
    const fromNumber = m(1);
    const fromString = m("1");
    pinEq<typeof fromNumber, "from-number">(true);
    pinEq<typeof fromString, "from-string">(true);
    assert.equal(fromNumber, "from-number");
    assert.equal(fromString, "from-string");
  });

  it("distinguishes boolean from same-text string keys", () => {
    const m = constMap([[true, "from-boolean"], ["true", "from-string"]]);
    assert.equal(m(true), "from-boolean");
    assert.equal(m("true"), "from-string");
  });

  it("keeps every key kind of the same spelling apart", () => {
    const m = constMap([[1, "number"], [1n, "bigint"], ["1", "string"], [true, "boolean"],
                        ["true", "true-string"], [1.5, "fraction"]]);
    assert.equal(m(1), "number");
    assert.equal(m(1n), "bigint");
    assert.equal(m("1"), "string");
    assert.equal(m(true), "boolean");
    assert.equal(m("true"), "true-string");
    assert.equal(m(1.5), "fraction");
    assert.equal(m.has(false), false);
    assert.equal(m.has(2n), false);
  });

  //regression: non-string keys were stored under string surrogates (`number(1)`), which a string
  //  key of that spelling overwrote at runtime
  it("does not collide a string key with a surrogate spelling", () => {
    const m = constMap([[1, "num"], ["number(1)", "str"]]);
    assert.equal(m(1), "num");
    assert.equal(m.get(1), "num");
    //the type level still encodes keys as surrogates, where the two rows share one key
    assert.equal(m("number(1)" as any), "str");
    assert.equal(m.has("number(1)" as any), true);
  });

  it("distinguishes key kinds below the first level", () => {
    const m = constMap([["a", [[1, "number"], [1n, "bigint"], ["1", "string"]]]]);
    assert.equal(m("a", 1), "number");
    assert.equal(m("a", 1n), "bigint");
    assert.equal(m("a", "1"), "string");
    assert.equal(m.subMap("a")(1n), "bigint");
    assert.equal(m.has("a", 2), false);
    assert.equal(m.has("b" as any, 1), false);
  });

  it("supports symbol keys", () => {
    const s1 = Symbol("s1"), s2 = Symbol("s2");
    const m = constMap([[s1, "one"], [s2, "two"]]);
    assert.equal(m(s1), "one");
    assert.equal(m(s2), "two");
    assert.equal(m.has(s1), true);
    //the loose lookups take the widened key type, which for a unique symbol is any symbol
    assert.equal(m.has(Symbol("s1")), false);
    assert.equal(m.get(Symbol("s1")), undefined);
  });
});
