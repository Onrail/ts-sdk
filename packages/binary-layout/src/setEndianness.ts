import type { Get, Merge, If, Not } from "@onrail-xyz/utils";
import type { Endianness, Layout, Item, Struct, NumItem, BytesItem,
              ArrayItem, SwitchItem, SwitchVariant, PackedItem, CodecItem } from "./layout.js";
import { isByteLane, isBitGroup, type PackedWord } from "./size.js";
import { isItem, itemHasLayout, structKeys } from "./utils.js";

export function setEndianness<const L extends Layout, E extends Endianness>(
  layout: L,
  endianness: E,
): SetEndianness<L, E> {
  return internalSetEndianness(layout, endianness, false) as SetEndianness<L, E>;
}

//inPacked: a packed word's num fields are bit-ranges of it and own no byte order - but a
//  nested word does, and so does the standalone content of a bytes lane, so the walk carries
//  on into a packed layout with the rule swapped rather than stopping at it
function internalSetEndianness(layout: Layout, endianness: Endianness, inPacked: boolean): any {
  if (!isItem(layout)) {
    const result: Record<string, unknown> = {};
    for (const key of structKeys(layout))
      result[key] = internalSetEndianness(layout[key]!, endianness, inPacked);

    return result;
  }

  const item = layout as Item;
  switch (item.binary) {
    case "uint":
    case "int":
      //bit fields have no byte order, and inside a word neither do byte-sized ones
      return inPacked || (item as { bits?: number }).bits !== undefined
        ? item
        : { ...item, endianness };
    case "bytes": {
      //a sized bytes lane's content is (de)serialized standalone, so its sub-layout leaves the
      //  word; a size-less one inside a word is a bit group of it, and stays
      const layoutPatch = itemHasLayout(item)
        ? { layout: internalSetEndianness(item.layout, endianness, inPacked && isBitGroup(item)) }
        : {};
      const sizePatch = typeof (item as { size?: unknown }).size === "object"
        ? { size: internalSetEndianness((item as { size: Item }).size, endianness, false) }
        : {};
      return { ...item, ...layoutPatch, ...sizePatch };
    }
    case "array": {
      const lengthPatch = typeof item.length === "object"
        ? { length: internalSetEndianness(item.length as Item, endianness, false) }
        : {};
      return {
        ...item,
        layout: internalSetEndianness(item.layout, endianness, inPacked),
        ...lengthPatch,
      };
    }
    case "switch":
      return {
        ...item,
        id: internalSetEndianness(item.id, endianness, false),
        variants: item.variants.map(variant =>
          ({ ...variant, layout: internalSetEndianness(variant.layout, endianness, false) })
        ),
      };
    case "packed": {
      const layoutPatch = { layout: internalSetEndianness(item.layout, endianness, true) };
      //at the wire boundary a word has a byte order unless it is spelled as a lane; inside a
      //  word only a byte lane does - handing one to a bit range would make it a byte lane
      const hasByteOrder = inPacked
        ? isByteLane(item as PackedWord)
        : (item as { bits?: number }).bits === undefined;
      return hasByteOrder
        ? { ...item, ...layoutPatch, endianness }
        : { ...item, ...layoutPatch };
    }
    case "codec":
      return item;
  }
}

//All the "extras" in this type are to tell tsc about type invariants when writing functions
//  that accept layouts as const generic parameters, otherwise when running e.g. a generic type
//  like `const L extends Struct` through setEndianness, tsc will fail to realize that the
//  result is also guaranteed to be a Struct, which sucks for chaining.
//InPacked mirrors the runtime walk's parameter of the same name and is threaded by the
//  recursion; callers pass two arguments. It must stay a parameter of this exported type
//  rather than of a private alias: tsc looks through a trivial alias body and would then have
//  to expand the whole computation into every consumer's declaration emit (TS7056).
export type SetEndianness<
  L extends Layout,
  E extends Endianness,
  InPacked extends boolean = false,
> = Layout extends L ? Layout
  : Struct extends L ? Struct
  : Item   extends L ? Item
  : L extends infer LI extends Item
  ? SetItemEndianness<LI, E, InPacked> extends infer R extends Item
    ? R
    : never
  : L extends infer S extends Struct
  ? { readonly [K in keyof S]: SetEndianness<S[K], E, InPacked> } extends infer R extends Struct
    ? R
    : never
  : never;

type SetProperty<I, P extends string, V> =
  Merge<{ [K in P]: V }, I> extends infer M ? { readonly [K in keyof M]: M[K] } : never;

//mirrors isByteLane: a lane speaks of whole bytes by stating a size or claiming a byte order
type IsByteLane<I> =
  Get<I, "size"> extends number
  ? true
  : Get<I, "endianness"> extends Endianness ? true : false;

type HasBits<I> = Get<I, "bits"> extends number ? true : false;
type IsBitGroup<I> = Get<I, "size"> extends number ? false : true;

type SetItemEndianness<I extends Item, E extends Endianness, InPacked extends boolean> =
  I extends NumItem
  ? InPacked extends true
    ? I
    : Get<I, "bits"> extends number
      ? I
      : SetProperty<I, "endianness", E>
  : I extends BytesItem
  ? Get<I, "size"> extends infer P extends Item
    ? SetProperty<RecurseLayoutProperty<I, E, false>, "size", SetItemEndianness<P, E, false>>
    : RecurseLayoutProperty<I, E, If<InPacked, IsBitGroup<I>, false>>
  : I extends ArrayItem
  ? Get<I, "length"> extends infer P extends Item
    ? SetProperty<
        RecurseLayoutProperty<I, E, InPacked>,
        "length",
        SetItemEndianness<P, E, false>
      >
    : RecurseLayoutProperty<I, E, InPacked>
  : I extends SwitchItem
  ? SetProperty<
      SetProperty<I, "id", SetItemEndianness<I["id"], E, false>>,
      "variants",
      RecurseVariants<I["variants"], E>
    >
  : I extends PackedItem
  ? If<If<InPacked, IsByteLane<I>, Not<HasBits<I>>>,
      SetProperty<RecurseLayoutProperty<I, E, true>, "endianness", E>,
      RecurseLayoutProperty<I, E, true>
    >
  : I extends CodecItem
  ? I
  : never;

type RecurseLayoutProperty<I, E extends Endianness, InPacked extends boolean> =
  Get<I, "layout"> extends infer L extends Layout
  ? SetProperty<I, "layout", SetEndianness<L, E, InPacked>>
  : I;

type VariantBodySetEndianness<B, E extends Endianness> =
  B extends SwitchItem
  ? SetItemEndianness<B, E, false> extends infer R extends SwitchItem ? R : never
  : B extends Struct
  ? SetEndianness<B, E>
  : never;

type RecurseVariants<V, E extends Endianness> =
  { readonly [K in keyof V]:
      V[K] extends infer VI extends SwitchVariant
      ? SetProperty<VI, "layout", VariantBodySetEndianness<VI["layout"], E>>
      : V[K]
  };
