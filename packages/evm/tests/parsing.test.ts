import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex, Log, RpcLog } from "viem";
import { getAddress, parseAbi, encodeEventTopics, encodeAbiParameters } from "viem";
import { bytes, utf8, hex } from "@onrail-xyz/utils";
import { keccak256 } from "../src/hashing.js";
import { addressItem, selectorOf, uint256Item, wordSize } from "../src/layouting.js";
import type { ViemLog } from "../src/parsing.js";
import { buildParseError, buildParseEvent } from "../src/parsing.js";

const word = (body: string) => hex.decode(body.padStart(2 * wordSize, "0"));
const ownerBytes = "0x00000000000000000000000000000000000000ab" as const;
//addressItem surfaces the EIP-55 spelling, so the expectation is derived rather than typed
const owner = getAddress(ownerBytes);

describe("buildParseError", () => {
  const invalidNonce = "InvalidNonce(address,uint256)";
  const parse = buildParseError([
    ["Unauthorized()", {}],
    [invalidNonce, { sender: addressItem, provided: uint256Item }],
  ]);
  const revertData =
    bytes.concat(selectorOf(invalidNonce), word(ownerBytes.slice(2)), word((7).toString(16)));

  it("decodes the matched variant's params", () => {
    assert.deepStrictEqual(parse(revertData), {
      error: "InvalidNonce", sender: owner, provided: 7n,
    });
  });

  it("decodes a paramless variant from its bare selector", () => {
    assert.deepStrictEqual(parse(selectorOf("Unauthorized()")), { error: "Unauthorized" });
  });

  it("reports an unknown selector in hex rather than as a decimal id", () => {
    assert.throws(
      () => parse(hex.decode("deadbeef")),
      /unrecognized error selector: 0xdeadbeef/,
    );
  });

  it("reports empty revert data as an empty selector", () => {
    assert.throws(() => parse(new Uint8Array()), /unrecognized error selector: 0x$/);
  });

  //v1 wrapped the whole deserialization in the catch, so a truncated payload behind a
  //  perfectly recognizable selector was reported as an unknown selector
  it("does not disguise a malformed payload as an unknown selector", () => {
    assert.throws(
      () => parse(revertData.subarray(0, revertData.length - 1)),
      (err: unknown) => !/unrecognized/.test(String(err)),
    );
  });
});

describe("buildParseEvent", () => {
  const depositRequest = "DepositRequest(address,uint256)";
  const parse = buildParseEvent([
    [depositRequest, { owner: addressItem, usdc: uint256Item }],
  ]);
  const topic0 = hex.encode(keccak256(utf8.encode(depositRequest)), true) as Hex;

  it("flattens topic0, the indexed params, then the data", () => {
    assert.deepStrictEqual(
      parse({ topics: [topic0, hex.encode(word(ownerBytes.slice(2)), true) as Hex],
              data: hex.encode(word((123).toString(16)), true) as Hex }),
      { event: "DepositRequest", owner, usdc: 123n },
    );
  });

  it("accepts the same event with nothing indexed", () => {
    assert.deepStrictEqual(
      parse({ topics: [topic0],
              data: hex.encode(
                bytes.concat(word(ownerBytes.slice(2)), word((123).toString(16))), true) as Hex }),
      { event: "DepositRequest", owner, usdc: 123n },
    );
  });

  it("reports an unknown topic0 in hex", () => {
    const unknown = hex.encode(keccak256(utf8.encode("Nope()")), true) as Hex;
    assert.throws(
      () => parse({ topics: [unknown], data: "0x" }),
      new RegExp(`unrecognized event topic0: ${unknown}`),
    );
  });

  it("rejects a log without topics", () => {
    assert.throws(() => parse({ topics: [], data: "0x" }), /anonymous event/);
  });

  //the struct is wire order - indexed params first - which is only the declaration's order
  //  when the indexed params lead it; an interleaved declaration is spelled as a pair directly
  it("decodes an interleaved declaration from a pair spelled in wire order", () => {
    const abi = parseAbi(["event Moved(uint256 a, address indexed who, uint256 b)"]);
    const parseMoved = buildParseEvent([
      ["Moved(uint256,address,uint256)", { who: addressItem, a: uint256Item, b: uint256Item }],
    ]);
    const log = {
      topics: encodeEventTopics({ abi, eventName: "Moved", args: { who: owner } }) as Hex[],
      data:   encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 2n]),
    };
    assert.deepStrictEqual(parseMoved(log), { event: "Moved", who: owner, a: 1n, b: 2n });
  });
});

//`ViemLog` states the minimum the parser reads rather than deriving from viem's `Log`, whose
//  `topics` is a tuple union that would turn away a log assembled from parts. These pin the
//  compatibility that buys instead of the derivation: viem's own shapes must keep fitting
type Fits<From> = [From] extends [ViemLog] ? true : false;
const viemLogFits:      Fits<Log>    = true;
const rpcLogFits:       Fits<RpcLog> = true;
const assembledLogFits: Fits<{ topics: readonly Hex[]; data: Hex }> = true;

describe("ViemLog", () => {
  it("accepts viem's own log shapes and one assembled from parts", () => {
    assert.ok(viemLogFits && rpcLogFits && assembledLogFits);
  });
});
