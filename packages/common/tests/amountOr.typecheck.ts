//type-only assertion battery for AmountOr — typechecked via tsconfig.test.json, never executed
//  (not picked up by the *.test.ts glob)
import type { Amount, KindWithAtomic } from "@onrail-xyz/amount";
import type { AmountOrAtomic } from "../src/index.js";
import { fromAtomicIfKind, toAtomicIfAmount, Sol } from "../src/index.js";

//a concrete kind keeps its own unit symbols, not just the meta ones
fromAtomicIfKind(1n, Sol).in("SOL");
fromAtomicIfKind(1n, Sol).in("lamport");
const _amount: Amount<typeof Sol> = fromAtomicIfKind(1n, Sol);
const _atomic: bigint = fromAtomicIfKind(1n);

//an open kind accepts the caller's Amount, where a conditional on K would accept nothing
const _open = <K extends KindWithAtomic>(amount: Amount<K>): AmountOrAtomic<K> => amount;
const _openMaybe =
  <K extends KindWithAtomic | undefined>(amount: Amount<K & {}>): AmountOrAtomic<K> => amount;
toAtomicIfAmount(fromAtomicIfKind(1n, Sol));
