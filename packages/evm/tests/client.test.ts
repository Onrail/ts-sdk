import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { encodeFunctionData, parseAbi } from "viem";
import { hex } from "@onrail-xyz/utils";
import { Amount, kind } from "@onrail-xyz/amount";
import { selectorOf, wordSize, abiParam, amountParam,
         addressItem, uint256Item, paramOf, addressParam, bytesParam } from "../src/layouting.js";
import { abiFunction, contractFromSpec, toViemTx } from "../src/client.js";

const to    = abiParam("to", "address", addressItem);
const value = amountParam("value", "uint256");

const contract = "0x3333333333333333333333333333333333333333" as Address;
const alice    = "0x1111111111111111111111111111111111111111" as Address;

//an overloaded pair: the second row keeps the ABI name and names its method key separately
const spec = [
  abiFunction("mint",                 [to],        to => ({ to })),
  abiFunction(["mintValue", "mint"], [to, value], (to, value) => ({ to, value })),
] as const;

const methods = contractFromSpec(contract, spec);

type Keys = keyof typeof methods;
type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const keysPin: Mutual<Keys, "mint" | "mintValue"> = true;

describe("contractFromSpec generated fields", () => {
  //the generated selector field led as `selector`, so a param of that name displaced it
  it("keeps the selector prefix under a param named selector", () => {
    const selectorParam = abiParam("selector", "uint256", uint256Item);
    const spec = [abiFunction("pick", [selectorParam], selector => ({ selector }))] as const;
    const { data } = contractFromSpec(contract, spec).pick(7n);
    assert.deepStrictEqual(data.subarray(0, 4), selectorOf("pick(uint256)"));
    assert.strictEqual(data.length, 4 + wordSize);
  });

  //a param of the generated selector's own name displaced it
  it("rejects a param named like the generated selector", () => {
    const selectorParam = abiParam("_selector", "uint256", uint256Item);
    const spec = [abiFunction("pick", [selectorParam], _selector => ({ _selector }))] as const;
    assert.throws(() => contractFromSpec(contract, spec), /not distinct: _selector, _selector/);
  });

  it("rejects a repeated method key", () => {
    const spec = [
      abiFunction("mint", [to], to => ({ to })),
      abiFunction(["mint", "burn"], [to], to => ({ to })),
    ] as const;
    assert.throws(() => contractFromSpec(contract, spec), /duplicate method key: mint/);
  });
});

describe("contractFromSpec overloads", () => {
  it("keys the overload by its own name, the plain row by the ABI name", () => {
    assert.ok(keysPin);
    assert.deepStrictEqual(Object.keys(methods).sort(), ["mint", "mintValue"]);
  });

  it("selects each overload's own selector from the ABI name and its params", () => {
    const plain = methods.mint(alice);
    const withValue = methods.mintValue(alice, 5n);
    assert.strictEqual(plain.to, contract);
    assert.deepStrictEqual(plain.data.subarray(0, 4), selectorOf("mint(address)"));
    assert.deepStrictEqual(withValue.data.subarray(0, 4), selectorOf("mint(address,uint256)"));
    assert.strictEqual(plain.data.length, 4 + wordSize);
    assert.strictEqual(withValue.data.length, 4 + 2 * wordSize);
  });

  it("accepts the object form under the key and stamps the positional arity", () => {
    const positional = methods.mintValue(alice, 5n);
    const named      = methods.mintValue({ to: alice, value: 5n });
    assert.strictEqual(hex.encode(named.data), hex.encode(positional.data));
    assert.strictEqual(methods.mint.length, 1);
    assert.strictEqual(methods.mintValue.length, 2);
  });
});

describe("contractFromSpec dynamic params", () => {
  const bytes32Param = paramOf("bytes32", { binary: "bytes", size: 32 } as const);
  const uint256Param = paramOf("uint256", uint256Item);
  const spec = [
    //Uniswap v4 PositionManager's entry point: the bytes leads
    abiFunction("modifyLiquidities", [bytesParam("unlockData"), uint256Param("deadline")],
      (unlockData, deadline) => ({ unlockData, deadline })),
    //TimelockController's: the bytes amid the list
    abiFunction("schedule",
      [addressParam("target"), uint256Param("value"), bytesParam("data"),
       bytes32Param("predecessor"), bytes32Param("salt"), uint256Param("delay")],
      (target, value, data, predecessor, salt, delay) =>
        ({ target, value, data, predecessor, salt, delay })),
  ] as const;
  const dynamic = contractFromSpec(contract, spec);
  const abi = parseAbi([
    "function modifyLiquidities(bytes unlockData, uint256 deadline)",
    "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  ]);
  const word = (fill: number) => new Uint8Array(wordSize).fill(fill);

  for (const size of [0, 1, 32, 33])
    it(`places the tail after the whole head wherever the param sits, ${size} bytes`, () => {
      const data = Uint8Array.from({ length: size }, (_, i) => i + 1);
      assert.strictEqual(
        hex.encode(dynamic.modifyLiquidities(data, 60n).data, true),
        encodeFunctionData({ abi, functionName: "modifyLiquidities",
          args: [hex.encode(data, true) as Hex, 60n] }),
      );
      assert.strictEqual(
        hex.encode(dynamic.schedule(alice, 5n, data, word(2), word(3), 60n).data, true),
        encodeFunctionData({ abi, functionName: "schedule",
          args: [alice, 5n, hex.encode(data, true) as Hex,
                 hex.encode(word(2), true) as Hex, hex.encode(word(3), true) as Hex, 60n] }),
      );
    });
});

const Eth = kind(
  "Eth",
  [ { symbols: [{ symbol: "wei" }]          },
    { symbols: [{ symbol: "ETH" }], oom: 18 } ],
  { human: "ETH", atomic: "wei" },
);

describe("toViemTx", () => {
  it("hex encodes the call data and leaves a bare write result otherwise untouched", () => {
    const tx = toViemTx(methods.mint(alice));
    assert.deepStrictEqual(tx, {
      to:   contract,
      data: hex.encode(methods.mint(alice).data, true),
    });
  });

  it("converts an amount value to atomic and renames the sender to viem's `account`", () => {
    const tx = toViemTx({
      ...methods.mint(alice),
      from:       alice,
      value:      Amount.from(1.5, Eth, "ETH"),
      accessList: [{ address: contract, storageKeys: [] }],
    });
    assert.strictEqual(tx.account, alice);
    assert.strictEqual(tx.value, 1_500_000_000_000_000_000n);
    assert.deepStrictEqual(tx.accessList, [{ address: contract, storageKeys: [] }]);
  });

  it("passes an atomic value through and omits the fields the transaction does not carry", () => {
    const tx = toViemTx({ ...methods.mint(alice), value: 7n });
    assert.strictEqual(tx.value, 7n);
    assert.deepStrictEqual(Object.keys(tx).sort(), ["data", "to", "value"]);
  });
});
