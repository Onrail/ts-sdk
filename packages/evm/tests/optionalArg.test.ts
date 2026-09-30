import { describe, it } from "node:test";
import type { RoUint8Array } from "@onrail-xyz/utils";
import type { DeriveType } from "@onrail-xyz/binary-layout";
import type { Amount } from "@onrail-xyz/amount";
import { Usdc } from "@onrail-xyz/common";
import { abiEncodedBytesItem, amountParam } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

type UsdcKind = typeof Usdc;
const uint8 = { binary: "uint", size: 1 } as const;

describe("options and kinds that may be absent", () => {
  //regression: `{ layout: maybeLayout }` inferred the layout without its undefined wherever `?`
  //  re-added it, and the payload claimed the layout's type while arriving as raw bytes
  it("abiEncodedBytesItem types either payload", () => {
    const maybe = abiEncodedBytesItem({ layout: undefined as typeof uint8 | undefined });
    const given = abiEncodedBytesItem({ layout: uint8 }), raw = abiEncodedBytesItem();
    pinEq<DeriveType<typeof maybe>, number | RoUint8Array>(true);
    pinEq<DeriveType<typeof given>, number>(true);
    pinEq<DeriveType<typeof raw>,   RoUint8Array>(true);
    const declared = abiEncodedBytesItem({} as { layout?: typeof uint8 });
    pinEq<DeriveType<typeof declared>, number | RoUint8Array>(true);
  });
  it("amountParam types the union the kind may yield", () => {
    const maybe = amountParam("v", "uint256", undefined as UsdcKind | undefined);
    const given = amountParam("v", "uint256", Usdc);
    pinEq<DeriveType<typeof maybe.item>, Amount<UsdcKind> | bigint>(true);
    pinEq<DeriveType<typeof given.item>, Amount<UsdcKind>>(true);
  });
});
