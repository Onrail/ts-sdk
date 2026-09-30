import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { TimeUnit } from "../src/index.js";
import { serialize, deserialize,
         calcStaticSize, buildDiscriminator, withCustom, pin,
         uintItem, intItem, bytesItem, arrayItem, switchItem,
         codecItem, timestampItem, timestampConversion, utf8Conversion } from "../src/index.js";

describe("switch id domain", () => {
  it("rejects an id of the wrong primitive for the id width", () => {
    assert.throws(() => switchItem("k", uintItem(8), [[1, {}]] as any), /is a number/);
    assert.throws(() => switchItem("k", uintItem(1), [[1n, {}]] as any), /is a bigint/);
    assert.throws(() => switchItem("k", uintItem(1), [[[0n, 3n], {}]] as any), /is a bigint/);
  });

  //such a variant can never be read back, just like a shadowed one
  it("rejects an id outside the id width", () => {
    assert.throws(() => switchItem("k", uintItem(1), [[1, {}], [256, {}]]), /does not fit in u8/);
    assert.throws(() => switchItem("k", uintItem(1), [[[0, 300], {}]]), /does not fit in u8/);
    assert.throws(() => switchItem("k", intItem(1), [[-1, {}], [128, {}]]), /does not fit in i8/);
  });

  it("accepts ids in the domain, and leaves a codec id's domain to the codec", () => {
    const wide = switchItem("k", uintItem(8), [[1n, {}], [[2n, 9n], {}]]);
    assert.deepEqual(serialize(wide, { k: 1n }), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
    const codec = codecItem({
      read:   (bytes, offset) => [bytes[offset]!, offset + 1],
      write:  (value: number, bytes, offset) => (bytes[offset] = value, offset + 1),
      sizeOf: () => 1,
    });
    assert.doesNotThrow(() => switchItem("k", codec, [[1000, {}]]));
  });
});

describe("field-path error wrapping", () => {
  const throwing = (thrown: unknown) => codecItem({
    read:   () => { throw thrown; },
    write:  () => { throw thrown; },
    sizeOf: () => 1,
  });

  //user code may throw anything; the field path must reach the caller either way
  it("wraps a non-Error throw from a codec, keeping it as the cause", () => {
    for (const thrown of ["boom", { code: 1 }]) {
      assert.throws(() => deserialize({ x: throwing(thrown) }, new Uint8Array([0])), (e: unknown) =>
        e instanceof Error && e.message.startsWith("when deserializing field 'x':") &&
        e.cause === thrown);
      assert.throws(() => serialize({ x: throwing(thrown) }, { x: 0 }), (e: unknown) =>
        e instanceof Error && e.message.startsWith("when serializing field 'x':"));
    }
  });

  it("prefixes an Error in place", () => {
    const error = new Error("inner");
    const nested = { a: { x: throwing(error) } };
    assert.throws(() => deserialize(nested, new Uint8Array([0])), (e: unknown) =>
      e === error &&
      error.message === "when deserializing field 'a': when deserializing field 'x': inner");
  });
});

describe("mismatch messages", () => {
  it("names the first mismatching fixed byte, not the input", () => {
    const magic = bytesItem({ fixed: new Uint8Array([0x89, 0x50, 0x4e]) });
    const layout = { magic, body: bytesItem() };
    const input = new Uint8Array(1_000_000);
    input.set([0x89, 0x50, 0x00]);
    assert.throws(() => deserialize(layout, input), (e: Error) =>
      /at offset 2: expected 0x4e, got 0x00/.test(e.message) && e.message.length < 200);
  });

  it("says what disagrees when the data does not fit the layout", () => {
    assert.throws(() => serialize({ arr: arrayItem(uintItem(1), 3) }, { arr: [1, 2] as any }),
      /when sizing field 'arr': array length mismatch: layout length: 3, data length: 2/);
    assert.throws(() => serialize({ b: bytesItem(3) }, { b: new Uint8Array(2) }),
      /when sizing field 'b': size mismatch: layout size: 3, data size: 2/);
  });
});

describe("fixed constants", () => {
  //the cache holds the constant's wire bytes, so its conversions run once, not per serialize
  it("are rendered once, not once per serialize", () => {
    let calls = 0;
    const counting = {
      to:   (bytes: Uint8Array) => utf8Conversion.to(bytes),
      from: (text: string) => (++calls, utf8Conversion.from(text)),
    };
    const layout = pin({ name: bytesItem({ custom: counting } as any) }, { name: "abc" } as any);
    for (let i = 0; i < 5; ++i)
      serialize(layout as any, undefined as any);
    assert.equal(calls, 1);
  });
});

describe("withCustom on an inert `as`", () => {
  //`as` surfaces only on a pinned item; without `fixed` the conversion applies to the value
  it("converts the value when `fixed` is unset", () => {
    const unpinned = { ...pin(uintItem(1), 5), fixed: undefined } as any;
    const converted = withCustom(unpinned, {
      to:   (v: any) => `#${v}`,
      from: (s: string) => Number(s.slice(1)),
    });
    assert.equal(deserialize(converted, new Uint8Array([7])), "#7");
  });
});

describe("calcStaticSize", () => {
  it("takes a codec id's stated static size for range variants", () => {
    const id = codecItem({
      read:   (bytes, offset) => [bytes[offset]!, offset + 1],
      write:  (value: number, bytes, offset) => (bytes[offset] = value, offset + 1),
      sizeOf: () => 1,
    }, { minSize: 1, maxSize: 1 });
    assert.equal(calcStaticSize(switchItem("k", id, [[[0, 9], { a: uintItem(2) }]])), 3);
  });
});

describe("discriminator", () => {
  //content of a static size fixes its prefix's count, and hence the prefix's wire bytes
  it("reads the prefix of static-size prefixed content", () => {
    const prefixed = bytesItem({ size: uintItem(1), layout: { a: uintItem(2) } });
    const tagged = { tag: uintItem(1, { fixed: 3 }), a: uintItem(2) };
    const discriminator = buildDiscriminator([prefixed, tagged]);
    assert.equal(discriminator(new Uint8Array([2, 0, 0])), 0);
    assert.equal(discriminator(new Uint8Array([3, 0, 0])), 1);
  });
});

describe("timestamp opts", () => {
  //the Opts convention: an explicitly undefined option passes through as unset
  it("take an unset option passed through", () => {
    const unit = undefined as TimeUnit | undefined;
    const item = timestampItem({ unit });
    assert.equal(deserialize(item, serialize(item, new Date(1000))).getTime(), 1000);
    //@ts-expect-error a conversion has no byte order to take
    timestampConversion({ endianness: "little" });
  });
});
