import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { hashTypedData, domainSeparator, encodeAbiParameters } from "viem";
import { hex, bignum, utf8 } from "@onrail-xyz/utils";
import { serialize, deserialize } from "@onrail-xyz/binary-layout";
import { keccak256 } from "../src/hashing.js";
import { selectorOf, wordSize, deadlineItem } from "../src/layouting.js";
import type { Eip712Data } from "../src/eip712.js";
import { toViemTypedData } from "../src/eip712.js";
import { permit, composePermitMsg } from "../src/permit.js";
import { probeNetwork, query, liveTimeout, token, usdcTreasury } from "./live.js";

const alice = "0x1111111111111111111111111111111111111111" as Address;
const bob   = "0x2222222222222222222222222222222222222222" as Address;

const maxUint256 = 2n ** 256n - 1n;
const hashStr = (s: string) => keccak256(utf8.encode(s));

const serializeCall = (call: { data: readonly [any, any, any] }) =>
  serialize(call.data[0], call.data[1]);

//viem derives the domain's field list from which fields are present, so a matching separator also
//  confirms that composePermitMsg's own EIP712Domain list agrees with it
const separatorOf = (data: Eip712Data) => domainSeparator(toViemTypedData(data));
const digestOf = (data: Eip712Data) => hashTypedData(toViemTypedData(data));

const deadlineWordOf = (data: Uint8Array) =>
  bignum.fromBytes(data.subarray(4 + 3 * wordSize, 4 + 4 * wordSize));

describe("permit spec", () => {
  const p = permit(token);

  describe("read calls", () => {
    it("DOMAIN_SEPARATOR() has the correct selector", () => {
      const call = p.DOMAIN_SEPARATOR();
      assert.strictEqual(call.to, token);
      const encoded = serializeCall(call);
      assert.deepStrictEqual(encoded, selectorOf("DOMAIN_SEPARATOR()"));
    });

    it("nonces(address) encodes owner after selector", () => {
      const encoded = serializeCall(p.nonces(alice));
      assert.deepStrictEqual(encoded.subarray(0, 4), selectorOf("nonces(address)"));
      assert.strictEqual(encoded.length, 4 + wordSize);
    });
  });

  describe("write calls", () => {
    const params = {
      owner:    alice,
      spender:  bob,
      value:    1000n,
      deadline: new Date("2030-01-01T00:00:00Z"),
      signature: new Uint8Array(65),
    } as const;

    it("permit serializes all 7 ABI params with correct selector", () => {
      //uses object form of arguments
      const result = p.permit(params);
      assert.strictEqual(result.to, token);
      assert.deepStrictEqual(
        result.data.subarray(0, 4),
        selectorOf("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"),
      );
      // 4 byte selector + 7 × 32 byte slots
      assert.strictEqual(result.data.length, 4 + 7 * wordSize);
    });

    it("floors a sub-second deadline instead of throwing", () => {
      const result = p.permit({
        ...params,
        deadline: new Date("2030-01-01T00:00:00.500Z"), //fractional second
      });
      assert.strictEqual(
        deadlineWordOf(result.data),
        BigInt(Math.floor(Date.parse("2030-01-01T00:00:00.500Z") / 1000)),
      );
    });

    //composePermitMsg defaults to an infinite deadline, so the on-chain call must be able to
    //  encode the very value that was signed
    it("encodes an infinite deadline as max uint256", () => {
      const result = p.permit({ ...params, deadline: "infinity" });
      assert.strictEqual(deadlineWordOf(result.data), maxUint256);
    });

    it("decodes max uint256 back into an infinite deadline", () => {
      assert.strictEqual(
        deserialize(deadlineItem, bignum.toBytes(maxUint256, wordSize)),
        "infinity",
      );
      const date = new Date("2030-01-01T00:00:00Z");
      assert.deepStrictEqual(
        deserialize(deadlineItem, bignum.toBytes(BigInt(date.getTime() / 1000), wordSize)),
        date,
      );
    });
  });
});

describe("composePermitMsg", () => {
  const domain = { name: "USD Coin", version: "2", chainId: 1n, verifyingContract: token } as const;

  it("allows a zero value (allowance reset)", () => {
    const msg = composePermitMsg(alice, bob, 0n, domain, 0);
    assert.strictEqual(msg.message.value, 0n);
  });

  it("rejects a negative value", () => {
    assert.throws(() => composePermitMsg(alice, bob, -1n, domain, 0));
  });

  it("defaults the deadline to max uint256", () => {
    const msg = composePermitMsg(alice, bob, 1n, domain, 0);
    assert.strictEqual(msg.message.deadline, maxUint256);
  });

  it("uses the canonical EIP-2612 Permit typehash", () => {
    const { types } = composePermitMsg(alice, bob, 1n, domain, 0);
    const typeString =
      `Permit(${types.Permit.map(f => `${f.type} ${f.name}`).join(",")})`;
    assert.strictEqual(
      typeString,
      "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
    );
    //the typehash every EIP-2612 token hardcodes
    assert.strictEqual(
      hex.encode(hashStr(typeString), true),
      "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9",
    );
  });

  it("hashes to the digest the token's permit() will recover against", () => {
    const [nonce, deadline] = [5n, new Date("2030-01-01T00:00:00Z")] as const;
    const msg = composePermitMsg(alice, bob, 1000n, domain, nonce, deadline);

    const structHash = keccak256(hex.decode(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [ hex.encode(hashStr(
          "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
        ), true),
        alice, bob, 1000n, nonce, BigInt(deadline.getTime() / 1000),
      ],
    )));
    const separator = hex.decode(separatorOf(msg));
    const expected = keccak256(new Uint8Array([0x19, 0x01, ...separator, ...structHash]));

    assert.strictEqual(digestOf(msg), hex.encode(expected, true));
  });

  //an explicitly undefined field must not enter the domain type, or the separator changes
  it("ignores domain fields that are undefined", () => {
    const withUndefined = { ...domain, salt: undefined } as typeof domain;
    assert.deepStrictEqual(
      composePermitMsg(alice, bob, 1n, withUndefined, 0).types.EIP712Domain,
      composePermitMsg(alice, bob, 1n, domain, 0).types.EIP712Domain,
    );
  });
});

// ---- Live query tests (require network) ----

let hasNetwork = false;
before(async () => { hasNetwork = await probeNetwork(); });

describe("permit live query", () => {
  it("reads DOMAIN_SEPARATOR and nonce", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const p = permit(token);
    const [[domainSep, nonce]] = await query([
      p.DOMAIN_SEPARATOR(),
      p.nonces(usdcTreasury),
    ]);
    assert.strictEqual(domainSep.length, 32);
    assert.strictEqual(typeof nonce, "bigint");
  });
});
