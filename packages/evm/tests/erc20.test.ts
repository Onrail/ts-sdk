import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { hex, bignum } from "@onrail-xyz/utils";
import { serialize } from "@onrail-xyz/binary-layout";
import { selectorOf, wordSize } from "../src/layouting.js";
import { erc20, allowanceAdjusters, erc20Events } from "../src/erc20.js";
import { buildParseEvent } from "../src/parsing.js";
import { probeNetwork, query, liveTimeout, token, usdcTreasury } from "./live.js";

const alice = "0x1111111111111111111111111111111111111111" as Address;
const bob   = "0x2222222222222222222222222222222222222222" as Address;

const contract = erc20(token);

describe("erc20 spec", () => {
  describe("read calls", () => {
    it("name() returns a layout triple with the correct selector", () => {
      const call = contract.name();
      assert.strictEqual(call.to, token);
      const [layout, params, _outputLayout] = call.data;
      const encoded = serialize(layout, params);
      // name() selector = keccak256("name()")[0:4]
      assert.deepStrictEqual(encoded, selectorOf("name()"));
    });

    it("symbol() returns a layout triple with the correct selector", () => {
      const call = contract.symbol();
      const encoded = serialize(call.data[0], call.data[1]);
      assert.deepStrictEqual(encoded, selectorOf("symbol()"));
    });

    it("decimals() returns a layout triple with the correct selector", () => {
      const call = contract.decimals();
      const encoded = serialize(call.data[0], call.data[1]);
      assert.deepStrictEqual(encoded, selectorOf("decimals()"));
    });

    it("totalSupply() returns a layout triple with the correct selector", () => {
      const call = contract.totalSupply();
      const encoded = serialize(call.data[0], call.data[1]);
      assert.deepStrictEqual(encoded, selectorOf("totalSupply()"));
    });

    it("balanceOf encodes owner address after selector", () => {
      const call = contract.balanceOf(alice);
      const [layout, params] = call.data;
      const encoded = serialize(layout, params);
      const expected = new Uint8Array(4 + wordSize);
      expected.set(selectorOf("balanceOf(address)"));
      expected.set(hex.decode(alice), 4 + wordSize - 20);
      assert.deepStrictEqual(encoded, expected);
    });

    it("allowance encodes owner and spender", () => {
      const call = contract.allowance(alice, bob);
      const [layout, params] = call.data;
      const encoded = serialize(layout, params);
      assert.strictEqual(encoded.length, 4 + 2 * wordSize);
      assert.deepStrictEqual(encoded.subarray(0, 4), selectorOf("allowance(address,address)"));
    });
  });

  describe("argument forms", () => {
    //a lone object argument is the ambiguous case: it could be the parameter object or a struct
    //  passed positionally
    it("encodes the object form identically to the positional form", () => {
      const [object, positional] =
        [contract.balanceOf({ owner: alice }), contract.balanceOf(alice)];
      assert.deepStrictEqual(
        serialize(object.data[0], object.data[1]),
        serialize(positional.data[0], positional.data[1]),
      );
      assert.deepStrictEqual(
        contract.transfer({ to: bob, value: 500n }).data,
        contract.transfer(bob, 500n).data,
      );
    });
  });

  describe("method reflection", () => {
    //`infer`/`Parameters` bind to an overloaded function's last signature, which
    //  ContractMethodOf deliberately makes the positional one
    it("Parameters yields the positional signature", () => {
      type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
      const balanceOf: Mutual<Parameters<typeof contract.balanceOf>, [Address]> = true;
      const allowance: Mutual<Parameters<typeof contract.allowance>, [Address, Address]> = true;
      assert.ok(balanceOf && allowance);
    });

    it("length reports the positional arity", () => {
      assert.strictEqual(contract.name.length,      0);
      assert.strictEqual(contract.balanceOf.length, 1);
      assert.strictEqual(contract.allowance.length, 2);
      assert.strictEqual(contract.transfer.length,  2);
    });
  });

  describe("write calls", () => {
    it("approve serializes selector, spender, and value", () => {
      const result = contract.approve(bob, 1000n);
      assert.strictEqual(result.to, token);
      assert.ok(result.data instanceof Uint8Array);
      assert.deepStrictEqual(
        result.data.subarray(0, 4),
        selectorOf("approve(address,uint256)"),
      );
    });

    it("transfer serializes selector, to, and value", () => {
      const result = contract.transfer(bob, 500n);
      assert.strictEqual(result.to, token);
      assert.deepStrictEqual(
        result.data.subarray(0, 4),
        selectorOf("transfer(address,uint256)"),
      );
    });

    it("transferFrom serializes from, to, and value in that order", () => {
      //pulls bob's tokens to alice
      const result = contract.transferFrom(bob, alice, 500n);
      assert.deepStrictEqual(
        result.data.subarray(0, 4),
        selectorOf("transferFrom(address,address,uint256)"),
      );
      assert.strictEqual(result.data.length, 4 + 3 * wordSize);
      const word = (i: number) => result.data.subarray(4 + i * wordSize, 4 + (i + 1) * wordSize);
      assert.deepStrictEqual(word(0).subarray(wordSize - 20), hex.decode(bob));
      assert.deepStrictEqual(word(1).subarray(wordSize - 20), hex.decode(alice));
      assert.strictEqual(bignum.fromBytes(word(2)), 500n);
    });

    it("approve round-trips value through the layout", () => {
      const value = 10n ** 18n;
      const result = contract.approve(bob, value);
      // value is in the last 32 bytes
      const encodedValue = bignum.fromBytes(result.data.subarray(result.data.length - wordSize));
      assert.strictEqual(encodedValue, value);
    });
  });
});

describe("allowanceAdjusters spec", () => {
  const adjusters = allowanceAdjusters(token);

  //the selectors USDC dispatches on
  it("increaseAllowance serializes spender and added value, canonical selector", () => {
    const result = adjusters.increaseAllowance(bob, 500n);
    assert.strictEqual(result.to, token);
    assert.deepStrictEqual(result.data.subarray(0, 4), hex.decode("0x39509351"));
    assert.deepStrictEqual(
      result.data.subarray(0, 4), selectorOf("increaseAllowance(address,uint256)"),
    );
    assert.strictEqual(result.data.length, 4 + 2 * wordSize);
    assert.strictEqual(bignum.fromBytes(result.data.subarray(4 + wordSize)), 500n);
  });

  it("decreaseAllowance serializes spender and subtracted value, canonical selector", () => {
    const result = adjusters.decreaseAllowance({ spender: bob, subtractedValue: 500n });
    assert.deepStrictEqual(result.data.subarray(0, 4), hex.decode("0xa457c2d7"));
    assert.deepStrictEqual(
      result.data.subarray(0, 4), selectorOf("decreaseAllowance(address,uint256)"),
    );
    assert.strictEqual(result.data.length, 4 + 2 * wordSize);
  });
});

describe("erc20Events", () => {
  const parse = buildParseEvent(erc20Events());

  //`sigVariant` rebuilds the signature at the type level too - pinned, as a parse against a
  //  widened string would still pass at runtime
  it("reconstructs the canonical signatures as literals", () => {
    type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
    const [transfer, approval] = erc20Events();
    const pin: Mutual<
      [typeof transfer[0], typeof approval[0]],
      ["Transfer(address,address,uint256)", "Approval(address,address,uint256)"]
    > = true;
    assert.ok(pin);
    assert.strictEqual(transfer[0], "Transfer(address,address,uint256)");
    assert.deepStrictEqual(Object.keys(approval[1]), ["owner", "spender", "value"]);
  });
  const abi = [
    { type: "event", name: "Transfer", inputs: [
      { name: "from",  type: "address", indexed: true  },
      { name: "to",    type: "address", indexed: true  },
      { name: "value", type: "uint256", indexed: false },
    ] },
    { type: "event", name: "Approval", inputs: [
      { name: "owner",   type: "address", indexed: true  },
      { name: "spender", type: "address", indexed: true  },
      { name: "value",   type: "uint256", indexed: false },
    ] },
  ] as const;

  //indexed params ride in the topics, the rest in the data - viem's encoding is the oracle
  it("parses a Transfer log", () => {
    const topics = encodeEventTopics(
      { abi, eventName: "Transfer", args: { from: alice, to: bob } },
    ) as Hex[];
    const data   = encodeAbiParameters([{ type: "uint256" }], [500n]);
    assert.deepStrictEqual(
      parse({ topics, data }), { event: "Transfer", from: alice, to: bob, value: 500n },
    );
  });

  it("carries an infinite allowance, max uint256, through Approval", () => {
    const maxUint256 = 2n ** 256n - 1n;
    const topics = encodeEventTopics(
      { abi, eventName: "Approval", args: { owner: alice, spender: bob } },
    ) as Hex[];
    const data   = encodeAbiParameters([{ type: "uint256" }], [maxUint256]);
    assert.strictEqual(parse({ topics, data }).value, maxUint256);
  });
});

// ---- Live query tests (require network) ----

let hasNetwork = false;
before(async () => { hasNetwork = await probeNetwork(); });

describe("erc20 live query", () => {
  it("reads name, symbol, and decimals", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const usdc = erc20(token);
    const [[name, symbol, decimals]] = await query([
      usdc.name(),
      usdc.symbol(),
      usdc.decimals(),
    ]);
    assert.strictEqual(name, "USD Coin");
    assert.strictEqual(symbol, "USDC");
    assert.strictEqual(decimals, 6);
  });

  it("reads a non-zero balance below total supply", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const usdc = erc20(token);
    const [[balance, totalSupply]] = await query([
      usdc.balanceOf(usdcTreasury),
      usdc.totalSupply(),
    ]);
    assert.strictEqual(typeof balance, "bigint");
    assert.ok(balance > 0n, `Expected positive balance, got ${balance}`);
    assert.ok(balance < totalSupply);
  });
});
