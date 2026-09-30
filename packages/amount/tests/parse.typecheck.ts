//type-only assertion battery for Amount.parse's candidate inference — typechecked via
//tsconfig.test.json, never executed (not picked up by the *.test.ts glob)
import { Amount, kind } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

const A = kind("A", [{ symbols: [{ symbol: "a" }] }], { human: "a" });
const B = kind("B", [{ symbols: [{ symbol: "b" }] }], { human: "b" });

const several = Amount.parse("1 a", A, B);
const lone    = Amount.parse("1 a", A);

//candidates are inferred per argument, so several kinds are admitted at once and the result is
//  their union — one shared type param would bind to A and reject every other candidate
pinEq<typeof several, Amount<typeof A> | Amount<typeof B>>(true);

//a lone candidate still yields exactly that kind, no union in sight
pinEq<typeof lone, Amount<typeof A>>(true);

//the union narrows by kind, and the narrowed arm admits only its own units
if (Amount.isOfKind(several, A))
  several.in("a");
