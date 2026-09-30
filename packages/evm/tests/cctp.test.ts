import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Abi, Address } from "viem";
import { encodeFunctionData, parseAbi } from "viem";
import { type RoArray, hex } from "@onrail-xyz/utils";
import { abiParam, uint256Item, addressItem, trailingBytesParam } from "../src/layouting.js";
import { abiFunction, contractFromSpec } from "../src/client.js";

const uint32Item  = { binary: "uint",  size:  4 } as const;
const bytes32Item = { binary: "bytes", size: 32 } as const;

const destinationDomain    = abiParam("destinationDomain",    "uint32",  uint32Item );
const minFinalityThreshold = abiParam("minFinalityThreshold", "uint32",  uint32Item );
const recipient            = abiParam("recipient",            "bytes32", bytes32Item);
const mintRecipient        = abiParam("mintRecipient",        "bytes32", bytes32Item);
const destinationCaller    = abiParam("destinationCaller",    "bytes32", bytes32Item);
const amount               = abiParam("amount",               "uint256", uint256Item);
const maxFee               = abiParam("maxFee",               "uint256", uint256Item);
const burnToken            = abiParam("burnToken",            "address", addressItem);

const spec = [
  abiFunction("sendMessage",
    [destinationDomain, recipient, destinationCaller, minFinalityThreshold,
     trailingBytesParam("messageBody")],
    (destinationDomain, recipient, destinationCaller, minFinalityThreshold, messageBody) =>
      ({ destinationDomain, recipient, destinationCaller, minFinalityThreshold, messageBody })),

  abiFunction("depositForBurnWithHook",
    [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee,
     minFinalityThreshold, trailingBytesParam("hookData")],
    (amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee,
     minFinalityThreshold, hookData) =>
      ({ amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee,
         minFinalityThreshold, hookData })),
] as const;

//a hook payload the trailing bytes carries as a layout rather than raw bytes
const hook = { recipient: bytes32Item, fee: uint256Item } as const;

//the contextual type of an inline spec displaces `abiFunction`'s output-layout default, so a
//  spec is bound before it is handed over
const typedSpec = [
  abiFunction("sendMessage",
    [destinationDomain, recipient, destinationCaller, minFinalityThreshold,
     trailingBytesParam("messageBody", hook)],
    (destinationDomain, recipient, destinationCaller, minFinalityThreshold, messageBody) =>
      ({ destinationDomain, recipient, destinationCaller, minFinalityThreshold, messageBody })),
] as const;

const messenger = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address;
const c = contractFromSpec(messenger, spec);
const typed = contractFromSpec(messenger, typedSpec);

const cctpAbi: Abi = parseAbi([
  "function sendMessage(uint32 destinationDomain, bytes32 recipient, bytes32 destinationCaller, uint32 minFinalityThreshold, bytes messageBody)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

const b32 = (n: number) => new Uint8Array(32).fill(n);
const viemHex = (functionName: string, args: RoArray) =>
  encodeFunctionData({ abi: cctpAbi, functionName, args: args as never[] });

const badSpec = [
  abiFunction("bad", [trailingBytesParam("data"), abiParam("to", "address", addressItem)],
    (data, to) => ({ data, to })),
] as const;

describe("CCTP: a trailing bytes parameter", () => {
  for (const size of [0, 1, 31, 32, 33, 96])
    it(`sendMessage matches viem for a ${size}-byte messageBody`, () => {
      const body = new Uint8Array(size).map((_, i) => (i * 7 + 1) & 0xff);
      assert.strictEqual(
        hex.encode(c.sendMessage(7, b32(0xaa), b32(0xbb), 1000, body).data, true),
        viemHex("sendMessage",
          [7, hex.encode(b32(0xaa), true), hex.encode(b32(0xbb), true), 1000,
           hex.encode(body, true)]),
      );
    });

  it("depositForBurnWithHook matches viem across eight params", () => {
    const hookData = new Uint8Array([1, 2, 3, 4, 5]);
    assert.strictEqual(
      hex.encode(c.depositForBurnWithHook({
        amount: 1_000_000n, destinationDomain: 3, mintRecipient: b32(0xcc),
        burnToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        destinationCaller: b32(0), maxFee: 500n, minFinalityThreshold: 2000, hookData,
      }).data, true),
      viemHex("depositForBurnWithHook",
        [1_000_000n, 3, hex.encode(b32(0xcc), true),
         "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", hex.encode(b32(0), true), 500n, 2000,
         hex.encode(hookData, true)]),
    );
  });

  it("a typed payload rides in the trailing bytes", () => {
    const payload = new Uint8Array(64);
    payload.set(b32(0xdd));
    payload[63] = 42;
    assert.strictEqual(
      hex.encode(typed.sendMessage(7, b32(0xaa), b32(0xbb), 1000,
        { recipient: b32(0xdd), fee: 42n }).data, true),
      viemHex("sendMessage",
        [7, hex.encode(b32(0xaa), true), hex.encode(b32(0xbb), true), 1000,
         hex.encode(payload, true)]),
    );
  });

  it("rejects a dynamic parameter that is not last", () => {
    assert.throws(
      () => contractFromSpec(messenger, badSpec),
      /must be the only one, and come last/,
    );
  });
});
