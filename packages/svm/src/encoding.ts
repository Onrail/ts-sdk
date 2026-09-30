import { getBase58Encoder, getBase58Decoder } from "@solana/kit";
import type { RoUint8Array } from "@onrail-xyz/utils";

//kit's codecs name directions from the wire's side (encode: string -> bytes); these follow
//  utils' hex and base64 (encode: bytes -> string)
const toBytes  = getBase58Encoder();
const toString = getBase58Decoder();

//no Uint8Array builtin counterpart, unlike base16/base64
export const base58 = {
  //kit types the result read-only, but each call returns a fresh array
  decode: (input: string): Uint8Array =>
    toBytes.encode(input) as Uint8Array,

  encode: (input: RoUint8Array): string =>
    toString.decode(input as Uint8Array),
};
