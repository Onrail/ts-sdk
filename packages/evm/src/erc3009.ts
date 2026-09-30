import type { Address } from "viem";
import type { RoUint8Array, OptionalArg } from "@onrail-xyz/utils";
import type { KindWithAtomic } from "@onrail-xyz/amount";
import { type AmountOrAtomic, toAtomicIfAmount, hashItem } from "@onrail-xyz/common";
import { type Deadline, deadlineItem, evmTimestampItem, abiBoolItem,
         abiSignatureItem, sigVariant, abiParam, amountParam, addressParam } from "./layouting.js";
import { type ContractMethods, abiFunction, contractFromSpec } from "./client.js";
import type { Eip712Domain, Eip712Data, Eip712Message } from "./eip712.js";
import { eip712DomainType } from "./eip712.js";

const from       = addressParam("from"      );
const to         = addressParam("to"        );
const authorizer = addressParam("authorizer");
//the standard's nonce is a caller-chosen bytes32, unrelated to EIP-2612's sequential uint256
const nonce       = abiParam("nonce",       "bytes32",               hashItem        );
const validAfter  = abiParam("validAfter",  "uint256",               evmTimestampItem);
const validBefore = abiParam("validBefore", "uint256",               deadlineItem    );
const signature   = abiParam("signature",   "uint8,bytes32,bytes32", abiSignatureItem);

const erc3009Spec = <const K extends KindWithAtomic | undefined = undefined>(
  ...kind: OptionalArg<K>
) => {
  const value = amountParam("value", "uint256", ...kind);

  //one parameter list under two names: the receiving variant binds the submitter to be `to`
  const withAuthorization = <N extends string>(name: N) =>
    abiFunction(name, [from, to, value, validAfter, validBefore, nonce, signature],
      (from, to, value, validAfter, validBefore, nonce, signature) =>
        ({ from, to, value, validAfter, validBefore, nonce, signature }));

  return [
    abiFunction("authorizationState", [authorizer, nonce],
      (authorizer, nonce) => ({ authorizer, nonce }), abiBoolItem),
    withAuthorization("transferWithAuthorization"),
    withAuthorization("receiveWithAuthorization"),
    abiFunction("cancelAuthorization", [authorizer, nonce, signature],
      (authorizer, nonce, signature) => ({ authorizer, nonce, signature })),
  ] as const;
};

export const erc3009 = <const K extends KindWithAtomic | undefined = undefined>(
  contract: Address,
  ...kind:  OptionalArg<K>
): ContractMethods<ReturnType<typeof erc3009Spec<K>>> =>
  contractFromSpec(contract, erc3009Spec(...kind));

//the standard's events as `buildParseEvent` variants; its reverts are left to implementations
export const erc3009Events = [
  sigVariant("AuthorizationUsed",     authorizer, nonce),
  sigVariant("AuthorizationCanceled", authorizer, nonce),
] as const;

// ---- EIP-3009 Authorization Messages ----

const authorizationType = [
  { name: "from",        type: "address" },
  { name: "to",          type: "address" },
  { name: "value",       type: "uint256" },
  { name: "validAfter",  type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce",       type: "bytes32" },
] as const;

const cancelAuthorizationType = [
  { name: "authorizer", type: "address" },
  { name: "nonce",      type: "bytes32" },
] as const;

export type Eip3009AuthorizationMessage = Eip712Message<typeof authorizationType>;
export type Eip3009CancelMessage        = Eip712Message<typeof cancelAuthorizationType>;

export const randomAuthorizationNonce = (): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(32));

//one struct under two names: the receiving variant additionally binds the submitter to be `to`
const composeAuthorization = (
  primaryType: "TransferWithAuthorization" | "ReceiveWithAuthorization",
) => (
  from:        Address,
  to:          Address,
  value:       AmountOrAtomic,
  domain:      Eip712Domain,
  nonce:       RoUint8Array,
  validBefore: Deadline = "infinity",
  validAfter:  Date     = new Date(0),
) => {
  const atomic = toAtomicIfAmount(value);
  if (atomic < 0n)
    throw new Error("Value must not be negative");

  return {
    types:       { EIP712Domain: eip712DomainType(domain), [primaryType]: authorizationType },
    primaryType,
    domain,
    message:     { from,
                   to,
                   value:       atomic,
                   validAfter:  evmTimestampItem.custom.from(validAfter),
                   validBefore: deadlineItem.custom.from(validBefore),
                   nonce,
                 },
  } as const satisfies Eip712Data<Eip3009AuthorizationMessage>;
};

//compose an EIP-3009 authorization; `toViemTypedData` bridges it to viem's signing calls
export const composeTransferWithAuthorizationMsg =
  composeAuthorization("TransferWithAuthorization");
export const composeReceiveWithAuthorizationMsg =
  composeAuthorization("ReceiveWithAuthorization");

export const composeCancelAuthorizationMsg = (
  authorizer: Address,
  domain:     Eip712Domain,
  nonce:      RoUint8Array,
) => ({
  types:       { EIP712Domain:        eip712DomainType(domain),
                 CancelAuthorization: cancelAuthorizationType,
               },
  primaryType: "CancelAuthorization",
  domain,
  message:     { authorizer, nonce },
} as const satisfies Eip712Data<Eip3009CancelMessage>);
