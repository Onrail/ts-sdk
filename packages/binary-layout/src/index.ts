//we export everything from layout.js because it's very easy to stumble over error
//  ts(4023) or ts(2742) regarding types from external modules that cannot be named/referenced
export * from "./layout.js";
export { numSizeToPrimitive, numBitsToPrimitive,
         isItem, isStruct, isLayout, isNumberSize, isOmitted,
         hasFixed, fixedOf, hasAs, asOf, hasCustom, customOf, rawIdOf,
         findVariantByRawId, variantTagValue, findVariantByTagValue } from "./utils.js";
export { type SerializeReturn, serialize } from "./serialize.js";
export { type DeserializeReturn, deserialize } from "./deserialize.js";
export { calcSize, calcStaticSize } from "./size.js";
export { fitsInBits, checkFitsInBits, readNum, writeNum } from "./numbers.js";
export * from "./discriminate.js";
export * from "./setEndianness.js";
export * from "./manipulate.js";
export * from "./items.js";
export * from "./timestamp.js";
export * from "./codecs.js";
