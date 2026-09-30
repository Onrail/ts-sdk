//type-only assertion battery for amount items at an open kind — typechecked via
//  tsconfig.test.json, never executed (not picked up by the *.test.ts glob). A layout holding
//  one has to derive, or every kind-generic layout needs its DeriveType rebuilt by hand
import { serialize, deserialize, switchItem, type DeriveType } from "@onrail-xyz/binary-layout";
import type { Amount, KindWithAtomic } from "@onrail-xyz/amount";
import { amountItem } from "../src/index.js";

const addr = { binary: "bytes", size: 20 } as const;

const _struct = <K extends KindWithAtomic>(kind: K, amt: Amount<K>) => {
  const layout = { a: amountItem(8, kind), nested: { b: amountItem(8, kind), c: addr } } as const;
  const value: DeriveType<typeof layout> = { a: amt, nested: { b: amt, c: new Uint8Array(20) } };
  const back: { a: Amount<K>; nested: { b: Amount<K> } } =
    deserialize(layout, serialize(layout, value));
  return back;
};

const _switch = <K extends KindWithAtomic>(kind: K, amt: Amount<K>) => {
  const cmds = switchItem("name", { binary: "uint", size: 1 } as const, [
    [0x10, "transfer", { to: addr, value: amountItem(8, kind) }],
    [0x11, "pause",    {}],
  ]);
  const cmd: DeriveType<typeof cmds> = { name: "transfer", to: new Uint8Array(20), value: amt };
  const back = deserialize(cmds, serialize(cmds, cmd));
  const narrowed: Amount<K> | undefined = back.name === "transfer" ? back.value : undefined;
  return narrowed;
};

const _array = <K extends KindWithAtomic>(kind: K, amt: Amount<K>) => {
  const layout = { xs: { binary: "array", length: 2, layout: amountItem(8, kind) } } as const;
  const value: DeriveType<typeof layout> = { xs: [amt, amt] };
  return value;
};
