# @onrail-xyz/svm

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/svm.svg)](https://www.npmjs.com/package/@onrail-xyz/svm)

Solana/SVM utilities built on [@solana/kit](https://www.npmjs.com/package/@solana/kit). Provides type-safe RPC helpers, PDA derivation, binary layouts for standard accounts, and instruction composition.

- [Client Utilities](#client-utilities) – RPC wrappers with optional `Amount` integration
- [PDA & Address Utilities](#pda--address-utilities) – PDA derivation, ATA lookup
- [Binary Layouts](#binary-layouts) – Layout items for Solana data structures
- [Instruction Composition](#instruction-composition) – Type-safe instruction building
- [Constants](#constants) – Program IDs, sysvar IDs, size constants
- [Ed25519 Program](#ed25519-program) – Signature verification instruction
- [Encoding](#encoding) – base58
- [Hashing](#hashing) – sha256

## Install

```bash
npm install @onrail-xyz/svm \
  @onrail-xyz/utils @onrail-xyz/binary-layout @onrail-xyz/common @onrail-xyz/amount \
  @noble/hashes @solana/kit
```

The `@onrail-xyz/*` packages, `@solana/kit`, and `@noble/hashes`, which backs the hash re-export, are peer dependencies — install them alongside `svm` (recent pnpm/npm auto-install peers; Yarn does not). Peering keeps a single shared `utils` (which anchors the SDK's branded types) and a single `@solana/kit` across the consuming app. `@noble/hashes` is accepted at `^1.8 || ^2`: the function used is the same in both majors, so an app that also carries viem's pinned copy needs no second one. It is here at all because kit hashes through WebCrypto, which is async, and PDA derivation stays synchronous. Node and TypeScript floors are [SDK-wide](https://github.com/Onrail/ts-sdk#requirements).

## Client Utilities

Thin wrappers around `@solana/kit` RPC methods with optional `Amount` kind integration for type-safe lamports/token amounts. The getters return `undefined` for an account that does not exist; RPC failures (and, for the layout-based getters, data that does not match the layout) reject. They take no commitment argument, i.e. they run at the node's default (`finalized`) — reach for `@solana/kit` directly when you need another commitment level.

```typescript
import { createSolanaRpc } from "@solana/kit";
import { Sol } from "@onrail-xyz/common";

const client = createSolanaRpc("https://api.mainnet-beta.solana.com");

// Basic account info (lamports as bigint by default)
const account = await getAccountInfo(client, address);

// With Amount kind - lamports become Amount<Sol>
const accountTyped = await getAccountInfo(client, address, Sol);
accountTyped?.lamports.in("SOL");  // Rational

// Batch fetching: one getMultipleAccounts request, so up to rpcMaxMultipleAccounts (100)
// addresses, all read at one slot - chunking a larger set is the caller's, since separate
// requests need not share a slot
const accounts = await getAccountInfo(client, [addr1, addr2, addr3]);

// Balances
const balance = await getBalance(client, address, Sol);  // Amount<Sol> | undefined

// SPL Token accounts - checks for program ownership (getDeserializedAccount is unchecked)
const mint = await getMint(client, mintAddress);
const tokenAcc = await getTokenAccount(client, ataAddress);

// With typed amounts
const typedMint = await getMint(client, mintAddress, MyTokenKind);
typedMint?.supply;  // Amount<MyTokenKind>
```

The rest follow suit: `getTokenBalance` reads a token account's amount alone, `getDurableNonceAccount` and `getAddressLookupTable` their accounts, and `sendTransaction` sends an already-encoded wire transaction. Lamports come back as a `LamportsType<KS>` (`Lamports`, or an `Amount` given a kind), an account as an `AccountInfo<KS>`, `getLatestBlockhash`'s reply as a `BlockHashInfo`; the transaction's stages are typed `TxMsg`, `TxMsgWithFeePayer`, `SignableTx` and `TxWithLifetime`.

### Bound Client

`bindClient(client, solKind?)` binds the client, and the SOL kind wherever one applies, into a `BoundClient` whose members are the functions above without those arguments. A kind that varies by account (a token's) or a layout is taken first, returning a getter that can be kept:

```typescript
const svm = bindClient(client, Sol);
await svm.getBalance(address);  // Amount<Sol> | undefined

const getTypedTokenAccount = svm.getTokenAccount(MyTokenKind);
await getTypedTokenAccount(ataAddress);

await svm.addLifetimeAndSendTx(txMessage, signers);
```

Its getters are `AccountGetter<T>`s, taking one address or an array like the free functions; `GetTokenAccount` and `GetDurableNonceAccount` name the two whose type depends on the SOL kind.

### Transaction Helpers

```typescript
// Get blockhash
const { blockhash, lastValidBlockHeight } = await getLatestBlockhash(client);

// Send with automatic lifetime
const signature = await addLifetimeAndSendTx(client, txMessage, signers);

// Or manually
const signature = await sendTx(client, txWithLifetime, signers);
```

Both return at RPC acceptance: confirmation, expiry and re-signing are the caller's. The manual route is how to keep the `lastValidBlockHeight` that `getLatestBlockhash` returns for that.

## PDA & Address Utilities

### PDA Derivation

```typescript
// Find PDA (returns address only)
const pda = findPda("my_seed", userAddress, programId);

// Find PDA with bump
const [pda, bump] = findPdaAndBump("my_seed", userAddress, programId);

// Calculate PDA with known bump (no search; the bump is still checked to land off-curve)
const pda = calcPda("my_seed", userAddress, bump, programId);
```

The first seed is type-checked to prevent accidentally passing an `Address` as a UTF-8 string:

```typescript
findPda(userAddress, programId);  // Type error! First seed can't be an Address
findPda("seed", userAddress, programId);  // OK - string seeds are UTF-8 encoded
findPda(new Uint8Array([...]), userAddress, programId);  // OK - raw bytes
```

A seed is a `Seed` (bytes or a string), and `RefuseAddress` is the check on the first. `isOffCurve(bytes)` tells whether 32 raw bytes lie off the ed25519 curve, as a PDA must.

### Associated Token Account

```typescript
const ata = findAta({ owner: walletAddress, mint: tokenMint });

// With Token-2022
const ata2022 = findAta({
  owner: walletAddress,
  mint: tokenMint,
  tokenProgram: token2022ProgramId,
});
```

### Anchor Discriminators

```typescript
discriminatorOf("instruction", "initialize");  // 8-byte discriminator
discriminatorOf("account", "MyAccount");
discriminatorOf("event", "MyEvent");
```

The first argument is a `DiscriminatorType`, and every discriminator is `discriminatorLength` (8) bytes. `anchorEmitCpiDiscriminator` is the prefix of an event Anchor's `emit_cpi!` sends through an instruction, the one Anchor discriminator stored byte-reversed.

### Rent Exemption

```typescript
const lamports = minimumBalanceForRentExemption(165);  // Lamports (bigint)
const amount = minimumBalanceForRentExemption(165, Sol);  // Amount<Sol>
```

A local formula over the standard rent parameters, unchanged since genesis: 3480 lamports per byte-year, exemption at two years' rent, 128 bytes of per-account overhead. A cluster configured otherwise wants the RPC's `getMinimumBalanceForRentExemption`.

## Binary Layouts

Layout items for Solana data structures, designed for use with `@onrail-xyz/binary-layout`.

### Basic Items

- `addressItem` – 32-byte base58 Address
- `lamportsItem` – u64 little-endian, optionally as Amount
- `svmAmountItem` – u64 little-endian for token amounts
- `u64Item` – raw u64 little-endian
- `bumpItem` – single byte
- `vecBytesItem` – length-prefixed bytes (u32 LE)
- `vecArrayItem` – length-prefixed array (u32 LE)
- `littleEndian` – set endianness on any layout
- `cEnumItem(names, size?)` – a C-style enum: the names numbered from 0, little-endian, one byte by default

`addressItem` is an `AddressItem` built on `addressConversion` (32 bytes ↔ base58 `Address`), and `lamportsItem(solKind?)` a `LamportsItem<KS>`, built on `lamportsConversion` (the raw count as kit's branded `Lamports`) when no kind is given.

### Account Layouts

Standard SPL account layouts with optional `Amount` kind support:

```typescript
import { deserialize } from "@onrail-xyz/binary-layout";

// Deserialize a mint account
const mint = deserialize(mintAccountLayout(), accountData);
// => { mintAuthority, supply, decimals, isInitialized, freezeAuthority }

// With typed supply
const typedMint = deserialize(mintAccountLayout(MyTokenKind), accountData);
typedMint.supply;  // Amount<MyTokenKind>
```

Available account layouts: `mintAccountLayout`, `tokenAccountLayout`, `durableNonceAccountLayout`, `addressLookupTableLayout`, plus `offchainMessageLayout` for [off-chain message signing](https://github.com/anza-xyz/solana-sdk/blob/master/offchain-message/src/lib.rs).

They derive `MintAccount<KT>`, `TokenAccount<KT, KS>`, `DurableNonceAccount<KS>` and `AddressLookupTable`; the account states are `initStates` and `tokenStates`, and an off-chain message's format is an `OffchainMessageFormat`.

`mintAccountLayout` and `tokenAccountLayout` cover the base 82- and 165-byte SPL structs, which Token-2022 shares. Token-2022 accounts that carry extensions are longer and deserializing them will fail on the trailing extension data.

### Discriminated Layouts (Anchor-style)

```typescript
// Automatically prepends the 8-byte Anchor discriminator
const myAccountLayout = accountLayout("MyAccount", {
  owner:   addressItem,
  balance: lamportsItem(Sol),
});

const myIxLayout = instructionLayout("initialize", {
  amount: svmAmountItem(MyTokenKind),
});
```

`eventLayout` completes the trio, for Anchor events.

### C-style Options

For SPL's `COption<T>` pattern:

```typescript
// COption<Pubkey> - common in SPL Token
const layout = { authority: cOptionAddressItem };
// authority derives Address | undefined
```

`cOptionItem(layout)` is `COption` itself: a 4-byte tag, and a body that keeps its space when absent, holding the value zero bytes decode to (so the layout must be of static size). `cOptionAddressItem` and `cOptionLamportsItem(solKind?)` are its SPL instances. `defaultOptionItem(layout, defaultValue, tagSize)` is the general form, for fixed-size options with another tag width or absent value – the address lookup table's bincode-encoded `authority` has a 1-byte tag. All of them are `DefaultOptionItem<L>`s.

## Instruction Composition

```typescript
import { AccountRole } from "@solana/kit";

// Build an instruction from a layout
const ix = composeIx(
  [
    [authority,       AccountRole.WRITABLE_SIGNER],
    [account,         AccountRole.WRITABLE       ],
    [systemProgramId, AccountRole.READONLY       ],
  ],
  myIxLayout,
  { amount: sol(0.1) },
  programId,
);

// Create ATA instruction
const ataIx = composeCreateAtaIx({
  payer: walletAddress,
  owner: walletAddress,
  mint: tokenMint,
});

// Build transaction message
const txMessage = feePayerTxFromIxs([ix1, ix2], feePayer);
```

An instruction is an `Ix`: kit's `Instruction` with every field present.

## Constants

All standard Solana program IDs, sysvar IDs, and size constants. Each group is also exported as an array, and `allAddresses` is all four:

- **Built-in programs** (`builtInProgramIds`): `systemProgramId`, `computeBudgetProgramId`, `bpfLoaderUpgradeableProgramId`, `addressLookupTableProgramId`, `ed25519SigVerifyProgramId`, `keccakSecp256k1ProgramId`, `secp256r1SigVerifyProgramId`, `zkTokenProofProgramId`, `zkElGamalProofProgramId`, `voteProgramId`, `stakeProgramId`, `configProgramId`, `nativeLoaderProgramId`, `bpfLoader1ProgramId`, `bpfLoader2ProgramId`, `loaderV4ProgramId`, `featureProgramId`
- **Sysvars** (`sysvarIds`): `clockSysvarId`, `rentSysvarId`, `instructionsSysvarId`, `epochScheduleSysvarId`, `feesSysvarId`, `recentBlockHashesSysvarId`, `rewardsSysvarId`, `slotHashesSysvarId`, `slotHistorySysvarId`, `stakeHistorySysvarId`, `epochRewardsSysvarId`, `lastRestartSlotSysvarId`
- **SPL programs** (`defaultProgramIds`): `tokenProgramId`, `token2022ProgramId`, `memoProgramId`, `memoV2ProgramId`, `associatedTokenProgramId`
- **Addresses** (`miscAddresses`): `incinerator`, `stakeConfig`, `nativeMint`, `nativeMint2022`; plus `zeroAddress`, the all-zero address (which is the system program's)
- **Sizes**: `addressSize` (32), `hashSize` (32), `signatureSize` (64), `maxTxSize` (1232), `minTxSize` (a one-instruction, one-signer legacy tx with no data), `maxUsableTxSize` (that tx's instruction-data budget, an optimistic bound for anything larger)
- **Rent**: `emptyAccountSize` (128, the per-account storage overhead), `lamportsPerByte` (6960n)

## Ed25519 Program

The Ed25519 signature verification program is notably absent from the official [solana-program](https://github.com/solana-program/) repositories, so we provide a TypeScript implementation here.

Compose Ed25519 signature verification instructions:

```typescript
// Verify a signature
const ix = composeEd25519VerifyIx({
  publicKey: pubkeyBytes,  // or Address, or reference to another ix
  signature: signatureBytes,
  message: messageBytes,
});

// Multiple verifications in one instruction
const ix = composeEd25519VerifyIx([
  { publicKey: pk1, signature: sig1, message: msg1 },
  { publicKey: pk2, signature: sig2, message: msg2 },
]);

// Reference data that already lives in another instruction of the same transaction instead
// of duplicating it (offsets are relative to that instruction's data)
const ix = composeEd25519VerifyIx({
  publicKey: { ixIndex: 0, offset: 12 },
  signature: sigBytes,
  message: { ixIndex: 0, offset: 77, size: 32 },
});
```

Data passed inline is appended once and shared across verifications, so repeating the same public key across entries costs no extra bytes. An entry is an `Ed25519VerifyParams`, and a message referenced in another instruction a `MessageReference`, which states its `size`.

## Encoding

```typescript
base58.decode("3yZe7d");            // => Uint8Array
base58.encode(arr);                 // => "3yZe7d"
```

base58 ships here rather than from `@onrail-xyz/utils` because it is the one encoding with no `Uint8Array` builtin behind it — it wraps kit's base58 codec, and Solana is the only chain that asks for it. The directions follow utils' `hex` and `base64` (`encode`: bytes → string), the reverse of kit's own codec naming.

## Hashing

Re-export of the hash Solana runs on, from [@noble/hashes](https://github.com/paulmillr/noble-hashes):

```typescript
import { sha256 } from "@onrail-xyz/svm";
```
