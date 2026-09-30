import type { OfLength, RoArray, RoNeTuple } from "@onrail-xyz/utils";
import { isArray } from "@onrail-xyz/utils";
import type { Rationalish } from "./rational.js";
import { Rational } from "./rational.js";
import type { Kind, KindWithAtomic, SymbolsOf } from "./kind.js";
import type { Amount } from "./amount.js";

//a literal count or weights tuple yields a length-typed tuple; a runtime length degrades to a
//  plain array
type Allocation<K extends Kind, P extends number | RoArray<Rationalish>> =
  P extends RoArray<Rationalish>
  ? OfLength<Amount<K>, P["length"]>
  : OfLength<Amount<K>, P & number>;

//Parts are pro-rata by weight (any sign, nonzero total), or equal when a count is given;
//  each part is a whole number of the given unit (atomic by default) and the parts sum exactly
//  to the amount, leftover units going to the largest fractional shares (earlier index breaks
//  ties). The amount must itself be whole in that unit: allocation never rounds the total, so
//  quantization — and the dust decision that comes with it — stays with the caller.
export function allocate<
        K extends KindWithAtomic,
  const P extends number | RoNeTuple<Rationalish>,
>(amount: Amount<K>, parts: P): Allocation<K, P>;
export function allocate<
        K extends Kind,
  const P extends number | RoNeTuple<Rationalish>,
>(amount: Amount<K>, parts: P, unitSymbol: SymbolsOf<K>): Allocation<K, P>;
export function allocate(
  amount:     Amount<Kind>,
  parts:      number | RoArray<Rationalish>,
  unitSymbol: SymbolsOf<Kind> = "atomic",
): RoArray<Amount<Kind>> {
  if (!amount.eq(amount.floorTo(unitSymbol)))
    throw new Error(
      `Amount is not a whole number of ${unitSymbol} units - quantize it first ` +
      `(floorTo/roundTo/ceilTo)`
    );

  if (isArray(parts) ? parts.length === 0 : !(Number.isSafeInteger(parts) && parts > 0))
    throw new Error("parts must be a nonempty weights list or a positive integer count");

  const weights = isArray(parts)
    ? parts.map(w => Rational.from(w))
    : Array.from({ length: parts }, () => Rational.from(1n));
  const totalWeight = weights.reduce((acc, w) => acc.add(w), Rational.from(0n));
  if (totalWeight.eq(0n))
    throw new Error("weights must not sum to zero");

  const inUnit: Rational | bigint = amount.in(unitSymbol);
  const total = typeof inUnit === "bigint" ? inUnit : inUnit.floor(); //integral, so floor is exact

  const shares = weights.map(w => Rational.from(total).mul(w).div(totalWeight));
  const floors = shares.map(s => s.floor());
  let leftover = total - floors.reduce((acc, f) => acc + f, 0n);

  const byFraction = shares
    .map((s, i) => [s.sub(floors[i]!), i] as const)
    .sort((a, b) => a[0].eq(b[0]) ? a[1] - b[1] : a[0].gt(b[0]) ? -1 : 1);

  const bumped = new Set<number>();
  for (const [, i] of byFraction) {
    if (leftover === 0n)
      break;

    bumped.add(i);
    --leftover;
  }

  return floors.map((f, i) => amount.ofSame(bumped.has(i) ? f + 1n : f, unitSymbol));
}
