import type { Address } from "viem";
import type { OptionalArg } from "@onrail-xyz/utils";
import { utf8Conversion, withCustom } from "@onrail-xyz/binary-layout";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { paddedSlotLayout, evmAmountItem,
         abiEncodedBytesItem, sigVariant, addressParam, amountParam } from "./layouting.js";
import type { ContractMethods } from "./client.js";
import { abiFunction, contractFromSpec } from "./client.js";

const abiStringItem = withCustom(abiEncodedBytesItem(), utf8Conversion);
const decimalsItem  = paddedSlotLayout({ binary: "uint", size: 1 } as const);

const from    = addressParam("from"   );
const to      = addressParam("to"     );
const owner   = addressParam("owner"  );
const spender = addressParam("spender");

const valueParam = <const K extends KindWithAtomic | undefined = undefined>(
  ...kind: OptionalArg<K>
) =>
  amountParam("value", "uint256", ...kind);

const erc20Spec = <const K extends KindWithAtomic | undefined = undefined>(
  ...kind: OptionalArg<K>
) => {
  const value      = valueParam(...kind);
  const amountItem = evmAmountItem(...kind);
  const abiF = abiFunction;
  return [
    abiF("name",         [],                ()                => ({}),              abiStringItem),
    abiF("symbol",       [],                ()                => ({}),              abiStringItem),
    abiF("decimals",     [],                ()                => ({}),               decimalsItem),
    abiF("totalSupply",  [],                ()                => ({}),                 amountItem),
    abiF("balanceOf",    [owner],           owner             => ({ owner }),          amountItem),
    abiF("allowance",    [owner, spender],  (owner, spender)  => ({ owner, spender }), amountItem),
    abiF("approve",      [spender, value],  (spender, value)  => ({ spender, value })            ),
    abiF("transfer",     [to, value],       (to, value)       => ({ to, value })                 ),
    abiF("transferFrom", [from, to, value], (from, to, value) => ({ from, to, value })           ),
  ] as const;
};

export const erc20 = <const K extends KindWithAtomic | undefined = undefined>(
  contract: Address,
  ...kind:  OptionalArg<K>
): ContractMethods<ReturnType<typeof erc20Spec<K>>> =>
  contractFromSpec(contract, erc20Spec(...kind));

//`Transfer` and `Approval` as `buildParseEvent` variants; `allowanceAdjusters` emits the latter
export const erc20Events = <const K extends KindWithAtomic | undefined = undefined>(
  ...kind: OptionalArg<K>
) => {
  const value = valueParam(...kind);
  return [
    sigVariant("Transfer", from,  to,      value),
    sigVariant("Approval", owner, spender, value),
  ] as const;
};

const allowanceAdjustersSpec = <const K extends KindWithAtomic | undefined = undefined>(
  ...kind: OptionalArg<K>
) => {
  const addedValue      = amountParam("addedValue",      "uint256", ...kind);
  const subtractedValue = amountParam("subtractedValue", "uint256", ...kind);
  return [
    abiFunction("increaseAllowance", [spender, addedValue],
      (spender, addedValue) => ({ spender, addedValue })),
    abiFunction("decreaseAllowance", [spender, subtractedValue],
      (spender, subtractedValue) => ({ spender, subtractedValue })),
  ] as const;
};

export const allowanceAdjusters = <const K extends KindWithAtomic | undefined = undefined>(
  contract: Address,
  ...kind:  OptionalArg<K>
): ContractMethods<ReturnType<typeof allowanceAdjustersSpec<K>>> =>
  contractFromSpec(contract, allowanceAdjustersSpec(...kind));
