import type { JsonCodec, MaybeArray, RoArray, StrRecord } from "@onrail-xyz/utils";
import { isArray, invalidPayload, expectString } from "@onrail-xyz/utils";
import { Rational } from "./rational.js";
import type { Kind } from "./kind.js";
import { Amount, isAmount } from "./amount.js";
import { Rate, isRate } from "./rate.js";

const expectFields = <const F extends RoArray<string>>(
  encoded: unknown,
  tag:     string,
  fields:  F,
): { [N in F[number]]: string } => {
  if (typeof encoded !== "object" || encoded === null || isArray(encoded))
    throw invalidPayload(encoded, tag);

  const out: StrRecord<string> = {};
  for (const field of fields) {
    const value = (encoded as StrRecord)[field];
    if (typeof value !== "string")
      throw invalidPayload(encoded, tag);

    out[field] = value;
  }
  return out as { [N in F[number]]: string };
};

const namedKind = <K extends Kind>(candidates: MaybeArray<K>, name: string, tag: string): K => {
  const kind = (isArray(candidates) ? candidates : [candidates]).find(k => k.name === name);
  if (!kind)
    throw new Error(`No candidate kind named "${name}" for ${tag}`);

  return kind;
};

export const rationalCodec: JsonCodec<Rational> = {
  tag: "Rational",
  test: (value): value is Rational => value instanceof Rational,
  encode: value   => value.toString(),
  decode: encoded => Rational.from(expectString(encoded, "Rational")),
};

export const amountCodec = (kinds: MaybeArray<Kind>): JsonCodec<Amount<Kind>> => ({
  tag: "Amount",
  test: isAmount,
  encode: value => ({ kind: value.kind.name, value: value.toJSON() }),
  decode: encoded => {
    const { kind, value } = expectFields(encoded, "Amount", ["kind", "value"]);
    return Amount.parse(value, namedKind(kinds, kind, "Amount"));
  },
});

export const rateCodec = (
  numKinds: MaybeArray<Kind>,
  denKinds: MaybeArray<Kind>,
): JsonCodec<Rate<Kind, Kind>> => ({
  tag: "Rate",
  test: isRate,
  encode: value => ({ num: value.num.name, den: value.den.name, value: value.toJSON() }),
  decode: encoded => {
    const { num, den, value } = expectFields(encoded, "Rate", ["num", "den", "value"]);
    return Rate.parse(value, namedKind(numKinds, num, "Rate"), namedKind(denKinds, den, "Rate"));
  },
});
