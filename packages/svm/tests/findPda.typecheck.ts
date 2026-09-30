//type-only assertion battery for the first-seed Address guard — typechecked via
//  tsconfig.test.json, never executed (not picked up by the *.test.ts glob)
import type { Address } from "@solana/kit";
import { findPda, findPdaAndBump, calcPda } from "../src/index.js";

const address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const stringOrAddress = "" as string | Address;

//an Address as the first seed would silently be utf8-encoded rather than base58-decoded
//@ts-expect-error
findPda(address, address);
//@ts-expect-error
findPdaAndBump(address, address);
//@ts-expect-error
calcPda(address, 255, address);
//a union that *might* be an Address is just as unsafe
//@ts-expect-error
findPda(stringOrAddress, address);

//plain strings and raw bytes are fine, and Addresses are fine in any later seed position
findPda("seed", address);
findPda(new Uint8Array(0), address, address);
findPda("seed", new Uint8Array(4), address, address);
findPdaAndBump("seed", address);
calcPda("seed", address, 255, address);
