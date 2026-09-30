//see https://github.com/solana-foundation/solana-web3.js/blob/maintenance/v1.x/src/programs/ed25519.ts

import type { Address } from "@solana/kit";
import type { RoUint8Array, MaybeArray } from "@onrail-xyz/utils";
import { isUint8Array, bytes } from "@onrail-xyz/utils";
import { serialize, calcStaticSize } from "@onrail-xyz/binary-layout";
import { base58 } from "./encoding.js";
import { ed25519SigVerifyProgramId,
         addressSize, maxUsableTxSize, signatureSize } from "./constants.js";
import type { Ix } from "./utils.js";

export type Reference = Readonly<{ ixIndex: number; offset: number }>;
export type MessageReference = Reference & { readonly size: number };
export type Ed25519VerifyParams = {
  publicKey: RoUint8Array | Reference | Address;
  message:   RoUint8Array | MessageReference;
  signature: RoUint8Array | Reference;
};

export function composeEd25519VerifyIx(params: MaybeArray<Ed25519VerifyParams>): Ix {
  const verifications = Array.isArray(params) ? params : [params];
  if (verifications.length === 0)
    throw new Error("At least one signature verification required");

  const headerSize = offsetsArrayLayout.length.size + verifications.length * offsetsSize;

  let currentOffset = headerSize;
  const appendData: RoUint8Array[] = [];
  const resolveLocation = (
    data: Address | RoUint8Array | Reference,
    fixedSize?: number
  ): { index: number, offset: number, size: number } => {
    if (typeof data === "string")
      data = base58.decode(data);

    if (isUint8Array(data)) {
      const size = data.length;
      if (fixedSize !== undefined && size !== fixedSize)
        throw new Error(`Expected data size ${fixedSize}, got ${size}`);

      //duplication check
      let existingOffset = headerSize;
      for (const existing of appendData) {
        if (bytes.equals(existing as Uint8Array, data))
          return { index: ownIxIndex, offset: existingOffset, size };

        existingOffset += existing.length;
      }

      const index = ownIxIndex;
      const offset = currentOffset;

      appendData.push(data);
      currentOffset += size;

      return { index, offset, size };
    }
    const ref = data as Reference;
    const size = (ref as MessageReference).size ?? fixedSize;

    return {
      index: ref.ixIndex,
      offset: ref.offset,
      size,
    };
  };

  //1. resolve locations and build up appendData with deduplication
  const offsets = verifications.map(({ publicKey, message, signature }) => {
    const  pkLoc = resolveLocation(publicKey, addressSize);
    const sigLoc = resolveLocation(signature, signatureSize);
    const msgLoc = resolveLocation(message);

    if (currentOffset > maxUsableTxSize)
      throw new Error("Ed25519 program instruction would exceed tx max size");
    return {
      signatureOffset:           sigLoc.offset,
      signatureInstructionIndex: sigLoc.index,
      publicKeyOffset:           pkLoc.offset,
      publicKeyInstructionIndex: pkLoc.index,
      messageDataOffset:         msgLoc.offset,
      messageDataSize:           msgLoc.size,
      messageInstructionIndex:   msgLoc.index,
    };
  });

  //2. write everything to a single buffer
  const ixData = new Uint8Array(currentOffset);
  serialize(offsetsArrayLayout, offsets, ixData);

  let writeOffset = headerSize;
  for (const data of appendData) {
    ixData.set(data, writeOffset);
    writeOffset += data.length;
  }

  return {
    programAddress: ed25519SigVerifyProgramId,
    accounts: [],
    data: ixData,
  };
}

const ownIxIndex = 0xffff; //magic value for index of own instruction

const u16Item = { binary: "uint", size: 2, endianness: "little" } as const;

const offsetsLayout = {
  signatureOffset:           u16Item,
  signatureInstructionIndex: u16Item,
  publicKeyOffset:           u16Item,
  publicKeyInstructionIndex: u16Item,
  messageDataOffset:         u16Item,
  messageDataSize:           u16Item,
  messageInstructionIndex:   u16Item,
} as const;

const offsetsSize = calcStaticSize(offsetsLayout)!;

const offsetsArrayLayout = {
  binary: "array",
  length: u16Item,
  layout: offsetsLayout,
} as const;
