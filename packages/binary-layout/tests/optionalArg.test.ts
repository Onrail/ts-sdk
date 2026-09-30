import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RoUint8Array } from "@onrail-xyz/utils";
import type { DeriveType } from "../src/index.js";
import { uintItem, bytesItem,
         customizableBytes, utf8Conversion, deserialize } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

//regression: declared `opts?: O`, an opts variable typed `X | undefined` inferred O = X - the `?`
//  absorbed the undefined - so the item's type claimed X's fields (a fixed value, say) that the
//  runtime item lacked whenever the variable held undefined
describe("an opts record that may be absent", () => {
  it("is rejected, as the item's shape would depend on it", () => {
    const maybeOpts = undefined as { fixed: 3 } | undefined;
    // @ts-expect-error - O's constraint does not admit undefined
    uintItem(1, maybeOpts);
    // @ts-expect-error - likewise for a width-or-opts argument
    bytesItem(undefined as 4 | undefined);
    const fixed = uintItem(1, { fixed: 3 }), plain = uintItem(1);
    pinEq<DeriveType<typeof fixed>, undefined>(true);
    pinEq<DeriveType<typeof plain>, number>(true);
  });
  it("a spec that may be absent frames the union", () => {
    const framed = customizableBytes({}, undefined as typeof utf8Conversion | undefined);
    pinEq<DeriveType<typeof framed>, string | RoUint8Array>(true);
    assert.deepEqual(deserialize(framed, new Uint8Array([1])), new Uint8Array([1]));
  });
});
