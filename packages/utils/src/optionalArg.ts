import type { RoArray } from "./typing.js";

//an optional argument whose type parameter sees whether it was passed: `...x: OptionalArg<T>`.
//  With `x?: T`, a passed `X | undefined` infers T = X - the `?` absorbs the undefined - so a
//  result computed from T claims X even when undefined came in; `[T]` has nothing to absorb it,
//  so T takes the undefined, or rejects it where its constraint does. Rest is the arguments after
//  it, so trailing optionals nest: OptionalArg<A, OptionalArg<B>>
export type OptionalArg<T, Rest extends RoArray = []> = [T, ...Rest] | [];

//the argument as its type parameter - forwarding the rest whole (`...x`) needs neither. A
//  destructured `[x]` reads as `T | undefined`, which loses what the tuple union knew; the cast
//  restores it: the empty list stands for an argument left out, which T admits unless a caller
//  instantiated it explicitly without passing one. Not for a parameter with a default in place
//  of undefined, whose omission leaves the value undefined while T is the default
export const argOf = <T, R extends RoArray>(args: OptionalArg<T, R>): T => args[0] as T;

//the arguments after the first, as their own optional list
export const restOf = <T, R extends RoArray>(args: OptionalArg<T, R>): R | [] =>
  args.slice(1) as unknown as R | [];
