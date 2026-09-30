import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { hashTypedData, domainSeparator, encodeAbiParameters, encodeEventTopics } from "viem";
import { hex, bignum, utf8 } from "@onrail-xyz/utils";
import { serialize } from "@onrail-xyz/binary-layout";
import { keccak256 } from "../src/hashing.js";
import { selectorOf, wordSize } from "../src/layouting.js";
import { type Eip712Data, toViemTypedData } from "../src/eip712.js";
import { buildParseEvent } from "../src/parsing.js";
import { erc3009, erc3009Events,
         composeTransferWithAuthorizationMsg,
         composeReceiveWithAuthorizationMsg,
         composeCancelAuthorizationMsg, randomAuthorizationNonce } from "../src/erc3009.js";
import { probeNetwork, query, liveTimeout, token, usdcTreasury } from "./live.js";

const alice = "0x1111111111111111111111111111111111111111" as Address;
const bob   = "0x2222222222222222222222222222222222222222" as Address;

const maxUint256 = 2n ** 256n - 1n;
const hashStr = (s: string) => keccak256(utf8.encode(s));
const nonce = new Uint8Array(32).fill(0x42);
//r ‖ s ‖ v with distinguishable words
const packedSig = new Uint8Array([
  ...new Uint8Array(32).fill(0x11), ...new Uint8Array(32).fill(0x22), 28,
]);

const serializeCall = (call: { data: readonly [any, any, any] }) =>
  serialize(call.data[0], call.data[1]);

const wordOf = (data: Uint8Array, index: number) =>
  bignum.fromBytes(data.subarray(4 + index * wordSize, 4 + (index + 1) * wordSize));

const separatorOf = (data: Eip712Data) => domainSeparator(toViemTypedData(data));
const digestOf = (data: Eip712Data) => hashTypedData(toViemTypedData(data));

const authorizationSig =
  "(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";

describe("erc3009 spec", () => {
  const a = erc3009(token);

  describe("read calls", () => {
    it("authorizationState encodes authorizer and nonce after selector", () => {
      const call = a.authorizationState(alice, nonce);
      assert.strictEqual(call.to, token);
      const encoded = serializeCall(call);
      assert.deepStrictEqual(
        encoded.subarray(0, 4), selectorOf("authorizationState(address,bytes32)"),
      );
      assert.strictEqual(encoded.length, 4 + 2 * wordSize);
      assert.deepStrictEqual(encoded.subarray(4 + wordSize), nonce);
    });
  });

  describe("write calls", () => {
    const params = {
      from:        alice,
      to:          bob,
      value:       1000n,
      validAfter:  new Date(0),
      validBefore: new Date("2030-01-01T00:00:00Z"),
      nonce,
      signature:   packedSig,
    } as const;

    //the selectors every EIP-3009 token, USDC included, dispatches on
    it("transferWithAuthorization serializes all 9 params with the canonical selector", () => {
      const result = a.transferWithAuthorization(params);
      assert.strictEqual(result.to, token);
      assert.deepStrictEqual(result.data.subarray(0, 4), hex.decode("0xe3ee160e"));
      assert.deepStrictEqual(
        result.data.subarray(0, 4), selectorOf("transferWithAuthorization" + authorizationSig),
      );
      assert.strictEqual(result.data.length, 4 + 9 * wordSize);
    });

    it("receiveWithAuthorization shares the parameter list under its own selector", () => {
      const result = a.receiveWithAuthorization(params);
      assert.deepStrictEqual(result.data.subarray(0, 4), hex.decode("0xef55bec6"));
      assert.deepStrictEqual(
        result.data.subarray(4), a.transferWithAuthorization(params).data.subarray(4),
      );
    });

    it("cancelAuthorization serializes all 5 params with the canonical selector", () => {
      const result = a.cancelAuthorization({ authorizer: alice, nonce, signature: packedSig });
      assert.deepStrictEqual(result.data.subarray(0, 4), hex.decode("0x5a049a70"));
      assert.deepStrictEqual(
        result.data.subarray(0, 4),
        selectorOf("cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)"),
      );
      assert.strictEqual(result.data.length, 4 + 5 * wordSize);
    });

    it("spreads the packed signature over the v, r, s words", () => {
      const result = a.transferWithAuthorization(params);
      assert.strictEqual(wordOf(result.data, 6), 28n);
      const word = (i: number) => result.data.subarray(4 + i * wordSize, 4 + (i + 1) * wordSize);
      assert.deepStrictEqual(word(7), packedSig.subarray(0, 32));
      assert.deepStrictEqual(word(8), packedSig.subarray(32, 64));
    });

    it("encodes the window as unix seconds, an infinite validBefore as max uint256", () => {
      const result = a.transferWithAuthorization({ ...params, validBefore: "infinity" });
      assert.strictEqual(wordOf(result.data, 3), 0n);
      assert.strictEqual(wordOf(result.data, 4), maxUint256);
      const dated = a.transferWithAuthorization(params);
      assert.strictEqual(wordOf(dated.data, 4), BigInt(params.validBefore.getTime() / 1000));
    });
  });
});

describe("compose*WithAuthorizationMsg", () => {
  const domain = { name: "USD Coin", version: "2", chainId: 1n, verifyingContract: token } as const;
  const composers = {
    TransferWithAuthorization: composeTransferWithAuthorizationMsg,
    ReceiveWithAuthorization:  composeReceiveWithAuthorizationMsg,
  } as const;
  const compose = (mode: keyof typeof composers = "TransferWithAuthorization") =>
    composers[mode](alice, bob, 1000n, domain, nonce);

  it("keeps the nonce as bytes; toViemTypedData spells it as hex", () => {
    const msg = compose();
    assert.deepStrictEqual(msg.message.nonce, nonce);
    assert.strictEqual(toViemTypedData(msg).message.nonce, hex.encode(nonce, true));
  });

  it("defaults to a window open from the epoch that never closes", () => {
    const msg = compose();
    assert.strictEqual(msg.message.validAfter, 0n);
    assert.strictEqual(msg.message.validBefore, maxUint256);
  });

  it("rejects a negative value", () => {
    assert.throws(() => composeTransferWithAuthorizationMsg(alice, bob, -1n, domain, nonce));
  });

  it("names the struct after the mode", () => {
    for (const mode of ["TransferWithAuthorization", "ReceiveWithAuthorization"] as const) {
      const msg = compose(mode);
      assert.strictEqual(msg.primaryType, mode);
      assert.deepStrictEqual(Object.keys(msg.types), ["EIP712Domain", mode]);
    }
  });

  //the typehashes every EIP-3009 token hardcodes
  it("uses the canonical typehashes", () => {
    const typeStringOf = (data: Eip712Data) =>
      `${data.primaryType}(${
        data.types[data.primaryType]!.map(f => `${f.type} ${f.name}`).join(",")
      })`;
    const expected = {
      TransferWithAuthorization:
        "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
      ReceiveWithAuthorization:
        "0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8",
      CancelAuthorization:
        "0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429",
    } as const;
    for (const mode of ["TransferWithAuthorization", "ReceiveWithAuthorization"] as const)
      assert.strictEqual(hex.encode(hashStr(typeStringOf(compose(mode))), true), expected[mode]);
    assert.strictEqual(
      hex.encode(hashStr(typeStringOf(composeCancelAuthorizationMsg(alice, domain, nonce))), true),
      expected.CancelAuthorization,
    );
  });

  it("hashes to the digest the token's transferWithAuthorization() will recover against", () => {
    const validBefore = new Date("2030-01-01T00:00:00Z");
    const msg = composeTransferWithAuthorizationMsg(alice, bob, 1000n, domain, nonce, validBefore);

    const structHash = keccak256(hex.decode(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [ "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
        alice, bob, 1000n, 0n, BigInt(validBefore.getTime() / 1000), hex.encode(nonce, true),
      ],
    )));
    const separator = hex.decode(separatorOf(msg));
    const expected = keccak256(new Uint8Array([0x19, 0x01, ...separator, ...structHash]));

    assert.strictEqual(digestOf(msg), hex.encode(expected, true));
  });
});

describe("erc3009Events", () => {
  //both params indexed: the whole event rides in the topics and the data is empty
  it("parses an AuthorizationUsed log", () => {
    const abi = [{ type: "event", name: "AuthorizationUsed", inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce",      type: "bytes32", indexed: true },
    ] }] as const;
    const topics = encodeEventTopics({
      abi,
      eventName: "AuthorizationUsed",
      args:      { authorizer: alice, nonce: hex.encode(nonce, true) },
    }) as Hex[];
    assert.deepStrictEqual(
      buildParseEvent(erc3009Events)({ topics, data: "0x" }),
      { event: "AuthorizationUsed", authorizer: alice, nonce },
    );
  });
});

describe("randomAuthorizationNonce", () => {
  it("draws 32 fresh bytes each time", () => {
    const [a, b] = [randomAuthorizationNonce(), randomAuthorizationNonce()];
    assert.strictEqual(a.length, 32);
    assert.notDeepStrictEqual(a, b);
  });
});

// ---- Live query tests (require network) ----

let hasNetwork = false;
before(async () => { hasNetwork = await probeNetwork(); });

describe("erc3009 live query", () => {
  it("reads an unused authorization state from USDC", { timeout: liveTimeout }, async (t) => {
    if (!hasNetwork) return t.skip("no network");
    const [[used]] = await query([erc3009(token).authorizationState(usdcTreasury, nonce)]);
    assert.strictEqual(used, false);
  });
});
