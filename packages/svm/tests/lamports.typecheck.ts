//type-only assertion battery for LamportsType — typechecked via tsconfig.test.json, never
//  executed (not picked up by the *.test.ts glob)
import type { Lamports } from "@solana/kit";
import type { Amount, KindWithAtomic } from "@onrail-xyz/amount";
import { Sol } from "@onrail-xyz/common";
import type { LamportsType } from "../src/index.js";
import { minimumBalanceForRentExemption } from "../src/index.js";

//a concrete kind keeps its own unit symbols, not just the meta ones
minimumBalanceForRentExemption(0, Sol).in("SOL");
const _lamports: Lamports = minimumBalanceForRentExemption(0);

//an open kind accepts the caller's Amount, where a conditional on K would accept nothing
const _open = <K extends KindWithAtomic>(amount: Amount<K>): LamportsType<K> => amount;
