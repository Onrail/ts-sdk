import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import type { JsonCodec } from "../src/json.js";
import { jsonStringify, jsonParse,
         bigintCodec, bytesCodec, dateCodec, invalidPayload } from "../src/json.js";

const roundTrip = (value: unknown, codecs: JsonCodec<any>[] = []) =>
  jsonParse(jsonStringify(value, codecs), codecs);

describe("json", () => {
  describe("plain JSON", () => {
    //regression: a top-level value without a JSON representation came back as undefined under
    //  a return type that said string
    it("throws where JSON.stringify would return undefined", () => {
      for (const value of [undefined, () => {}, Symbol("s"), { toJSON: () => undefined }])
        assert.throws(() => jsonStringify(value), /no JSON representation/);
    });
    it("passes plain values through unchanged", () => {
      const value = { a: 1, b: "two", c: [true, null, { d: 3.5 }], e: {} };
      assert.deepStrictEqual(roundTrip(value), value);
      assert.strictEqual(jsonStringify(value), JSON.stringify(value));
    });

    it("honors toJSON like JSON.stringify does", () => {
      assert.strictEqual(jsonStringify({ x: { toJSON: () => "flat" } }), '{"x":"flat"}');
    });

    it("supports the space option", () => {
      assert.strictEqual(jsonStringify({ a: 1 }, [], { space: 2 }), '{\n  "a": 1\n}');
    });
  });

  describe("toJSON", () => {
    //regression: toJSON was called without the property key and its result was asked for a
    //  toJSON of its own, so a method returning `this` recursed until the stack ran out
    it("is called once, with the property key, like JSON.stringify", () => {
      const keys: string[] = [];
      const self = { n: 1, toJSON(key: string) { keys.push(key); return this; } };
      const expected = JSON.stringify({ a: self, b: [self] });
      keys.length = 0;
      assert.strictEqual(jsonStringify({ a: self, b: [self] }), expected);
      assert.deepStrictEqual(keys, ["a", "0"]);
    });
    it("offers the result to the codecs", () => {
      const wrapped = { toJSON: () => 5n };
      assert.strictEqual(jsonStringify(wrapped, [bigintCodec]), '{"$type":"bigint","value":"5"}');
    });
  });

  describe("codecs", () => {
    it("round-trips bigints anywhere in the structure", () => {
      const value = { a: 5n, b: [1n, -2n, 0n], c: { d: 123456789012345678901234567890n } };
      assert.deepStrictEqual(roundTrip(value, [bigintCodec]), value);
    });

    it("keeps the wire format of the previous bigint serializer", () => {
      assert.strictEqual(jsonStringify(5n, [bigintCodec]), '{"$type":"bigint","value":"5"}');
      assert.strictEqual(jsonParse('{"$type":"bigint","value":"123"}', [bigintCodec]), 123n);
    });

    it("catches bytes from another realm [instanceof would let them serialize as garbage]", () => {
      const foreign = runInNewContext("new Uint8Array([1, 2, 3])") as Uint8Array;
      assert(!(foreign instanceof Uint8Array));
      assert.deepStrictEqual(roundTrip({ data: foreign }, [bytesCodec]), { data: new Uint8Array([1, 2, 3]) });
    });

    it("round-trips bytes and dates", () => {
      const value = { data: new Uint8Array([0, 1, 254, 255]), at: new Date("2026-08-15T12:34:56.789Z") };
      assert.deepStrictEqual(roundTrip(value, [bytesCodec, dateCodec]), value);
    });

    it("composes: codec payloads are walked recursively", () => {
      const mapCodec: JsonCodec<Map<unknown, unknown>> = {
        tag: "Map",
        test: (v): v is Map<unknown, unknown> => v instanceof Map,
        encode: v => [...v.entries()],
        decode: e => new Map(e as [unknown, unknown][]),
      };
      const value = new Map<string, unknown>([["big", 5n], ["nested", new Map([["deep", 7n]])]]);
      assert.deepStrictEqual(roundTrip(value, [mapCodec, bigintCodec]), value);
    });

    it("throws on a bigint no codec claimed, like JSON.stringify", () => {
      assert.throws(() => jsonStringify({ a: 5n }), TypeError);
    });

    it("throws on an unregistered tag rather than handing back the wire object", () => {
      assert.throws(
        () => jsonParse('{"$type":"bigint","value":"5"}'),
        /No codec registered for \$type "bigint"/,
      );
    });

    it("throws on malformed payloads", () => {
      assert.throws(() => jsonParse('{"$type":"bigint","value":"0x5"}', [bigintCodec]), /Invalid bigint/);
      assert.throws(() => jsonParse('{"$type":"bigint","value":5}', [bigintCodec]), /Invalid bigint/);
      assert.throws(() => jsonParse('{"$type":"Date","value":"yesterday"}', [dateCodec]), /Invalid Date/);
    });
  });

  describe("round-trip totality", () => {
    //the previous serializer passed wire-format look-alikes through unchanged, so a genuine
    //  { $type: "bigint", value: "5" } object came back as 5n — these pin the escaping fix
    it("preserves genuine objects that look like the wire format", () => {
      const value = { $type: "bigint", value: "5" };
      assert.deepStrictEqual(roundTrip(value, [bigintCodec]), value);
    });

    it("climbs the escape ladder", () => {
      const value = { $type: "x", $$type: "y", $$$type: "z", value: 1, extra: true };
      assert.deepStrictEqual(roundTrip(value, [bigintCodec]), value);
    });

    it("leaves unrelated $-keys alone", () => {
      const value = { $typeX: 1, x$type: 2, $: 3, type: 4 };
      assert.strictEqual(jsonStringify(value), JSON.stringify(value));
      assert.deepStrictEqual(roundTrip(value), value);
    });

    it("does not mistake near-misses of the wire shape for encodings", () => {
      for (const value of [
        { $type: "bigint", value: "5", extra: 1 },  //too many keys
        { $type: "bigint" },                        //missing value
        { $type: 5, value: "5" },                   //non-string tag
      ])
        assert.deepStrictEqual(roundTrip(value, [bigintCodec]), value);
    });

    //the traversals used to assign keys onto a fresh {}, so an own "__proto__" key from the
    //  wire went through the inherited setter: the entry vanished and the result inherited
    //  attacker-chosen properties
    it("keeps prototype-named keys as own data properties", () => {
      const json = `{"__proto__":{"admin":true},"constructor":1,"prototype":2,"ok":3}`;
      const decoded = jsonParse(json) as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(decoded), ["__proto__", "constructor", "prototype", "ok"]);
      assert.strictEqual(Object.getPrototypeOf(decoded), Object.prototype);
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value, { admin: true });
      assert.strictEqual(jsonStringify(decoded), json);
    });
  });

  describe("what JSON.stringify special-cases", () => {
    it("serializes a boxed primitive as the primitive it holds", () => {
      const value = { s: new String("ab"), n: new Number(5), b: new Boolean(false) };
      assert.strictEqual(jsonStringify(value), JSON.stringify(value));
      assert.strictEqual(jsonStringify({ x: Object(5n) }, [bigintCodec]),
        '{"x":{"$type":"bigint","value":"5"}}');
    });

    it("emits raw JSON verbatim, including from toJSON", () => {
      const digits = "123456789012345678901234567890";
      const exact = { toJSON: () => (JSON as any).rawJSON(digits) };
      assert.strictEqual(jsonStringify({ x: (JSON as any).rawJSON(digits) }), `{"x":${digits}}`);
      assert.strictEqual(jsonStringify({ x: exact }), `{"x":${digits}}`);
    });
  });

  describe("dateCodec", () => {
    it("claims a Date from another realm", () => {
      const foreign = runInNewContext("new Date(0)") as Date;
      const decoded = roundTrip({ d: foreign }, [dateCodec]) as { d: Date };
      assert(decoded.d instanceof Date);
      assert.strictEqual(decoded.d.getTime(), 0);
    });

    it("round-trips an Invalid Date", () => {
      const decoded = roundTrip({ d: new Date(NaN) }, [dateCodec]) as { d: Date };
      assert(decoded.d instanceof Date);
      assert(Number.isNaN(decoded.d.getTime()));
    });
  });

  describe("payload errors", () => {
    //the payload is decoded before its codec sees it, so it can hold what plain JSON can't print
    it("describe a payload holding a nested codec value", () => {
      const json = '{"$type":"Uint8Array","value":{"$type":"bigint","value":"1"}}';
      assert.throws(() => jsonParse(json, [bigintCodec, bytesCodec]), /Invalid Uint8Array payload/);
      assert.match(invalidPayload(new Uint8Array([1]), "x").message, /"value":"01"/);
    });
  });

  describe("sortKeys", () => {
    it("canonicalizes key order recursively", () => {
      const a = { b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] };
      const b = { a: [{ x: 2, y: 1 }], b: { c: 2, d: 1 } };
      const opts = { sortKeys: true };
      assert.strictEqual(jsonStringify(a, [], opts), jsonStringify(b, [], opts));
      assert.notStrictEqual(jsonStringify(a), jsonStringify(b));
    });
  });
});
