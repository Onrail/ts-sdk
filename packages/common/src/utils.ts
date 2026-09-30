import type { OptionalArg } from "@onrail-xyz/utils";
import { type KindWithAtomic, Amount } from "@onrail-xyz/amount";

//a union rather than a conditional on K, so that a caller holding an open K constrained to a kind
//  can satisfy it: `Amount<K & {}>` accepts `Amount<K>`, where a conditional would stay deferred
//  and accept nothing. `& {}` rather than `& KindWithAtomic`: both strip undefined, but the
//  latter's string-keyed units would widen a concrete kind's unit symbols to string, leaving `in`
//  only the meta symbols. At every concrete K the arms collapse to one result.
export type AmountOr<K extends KindWithAtomic | undefined, Raw> =
  Amount<K & {}> | (K extends undefined ? Raw : never);

export type AmountOrAtomic<K extends KindWithAtomic | undefined = KindWithAtomic | undefined> =
  AmountOr<K, bigint>;

export const fromAtomicIfKind = <const K extends KindWithAtomic | undefined = undefined>(
  amount:    bigint,
  ...[kind]: OptionalArg<K>
): AmountOrAtomic<K> =>
  (kind ? Amount.from(amount, kind as K & KindWithAtomic, "atomic") : amount) as any;

export const toAtomicIfAmount = (aoa: AmountOrAtomic): bigint =>
  typeof aoa === "bigint" ? aoa : aoa.in("atomic");
