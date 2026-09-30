import type { Opts, RoArray, RoUint8Array } from "./typing.js";
import { isUint8Array } from "./array.js";
import { hex } from "./encoding.js";

//A codec teaches jsonStringify/jsonParse one extra type: `test` picks values up on the way
//  out, `tag` names them on the wire ({ $type: tag, value: encode(v) }), `decode` restores
//  them on the way back in. Encoded payloads are themselves walked recursively, so codecs
//  compose: a Map codec whose entries contain bigints just works. Round-tripping is total —
//  genuine objects that happen to look like the wire format survive, because every key
//  matching /^\$+type$/ is escaped with one more "$" on the way out and unescaped on the way
//  back in.
//Members use method syntax: their bivariance is what lets a JsonCodec<bigint> into an
//  RoArray<JsonCodec>.
export type JsonCodec<T = unknown> = {
  tag: string;
  test(value: unknown): value is T;
  encode(value: T): unknown;
  decode(encoded: unknown): T;
};

type CodecArray = RoArray<JsonCodec>;

export const jsonStringify = (
  value:  unknown,
  codecs: CodecArray = [],
  opts?:  Opts<{ space: number; sortKeys: boolean }>,
): string => {
  const encVal = encodeValue(value, "", codecs, opts?.sortKeys ?? false);
  const json = JSON.stringify(encVal, null, opts?.space);
  if (json === undefined)
    throw new Error("value has no JSON representation");

  return json;
};

export const jsonParse = (json: string, codecs: CodecArray = []): unknown =>
  decodeValue(JSON.parse(json), codecs);

const typeKey        = /^\$+type$/;
const escapedTypeKey = /^\$\$+type$/;

//codecs are consulted before toJSON, so a codec sees the Date and not the string its toJSON
//  would have made of it; the first codec to claim a value wins
const claim = (value: unknown, codecs: CodecArray, sortKeys: boolean): object | undefined => {
  for (const codec of codecs)
    if (codec.test(value))
      return { $type: codec.tag, value: encodeValue(codec.encode(value), "value", codecs, sortKeys) };

  return undefined;
};

const hasToJson = (value: object): value is { toJSON: (key: string) => unknown } =>
  "toJSON" in value && typeof value.toJSON === "function";

const encodeValue = (
  value:    unknown,
  key:      string,
  codecs:   CodecArray,
  sortKeys: boolean,
): unknown => {
  const claimed = claim(value, codecs, sortKeys);
  if (claimed !== undefined)
    return claimed;

  //primitives fall through to JSON.stringify itself, including its TypeError on a bigint
  //  that no codec claimed
  if (typeof value !== "object" || value === null)
    return value;

  //as JSON.stringify does: toJSON is called once, with the property key, and its result is
  //  taken as the value - offered to the codecs, but not asked for a toJSON of its own
  if (hasToJson(value)) {
    const json = value.toJSON(key);
    return claim(json, codecs, sortKeys) ?? encodeShape(json, codecs, sortKeys);
  }

  return encodeShape(value, codecs, sortKeys);
};

//Node has JSON.rawJSON; TypeScript's lib does not declare it yet
const isRawJson = (JSON as JSON & { isRawJSON(value: unknown): boolean }).isRawJSON;

//the primitive a boxed String/Number/Boolean/BigInt holds, which JSON.stringify unwraps
const unboxed = (value: object): unknown =>
  value instanceof String || value instanceof Number ||
  value instanceof Boolean || value instanceof BigInt
  ? value.valueOf()
  : undefined;

const encodeShape = (value: unknown, codecs: CodecArray, sortKeys: boolean): unknown => {
  if (typeof value !== "object" || value === null)
    return value;

  //raw JSON is left for JSON.stringify, which emits it verbatim
  if (isRawJson(value))
    return value;

  const primitive = unboxed(value);
  if (primitive !== undefined)
    return claim(primitive, codecs, sortKeys) ?? primitive;

  if (Array.isArray(value))
    return value.map((item, index) => encodeValue(item, String(index), codecs, sortKeys));

  //what JSON.stringify would drop is dropped here, so no function - a toJSON above all - is
  //  copied into the encoded tree for JSON.stringify to call a second time
  const entries = Object.entries(value).filter(([, item]) =>
    item !== undefined && typeof item !== "function" && typeof item !== "symbol");
  if (sortKeys)
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  return Object.fromEntries(entries.map(([key, item]) =>
    [typeKey.test(key) ? "$" + key : key, encodeValue(item, key, codecs, sortKeys)]
  ));
};

const decodeValue = (value: unknown, codecs: CodecArray): unknown => {
  if (typeof value !== "object" || value === null)
    return value;

  if (Array.isArray(value))
    return value.map(item => decodeValue(item, codecs));

  const entries = Object.entries(value);
  if (entries.length === 2 &&
      "$type" in value && typeof value.$type === "string" && "value" in value) {
    const { $type, value: payload } = value;
    const codec = codecs.find(c => c.tag === $type);
    if (!codec)
      throw new Error(`No codec registered for $type "${$type}"`);

    return codec.decode(decodeValue(payload, codecs));
  }

  //keys become own data properties: assigning them would route an own "__proto__" key through
  //  the inherited setter, swapping the prototype instead of storing the entry
  return Object.fromEntries(entries.map(([key, item]) =>
    [escapedTypeKey.test(key) ? key.slice(1) : key, decodeValue(item, codecs)]
  ));
};

// ---- Codecs for the types this package can speak for ----
//tags are the type's own name; kind-aware codecs (Amount, Rate, ...) live with their types

//a payload is decoded before its codec sees it, so it can hold values plain JSON cannot print
const describePayload = (encoded: unknown): string => {
  try {
    return jsonStringify(encoded, [bigintCodec, bytesCodec, dateCodec]);
  } catch {
    return typeof encoded;
  }
};

//the decode-side validation kit, for in-house and third-party codecs alike
export const invalidPayload = (encoded: unknown, tag: string): Error =>
  new Error(`Invalid ${tag} payload: ${describePayload(encoded)}`);

export const expectString = (encoded: unknown, tag: string): string => {
  if (typeof encoded !== "string")
    throw invalidPayload(encoded, tag);

  return encoded;
};

const decimalInteger = /^-?(?:0|[1-9][0-9]*)$/;
export const bigintCodec: JsonCodec<bigint> = {
  tag: "bigint",
  test: (value): value is bigint => typeof value === "bigint",
  encode: value => value.toString(10),
  decode: encoded => {
    const str = expectString(encoded, "bigint");
    if (!decimalInteger.test(str))
      throw invalidPayload(encoded, "bigint");

    return BigInt(str);
  },
};

export const bytesCodec: JsonCodec<RoUint8Array> = {
  tag: "Uint8Array",
  test: isUint8Array, //cross-realm, unlike instanceof — foreign bytes must not slip past the codec
  encode: value => hex.encode(value),
  decode: encoded => hex.decode(expectString(encoded, "Uint8Array")),
};

//cross-realm like bytesCodec. An Invalid Date is encoded as null, which is what its own toJSON
//  gives, and decodes back to one
export const dateCodec: JsonCodec<Date> = {
  tag: "Date",
  test: (value): value is Date => Object.prototype.toString.call(value) === "[object Date]",
  encode: value => Number.isNaN(value.getTime()) ? null : value.toISOString(),
  decode: encoded => {
    if (encoded === null)
      return new Date(NaN);

    const date = new Date(expectString(encoded, "Date"));
    if (Number.isNaN(date.getTime()))
      throw invalidPayload(encoded, "Date");

    return date;
  },
};
