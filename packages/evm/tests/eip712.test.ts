import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Address, domainSeparator, encodeAbiParameters } from "viem";
import { type RoUint8Array, hex, bignum, utf8 } from "@onrail-xyz/utils";
import { type DeriveType, serialize, deserialize } from "@onrail-xyz/binary-layout";
import { keccak256 } from "../src/hashing.js";
import { wordSize } from "../src/layouting.js";
import type { Eip712Data, Eip712Message } from "../src/eip712.js";
import { toViemTypedData, eip712DomainType,
         eip712EncodeDataLayout, guessEip712Domain } from "../src/eip712.js";
import { composePermitMsg, permit } from "../src/permit.js";
import { probeNetwork, query, liveTimeout, token } from "./live.js";

const alice = "0x1111111111111111111111111111111111111111" as Address;
const bob   = "0x2222222222222222222222222222222222222222" as Address;

const hashStr = (s: string) => keccak256(utf8.encode(s));
const separatorOf = (data: Eip712Data) => domainSeparator(toViemTypedData(data));

describe("toViemTypedData", () => {
  const salt  = new Uint8Array(32).fill(0xab);
  const nonce = new Uint8Array(32).fill(0xcd);
  const data = {
    types: {
      EIP712Domain: eip712DomainType({ name: "Test", salt }),
      Order: [
        { name: "nonce",  type: "bytes32"   },
        { name: "legs",   type: "Leg[]"     },
        { name: "amount", type: "uint256"   },
        { name: "memo",   type: "string"    },
      ],
      Leg: [{ name: "id", type: "bytes32" }],
    },
    primaryType: "Order",
    domain:      { name: "Test", salt },
    message:     { nonce, legs: [{ id: nonce }], amount: 5n, memo: "hi" },
  } as const satisfies Eip712Data;

  it("hex-encodes the domain salt", () => {
    assert.equal(toViemTypedData(data).domain.salt, hex.encode(salt, true));
  });

  it("hex-encodes every bytes leaf of the message, nested and in arrays", () => {
    const { message } = toViemTypedData(data);
    assert.equal(message.nonce, hex.encode(nonce, true));
    assert.deepEqual(message.legs, [{ id: hex.encode(nonce, true) }]);
  });

  it("passes other leaves through untouched", () => {
    const { message } = toViemTypedData(data);
    assert.equal(message.amount, 5n);
    assert.equal(message.memo, "hi");
  });

  it("leaves a salt-less domain unchanged", () => {
    const domain = { name: "Test", chainId: 1n } as const;
    assert.deepEqual(toViemTypedData({ ...data, domain }).domain, domain);
  });
});

describe("Eip712Message", () => {
  it("derives the message type from the field list", () => {
    const fields = [
      { name: "a", type: "address" },
      { name: "n", type: "uint256" },
      { name: "h", type: "bytes32" },
      { name: "b", type: "bool"    },
      { name: "s", type: "string"  },
    ] as const;
    type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
    const pin: Mutual<
      Eip712Message<typeof fields>,
      Readonly<{ a: Address; n: bigint; h: RoUint8Array; b: boolean; s: string }>
    > = true;
    assert.ok(pin);
  });

  it("is the message of some field list when the list is unknown", () => {
    const fields = [{ name: "a", type: "address" }, { name: "n", type: "uint256" }] as const;
    const widened: Eip712Message = { a: alice, n: 1n } satisfies Eip712Message<typeof fields>;
    type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
    const pin: Mutual<Eip712Message[string], Address | boolean | bigint | RoUint8Array | string> = true;
    assert.ok(pin);
    assert.equal(widened["a"], alice);
  });
});

describe("eip712EncodeDataLayout", () => {
  const fields = [
    { name: "isSenior", type: "bool"    },
    { name: "tokens",   type: "uint64"  },
    { name: "tick",     type: "int24"   },
    { name: "owner",    type: "address" },
    { name: "nonce",    type: "bytes32" },
    { name: "tag",      type: "bytes4"  },
  ] as const;
  const layout = eip712EncodeDataLayout(fields);
  const nonce = new Uint8Array(32).fill(0xcd);
  const tag   = new Uint8Array([1, 2, 3, 4]);
  const message = {
    isSenior: true, tokens: 5n, tick: -887220n, owner: alice, nonce, tag,
  } as const satisfies Eip712Message<typeof fields>;

  it("serializes a message to the struct's encodeData", () => {
    assert.equal(
      hex.encode(serialize(layout, message), true),
      encodeAbiParameters(
        fields.map(f => ({ type: f.type })),
        [true, 5n, -887220, alice, hex.encode(nonce, true), hex.encode(tag, true)],
      ),
    );
  });

  it("reads a message back", () => {
    assert.deepEqual(deserialize(layout, serialize(layout, message)), message);
  });

  it("derives the field list's message type", () => {
    type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
    const pin: Mutual<DeriveType<typeof layout>, Eip712Message<typeof fields>> = true;
    assert.ok(pin);
  });

  it("has no word for dynamic, array or struct types, nor for bytes beyond a word", () => {
    for (const type of ["string", "bytes", "Leg[]", "Leg", "bytes0", "bytes33"])
      assert.throws(() => eip712EncodeDataLayout([{ name: "x", type }]));
  });
});

describe("eip712DomainType", () => {
  it("lists the fields present in the standard's order, whatever the key order", () => {
    const fields = eip712DomainType({ verifyingContract: alice, chainId: 1n, name: "X" });
    assert.deepEqual(fields.map(f => f.name), ["name", "chainId", "verifyingContract"]);
  });

  //an explicitly undefined field must not enter the domain type, or the separator changes
  it("ignores fields that are explicitly undefined", () => {
    const domain = { name: "X" } as const;
    const withUndefined = { ...domain, salt: undefined } as typeof domain;
    assert.deepEqual(eip712DomainType(withUndefined), eip712DomainType(domain));
  });
});

describe("guessEip712Domain", () => {
  // Canonical EIP-712 domain separator: the encoded field values MUST follow the standard's
  //   fixed order (name, version, chainId, verifyingContract), not the caller's argument order.
  //   A regression here previously made version recovery impossible for versioned tokens (USDC).
  const word = (b: Uint8Array) => { const w = new Uint8Array(wordSize); w.set(b, wordSize - b.length); return w; };
  const name = "USD Coin", version = "2", chainId = 1n;
  const verifyingContract = token;

  const separator = (typeStr: string, ...fields: Uint8Array[]) => {
    const parts = [hashStr(typeStr), ...fields];
    const buf = new Uint8Array(parts.length * wordSize);
    parts.forEach((p, i) => buf.set(p, i * wordSize));
    return keccak256(buf);
  };

  it("recovers the version from a versioned separator", () => {
    const sep = separator(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      hashStr(name), hashStr(version), word(bignum.toBytes(chainId, wordSize)), word(hex.decode(verifyingContract)),
    );
    const domain = guessEip712Domain(name, verifyingContract, chainId, sep);
    assert.strictEqual(domain.version, "2");
  });

  it("omits version for an unversioned separator", () => {
    const sep = separator(
      "EIP712Domain(string name,uint256 chainId,address verifyingContract)",
      hashStr(name), word(bignum.toBytes(chainId, wordSize)), word(hex.decode(verifyingContract)),
    );
    const domain = guessEip712Domain(name, verifyingContract, chainId, sep);
    assert.ok(!("version" in domain));
  });

  it("throws when no guess matches", () => {
    const sep = separator(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      hashStr(name), hashStr("999"), word(bignum.toBytes(chainId, wordSize)), word(hex.decode(verifyingContract)),
    );
    assert.throws(() => guessEip712Domain(name, verifyingContract, chainId, sep));
  });

  it("agrees with viem's domainSeparator", () => {
    const domain = { name, version, chainId, verifyingContract } as const;
    const sep = separatorOf(composePermitMsg(alice, bob, 1n, domain, 0));
    assert.deepStrictEqual(guessEip712Domain(name, verifyingContract, chainId, hex.decode(sep)), domain);
  });
});

// ---- Live query tests (require network) ----

let hasNetwork = false;
before(async () => { hasNetwork = await probeNetwork(); });

describe("eip712 live query", () => {
  //end-to-end proof of the domain machinery: the reconstructed domain must reproduce the
  //  separator that USDC's permit() actually verifies against
  it("reconstructs USDC's domain from its on-chain separator", { timeout: liveTimeout },
    async (t) => {
      if (!hasNetwork) return t.skip("no network");
      const [[separator]] = await query([permit(token).DOMAIN_SEPARATOR()]);
      const domain = guessEip712Domain("USD Coin", token, 1n, separator);
      assert.strictEqual(domain.version, "2");
      assert.strictEqual(
        separatorOf(composePermitMsg(alice, bob, 1n, domain, 0)),
        hex.encode(separator, true),
      );
    },
  );
});
