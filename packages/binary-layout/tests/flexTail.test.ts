//Tail reservation: a flex item consumes its boundary minus the static size of everything
//  after it. Before tail reservation landed, any flex not in final position was UB.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Layout } from "../src/index.js";
import { serialize, deserialize, uintItem,
         bytesItem, arrayItem, switchItem, utf8Conversion } from "../src/index.js";

const roundtrip = <const L extends Layout>(layout: L, data: any, expectedHex?: string) => {
  const encoded = serialize(layout, data);
  if (expectedHex !== undefined)
    assert.equal(encoded.toHex(), expectedHex);

  assert.deepEqual(deserialize(layout, encoded), data);
  return encoded;
};

describe("flex bytes with a static trailer", () => {
  const layout = {
    payload: bytesItem(),
    digest:  uintItem(4),
  };

  it("roundtrips payload + digest", () => {
    roundtrip(
      layout,
      { payload: new Uint8Array([1, 2, 3]), digest: 0xdeadbeef },
      "010203deadbeef",
    );
  });

  it("handles an empty payload", () => {
    assert.deepEqual(
      deserialize(layout, Uint8Array.fromHex("deadbeef")),
      { payload: new Uint8Array([]), digest: 0xdeadbeef },
    );
  });

  it("rejects input shorter than the reserved tail", () => {
    assert.throws(
      () => deserialize(layout, new Uint8Array(3)),
      /when deserializing field 'payload'.*too few bytes/,
    );
  });

  it("reserves across nested structs", () => {
    //the exact layout the README used to declare UB: the flex ends the struct it sits in
    //  yet leaves the outer tail its byte
    const nested = { head: { flex: bytesItem() }, tail: uintItem(1) };
    assert.deepEqual(
      deserialize(nested, new Uint8Array([1, 2, 3])),
      { head: { flex: new Uint8Array([1, 2]) }, tail: 3 },
    );
  });

  it("passes the reservation through a size-less bytes item", () => {
    const layout = {
      body: bytesItem({ layout: { s: bytesItem({ custom: utf8Conversion }) } }),
      tail: uintItem(1),
    };
    roundtrip(layout, { body: { s: "hi" }, tail: 7 }, "686907");
  });
});

describe("flex array with a static trailer", () => {
  const layout = {
    vals: arrayItem(uintItem(2)),
    crc:  uintItem(1),
  };

  it("roundtrips elements + trailer", () => {
    roundtrip(layout, { vals: [256, 2], crc: 7 }, "0100000207");
  });

  it("handles an empty array", () => {
    assert.deepEqual(deserialize(layout, new Uint8Array([7])), { vals: [], crc: 7 });
  });

  it("rejects an element overrunning into the reserved tail", () => {
    //4 bytes leave 3 for 2-byte elements: the second element crosses the reservation
    assert.throws(
      () => deserialize(layout, new Uint8Array(4)),
      /overran into the 1 byte tail/,
    );
  });
});

describe("boundaries reset the reservation", () => {
  it("frames an inner flex by explicit size", () => {
    const layout = {
      framed: bytesItem({ size: 3, layout: { p: bytesItem() } }),
      tail:   uintItem(1),
    };
    roundtrip(layout, { framed: { p: new Uint8Array([1, 2, 3]) }, tail: 9 }, "01020309");
  });

  it("frames an inner flex by size prefix", () => {
    const layout = {
      framed: bytesItem({ size: uintItem(1), layout: { p: bytesItem() } }),
      tail:   uintItem(1),
    };
    roundtrip(layout, { framed: { p: new Uint8Array([5, 6]) }, tail: 9 }, "02050609");
  });
});

describe("flex inside a switch variant", () => {
  it("accumulates the tail at runtime across the taken branch", () => {
    //the flex's tail (pad + checksum) is only knowable once the branch is taken
    const layout = {
      msg: switchItem("kind", uintItem(1), [
        [0, "data",  { payload: bytesItem(), pad: uintItem(1) }],
        [1, "empty", {}],
      ]),
      checksum: uintItem(2),
    };
    roundtrip(
      layout,
      { msg: { kind: "data", payload: new Uint8Array([9, 9, 9]), pad: 5 }, checksum: 0xffee },
      "0009090905ffee",
    );
    roundtrip(layout, { msg: { kind: "empty" }, checksum: 0xffee }, "01ffee");
  });

  it("accepts a uniform switch as a static tail", () => {
    const layout = {
      payload: bytesItem(),
      status: switchItem("s", uintItem(1), [
        [0, "a", { v: uintItem(2) }],
        [1, "b", { w: uintItem(2) }],
      ]),
    };
    roundtrip(layout, { payload: new Uint8Array([42]), status: { s: "b", w: 3 } }, "2a010003");
  });

  it("rejects a non-uniform switch tail", () => {
    const layout = {
      payload: bytesItem(),
      status: switchItem("s", uintItem(1), [
        [0, "a", { v: uintItem(2) }],
        [1, "b", { w: uintItem(4) }],
      ]),
    };
    assert.throws(
      () => deserialize(layout, new Uint8Array(4)),
      /not statically sized/,
    );
  });
});

describe("rejected tails", () => {
  it("rejects a dynamically sized tail on deserialization only", () => {
    const layout = {
      payload: bytesItem(),
      tail:    bytesItem(uintItem(1)),
    };
    //serialization needs no reservation - the write pass writes what it is handed
    const encoded = serialize(layout, {
      payload: new Uint8Array([1]),
      tail:    new Uint8Array([2]),
    });
    assert.equal(encoded.toHex(), "010102");
    assert.throws(() => deserialize(layout, encoded), /not statically sized/);
  });

  it("rejects a second flex in the same boundary", () => {
    const layout = { a: bytesItem(), b: bytesItem() };
    assert.throws(
      () => deserialize(layout, new Uint8Array(4)),
      /when deserializing field 'a'.*not statically sized/,
    );
  });

  it("rejects a flex inside an array element layout", () => {
    const layout = arrayItem({ p: bytesItem(), n: uintItem(1) }, 2);
    assert.throws(
      () => deserialize(layout, new Uint8Array(4)),
      /inside array element layouts/,
    );
  });

  it("rejects a flex element even in a flex array", () => {
    //previously UB that happened to yield a single all-consuming element
    assert.throws(
      () => deserialize(arrayItem(bytesItem()), new Uint8Array(3)),
      /inside array element layouts/,
    );
  });
});

describe("consumeAll: false", () => {
  it("still measures a flex against the whole input", () => {
    //the documented sharp edge: a flex takes the data it is handed, trailer or no trailer,
    //  so reading one message off the front of a stream needs framing around the layout
    const layout = { payload: bytesItem(), digest: uintItem(1) };
    const stream = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const [value, consumed] = deserialize(layout, stream, false);
    assert.equal(consumed, stream.length);
    assert.deepEqual(value, { payload: new Uint8Array([1, 2, 3, 4, 5]), digest: 6 });
  });
});
