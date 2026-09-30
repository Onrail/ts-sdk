//Property tests over randomly generated layouts: a discriminator never drops the layout that
//  produced the data (perfect sensitivity), and deserialization is injective (re-serializing a
//  deserialized value reproduces its exact bytes). Seeded, so a failure is reproducible.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Layout } from "../src/index.js";
import { serialize, deserialize, buildDiscriminator,
         calcStaticSize, uintItem, bytesItem, arrayItem, switchItem } from "../src/index.js";

const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

type Gen = { layout: Layout; value: () => unknown };

const generators = (rnd: () => number) => {
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]) => xs[ri(xs.length)]!;
  const someBytes = (length: number) => new Uint8Array(Array.from({ length }, () => ri(3)));

  const item = (depth: number): Gen => {
    switch (ri(depth > 1 ? 5 : 8)) {
      case 0: {
        const size = pick([1, 2]);
        return { layout: uintItem(size), value: () => ri(256 ** size) };
      }
      case 1:
        return { layout: uintItem(pick([1, 2]), { fixed: ri(4) }), value: () => undefined };
      case 2:
        return { layout: bytesItem({ fixed: someBytes(1 + ri(2)) }), value: () => undefined };
      case 3: {
        const size = ri(3);
        return { layout: bytesItem(size), value: () => someBytes(size) };
      }
      case 4:
        return { layout: bytesItem(uintItem(1)), value: () => someBytes(ri(3)) };
      case 5: {
        const inner = item(depth + 1);
        const length = ri(3);
        return {
          layout: arrayItem(inner.layout, length),
          value: () => Array.from({ length }, inner.value),
        };
      }
      case 6: {
        //zero-size elements are excluded: the forward-progress guard that keeps a malicious
        //  count prefix from driving unbounded work refuses them on deserialization
        let inner = item(depth + 1);
        while (calcStaticSize(inner.layout) === 0)
          inner = item(depth + 1);

        return {
          layout: arrayItem(inner.layout, uintItem(1)),
          value: () => Array.from({ length: ri(3) }, inner.value),
        };
      }
      default: {
        const ids = [...new Set(Array.from({ length: 1 + ri(3) }, () => ri(4)))];
        const bodies = ids.map(() => struct(depth + 1, false));
        const rows = ids.map((id, i) => [id, bodies[i]!.layout] as const);
        return {
          layout: switchItem("t", uintItem(1), rows as any) as Layout,
          value: () => {
            const i = ri(ids.length);
            return { t: ids[i], ...(bodies[i]!.value() as object) };
          },
        };
      }
    }
  };

  //a trailing flex is legal at the end of a top-level struct: nothing follows it
  const struct = (depth: number, allowFlex: boolean): Gen => {
    const fields: [string, Gen][] =
      Array.from({ length: ri(4) }, (_, i) => [`f${i}`, item(depth)]);
    if (allowFlex && rnd() < 0.3)
      fields.push(["flex", { layout: bytesItem(), value: () => someBytes(ri(3)) }]);

    return {
      layout: Object.fromEntries(fields.map(([key, gen]) => [key, gen.layout])) as Layout,
      value: () => Object.fromEntries(fields.flatMap(([key, gen]) => {
        const value = gen.value();
        return value === undefined ? [] : [[key, value]];
      })),
    };
  };

  const layoutSet = (): Gen[] =>
    Array.from({ length: 2 + ri(3) }, () => rnd() < 0.5 ? struct(0, true) : item(0));

  return { layoutSet };
};

describe("randomly generated layout sets", () => {
  for (const seed of [1, 2, 3]) {
    it(`never lose the true layout and round-trip exactly (seed ${seed})`, () => {
      const { layoutSet } = generators(lcg(seed));
      for (let set = 0; set < 400; ++set) {
        const gens = layoutSet();
        const discriminator = buildDiscriminator(gens.map(gen => gen.layout), true);
        for (const [index, gen] of gens.entries())
          for (let sample = 0; sample < 5; ++sample) {
            const encoded = serialize(gen.layout, gen.value() as any);
            assert.ok(discriminator(encoded).includes(index),
              `discriminator dropped layout ${index} for ${encoded.toHex()}`);
            assert.deepEqual(serialize(gen.layout, deserialize(gen.layout, encoded)), encoded);
          }
      }
    });
  }
});
