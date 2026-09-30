//identity rather than mutual assignability, which cannot tell an optional key from a missing
//  one, a readonly property from a mutable one, or any from anything
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

//a type pin: `pinEq<Actual, Expected>(true)` compiles only if the two are identical, and a
//  failure prints both
export const pinEq = <A, B>(_: Equal<A, B> extends true ? true : { error: [A, B] }) => {};

//for pins of a relation other than identity, such as assignability
export type Assert<T extends true> = T;
