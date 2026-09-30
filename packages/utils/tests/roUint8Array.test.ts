import type { RoUint8Array } from "../src/typing.js";
import type { Assert } from "./typeAssert.js";

type CBArrayParam<T> =
  T extends (cb: (value: number, index: number, array: infer A) => any, ...rest: any[]) => any
  ? A
  : never;

// ============================================================================
// Assignability tests
// ============================================================================

// Uint8Array should be assignable to RoUint8Array
type _AssignabilityTest1 = Assert<Uint8Array              extends RoUint8Array ? true : false>;
type _AssignabilityTest2 = Assert<Uint8Array<ArrayBuffer> extends RoUint8Array ? true : false>;
type _AssignabilityTest2b = Assert<Uint8Array<SharedArrayBuffer> extends RoUint8Array ? true : false>;

// RoUint8Array should NOT be assignable to Uint8Array (it's missing mutable methods)
type _AssignabilityTest3 = Assert<RoUint8Array            extends Uint8Array ? false : true>;

// ============================================================================
// Mutable methods and the writable-view escape should be absent
// ============================================================================

type _MutableMethodsAbsent1 = Assert<"copyWithin"    extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent2 = Assert<"fill"          extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent3 = Assert<"reverse"       extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent4 = Assert<"set"           extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent5 = Assert<"sort"          extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent6 = Assert<"setFromBase64" extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent7 = Assert<"setFromHex"    extends keyof RoUint8Array ? false : true>;
type _MutableMethodsAbsent8 = Assert<"buffer"        extends keyof RoUint8Array ? false : true>;

// ============================================================================
// Callback methods should receive RoUint8Array in the array parameter
// ============================================================================

type _CBT1 = Assert<CBArrayParam<RoUint8Array["every"]>     extends RoUint8Array ? true : false>;
type _CBT2 = Assert<CBArrayParam<RoUint8Array["some"]>      extends RoUint8Array ? true : false>;
type _CBT3 = Assert<CBArrayParam<RoUint8Array["forEach"]>   extends RoUint8Array ? true : false>;
type _CBT4 = Assert<CBArrayParam<RoUint8Array["map"]>       extends RoUint8Array ? true : false>;
type _CBT5 = Assert<CBArrayParam<RoUint8Array["filter"]>    extends RoUint8Array ? true : false>;
type _CBT6 = Assert<CBArrayParam<RoUint8Array["find"]>      extends RoUint8Array ? true : false>;
type _CBT7 = Assert<CBArrayParam<RoUint8Array["findIndex"]> extends RoUint8Array ? true : false>;

// Callback array param should NOT be plain Uint8Array (it should be the more specific RoUint8Array)
type _CBU = Assert<CBArrayParam<RoUint8Array["map"]>       extends Uint8Array    ? false : true>;

// ============================================================================
// Return types: methods that create copies should return Uint8Array
// ============================================================================

type _RTT1 = Assert<ReturnType<RoUint8Array["slice"]>  extends Uint8Array ? true : false>;
type _RTT2 = Assert<ReturnType<RoUint8Array["map"]>    extends Uint8Array ? true : false>;
type _RTT3 = Assert<ReturnType<RoUint8Array["filter"]> extends Uint8Array ? true : false>;

// ============================================================================
// subarray should return RoUint8Array (it's a view, not a copy)
// ============================================================================

type _SATest = Assert<ReturnType<RoUint8Array["subarray"]> extends RoUint8Array ? true : false>;

// ============================================================================
// Index signature should be readonly (number values, but not assignable)
// ============================================================================

type _IATIndexAccessTest = Assert<
  RoUint8Array[number] extends number
  ? number extends RoUint8Array[number]
    ? true
    : false
  : false
>;
