import { describe, it } from "node:test";
import type { ElementRest } from "../src/typing.js";
import { pinEq } from "./typeAssert.js";

describe("ElementRest", () => {
  it("extracts a fixed head or suffix and preserves the rest", () => {
    pinEq<ElementRest<[1, 2]>, [1, [2]]>(true);
    pinEq<ElementRest<readonly [1, 2]>, [1, [2]]>(true);
    pinEq<ElementRest<[1, ...number[]]>, [1, number[]]>(true);
    pinEq<ElementRest<[...number[], 1]>, [1, number[]]>(true);
    pinEq<ElementRest<[1, ...number[], 2]>, [1, [...number[], 2]]>(true);
    pinEq<ElementRest<readonly []>, undefined>(true);
    pinEq<ElementRest<readonly number[]>, undefined>(true);
    pinEq<ElementRest<[1?]>, undefined>(true);
    pinEq<ElementRest<[1] | []>, [1, []] | undefined>(true);
  });
});
