import { describe, it } from "node:test";
import type { Address, Lamports } from "@solana/kit";
import { createSolanaRpc } from "@solana/kit";
import type { DeriveType } from "@onrail-xyz/binary-layout";
import type { Amount } from "@onrail-xyz/amount";
import { Usdc, Sol } from "@onrail-xyz/common";
import type { TokenAccount } from "../src/index.js";
import { svmAmountItem, tokenAccountLayout, bindClient } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

type UsdcKind = typeof Usdc;
type SolKind  = typeof Sol;

//the kind parameters forward through every layer as OptionalArg, so a concrete kind stays exact
//  and one that may be absent yields the union the runtime returns
describe("kinds forwarded through svm", () => {
  it("svmAmountItem", () => {
    const given = svmAmountItem(Usdc), maybe = svmAmountItem(undefined as UsdcKind | undefined);
    pinEq<DeriveType<typeof given>, Amount<UsdcKind>>(true);
    pinEq<DeriveType<typeof maybe>, Amount<UsdcKind> | bigint>(true);
  });
  it("tokenAccountLayout takes two", () => {
    const both   = tokenAccountLayout(Usdc, Sol);
    const maybeS = tokenAccountLayout(Usdc, undefined as SolKind | undefined);
    pinEq<DeriveType<typeof both>["amount"], Amount<UsdcKind>>(true);
    pinEq<DeriveType<typeof maybeS>["amount"], Amount<UsdcKind>>(true);
    pinEq<DeriveType<typeof maybeS>["isNative"], Amount<SolKind> | Lamports | undefined>(true);
  });
  it("a bound client keeps a concrete token kind exact", () => {
    //never called: building the getters is all the pins need
    const client = bindClient(createSolanaRpc("http://localhost:8899"), Sol);
    const getter = client.getTokenAccount(Usdc);
    type Account = Awaited<ReturnType<typeof getter<Address>>>;
    pinEq<Account, TokenAccount<UsdcKind, SolKind> | undefined>(true);
    const maybeGetter = client.getTokenAccount(undefined as UsdcKind | undefined);
    type MaybeAccount = Awaited<ReturnType<typeof maybeGetter<Address>>>;
    pinEq<MaybeAccount, TokenAccount<UsdcKind | undefined, SolKind> | undefined>(true);
  });
});
