import type { Address, PublicClient } from "viem";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import type { Query } from "../src/query.js";
import { createQuery } from "../src/query.js";

//viem's default mainnet transport (cloudflare-eth) frequently refuses requests
export const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://ethereum-rpc.publicnode.com"),
});

export const query: Query = createQuery(client);

export const liveTimeout = 30_000; //bound a slow/dead RPC instead of hanging CI indefinitely

//probe in a `before` hook rather than at module top level: a top-level await would defer
//  registration of every subsequent suite
export const probeNetwork = () =>
  fetch("https://cloudflare.com", { method: "HEAD", signal: AbortSignal.timeout(10_000) })
    .then(() => true)
    .catch(() => false);

export const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address; //USDC
//Circle's USDC treasury - reliably holds a non-zero balance
export const usdcTreasury = "0x55FE002aefF02F77364de339a1292923A15844B8" as Address;
