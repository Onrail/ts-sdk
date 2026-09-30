import type { Address } from "viem";
import type { OptionalArg } from "@onrail-xyz/utils";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { type AmountOrAtomic, toAtomicIfAmount, hashItem } from "@onrail-xyz/common";
import { type Deadline, uint256Item, deadlineItem,
         abiSignatureItem, abiParam, addressParam, amountParam } from "./layouting.js";
import { type ContractMethods, abiFunction, contractFromSpec } from "./client.js";
import type { Eip712Domain, Eip712Data, Eip712Message } from "./eip712.js";
import { eip712DomainType } from "./eip712.js";

const owner     = addressParam("owner"  );
const spender   = addressParam("spender");
const deadline  = abiParam("deadline",  "uint256", deadlineItem    );
const signature = abiParam("signature", "uint8,bytes32,bytes32", abiSignatureItem);

const permitSpec = <const K extends KindWithAtomic | undefined = undefined>(
  ...kind: OptionalArg<K>
) => {
  const value = amountParam("value", "uint256", ...kind);
  return [
    abiFunction("DOMAIN_SEPARATOR", [],      () => ({}),           hashItem   ),
    abiFunction("nonces",           [owner], owner => ({ owner }), uint256Item),
    abiFunction("permit", [owner, spender, value, deadline, signature],
      (owner, spender, value, deadline, signature) =>
        ({ owner, spender, value, deadline, signature })),
  ] as const;
};

export const permit = <const K extends KindWithAtomic | undefined = undefined>(
  contract: Address,
  ...kind:  OptionalArg<K>
): ContractMethods<ReturnType<typeof permitSpec<K>>> =>
  contractFromSpec(contract, permitSpec(...kind));

const permitType = [
  { name: "owner",    type: "address" },
  { name: "spender",  type: "address" },
  { name: "value",    type: "uint256" },
  { name: "nonce",    type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export type Eip2612Message = Eip712Message<typeof permitType>;
export type Eip2612Data    = Eip712Data<Eip2612Message>;

//compose an EIP-2612 permit message; `toViemTypedData` bridges it to viem's signing calls
export const composePermitMsg = (
  owner:    Address,
  spender:  Address,
  value:    AmountOrAtomic,
  domain:   Eip712Domain,
  nonce:    number | bigint,
  deadline: Deadline = "infinity",
) => {
  const atomic = toAtomicIfAmount(value);
  if (atomic < 0n)
    throw new Error("Value must not be negative");

  const unixDeadline = deadlineItem.custom.from(deadline);
  const bigNonce = typeof nonce === "number" ? BigInt(nonce) : nonce;

  return {
    types:       { EIP712Domain: eip712DomainType(domain), Permit: permitType },
    primaryType: "Permit",
    domain,
    message:     { owner, spender, value: atomic, nonce: bigNonce, deadline: unixDeadline },
  } as const satisfies Eip2612Data;
};
