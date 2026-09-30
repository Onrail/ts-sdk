# Onrail TypeScript SDK

A collection of TypeScript utilities for building robust, type-safe blockchain applications. The monorepo provides foundational tools from low-level binary serialization to high-level Solana fork testing; the lower three (`utils`, `binary-layout`, `amount`) are chain-agnostic and serve any domain.

## Packages

| Package | Description |
|---------|-------------|
| [`@onrail-xyz/utils`](./packages/utils) | Dependency-free foundation: readonly/const data structures, branding, type manipulation, encoding, bigint JSON |
| [`@onrail-xyz/binary-layout`](./packages/binary-layout) | Declarative DSL for binary serialization/deserialization with strong typing |
| [`@onrail-xyz/amount`](./packages/amount) | Type-safe amounts with units and arbitrary-precision arithmetic |
| [`@onrail-xyz/common`](./packages/common) | Glue layer tying lower-level packages into practical building blocks |
| [`@onrail-xyz/evm`](./packages/evm) | Ethereum/EVM utilities: ERC20 client, Multicall3 queries, EIP-2612 permits, binary layouts |
| [`@onrail-xyz/svm`](./packages/svm) | Solana/SVM utilities and helpers |
| [`@onrail-xyz/fork-svm`](./packages/fork-svm) | Anvil-style local SVM fork with lazy account fetching for testing |

## Dependency Graph

```
utils ──┬── amount ─────────┬── common ──┬── evm
        └── binary-layout ──┘            └── svm ── fork-svm
```

## Documentation Map

The package READMEs are usage manuals, not feature summaries: start with the package table above, then treat that package's README as the canonical guide to its public API, invariants, edge cases, and composition patterns. They are intentionally complete enough for an agent to work from without guessing at unstated conventions.

Three design notes go below the public surface where the compiler behavior itself matters:

* [`packages/utils/RoUint8Array.md`](./packages/utils/RoUint8Array.md) explains how `RoUint8Array` retypes `Uint8Array`'s methods so that a readonly view stays readonly through every one of them.
* [`packages/amount/Amount.md`](./packages/amount/Amount.md) explains the distributive aliases, polymorphic `this`, helper functions, and other machinery behind kind-safe `Amount` and `Rate` APIs.
* [`DeclarationEmit.md`](./DeclarationEmit.md) explains how exported annotations and named type objects keep generated declarations compact and reusable.

Sections labeled **Future Direction** describe designed but unimplemented APIs; their status is stated at the section boundary so examples there are not mistaken for current exports.

## Package Summaries

### utils
The foundation layer, with no dependencies of its own — type-safe utilities for readonly and const data structures, plus the runtime primitives built on them:
- **Const Maps**: Type-safe lookups in any direction, projected from one hierarchical const table
- **Array/Object Utilities**: Const-preserving transformations (`mapTo`, `zip`, `pick`, `omit`, etc.)
- **Branding**: Hierarchical type branding with tag accumulation for nominal typing
- **Type Utilities**: `RoUint8Array`, deep readonly/mutable helpers, tuple types, aliasing
- **String**: Case conversion that preserves literal types (`uppercase`, `capitalize`, ...)
- **Piping**: Function composition (`pipe`), guarded assertions (`ensure`, `forbid`), predicates
- **Encoding**: hex, base64, UTF-8, bignum, byte arrays — on the `Uint8Array` builtins
- **JSON Codecs**: Round-trip serialization for types JSON cannot natively carry
- **Time**: Range-checked unix timestamp/`Date` conversion (`unixTime`, `checkedDate`)
- **Assertions**: Simple runtime checks (`assertEqual`, `assertDistinct`)

### binary-layout
A declarative DSL for binary data serialization/deserialization:
- **Pure TypeScript**: No code generation or meta-compilation required
- **Strong Typing**: `DeriveType` infers types from layout definitions
- **Composable**: Nested structures, arrays, switches (tagged unions)
- **Automatic Discrimination**: Generates efficient discriminators for layout sets
- **Custom Conversions**: Transform between binary and domain types
- **Manipulation**: Compose conversions and restructure layouts (`withCustom`, `pin`, `spreadLayout`, `unwrapSingleton`), switch endianness

### amount
Type-safe handling of amounts with units and arbitrary-precision arithmetic:
- **Rational**: Exact arithmetic via normalized fractions
- **Kind**: Define dimensions with multiple unit systems (ETH/Gwei/wei, USD/cents, etc.)
- **Unit Specs**: Unit definition helpers for creating custom kinds
- **Amount**: Values paired with kinds, with unit conversion and formatting
- **Rate**: Type-safe ratios between kinds (prices, exchange rates)
- **JSON Codecs**: `amountCodec`, `rateCodec`, `rationalCodec` for round-trip serialization

### common
Glue layer that ties the lower-level packages together:
- **Layout Items**: Binary-layout items that serialize to/from `Amount`/`Rate`, etc.
- **Units**: Predefined kinds for currencies (USD, USDT, USDC, BTC, ETH, SOL), percentages, duration, tenor, bytes
- **Optional-Kind Helpers**: `AmountOrAtomic` — APIs that return typed `Amount`s when given a kind and raw atomic `bigint`s otherwise

### evm
Ethereum/EVM utilities built on [viem](https://www.npmjs.com/package/viem):
- **Contract Specs**: `contractFromSpec` turns a declarative interface definition into call-data composers and result parsers
- **Layout Primitives**: Word-aligned binary layouts, function selectors, storage slot computation
- **Error & Event Parsing**: `buildParseError` / `buildParseEvent` decode revert data and logs against their signatures
- **Batched Queries**: Multicall3-based read batching with block-consistent results
- **ERC20 Client**: Compose approve, transfer, permit, and query call data
- **EIP-712 / EIP-2612 / EIP-3009**: Domain reconstruction, permit and transfer-authorization message composition
- **Hashing**: `keccak256` and `sha3_256` re-exports

### svm
Solana/SVM utilities built on `@solana/kit`:
- **Client Utilities**: Type-safe RPC wrappers with optional `Amount` integration, bound to one client and SOL kind by `bindClient`
- **PDA Derivation**: `findPda`, `findAta`, with type-safe seed handling
- **Binary Layouts**: Items for addresses, lamports, SPL accounts (mint, token, ALT)
- **Instruction Composition**: Type-safe instruction and transaction building, including ed25519 signature verification
- **Constants**: Standard program IDs, sysvar IDs, size and rent constants

### fork-svm
Anvil-style local SVM fork for Solana testing:
- **Lazy Forking**: Accounts fetched on-demand from mainnet/devnet
- **State Manipulation**: Modify accounts, clock, and balances
- **Snapshots**: Save/restore state; persist to disk for reproducible CI
- **RPC Adapter**: Seven-method, kit-compatible subset for existing RPC-based code
- **In-Process**: Fast, no separate validator process

## Requirements

ESM-only, TypeScript ≥ 7, Node ≥ 25 — one floor for the whole SDK; the Node floor is declared in every package's `engines` field.

The Node floor comes from encoding: `utils` rides the `Uint8Array` base16/base64 builtins, Baseline since 09/2025, and every other package sits downstream of it. TypeScript 7 is required; earlier versions are unsupported. Constraints beyond these belong to the package that has them; `fork-svm` documents its native-binary platform matrix beside its installation instructions.

## Installation

```bash
# Install individual packages as needed
pnpm add @onrail-xyz/utils
pnpm add @onrail-xyz/binary-layout
pnpm add @onrail-xyz/amount
# etc.
```

Packages use peer dependencies for internal cross-references, so install the required packages directly.

## Cross-Package Conventions

### Export Names

No package shadows an export of a package it builds on, since the two are in scope together in nearly every file that uses the dependent: where a platform package refines an upstream item, the refinement carries the platform's prefix (`evmAmountItem`, `evmTimestampItem`, `svmAmountItem`). Sibling packages do not coordinate — `evm` and `svm` both export `addressItem`, `addressConversion`, `addressSize` and `signatureSize` — and code that uses both aliases one side on import.

### Optional Arguments

A parameter whose type parameter decides the result — a kind that selects `Amount` over `bigint`, an opts record an item merges in — is declared as a rest, `...kind: OptionalArg<K>` (from `utils`), rather than as `kind?: K`. Both accept the same calls, but with `kind?: K` a passed `X | undefined` infers `K = X`: the `?` absorbs the `undefined`, and the result claims the `X` case even when `undefined` came in. `OptionalArg<K>` is `[K] | []`, where nothing absorbs it, so where `K` admits `undefined` the result is honestly the union (common's `fromAtomicIfKind(n, maybeKind)` is `Amount<K> | bigint`), and where it does not — an opts record — the call is rejected.

A wrapper forwarding such a parameter declares the same rest and passes it on whole (`...kind`), or, where it goes elsewhere than the callee's tail, through `argOf(kind)` (and `argOf(restOf(kinds))` for the one after it). Destructuring it, `...[kind]`, is for reading the value: destructured it types as `K | undefined`, so passing it on widens even a concrete kind to the union. Type arguments are inference's to supply: an explicit `f<X>()` with the argument left out is not checked against it.
