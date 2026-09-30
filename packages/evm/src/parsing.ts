import type { Hex } from "viem";
import type { RoArray, RoUint8Array } from "@onrail-xyz/utils";
import { bytes, hex, succeeds } from "@onrail-xyz/utils";
import type { DeriveType, SwitchItem } from "@onrail-xyz/binary-layout";
import { deserialize, findVariantByRawId } from "@onrail-xyz/binary-layout";
import { type SigVariants, selectorLength, sigSwitchItem, wordSize } from "./layouting.js";

const requireKnownSig = (item: SwitchItem, prefix: RoUint8Array, what: string): void => {
  if (!succeeds(() => findVariantByRawId(item, deserialize(item.id, prefix))))
    throw new Error(`unrecognized ${what}: ${hex.encode(prefix, true)}`);
};

//required minimum for both viem's Log and RpcLog
export type ViemLog = Readonly<{ topics: RoArray<Hex>; data: Hex }>;

const errorSwitchItem = sigSwitchItem(selectorLength, "error");
const eventSwitchItem = sigSwitchItem(wordSize,       "event");

//deliberate explicit result types to avoid issues arising from massive expansion by inference
export type ParsedError<V extends SigVariants> =
  DeriveType<ReturnType<typeof errorSwitchItem<V>>>;
export type ParsedEvent<V extends SigVariants> =
  DeriveType<ReturnType<typeof eventSwitchItem<V>>>;

export const buildParseError = <const V extends SigVariants>(errorDefs: V) => {
  const item = errorSwitchItem(errorDefs);
  return (revertData: RoUint8Array): ParsedError<V> => {
    requireKnownSig(item, revertData.subarray(0, selectorLength), "error selector");
    return deserialize(item, revertData);
  };
};

export const buildParseEvent = <const V extends SigVariants>(eventDefs: V) => {
  const item = eventSwitchItem(eventDefs);
  return (log: ViemLog): ParsedEvent<V> => {
    if (log.topics.length === 0)
      throw new Error("anonymous event: no topic0 to switch on");

    const encoded = bytes.concat(...log.topics.map(t => hex.decode(t)), hex.decode(log.data));
    requireKnownSig(item, encoded.subarray(0, wordSize), "event topic0");
    return deserialize(item, encoded);
  };
};
