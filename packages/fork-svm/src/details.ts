//TODO drop the KitReadonlyUint8Array alias if kit fixes their type
import type { Address, Lamports,
              AccountInfoBase, Base64EncodedBytes,
              AccountInfoWithBase64EncodedData,
              ReadonlyUint8Array as KitReadonlyUint8Array } from "@solana/kit";
import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import type { RoUint8Array } from "@onrail-xyz/utils";
import { mapTo, base64 } from "@onrail-xyz/utils";
import { systemProgramId, builtInProgramIds, sysvarIds, defaultProgramIds } from "@onrail-xyz/svm";
import type { AccountInfo as SvmAccountInfo,
              RoAccountInfo as RoSvmAccountInfo } from "./liteSvm.js";

type KitAccountInfo = AccountInfoBase & AccountInfoWithBase64EncodedData;

export const emptyAccountInfo = {
  executable: false,
  owner:      systemProgramId,
  lamports:   0n as Lamports,
  space:      0n,
  data:       new Uint8Array(),
} as const satisfies RoSvmAccountInfo;

export const [builtInSet, sysvarSet, defProgSet] =
  mapTo([builtInProgramIds, sysvarIds, defaultProgramIds])(pids => new Set<Address>(pids));

const decompiledTransactionMessageDecoder = getCompiledTransactionMessageDecoder();
export const decodeCompiledTransactionMessage = (bytes: RoUint8Array) =>
  decompiledTransactionMessageDecoder.decode(bytes as KitReadonlyUint8Array);

const mapNonNull =
  <P, R>(f: (_: P) => R) =>
    (arg: P | null): R | null =>
      arg === null ? null : f(arg);

export const liteSvmAccountToKitAccount =
  mapNonNull((acc: RoSvmAccountInfo): KitAccountInfo => ({
    executable: acc.executable,
    lamports:   acc.lamports,
    owner:      acc.owner,
    data:       [base64.encode(acc.data) as Base64EncodedBytes, "base64"],
    space:      acc.space,
  }));

export const kitAccountToLiteSvmAccount =
  mapNonNull((acc: KitAccountInfo): SvmAccountInfo => ({
    executable: acc.executable,
    lamports:   acc.lamports,
    owner:      acc.owner,
    data:       base64.decode(acc.data[0]),
    space:      acc.space,
  }));
