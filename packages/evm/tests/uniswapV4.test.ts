import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Abi, Address } from "viem";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { hex } from "@onrail-xyz/utils";
import { abiParam, uint256Item, selectorOf,
         paddedSlotLayout, trailingBytesParam } from "../src/layouting.js";
import { abiFunction, contractFromSpec } from "../src/client.js";

const int24Item  = { binary: "int",  size: 3  } as const;
const int256Item = { binary: "int",  size: 32 } as const;
const uint24Item = { binary: "uint", size: 3  } as const;
const uint160Item= { binary: "uint", size: 20 } as const;
const addrItem   = { binary: "bytes", size: 20 } as const;
const b32Item    = { binary: "bytes", size: 32 } as const;
const boolItm    = { binary: "uint", size: 1 } as const;

const POOL_KEY = "(address,address,uint24,int24,address)";
const MODLIQ   = "(int24,int24,int256,bytes32)";
const SWAPP    = "(bool,int256,uint160)";

//a static tuple's members each occupy a whole slot, so each is padded onto one
const slot = paddedSlotLayout;

const key = abiParam("key", POOL_KEY, { binary: "bytes", layout: {
  currency0: slot(addrItem), currency1: slot(addrItem), fee: slot(uint24Item),
  tickSpacing: slot(int24Item), hooks: slot(addrItem),
} } as const);

const modParams = abiParam("params", MODLIQ, { binary: "bytes", layout: {
  tickLower: slot(int24Item), tickUpper: slot(int24Item),
  liquidityDelta: slot(int256Item), salt: slot(b32Item),
} } as const);

const swapParams = abiParam("params", SWAPP, { binary: "bytes", layout: {
  zeroForOne: slot(boolItm), amountSpecified: slot(int256Item),
  sqrtPriceLimitX96: slot(uint160Item),
} } as const);

const spec = [
  abiFunction("initialize", [key, abiParam("sqrtPriceX96", "uint160", uint160Item)],
    (key, sqrtPriceX96) => ({ key, sqrtPriceX96 })),
  abiFunction("modifyLiquidity", [key, modParams, trailingBytesParam("hookData")],
    (key, params, hookData) => ({ key, params, hookData })),
  abiFunction("swap", [key, swapParams, trailingBytesParam("hookData")],
    (key, params, hookData) => ({ key, params, hookData })),
  abiFunction("donate",
    [key, abiParam("amount0", "uint256", uint256Item), abiParam("amount1", "uint256", uint256Item),
     trailingBytesParam("hookData")],
    (key, amount0, amount1, hookData) => ({ key, amount0, amount1, hookData })),
] as const;

const pm = "0x000000000004444c5dc75cB358380D2e3dE08A90" as Address;
const c = contractFromSpec(pm, spec);

const v4Abi: Abi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "function initialize(PoolKey key, uint160 sqrtPriceX96)",
  "function modifyLiquidity(PoolKey key, ModifyLiquidityParams params, bytes hookData)",
  "function swap(PoolKey key, SwapParams params, bytes hookData)",
  "function donate(PoolKey key, uint256 amount0, uint256 amount1, bytes hookData)",
]);

const A0 = "0x0000000000000000000000000000000000000000" as Address;
const A1 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const HK = "0x0000000000000000000000000000000000002080" as Address;
const bytesOf = (a: Address) => hex.decode(a);

const poolKey = { currency0: A0, currency1: A1, fee: 3000, tickSpacing: 60, hooks: HK };
const ourKey  = { currency0: bytesOf(A0), currency1: bytesOf(A1), fee: 3000,
                  tickSpacing: 60, hooks: bytesOf(HK) };

describe("Uniswap v4: static structs and the selector", () => {
  for (const [name, sig] of [
    ["initialize",      `initialize(${POOL_KEY},uint160)`],
    ["modifyLiquidity", `modifyLiquidity(${POOL_KEY},${MODLIQ},bytes)`],
    ["swap",            `swap(${POOL_KEY},${SWAPP},bytes)`],
    ["donate",          `donate(${POOL_KEY},uint256,uint256,bytes)`],
  ] as const)
    it(`recovers the canonical selector for ${name}`, () => {
      assert.strictEqual(
        hex.encode(selectorOf(sig), true),
        toFunctionSelector(sig as `${string}(${string})`),
      );
    });

  it("initialize: full calldata matches viem (all values positive)", () => {
    assert.strictEqual(
      hex.encode(c.initialize(ourKey, 79228162514264337593543950336n).data, true),
      encodeFunctionData({ abi: v4Abi, functionName: "initialize",
        args: [poolKey, 79228162514264337593543950336n] }),
    );
  });

  it("swap: full calldata matches viem, positive amountSpecified", () => {
    assert.strictEqual(
      hex.encode(c.swap(ourKey,
        { zeroForOne: 1, amountSpecified: 1000n, sqrtPriceLimitX96: 4295128740n },
        new Uint8Array(0)).data, true),
      encodeFunctionData({ abi: v4Abi, functionName: "swap",
        args: [poolKey, { zeroForOne: true, amountSpecified: 1000n,
                          sqrtPriceLimitX96: 4295128740n }, "0x"] }),
    );
  });

  it("modifyLiquidity: negative ticks sign-extend, matching viem", () => {
    assert.strictEqual(
      hex.encode(c.modifyLiquidity(ourKey,
        { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 18n,
          salt: new Uint8Array(32) }, new Uint8Array(0)).data, true),
      encodeFunctionData({ abi: v4Abi, functionName: "modifyLiquidity",
        args: [poolKey, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 18n,
                          salt: `0x${"00".repeat(32)}` }, "0x"] }),
    );
  });

  it("donate: a static tuple ahead of the trailing bytes places the offset correctly", () => {
    assert.strictEqual(
      hex.encode(c.donate(ourKey, 1n, 2n, new Uint8Array([9])).data, true),
      encodeFunctionData({ abi: v4Abi, functionName: "donate",
        args: [poolKey, 1n, 2n, "0x09"] }),
    );
  });

  it("a signed item's own conversion survives the widening", () => {
    //a tick spelled as a domain type: the conversion speaks the declared int24 width, and the
    //  slot's widening has to wrap it rather than replace it
    const tickItem = { binary: "int", size: 3, custom: {
      to:   (n: number) => ({ tick: n }),
      from: (t: { tick: number }) => t.tick,
    } } as const;
    //the param is named apart from the domain object's key: a single-key object whose key
    //  matches the sole param is the object form, which `resolveArgs` cannot tell from a value
    const tickSpec = [
      abiFunction("poke", [abiParam("lower", "int24", tickItem)], lower => ({ lower })),
    ] as const;
    const poked = contractFromSpec(pm, tickSpec);

    assert.strictEqual(
      hex.encode(poked.poke({ tick: -887220 }).data, true),
      encodeFunctionData({
        abi: parseAbi(["function poke(int24 tick)"]),
        functionName: "poke", args: [-887220],
      }),
    );
    assert.throws(() => poked.poke({ tick: 1 << 23 }), /does not fit a signed 24-bit slot/);
  });

  it("an int24 keeps its `number` surface and rejects an out-of-range value", () => {
    const tick: number = c.modifyLiquidity.length === 3 ? -887220 : 0;
    assert.strictEqual(typeof tick, "number");
    assert.throws(
      () => c.modifyLiquidity(ourKey,
        { tickLower: 1 << 23, tickUpper: 0, liquidityDelta: 0n, salt: new Uint8Array(32) },
        new Uint8Array(0)),
      /does not fit a signed 24-bit slot/,
    );
  });
});
