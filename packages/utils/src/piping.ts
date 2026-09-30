import type { Function, Guard, HeadTail, Nullish,
              Predicate, RoTuple, RoNeTuple, RoArray } from "./typing.js";

//composes functions via chaining:
//  for f: A -> B, g: B -> C, h: C -> D
//  pipe(f, g, h) gives A -> D
export type Pipe<FT extends RoTuple<Function>> =
  FT extends readonly [
    infer F extends Function,
    infer G extends Function,
    ...infer Tail extends RoTuple<Function>
  ]
  ? Pipe<[Function<Parameters<F>, ReturnType<G>>, ...Tail]>
  : FT[0];

//enforces that every function past the first accepts its predecessor's return type.
//  no readonly: a splice fragment is only ever consumed by spreads, which erase it anyway
type ChainedTail<In, FT extends RoTuple<Function>> =
  FT extends HeadTail<FT, infer G, infer Tail>
  ? [Function<[In], ReturnType<G>>, ...ChainedTail<ReturnType<G>, Tail>]
  : [];

type Chained<FT extends RoTuple<Function>> =
  FT extends HeadTail<FT, infer F, infer Tail>
  ? readonly [F, ...ChainedTail<ReturnType<F>, Tail>]
  : FT;

export const pipe = <const FT extends RoNeTuple<Function>>(...fns: FT & Chained<FT>): Pipe<FT> => {
  const [head, ...tail] = fns as RoArray<Function>;
  return ((...args: RoArray) =>
    tail.reduce((acc, fn) => fn(acc), head!(...args))) as any;
};

// --- utils ---

export const identity = <const T>(val: T) => val;

export const raise = (error: string | Error): never => {
  throw typeof error === "string" ? new Error(error) : error;
};

export const tap =
  <const T>(fn: Function<[T], void>) =>
    (val: T): T => { fn(val); return val; };

export const tryOr =
  <const F>(fallback: F) =>
    <const T, U>(fn: Function<[T], U>): Function<[T], U | F> =>
      (val: T) => {
        try { return fn(val); }
        catch { return fallback; }
      };

//the result carries exactly the nullish constituents of the input (`V & Nullish` rather than
//  Extract, which is never for a non-union input like unknown)
export const map =
  <const V, U>(val: V, fn: Function<[Exclude<V, Nullish>], U>): U | (V & Nullish) =>
    (val != null ? fn(val as Exclude<V, Nullish>) : val) as U | (V & Nullish);

export const fallback =
  <const F>(val: F) =>
    <const T>(input: T | Nullish): T | F =>
      (input != null ? input : val) as T | F;

type Msg<T> = string | Function<[T], string>;

const evalMsg = (msg: Msg<unknown>, val: unknown): string =>
  typeof msg === "function" ? msg(val) : msg;

export function ensure<T, U extends T>(val: T, pred: Guard<T, U>, msg?: Msg<T>): U;
export function ensure<T>(val: T, pred: Predicate<T>, msg?: Msg<T>): T;
export function ensure(val: unknown, pred: Predicate<unknown>, msg?: Msg<unknown>) {
  if (!pred(val))
    throw new Error(evalMsg(msg ?? "Required condition not met", val));
  return val;
}

export function forbid<T, U extends T>(val: T, pred: Guard<T, U>, msg?: Msg<T>): Exclude<T, U>;
export function forbid<T>(val: T, pred: Predicate<T>, msg?: Msg<T>): T;
export function forbid(val: unknown, pred: Predicate<unknown>, msg?: Msg<unknown>) {
  if (pred(val))
    throw new Error(evalMsg(msg ?? "Forbidden condition violated", val));
  return val;
}

// --- predicates ---

export const and =
  <T>(...preds: RoArray<Predicate<T>>): Predicate<T> =>
    val => preds.every(p => p(val));

export const or =
  <T>(...preds: RoArray<Predicate<T>>): Predicate<T> =>
    val => preds.some(p => p(val));

export const not = (val: boolean) => !val;

export const isUndefined = (val: unknown): val is undefined => val === undefined;
export const isNullish   = (val: unknown): val is Nullish   => val == null;
export const isDefined   = <const T>(val: T | undefined): val is T => val !== undefined;
export const exists      = <const T>(val: T | Nullish  ): val is T => val != null;

export const succeeds = (fn: Function<[]>): boolean => {
  try {
    fn();
    return true;
  }
  catch {
    return false;
  }
}

export const throws = pipe(succeeds, not);

export const throwOnUndefined = <const T>(val: T | undefined, msg?: Msg<T | undefined>) =>
  ensure(val, isDefined, msg);
export const throwOnNullish = <const T>(val: T | Nullish, msg?: Msg<T | Nullish>) =>
  ensure(val, exists, msg);
