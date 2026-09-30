// This file implements a hack to make large unions more readable in IDE tooltips.
//
// It provides a way to turn a union type like: `type Letter = "a" | "b" | ... | "z";` which
//   tsc always expands to the full union in tool tips (instead of sticking with the custom `Letter`
//   type) to something much closer to the original.
//
// # Basic Usage Example
//
// ```
// type Letter = "a" | "b" | "c" | "d" | "e" | "f";
// interface AllLetters extends SuppressExpansion<Letter> {}
//
// interface LetterAliases {
//   AllLetters: [Letter, AllLetters];
// }
//
// type Test1 = ApplyAliases<LetterAliases, Letter>; //keyof AllLetters instead of union type
// ```
//
// # Subsets
//
// Additionally, we can register additional subsets to collapse just those:
//
// ```
// interface AandB extends SuppressExpansion<"a" | "b"> {}
// interface CandD extends SuppressExpansion<"c" | "d"> {}
// interface LetterAliases {
//   AandB: ["a" | "b", AandB];
//   CandD: ["c" | "d", CandD];
// }
//
// type Test2 = ApplyAliases<LetterAliases, "a" | "b">;            //keyof AandB
// type Test3 = ApplyAliases<LetterAliases, "a" | "b" | "c">;      //keyof AandB | "c"
// type Test4 = ApplyAliases<LetterAliases, Exclude<Letter, "f">>; //keyof AandB | keyof CandD | "e"
// ```
//
// # Limitations
//
// If the union we pass in can be equally well matched by multiple combinations of subsets,
//   then we end up with a fully expanded union again:
//
// ```
// interface AandBandC extends SuppressExpansion<"a" | "b" | "c"> {}
//
// interface LetterAliases {
//   AandBandC: ["a" | "b" | "c", AandBandC];
// }
//
// //both keyof AandB | "c" | "f" and keyof AandBandC | "f" are considered equally good matches
// type Test5 = ApplyAliases<LetterAliases, "a" | "b" | "c" | "f">;
// ```
//
// ```
// interface AandC extends SuppressExpansion<"a" | "c"> {}
// interface BandD extends SuppressExpansion<"b" | "d"> {}
// interface LetterAliases {
//   AandC: ["a" | "c", AandC];
//   BandD: ["b" | "d", BandD];
// }
//
// //both keyof AandB | keyof CandD and keyof AandC | keyof BandD match equally well
// type Test6 = ApplyAliases<LetterAliases, "a" | "b" | "c" | "d">;
// ```
//
// Notice that a subset is always preferred over a raw union, hence Test4 is unambiguous.

export type SuppressExpansion<T extends PropertyKey> = { readonly [key in T]: never };

//utility type to re-expand aliases
export type Expand<A extends PropertyKey> = { [K in A]: K }[A];

//IofA = interface of aliases
type PartitionAliases<IofA extends object, Union> = {
  [K in keyof IofA]:
    IofA[K] extends [unknown, unknown]
    ? IofA[K][0] extends Union
      ? [Union] extends [IofA[K][0]]
        ? IofA[K][1]
        : [IofA[K][1], PartitionAliases<IofA, Exclude<Union, IofA[K][0]>>]
      : [Union]
    : never
}[keyof IofA];

type PerfectMatch<T> = T extends unknown[] ? never : T;
type PartialMatch<T> = T extends [infer Alias, infer Rest] ? [Alias, Rest] : never;

type BestPartition<T> =
  PerfectMatch<T> extends never
  ? PartialMatch<T> extends never
    ? T extends [infer Unaliased]
      ? Unaliased
      : never
    //if there are multiple matches, we should choose the one with the least members
    //  but that would require turning unions into tuples which continues to be a very
    //  costly type operation
    : T extends [infer Alias, infer Rest]
    ? keyof Alias | BestPartition<Rest>
    : never
  : keyof PerfectMatch<T>;

export type ApplyAliases<IofA extends object, Union> =
  [keyof IofA] extends [never] //no alias if the registry is empty
  ? Union
  //we use extends infer R extends Union to tell tsc that our result is a still of type Union
  //this is relevant when using ApplyAliases with generic types where tsc might otherwise
  //  not be able to automatically infer this guarantee
  : BestPartition<PartitionAliases<IofA, Union>> extends infer R extends Union
  ? R
  : never;
