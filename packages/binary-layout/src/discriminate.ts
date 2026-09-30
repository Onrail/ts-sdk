import type { RoUint8Array, RoPair, RoArray, RoTuple, If } from "@onrail-xyz/utils";
import type { Layout, Item, Count, PrefixItem, DeriveType } from "./layout.js";
import { bitsPerByte } from "./layout.js";
import { serializeNum } from "./numbers.js";
import { deserialize } from "./deserialize.js";
import { getCachedFixedBytes, internalSerialize } from "./serialize.js";
import { internalCalcSize, calcStaticSize, packedByteSize } from "./size.js";
import { isItem, structKeys, hasFixed,
         customOf, fixedOf, isRangeId, itemHasLayout } from "./utils.js";

type LayoutIndex = number;

export type Discriminator<B extends boolean = false> =
  (encoded: RoUint8Array) => If<B, RoArray<LayoutIndex>, LayoutIndex | null>;

export function buildDiscriminator<B extends boolean = false>(
  layouts:         RoArray<Layout>,
  allowAmbiguous?: B
): Discriminator<B> {
  const [distinguishable, discriminator] = internalBuildDiscriminator(layouts);
  if (!distinguishable && !allowAmbiguous)
    throw new Error("Cannot uniquely distinguish the given layouts");

  return (
    !allowAmbiguous
    ? (encoded: RoUint8Array) => {
      const layout = discriminator(encoded);
      return layout.length === 0 ? null : layout[0];
    }
    : discriminator
  ) as Discriminator<B>;
}

export type Deserialized<L extends RoArray<Layout>> =
  L extends RoTuple<Layout>
  ? { [I in keyof L]:
        RoPair<I extends `${infer N extends number}` ? N : never, DeriveType<L[I]>>
    }[number]
  : RoPair<number, DeriveType<L[number]>>;

export type Deserializer<L extends RoArray<Layout>, B extends boolean = false> =
  (encoded: RoUint8Array) => If<B, RoArray<Deserialized<L>>, Deserialized<L> | null>;

//One-step discriminate-and-deserialize: candidates are tried in index order and the first
//  successful parse wins. Deserialization is the ground truth that discrimination
//  approximates, so false positives are weeded out and even layout sets that no strategy can
//  uniquely distinguish are legal - overlaps resolve like switch variants: first match wins.
//`allMatches` flips the posture for data whose identity is the very question - where
//  committing to the first fit would be false confidence: every candidate is tried and all
//  successful parses are returned.
export function buildDeserializer<const L extends RoArray<Layout>, B extends boolean = false>(
  layouts:     L,
  allMatches?: B,
): Deserializer<L, B> {
  const [, discriminator] = internalBuildDiscriminator(layouts);
  return (encoded => {
    const matches: Deserialized<L>[] = [];
    for (const candidate of discriminator(encoded))
      try {
        const match =
          [candidate, deserialize(layouts[candidate]!, encoded)] as unknown as Deserialized<L>;
        if (!allMatches)
          return match;

        matches.push(match);
      }
      catch {}

    return allMatches ? matches : null;
  }) as Deserializer<L, B>;
}

// --- implementation ---

type Uint       = number;
type Bitset     = bigint;
type Size       = Uint;
type BytePos    = Uint;
type ByteVal    = Uint; //actually a uint8
type Candidates = Bitset;
type FixedBytes = RoPair<BytePos, RoUint8Array>[];
type Bounds     = [Size, Size];

function arrayToBitset(arr: RoArray<number>): Bitset {
  return arr.reduce((bit, i) => bit | BigInt(1) << BigInt(i), BigInt(0));
}

function bitsetToArray(bitset: Bitset): number[] {
  const ret: number[] = [];
  for (let i = 0n; bitset > 0n; bitset >>= 1n, ++i)
    if (bitset & 1n)
      ret.push(Number(i));

  return ret;
}

function count(candidates: Candidates) {
  let count = 0;
  for (; candidates > 0n; candidates >>= 1n)
    count += Number(candidates & 1n);
  return count;
}

//the maximum count a uint prefix of the given byte size can encode
const uintPrefixMax = (size: number) => 2 ** (bitsPerByte * size) - 1;

//returns the encoded byte width bounds of a prefix, plus its wire bytes when the count is
//  known (a known count pins the exact encoding of any prefix item)
function prefixMeta(
  prefix:     Count | undefined,
  knownCount: number | null,
): { bounds: Bounds, fixed?: Uint8Array, countMax: number } {
  if (prefix === undefined || typeof prefix === "number")
    return { bounds: [0, 0], countMax: Infinity };

  //only a conversion-free uint prefix has a knowable maximum count
  const countMax = prefix.binary === "uint" && customOf(prefix as Item) === undefined
    ? uintPrefixMax((prefix as { size: number }).size)
    : Infinity;

  if (knownCount !== null) {
    const width = internalCalcSize(prefix as Layout, knownCount);
    const cursor = { bytes: new Uint8Array(width), offset: 0 };
    internalSerialize(prefix as Layout, knownCount, cursor, undefined);
    return { bounds: [width, width], fixed: cursor.bytes, countMax };
  }

  return { bounds: createLayoutMeta(prefix as Layout, null, []), countMax };
}

//a fixed item's wire is its constant content behind an optional prefix, whose count the
//  constant settles - so both are fixed bytes wherever the offset is known
function fixedItemMeta(
  item:       Item,
  prefix:     PrefixItem | undefined,
  count:      number,
  offset:     BytePos | null,
  fixedBytes: FixedBytes,
): Bounds {
  const content = getCachedFixedBytes(item);
  const pm = prefixMeta(prefix, count);
  if (offset !== null) {
    if (pm.fixed !== undefined)
      fixedBytes.push([offset, pm.fixed]);

    fixedBytes.push([offset + pm.bounds[0], content]);
  }
  return [pm.bounds[0] + content.length, pm.bounds[1] + content.length];
}

function layoutItemMeta(
  item:       Item,
  offset:     BytePos | null,
  fixedBytes: FixedBytes,
): Bounds {
  switch (item.binary) {
    case "int":
    case "uint": {
      const size = (item as { size?: number }).size;
      if (size === undefined)
        throw new Error(`num items with bit width are only legal inside packed layouts`);

      if (hasFixed(item) && offset !== null)
        fixedBytes.push([offset, getCachedFixedBytes(item)]);

      return [size, size];
    }
    case "bytes": {
      const sizeProp = item.size;
      const prefix = typeof sizeProp === "object" ? sizeProp : undefined;

      if (hasFixed(item))
        return fixedItemMeta(item, prefix, getCachedFixedBytes(item).length, offset, fixedBytes);

      //content of a static size gives a prefix a known count, and hence fixed wire bytes
      const staticContent = prefix !== undefined && itemHasLayout(item)
        ? calcStaticSize(item.layout)
        : null;
      const pm = prefixMeta(prefix, staticContent);
      if (pm.fixed !== undefined && offset !== null)
        fixedBytes.push([offset, pm.fixed]);

      //a manually sized item has a known content width regardless of its content
      const manualSize = typeof sizeProp === "number" ? sizeProp : undefined;

      if (itemHasLayout(item)) {
        //fixed sub-items serialize their constants no matter what conversion sits on top,
        //  so recursing for fixed bytes is sound even for custom items - but only when the
        //  content offset is predictable (i.e. no variable-width prefix)
        const contentOffset =
          offset !== null && pm.bounds[0] === pm.bounds[1] ? offset + pm.bounds[0] : null;
        const lm = createLayoutMeta(item.layout, contentOffset, fixedBytes);
        return manualSize !== undefined
          ? [pm.bounds[0] + manualSize, pm.bounds[1] + manualSize]
          : [pm.bounds[0] + lm[0], pm.bounds[1] + lm[1]];
      }

      if (manualSize !== undefined)
        return [manualSize, manualSize];

      if (prefix === undefined)
        return [0, Infinity]; //flex bytes consume the remainder

      //upper bound must include the prefix itself, lest we understate it and thus wrongly
      //  conclude that two layouts have disjoint size ranges
      return [pm.bounds[0], pm.bounds[1] + pm.countMax];
    }
    case "array": {
      const { length } = item;
      if (hasFixed(item)) {
        const prefix = typeof length === "object" ? length : undefined;
        const count = (fixedOf(item) as RoArray<unknown>).length;
        return fixedItemMeta(item, prefix, count, offset, fixedBytes);
      }

      if (typeof length === "number") {
        const localFixedBytes: FixedBytes = [];
        const elemSize = createLayoutMeta(item.layout, 0, localFixedBytes);
        if (offset !== null) {
          if (elemSize[0] !== elemSize[1]) {
            //if the element size is not fixed we can only add the fixed bytes of the first
            if (length > 0)
              for (const [o, s] of localFixedBytes)
                fixedBytes.push([offset + o, s]);
          }
          else
            for (let i = 0; i < length; ++i)
              for (const [o, s] of localFixedBytes)
                fixedBytes.push([offset + o + i * elemSize[0], s]);
        }

        return length === 0
          ? [0, 0] //avoids 0 * Infinity = NaN for a zero-length array of boundless items
          : [length * elemSize[0], length * elemSize[1]];
      }

      if (length === undefined) //flex array
        return [0, Infinity];

      const pm = prefixMeta(length, null);
      const elementUpper = createLayoutMeta(item.layout, null, [])[1];
      //upper bound must account for the prefix and the elements, lest we understate it
      return [pm.bounds[0], pm.bounds[1] + pm.countMax * elementUpper];
    }
    case "switch": {
      if (hasFixed(item))
        return fixedItemMeta(item, undefined, 0, offset, fixedBytes);

      const caseFixedBytes: FixedBytes[] = item.variants.map(_ => []);
      const { id } = item;
      const caseBounds = item.variants.map((variant, caseIndex) => {
        let idBounds: Bounds;
        if (!isRangeId(variant.id)) {
          if (id.binary !== "codec") {
            if (offset !== null) {
              const cursor = { bytes: new Uint8Array(id.size), offset: 0 };
              serializeNum(variant.id, id.size, cursor, id.endianness, id.binary === "int");
              caseFixedBytes[caseIndex]!.push([0, cursor.bytes]);
            }
            idBounds = [id.size, id.size];
          }
          else {
            const idSize = id.sizeOf(variant.id as number);
            if (offset !== null) {
              const bytes = new Uint8Array(idSize);
              const end = id.write(variant.id as number, bytes, 0);
              caseFixedBytes[caseIndex]!.push([0, bytes.subarray(0, end)]);
            }
            idBounds = [idSize, idSize];
          }
        }
        else
          idBounds = id.binary !== "codec"
            ? [id.size, id.size]
            : [id.minSize ?? 0, id.maxSize ?? Infinity];

        const fixedIdWidth = idBounds[0] === idBounds[1];
        const ret = createLayoutMeta(
          variant.layout,
          offset !== null && fixedIdWidth ? idBounds[0] : null,
          caseFixedBytes[caseIndex]!
        );
        return [ret[0] + idBounds[0], ret[1] + idBounds[1]] as Bounds;
      });

      if (offset !== null && caseFixedBytes.every(fbs => fbs.length > 0))
        //find fixed bytes that have the same value across all cases
        //  (it's a lambda to enable early return from inner loops)
        (() => {
          //constrain search to the minimum length of all cases
          const minLen = Math.min(
            ...caseFixedBytes.map(fbs => fbs.at(-1)![0] + fbs.at(-1)![1].length)
          );
          //keep track of the current index in each case's fixed bytes array
          const itIndexes = caseFixedBytes.map(_ => 0);

          for (let bytePos = 0; bytePos < minLen;) {
            let byteVal: number | null = null;
            let caseIndex = 0;
            while (caseIndex < caseFixedBytes.length) {
              let curItIndex = itIndexes[caseIndex]!;
              const curFixedBytes = caseFixedBytes[caseIndex]!;
              let [curOffset, curSerialized] = curFixedBytes[curItIndex]!;
              //advance this case's cursor past every fixed-byte run that ends before bytePos
              while (curOffset + curSerialized.length <= bytePos) {
                ++curItIndex;

                if (curItIndex === curFixedBytes.length)
                  return; //we have exhausted all fixed bytes in at least one case

                itIndexes[caseIndex] = curItIndex;
                [curOffset, curSerialized] = curFixedBytes[curItIndex]!;
              }

              if (curOffset > bytePos) {
                //we landed in a gap for this case -> move to the next possible position
                bytePos = curOffset;
                break;
              }

              const curByteVal = curSerialized[bytePos - curOffset]!;
              if (byteVal === null)
                byteVal = curByteVal;

              if (curByteVal !== byteVal) {
                ++bytePos;
                break;
              }

              ++caseIndex;
            }

            //only if we made it through all cases without breaking do we have a common fixed
            //  byte and hence add it to the list of fixed bytes
            if (caseIndex === caseFixedBytes.length) {
              fixedBytes.push([offset + bytePos, new Uint8Array([byteVal!])]);
              ++bytePos;
            }
          }
        })();

      return [
        Math.min(...caseBounds.map(([lower]) => lower)),
        Math.max(...caseBounds.map(([_, upper]) => upper))
      ] as Bounds;
    }
    case "packed": {
      const size = packedByteSize(item);
      if (hasFixed(item) && offset !== null)
        fixedBytes.push([offset, getCachedFixedBytes(item)]);

      return [size, size];
    }
    case "codec": {
      if (hasFixed(item)) {
        const content = getCachedFixedBytes(item);
        if (offset !== null)
          fixedBytes.push([offset, content]);

        return [content.length, content.length];
      }

      return [item.minSize ?? 0, item.maxSize ?? Infinity];
    }
  }
}

function createLayoutMeta(
  layout:     Layout,
  offset:     BytePos | null,
  fixedBytes: FixedBytes
): Bounds {
  if (isItem(layout))
    return layoutItemMeta(layout as Item, offset, fixedBytes);

  const bounds: Bounds = [0, 0];
  for (const key of structKeys(layout)) {
    const itemSize = createLayoutMeta(layout[key]!, offset, fixedBytes);
    bounds[0] += itemSize[0];
    bounds[1] += itemSize[1];
    //if the bounds don't agree then we can't reliably predict the offset of subsequent items
    if (offset !== null)
      offset = itemSize[0] === itemSize[1] ? offset + itemSize[0] : null;
  }
  return bounds;
}

function buildAscendingBounds(sortedBounds: RoArray<RoPair<Bounds, LayoutIndex>>) {
  const ascendingBounds = new Map<Size, Candidates>();
  //sortedCandidates tracks all layouts that have a size bound that contains the size that's
  //  currently under consideration, sorted in ascending order of their respective upper bounds
  let sortedCandidates: RoPair<Size, LayoutIndex>[] = [];
  const closeCandidatesBefore = (before: number) => {
    while (sortedCandidates.length > 0 && sortedCandidates[0]![0] < before) {
      const end = sortedCandidates[0]![0] + 1;
      //remove all candidates that end at the same position
      const removeIndex = sortedCandidates.findIndex(([upper]) => end <= upper);
      if (removeIndex === -1)
        sortedCandidates = [];
      else
        sortedCandidates.splice(0, removeIndex);
      //introduce a new bound that captures all candidates that can have a size of at least `end`
      ascendingBounds.set(end, arrayToBitset(sortedCandidates.map(([, j]) => j)));
    }
  };

  for (const [[lower, upper], i] of sortedBounds) {
    closeCandidatesBefore(lower);
    const insertIndex = sortedCandidates.findIndex(([u]) => u > upper);
    if (insertIndex === -1)
      sortedCandidates.push([upper, i]);
    else
      sortedCandidates.splice(insertIndex, 0, [upper, i]);

    ascendingBounds.set(lower, arrayToBitset(sortedCandidates.map(([, j]) => j)));
  }
  closeCandidatesBefore(Infinity);

  return ascendingBounds;
}

//Generates a greedy divide-and-conquer strategy to determine the layout (or set of layouts)
//  that a given serialized byte array might conform to.
//It leverages size bounds and known fixed bytes of layouts to quickly eliminate candidates, by
//  (greedily) choosing the discriminator (byte or size) that eliminates the most candidates at
//  each step.
//Power is a relative measure of the strength of a discriminator given a set of layout
//  candidates. It's in [0, candidate.length - 1] and states how many layouts of that set can
//  _at least_ be eliminated when applying that discriminator.
//Layout sizes are only tracked in terms of lower and upper bounds, so the algorithm is "lossy"
//  in the sense that it does not use all information that is theoretically available - see the
//  v1 implementation notes for the tradeoff discussion.
function internalBuildDiscriminator(
  layouts: RoArray<Layout>
): [boolean, (encoded: RoUint8Array) => RoArray<LayoutIndex>] {
  if (layouts.length === 0)
    throw new Error("Cannot discriminate empty set of layouts");

  const emptySet = 0n;
  const allLayouts = (1n << BigInt(layouts.length)) - 1n;

  const fixedKnown = layouts.map((): FixedBytes => []);
  const sizeBounds = layouts.map((l, i) => createLayoutMeta(l, 0, fixedKnown[i]!));
  const sortedBounds = sizeBounds.map((b, i) => [b, i] as const).sort(([[l1]], [[l2]]) => l1 - l2);

  const mustHaveByteAt = (() => {
    let remaining = allLayouts;
    const ret = new Map<Size, Candidates>();
    for (const [[lower], i] of sortedBounds) {
      remaining ^= 1n << BigInt(i); //delete the i-th bit
      ret.set(lower, remaining);
    }
    return ret;
  })();
  const ascendingBounds = buildAscendingBounds(sortedBounds);
  const sizePower = layouts.length - Math.max(
    ...[...ascendingBounds.values()].map(candidates => count(candidates))
  );
  //we don't check sizePower here and bail early if it is perfect because we prefer perfect
  //  byte discriminators over perfect size discriminators due to their faster lookup times
  //  and more predictable / lower complexity branching behavior
  const layoutsWithByteAt = (bytePos: BytePos) => {
    let ret = allLayouts;
    for (const [lower, candidates] of mustHaveByteAt) {
      if (bytePos < lower)
        break;

      ret = candidates;
    }
    return ret;
  };

  const layoutsWithSize = (size: Size) => {
    let ret = emptySet;
    for (const [lower, candidates] of ascendingBounds) {
      if (size < lower)
        break;

      ret = candidates;
    }
    return ret;
  };

  const fixedKnownBytes: RoArray<RoPair<ByteVal, LayoutIndex>[]> = Array.from({length:
    Math.max(...fixedKnown.map(fkb => fkb.length > 0 ? fkb.at(-1)![0] + fkb.at(-1)![1].length : 0))
  }).map(() => []);

  for (let i = 0; i < fixedKnown.length; ++i)
    for (const [offset, serialized] of fixedKnown[i]!)
      for (let j = 0; j < serialized.length; ++j)
        fixedKnownBytes[offset + j]!.push([serialized[j]!, i]);

  const bestBytes:
    [number, BytePos, Candidates, Map<ByteVal, Candidates>, Candidates, Candidates][] = [];
  for (const [bytePos, fixedKnownByte] of fixedKnownBytes.entries()) {
    //the number of layouts with a given size is an upper bound on the discriminatory power of
    //  a byte at a given position: If the encoded data is too short we can automatically
    //  exclude all layouts whose minimum size is larger than it, nevermind those who expect
    //  a known, fixed value at this position.
    const lwba = layoutsWithByteAt(bytePos);
    const anyValueLayouts = lwba ^ arrayToBitset(fixedKnownByte.map(([, layoutIdx]) => layoutIdx));
    //layouts *not guaranteed* to reach bytePos (lower size bound <= bytePos) - i.e. they might
    //  be too short, or might not. Which of them actually are too short for a given encoding
    //  can only be decided at runtime from its length, not statically here.
    const maybeTooShortLayouts = allLayouts ^ lwba;
    //the subset of those whose upper bound can't reach bytePos either - the only ones that the
    //  mere existence of a byte at this position eliminates, regardless of the encoding's length
    const tooShortLayouts = arrayToBitset(
      bitsetToArray(maybeTooShortLayouts).filter(i => sizeBounds[i]![1] <= bytePos)
    );
    const distinctValues = new Map<BytePos, Candidates>();
    //the following equation holds (after applying .length to each component):
    //layouts = maybeTooShortLayouts + anyValueLayouts + fixedKnownByte
    for (const [byteVal, candidate] of fixedKnownByte) {
      if (!distinctValues.has(byteVal))
        distinctValues.set(byteVal, emptySet);

      distinctValues.set(byteVal, distinctValues.get(byteVal)! | 1n << BigInt(candidate));
    }

    //a byte position with no fixed value in any layout carries no byte-discrimination power.
    //  otherwise, the weakest case is an encoding that's too short to reach bytePos, which only
    //  eliminates the layouts that are guaranteed to have a byte there
    let power = distinctValues.size > 0 ? layouts.length - count(maybeTooShortLayouts) : 0;
    for (const layoutsWithValue of distinctValues.values()) {
      //if we find the byte value associated with this set of layouts, we can eliminate all
      //  other layouts that fix a different value at this position, plus all layouts that
      //  can't be long enough to have a byte here at all. Layouts that merely *might* be too
      //  short survive: whether they do is up to the encoding's length and hence only known
      //  at runtime.
      const curPower = fixedKnownByte.length - count(layoutsWithValue) + count(tooShortLayouts);
      power = Math.min(power, curPower);
    }

    if (power === 0)
      continue;

    if (power === layouts.length - 1)
      //we have a perfect byte discriminator -> bail early
      return [
        true,
        (encoded: RoUint8Array) =>
          bitsetToArray(
            (encoded.length <= bytePos
              ? maybeTooShortLayouts
              //besides the layouts fixing this exact value, every possibly-too-short layout
              : (distinctValues.get(encoded[bytePos]!) ?? emptySet) | maybeTooShortLayouts
            //size bounds are sound, so filtering by them never drops a layout that could parse
            ) & layoutsWithSize(encoded.length)
          )
      ];

    bestBytes.push(
      [power, bytePos, maybeTooShortLayouts, distinctValues, anyValueLayouts, tooShortLayouts]
    );
  }

  //if we get here, we know we don't have a perfect byte discriminator so we now check whether
  //  we have a perfect size discriminator and bail early if so
  if (sizePower === layouts.length - 1)
    return [true, (encoded: RoUint8Array) => bitsetToArray(layoutsWithSize(encoded.length))];

  //sort in descending order of power
  bestBytes.sort(([lhsPower], [rhsPower]) => rhsPower - lhsPower);
  type BestBytes = typeof bestBytes;
  type Strategy = [BytePos, Candidates, Map<number, Candidates>] | "size" | "indistinguishable";

  let distinguishable = true;
  const strategies = new Map<Candidates, Strategy>();
  const candidatesBySize = new Map<Size, Candidates[]>();
  const addStrategy = (candidates: Candidates, strategy: Strategy) => {
    strategies.set(candidates, strategy);
    if (!candidatesBySize.has(count(candidates)))
      candidatesBySize.set(count(candidates), []);
    candidatesBySize.get(count(candidates))!.push(candidates);
  };

  const recursivelyBuildStrategy = (
    candidates: Candidates,
    bestBytes: BestBytes,
  ) => {
    if (count(candidates) <= 1 || strategies.has(candidates))
      return;

    let sizePower = 0;
    const narrowedBounds = new Map<Size, Candidates>();
    for (const candidate of bitsetToArray(candidates)) {
      const lower = sizeBounds[candidate]![0];
      const overlap = ascendingBounds.get(lower)! & candidates;
      narrowedBounds.set(lower, overlap)
      sizePower = Math.max(sizePower, count(overlap));
    }
    sizePower = count(candidates) - sizePower;

    const narrowedBestBytes: BestBytes = [];
    for (const [
      , bytePos, maybeTooShortLayouts, distinctValues, anyValueLayouts, tooShortLayouts
    ] of bestBytes) {
      const narrowedDistinctValues = new Map<ByteVal, Candidates>();
      let fixedKnownCount = 0;
      for (const [byteVal, layoutsWithValue] of distinctValues) {
        const lwv = layoutsWithValue & candidates;
        if (count(lwv) > 0) {
          narrowedDistinctValues.set(byteVal, lwv);
          fixedKnownCount += count(lwv);
        }
      }
      const narrowedMaybeTooShortLayouts = maybeTooShortLayouts & candidates;
      const narrowedTooShortLayouts = tooShortLayouts & candidates;

      //see the power calculation of the unnarrowed case for the reasoning
      let narrowedPower = narrowedDistinctValues.size > 0
        ? count(candidates) - count(narrowedMaybeTooShortLayouts)
        : 0;
      for (const layoutsWithValue of narrowedDistinctValues.values()) {
        const curPower =
          fixedKnownCount - count(layoutsWithValue) + count(narrowedTooShortLayouts);
        narrowedPower = Math.min(narrowedPower, curPower);
      }

      if (narrowedPower === 0)
        continue;

      if (narrowedPower === count(candidates) - 1) {
        //if we have a perfect byte discriminator, we can bail early
        addStrategy(candidates, [bytePos, narrowedMaybeTooShortLayouts, narrowedDistinctValues]);
        return;
      }

      narrowedBestBytes.push([
        narrowedPower,
        bytePos,
        narrowedMaybeTooShortLayouts,
        narrowedDistinctValues,
        anyValueLayouts & candidates,
        narrowedTooShortLayouts
      ]);
    }

    if (sizePower === count(candidates) - 1) {
      //if we have a perfect size discriminator, we can bail early
      addStrategy(candidates, "size");
      return;
    }

    narrowedBestBytes.sort(([lhsPower], [rhsPower]) => rhsPower - lhsPower);

    //prefer byte discriminators over size discriminators
    if (narrowedBestBytes.length > 0 && narrowedBestBytes[0]![0] >= sizePower) {
      const [
        , bytePos, narrowedMaybeTooShortLayouts, narrowedDistinctValues, anyValueLayouts,
        narrowedTooShortLayouts
      ] = narrowedBestBytes[0]!;
      addStrategy(candidates, [bytePos, narrowedMaybeTooShortLayouts, narrowedDistinctValues]);
      recursivelyBuildStrategy(narrowedMaybeTooShortLayouts, narrowedBestBytes);
      const remainingBytes = narrowedBestBytes.slice(1);
      //whatever value is found at bytePos, all layouts that don't fix a value there survive it
      //  - which besides the any-value ones includes those that merely might be too short to
      //  reach it
      const survivors =
        anyValueLayouts | (narrowedMaybeTooShortLayouts ^ narrowedTooShortLayouts);
      recursivelyBuildStrategy(survivors, remainingBytes);
      for (const cand of narrowedDistinctValues.values())
        recursivelyBuildStrategy(cand | survivors, remainingBytes);

      return;
    }

    if (sizePower > 0) {
      addStrategy(candidates, "size");
      for (const cands of narrowedBounds.values())
        recursivelyBuildStrategy(cands, narrowedBestBytes);

      return;
    }

    addStrategy(candidates, "indistinguishable");
    distinguishable = false;
  }

  recursivelyBuildStrategy(allLayouts, bestBytes);

  const findSmallestSuperSetStrategy = (candidates: Candidates) => {
    //search all strictly larger candidate sets up to and including allLayouts
    for (let size = count(candidates) + 1; size <= layouts.length; ++size)
      for (const larger of candidatesBySize.get(size) ?? [])
        if ((candidates & larger) === candidates) //is subset?
          return strategies.get(larger)!;

    //unreachable: allLayouts is always a stored superset of any candidate set
    throw new Error("Implementation error in layout discrimination algorithm");
  };

  return [distinguishable, (encoded: RoUint8Array) => {
    let candidates = allLayouts;

    let strategy = strategies.get(candidates)!;
    while (strategy !== "indistinguishable") {
      const before = candidates;
      if (strategy === "size")
        candidates &= layoutsWithSize(encoded.length);
      else {
        const [bytePos, maybeTooShortLayouts, distinctValues] = strategy;
        if (encoded.length <= bytePos)
          candidates &= maybeTooShortLayouts;
        else {
          const byteVal = encoded[bytePos];
          for (const [val, cands] of distinctValues)
            if (val !== byteVal)
              candidates ^= candidates & cands; //= candidates - cands (set minus)

          //these layouts might be too short to reach bytePos, but might not - so having read a
          //  byte here we may only drop the ones that genuinely can't match this encoding's
          //  length, i.e. those also outside layoutsWithSize. Dropping a
          //  maybe-short-but-size-compatible layout would be a false negative.
          candidates ^=
            candidates & maybeTooShortLayouts & (allLayouts ^ layoutsWithSize(encoded.length));
        }
      }

      //termination guard: if a strategy leaves the candidate set unchanged we've stopped making
      //  progress. This normally can't happen for a stored strategy (each is built to shrink
      //  its set), but a superset strategy applied via findSmallestSuperSetStrategy to a subset
      //  it wasn't built for might not reduce it - re-fetching the same superset strategy would
      //  then loop forever. Breaking leaves the current (possibly ambiguous) set as the result,
      //  which is the correct answer when the remaining candidates are genuinely
      //  indistinguishable here.
      if (count(candidates) <= 1 || candidates === before)
        break;

      strategy = strategies.get(candidates) ?? findSmallestSuperSetStrategy(candidates)
    }

    return bitsetToArray(candidates);
  }];
}
