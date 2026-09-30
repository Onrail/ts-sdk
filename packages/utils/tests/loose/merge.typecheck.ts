//merge's optional-key branches admit undefined exactly when the consumer's optional keys can hold it
import { merge } from "../../src/index.js";
import { pinEq } from "../typeAssert.js";

const merged = merge({} as { a?: 1 }, { a: "fallback" } as const);
pinEq<typeof merged, { a?: 1 | "fallback" }>(true);
