//OptionalArg keeps a passed undefined in the kind parameter without exactOptionalPropertyTypes
//  too, where an optional tuple element (`[kind?: K]`) would add the undefined back
import type { DeriveType } from "@onrail-xyz/binary-layout";
import type { Amount } from "@onrail-xyz/amount";
import { fromAtomicIfKind, amountItem, Usdc } from "../../src/index.js";
import { pinEq } from "../typeAssert.js";

type UsdcKind = typeof Usdc;
declare const maybeKind: UsdcKind | undefined;
const passed = fromAtomicIfKind(1n, maybeKind);
pinEq<typeof passed, Amount<UsdcKind> | bigint>(true);
const item = amountItem(8, maybeKind);
pinEq<DeriveType<typeof item>, Amount<UsdcKind> | bigint>(true);
