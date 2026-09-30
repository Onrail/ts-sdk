# @onrail-xyz/evm

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/evm.svg)](https://www.npmjs.com/package/@onrail-xyz/evm)

Ethereum/EVM utilities built on [viem](https://www.npmjs.com/package/viem). Provides type-safe ERC20, EIP-2612 permit and EIP-3009 authorization interactions, batched on-chain queries via Multicall3, and low-level EVM binary layout primitives.

- [Contract Specs](#contract-specs) – declarative contract interface definitions
- [ERC20](#erc20) – read/write ERC20 methods via spec
- [EIP-2612 Permit](#eip-2612-permit) – on-chain permit calls and off-chain message composition
- [EIP-3009 Authorizations](#eip-3009-authorizations) – transfers by signed authorization, on-chain calls and message composition
- [Batched Queries](#batched-queries) – Multicall3-based read batching with block-consistent results
- [EVM Layout Primitives](#evm-layout-primitives) – word-aligned binary layouts, function selectors, storage slot computation
- [Hashing](#hashing) – keccak256, sha3_256

## Install

```bash
npm install @onrail-xyz/evm \
  @onrail-xyz/utils @onrail-xyz/binary-layout @onrail-xyz/common @onrail-xyz/amount \
  @noble/hashes viem
```

The `@onrail-xyz/*` packages, `viem`, and `@noble/hashes`, which backs the hash re-exports, are peer dependencies — install them alongside `evm` (recent pnpm/npm auto-install peers; Yarn does not). Peering keeps a single shared `utils` (which anchors the SDK's branded types) and a single `viem` across the consuming app. `@noble/hashes` is accepted at `^1.8 || ^2`: the functions used are the same in both majors, so the copy viem pins serves. Node and TypeScript floors are [SDK-wide](https://github.com/Onrail/ts-sdk#requirements).

## Contract Specs

`contractFromSpec` generates a typed contract interface from a declarative spec: a tuple of `abiFunction(name, params, composer, outputLayout?)` rows.

- **Params** are `abiParam(name, solidityType, item)` triples: the type is the string the ABI uses, the item says how its slot reads. A parameter spanning several words that is not a tuple — a signature's `(v, r, s)` — spells its types comma-joined, `"uint8,bytes32,bytes32"`, so the signature string reads as if they were separate parameters. The surfaced value type is the item's; where `DeriveType` cannot reduce it — an amount at an open kind — `abiParam<V>()(name, type, item)` states it, the zero-argument overload taking `V` alone so the rest stays inferred; `paramOf<V>()(type, item)` is the same door for a factory. Two more exist beside it: `amountParam(name, type, kind?, size?)`, which states `AmountOr<K, NumSizeToPrimitive<S>>` — an `Amount<K>` given a kind, otherwise the primitive the item's width derives — and `trailingBytesParam(name, layout?)`, which carries the dynamic marker `abiParam` cannot express. Note the ABI type and the item's width are independent: the type is what the slot is spelled as, the width is the domain's range, so a `uint64` amount the contract holds is `amountParam(name, "uint256", kind, 8)` — an 8-byte item on a `uint256` word, which rejects a value the contract could not hold where a word-wide item would pass it. What recurs across a domain's tables is the type-and-item pair, not the name, so `paramOf(type, item)` fixes the pair and returns a factory taking the name — `addressParam` is `paramOf("address", addressItem)`, and a domain spells its own the same way (`const usdcParam = paramOf("uint256", usdcItem)`). Beyond that there is no shared parameter vocabulary — names are cheap to spell and each table defines the handful it reuses.
- **Read calls** (output layout given) return a layout triple `[layout, params, outputLayout]` for use with the query function from `createQuery`.
- **Write calls** (no output layout) return pre-serialized call data; the sender is the transaction's business, so none is taken. `toViemTx` bridges the result to viem's transaction parameters.
- The **composer** maps positional arguments to the params object, giving every method both a positional and an object overload. It is typed from the params, so it is written with names only. The two forms are told apart by arity, except for a single object argument to a single-parameter method, which is read as the object form iff its one key is the parameter's name — so a positional record whose sole key happens to be the parameter's name, or an object-form value carrying extra keys, is read the other way. Name such a parameter after something other than its record's only key, or pass the object form with exactly the one key.
- **Solidity overloads** share an ABI name, so a row whose method key must differ names both, key first: `abiFunction(["safeTransferFromWithData", "safeTransferFrom"], [from, to, tokenId, data], ...)`. The key names the method on the generated interface; the ABI name goes into the selector.
- **Events and errors** are `[signature, struct]` pairs, listed as the variants of `buildParseEvent` / `buildParseError` (`erc20Events`, say); `sigVariant(name, ...params)` spells one from the same params. The struct is in *wire* order. For an error that is the parameter order. For an event it is the indexed parameters first, then the rest, each group in declaration order — which is `sigVariant`'s param order exactly when the indexed parameters lead the declaration, as they conventionally do. An event whose declaration interleaves them is spelled as a pair directly: the signature in declaration order, the struct in wire order. An indexed `bytes`, `string`, array or struct parameter is its keccak on the wire, so its item is `hashItem`. Since topics and data are read as one sequence, events that share a signature but not its indexing decode alike (ERC-721's `Transfer` indexes the token id that ERC-20's carries as data): parse the logs of known contracts, filtered by address.

The pieces are typed too. A row is a `FuncSpec`, named by a `FuncName` — a string, or a `[key, abiName]` pair whose `FuncKey` names the method. Params are `AbiParam`s (`DynamicAbiParam` for the trailing one), each surfacing its `AbiParamValue`; for a param list, `ParamsStruct` is its items, `ParamsLayout` the call layout they form, and `ParamsRecord` the record the composer builds. `ContractMethods<S>` is the interface `contractFromSpec` generates. A variant is a `SigVariant` (a non-empty tuple of them, `SigVariants`), and `SigVariantOf<N, P>` is the one `sigVariant` spells; `signatureOf(name, params)` is the signature string a spec derives, `sigNameOf`/`SigNameOf` read the name back. `buildParseError` reads revert data and `buildParseEvent` a `ViemLog`, yielding `ParsedError<V>`/`ParsedEvent<V>`; both run on `sigSwitchItem(idSize, tag)`, a *switch* keyed by a signature hash's leading bytes (4 for errors, the whole 32-byte topic for events), whose returned factory is a `SigSwitcher`.

### What specs cover, and what they do not

**This is not a full ABI codec.** A spec lays each parameter out on its ABI slots with `binary-layout`, which buys the typed, branded values this SDK is built on — an `Amount`, a `Deadline`, a domain type — at a fraction of an encoder's cost. The price is that the argument shapes it can express are a subset of the ABI's, and the boundary is *static versus dynamic*, not "primitives versus structs".

Covered:

- Any statically sized parameter — `address`, `bool`, `uintN`, `intN`, `bytesN`. A signed parameter narrower than a word takes the word's own width on the wire, since the ABI sign-extends it, and a value its declared width cannot hold is rejected. A `bytesN` is `bytesNItem(N)`: the one static type the ABI pads on the *right*, so it is spelled at word width, whereas a bare `{ binary: "bytes", size }` on a slot is left-padded like every other value — which is how `addressItem`, a bare 20-byte item, lands on its `uint160` slot.
- **Static tuples**, which the ABI encodes inline, as one multi-word parameter whose type is paren-spelled: `abiParam("order", "(uint256,address)", { binary: "bytes", layout: { amount: uint256Item, taker: abiAddressItem } })`. A tuple's members each occupy a whole slot, so each is padded individually (`paddedFields` does that for a struct of sub-word items). Nesting is fine as long as every member is static.
- **Fixed-size arrays of static types** (`uint256[2]`), likewise inline.
- **One trailing dynamic argument**, via `trailingBytesParam(name, layout?)` — the common `f(..., bytes data)` shape (CCTP's `messageBody` and `hookData`, Uniswap v4's `hookData`). Given a `layout` it carries that structure's serialization rather than raw bytes.
- **A single dynamic return value.** An output layout is handed straight to `deserialize` rather than laid out on slots, so `abiEncodedBytesItem` spells one — which is what `erc20`'s `name` and `symbol` do. It is an `AbiEncodedBytesItem<L>`, deriving `AbiEncoded<L>`: the content layout's type, or raw bytes without one. Several of them hit the same offset problem as several dynamic arguments.

Not covered:

- **Dynamic arrays** — `address[]`, `uint256[]`, `bytes[]`.
- **More than one dynamic parameter**, or one that is not last. With two, each offset depends on the lengths of the tails ahead of it; nothing constant remains to bake into a layout, which is where clever layouts end and an encoder begins. A spec that asks for this through `trailingBytesParam` anywhere but last throws when it is built. A plain `abiParam` is not parsed for its type string: the item is the author's statement of how the slots read, and the type string is only what goes into the selector, so a dynamic type over a static item is the author's error and encodes inline, wrongly.
- **Dynamic tuples** — a tuple with any dynamic member is itself dynamic, offset pointer and all.

These exclusions are somewhat common: ERC-1155's `safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)` and any router taking a multi-hop path or a batch of calls fall within that limitation and require a complete encoder like viem's `encodeFunctionData`.


```ts
import { contractFromSpec, abiFunction, addressParam, amountParam, evmAmountItem } from "@onrail-xyz/evm";

//a spec's parameter vocabulary is its own
const owner = addressParam("owner");
const to    = addressParam("to");
const value = amountParam("value", "uint256");

const spec = [
  abiFunction("balanceOf", [owner],     owner => ({ owner }),           evmAmountItem()),
  abiFunction("transfer",  [to, value], (to, value) => ({ to, value })),
] as const;

const contract = contractFromSpec("0xA0b8...eB48", spec);

// Read call — returns { to, data: [layout, params, outputLayout] }
const call = contract.balanceOf({ owner: "0xd8dA...6045" });

// Write call — returns { to, data: Uint8Array }
const tx = contract.transfer({ to: "0xd8dA...6045", value: 500n });
```

`toViemTx` converts a `ContractTx` — a write call's result, optionally carrying a `from`, a `value` and an access list — into viem's transaction parameters (a `ViemTx`): call data as hex, the value as an atomic `bigint`, and the sender under viem's name for it, `account`.

```ts
import { toViemTx } from "@onrail-xyz/evm";

await walletClient.sendTransaction(toViemTx(tx));
```

`addressItem` surfaces the EIP-55 checksummed spelling, matching what viem's decoders return — a lowercase one would make the same word decode to two strings that compare unequal. Either spelling is accepted on the way in.

## ERC20

Built on `contractFromSpec`. Provides `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `allowance`, `approve`, `transfer`, and `transferFrom`. The optional `kind` parameter enables typed `Amount` values via `@onrail-xyz/amount`.

`erc20Events` lists `Transfer` and `Approval` as variants for `buildParseEvent`. `allowanceAdjusters` provides `increaseAllowance` and `decreaseAllowance` the same way as `erc20`. They are OpenZeppelin's extension rather than ERC-20, dropped from OpenZeppelin 5.0 but implemented by USDC and most tokens built on earlier releases, hence a spec of their own.

```ts
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { erc20, createQuery } from "@onrail-xyz/evm";

const client = createPublicClient({ chain: mainnet, transport: http() });
const query = createQuery(client);
const usdc = erc20("0xA0b8...eB48");

// Read calls — use with the query function from createQuery
const [[name, decimals, balance]] = await query([
  usdc.name(),
  usdc.decimals(),
  usdc.balanceOf({ owner: "0xd8dA...6045" }),
]);

// Write calls
const approveTx = usdc.approve({ spender: spenderAddr, value: 1000n });
const transferTx = usdc.transfer({ to: toAddr, value: 500n });
```

## EIP-2612 Permit

### On-chain calls

The `permit` function provides `DOMAIN_SEPARATOR`, `nonces`, and `permit` methods via `contractFromSpec`:

```ts
import { permit } from "@onrail-xyz/evm";

const p = permit("0xA0b8...eB48");

// Read the domain separator and nonce
const [[domainSep, nonce]] = await query([
  p.DOMAIN_SEPARATOR(),
  p.nonces({ owner: ownerAddr }),
]);

// Submit a permit
const tx = p.permit({
  owner: ownerAddr, spender: spenderAddr, value: 1000n,
  deadline: new Date("2030-01-01"), signature,
});
```

`deadline` is a `Date` or `"infinity"`, the latter encoding the maxed out uint256 that means "never expires". `signature` is the 65 packed bytes a signer returns (`hex.decode(await walletClient.signTypedData(...))`); the spec spreads them over the `v`, `r`, `s` words the Solidity signature takes (`abiSignatureItem`), so nothing is split by hand. `signatureItem` carries the packed bytes as is and `compactSignatureItem` EIP-2098's 64-byte form; all three type the signature as the packed bytes. `signatureSize` is those 65 bytes, and `signatureLayout`/`abiSignatureLayout` are the structs behind the items — `r`, `s`, `v` packed, and `v`, `r`, `s` on words. The deadline is `deadlineItem`, a word-wide timestamp saturating at `"infinity"` (a `Deadline`); `evmTimestampItem` is the same word without the sentinel.

### Off-chain message composition

`guessEip712Domain` reconstructs the EIP-712 domain from on-chain data by brute-forcing the version field against the domain separator hash. It covers the `{ name, chainId, verifyingContract }` domain with an optional version, i.e. tokens following EIP-2612's reference implementation. `composePermitMsg` builds an EIP-2612 permit, and `toViemTypedData` hands it to viem: a composed message keeps its `bytes32` values (the domain's `salt`, an EIP-3009 `nonce`) as byte arrays and an all-optional domain, whereas viem wants hex and derives the domain's required fields from `types.EIP712Domain`. A message is an `Eip712Message<F>`, the object its `Eip712Field` list describes, and a composed one an `Eip712Data` (`Eip2612Message`/`Eip2612Data` for a permit) with an `Eip712Domain`; `toViemTypedData` returns a `ViemTypedData<T>`, and `eip712DomainType(domain)` is the domain's field list as viem derives it.

Only EIP-2612 is covered — DAI-style permits (`nonce`/`expiry`/`allowed` instead of `value`/`deadline`, and hence a different struct and selector) need their own spec.

```ts
import { composePermitMsg, guessEip712Domain, toViemTypedData } from "@onrail-xyz/evm";

const domain = guessEip712Domain(
  tokenName, contractAddress, chainId, domainSeparator,
);

const permitData = composePermitMsg(
  owner, spender, amount, domain, nonce,
  deadline, // optional — defaults to max uint256
);

const signature = await walletClient.signTypedData(toViemTypedData(permitData));
```

`eip712EncodeDataLayout(fields)` spells a struct's `encodeData` as a layout, an `Eip712EncodeDataLayout<F>`: each atomic field (`bool`, `address`, `uintN`, `intN`, `bytesN`) on a word, in field order. Serializing a message through it yields the bytes `hashStruct` hashes after the type hash, and deserializing derives a message from any data that already has a word-per-field layout — a command a contract also accepts through its ABI, say — so the message need not be composed by hand. It is atomic-only: a dynamic, array or struct-typed field takes a word holding a hash rather than the value, which the layout does not compute, so a field list with one is rejected.

## EIP-3009 Authorizations

[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) moves tokens on the holder's signature alone: whoever submits the authorization pays the gas, and the receiving variant additionally requires the submitter to be the recipient. `erc3009` provides `authorizationState`, `transferWithAuthorization`, `receiveWithAuthorization` and `cancelAuthorization` via `contractFromSpec`; USDC implements the standard.

```ts
import { erc3009, composeTransferWithAuthorizationMsg, randomAuthorizationNonce, toViemTypedData } from "@onrail-xyz/evm";

const nonce = randomAuthorizationNonce();
const authorization = composeTransferWithAuthorizationMsg(
  holder, recipient, amount, domain, nonce,
  validBefore, // optional — defaults to max uint256
  validAfter,  // optional — defaults to the epoch, i.e. valid immediately
);
const signature = await walletClient.signTypedData(toViemTypedData(authorization));

const a = erc3009("0xA0b8...eB48");
const tx = a.transferWithAuthorization({
  from: holder, to: recipient, value: amount, validAfter, validBefore, nonce,
  signature: hex.decode(signature),
});

// A pending authorization is revoked by its holder through a second signature
const cancellation = composeCancelAuthorizationMsg(holder, domain, nonce);
```

`composeReceiveWithAuthorizationMsg` is the receiving variant's twin, taking the same arguments; the messages are `Eip3009AuthorizationMessage` and `Eip3009CancelMessage`.

Nonces are 32 random bytes rather than a counter, so several authorizations can stand at once and composing one needs no chain state; `authorizationState(authorizer, nonce)` reads whether a nonce has been used or canceled, and `erc3009Events` lists the standard's `AuthorizationUsed` / `AuthorizationCanceled` for `buildParseEvent`. The standard leaves revert reasons to implementations, so none are listed.

## Batched Queries

`createQuery(client)` returns a `query` function that batches arbitrary read calls into a single [Multicall3](https://www.multicall3.com/) request and returns the results together with the block they were read from — so all reads come from the same point in time.

Consistency is not merely a matter of batching: the block tag is first resolved to a block hash, and the batch is then executed against that hash with `requireCanonical`, so a reorg fails the query (and is retried) instead of silently mixing states. This requires an RPC that supports [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898) block hash parameters, plus archive state for blocks beyond the pruning window.

```ts
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { createQuery, erc20 } from "@onrail-xyz/evm";

const client = createPublicClient({ chain: mainnet, transport: http() });
const query = createQuery(client);

const token = erc20("0xA0b8...eB48");

const [[balance, allowance], blockNumber, blockHash, blockTime] = await query(
  [
    token.balanceOf({ owner: "0xd8dA...6045" }),
    token.allowance({ owner: "0xd8dA...6045", spender: "0xBEEF...0000" }),
  ],
  "latest",
);
```

The block can also be given as a number, as `"finalized"`, or as a block hash — the latter pins the query directly and hence yields the results only, without the block meta tuple. The types follow: the block is a `BlockSpec`, the results a `QueryResult` or `QueryResultWithMeta`, and `Query` is the function `createQuery` returns.

A call is a `QueryCall`, and its data a `QueryCallData` in one of three formats — raw bytes, a `QueryLayoutTriple`, or a `QueryAbiPair` whose result is its `QueryAbiReturn` — which mix freely, even within the same batch:

```ts
const [[rawBytes, amount, viemDecoded]] = await query(
  [
    // 1. Raw bytes — pre-serialized in, raw bytes out
    { to: tokenAddr, data: serialize(balanceOfLayout, { owner }) },
    // 2. Layout triple — deserialized via the output layout
    { to: tokenAddr, data: [balanceOfLayout, { owner }, evmAmountItem(ethKind)] },
    // 3. Function signature — viem ABI-encodes the call and decodes the return
    { to: tokenAddr, data: ["balanceOf(address) view returns (uint256)", [owner]] },
  ],
  "latest",
);
```

A reverting call fails the whole query unless it opts into `allowFailure`, which turns its result into a `{ success, data }` pair — with the raw revert data on failure — while the rest of the batch is unaffected:

```ts
const [[maybeAllowance]] = await query([
  { to: tokenAddr, data: [allowanceLayout, { owner, spender }, uint256Item], allowFailure: true },
]);
if (maybeAllowance.success)
  console.log(maybeAllowance.data);
```

## EVM Layout Primitives

The plumbing that the rest of the package is built on. Layout items for EVM's 32-byte word-aligned world, function selector helpers, and storage slot computation — all plugging into `@onrail-xyz/binary-layout`.

```ts
import {
  uint256Item,
  addressItem,
  bytesNItem,
  signatureItem,
  selectorOf,
  selectorLayout,
  evmAmountItem,
  mappingSlot,
  paddedSlotLayout,
  paddedFields,
} from "@onrail-xyz/evm";

// Compute a 4-byte function selector — the signature must be canonical, i.e. no parameter
//   names, no whitespace, and no type aliases (`uint256`, not `uint`)
const sel = selectorOf("transfer(address,uint256)");

// Wrap a struct with a function selector prefix
const transferLayout = selectorLayout("transfer(address,uint256)")({
  to:    paddedSlotLayout(addressItem),
  value: uint256Item,
});

// The ABI's bytes4 on its word: right-padded, unlike everything else on a slot
const tag = bytesNItem(4);

// Compute a Solidity mapping storage slot
const slot = mappingSlot(key, declarationSlot);

// Put every field of a struct on a slot of its own - the ABI's static parameter list
const paramsLayout = paddedFields({ to: addressItem, value: uint256Item, flag: boolItem() });
```

**Storage slots:** `mappingSlot(key, slot)` hashes `key . slot` for a value-type key, padded to the word the way Solidity pads its type, which the key's JS type names: a `bigint`/`number` is an integer (a negative one sign-extended), a `boolean` a bool, an `Address` an address — all right-aligned — and a `Uint8Array` a `bytesN`, left-aligned, so a full word is itself (chain the calls for nested mappings; `string`/`bytes` keys are hashed unpadded and are not covered). `keccakSlot(slot)` yields the first element's slot of a dynamic array.

**More items:** `abiBoolItem` is a bool on its word, `selectorItem(sig)` a selector as a fixed constant, and `addressConversion` the EIP-55 conversion `addressItem` (an `AddressItem`) carries. `paddedSlotLayout` makes a `PaddedSlotLayout<T>` of an item — for a signed one a `SignedSlotItem`, sign-extended onto the word — and `paddedFields` a `PaddedFields<S>`; `bytesNItem(N)` is a `BytesNItem<N>`, and a mapping key a `MappingKey`.

**Constants:** `wordSize` (32), `addressSize` (20), `selectorLength` (4).

## Hashing

Re-exports of the hashes the EVM runs on, from [@noble/hashes](https://github.com/paulmillr/noble-hashes):

```typescript
import { keccak256, sha3_256 } from "@onrail-xyz/evm";
```

`keccak256` is the pre-standardization padding Ethereum uses, not `sha3_256` — the two disagree on every input.
