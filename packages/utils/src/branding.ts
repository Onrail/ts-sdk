// This file implements a hierarchical branding system for TypeScript types.
//
// Branding allows you to create distinct types from a base type by attaching tags, to get around
//   issues that stem from TypeScript using structural typing (duck-typing) where
//   `type UserId = string;` and `type ProductId = string;` are considered equivalent, leading to
//   accidental mixing of values that share the same underlying type but represent different
//   concepts.
//
// # Hierarchical Tag Accumulation
//
// The key feature of this implementation on top of normal branding mechanics is that tags
//   accumulate hierarchically. When you brand a type that's already branded, the new tag is
//   added to the existing set of tags rather than replacing them:
//
// ```
// type UserId = Brand<string, "UserId">;
// type AdminId = Brand<UserId, "AdminId">; // AdminId now has both "UserId" and "AdminId" tags
// ```
//
// This allows for type hierarchies where more specific branded types inherit the constraints
//   of their parent brands, but can be covariantly passed to functions that expect the parent type:
//
// ```
// function processUser(userId: UserId);
// processUser(adminId); // works because AdminId is a subtype of UserId
// ```
//
// # brand Convenience Function
//
// `brand()` captures the inferred type without requiring its explicit specification.
//
// This is useful when branding complex types like kinds from @onrail-xyz/amount or when
//   combining branding utilities, e.g. @solana/kit's address:
//
// ```
// import { address } from "@solana/kit";
//
// const userAddress = brand<"user">()(address("3WxjT2rCBfncPvDHsnBc9nB3MQo2eYk25tV2SmC9E5HM"));
// // => userAddress: Brand<Address<3WxjT2rCBfncPvDHsnBc9nB3MQo2eYk25tV2SmC9E5HM>, "user">
// ```

import type { IsAny } from "./typing.js";

declare const __brand: unique symbol;
export type Branded<Base, Tags extends string> = {
  [__brand]: { base: Base; tags: { [K in Tags]: never } }
};

export type ExtractTags<T> =
  T extends { [__brand]: { tags: infer Tags } } ? keyof Tags & string : never;

export type Unbrand<T> = T extends { [__brand]: { base: infer B } } ? B : T;

export type Brand<T = unknown, B extends string = string> =
  Exclude<B, ""> extends never //neutral element: computed tag unions use "" for "no tag"
  ? T
  : IsAny<T> extends true //any absorbs the brand intersection -> treat as unknown
  ? Brand<unknown, B>
  : Unbrand<T> & Branded<Unbrand<T>, ExtractTags<T> | Exclude<B, "">>;

export type IsBranded<T> = [ExtractTags<T>] extends [never] ? false : true;

export type PreserveBrand<T, R> =
  [ExtractTags<T>] extends [never]
  ? R
  : Unbrand<T> extends R
    ? Brand<R, ExtractTags<T>>
    : never;

export type SameBrand<T, U> =
  ExtractTags<T> extends ExtractTags<U>
  ? ExtractTags<U> extends ExtractTags<T>
    ? true
    : false
  : false;

//check for brands first to avoid interpreting branded strings as normal tags
type ResolveTags<B> =
  [ExtractTags<B>] extends [never]
  ? B extends string ? B : never
  : ExtractTags<B>;

type AnyBranded = { [__brand]: unknown };

//inherits all tags from the specified branded types and applies the specified tag
//
//sadly <B extends string | AnyBranded, const T = unknown>(base: T) and then calling via
//  brand<"someTag">(makeComplexType()) doesn't work because tsc doesn't handle partial
//  application of generic parameters. I.e. seeing "someTag" it will take the default i.e.
//  unknown for T instead of deducing it from the argument, so the split into two functions
//  and the slightly ugly syntax that goes with it is unavoidable.
export const brand =
  <B extends string | AnyBranded>() =>
    <const T>(base: T): Brand<T, ResolveTags<B> & string> =>
      base as Brand<T, ResolveTags<B> & string>;
