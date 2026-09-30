import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { base64 } from "@onrail-xyz/utils";
import { serialize, deserialize } from "@onrail-xyz/binary-layout";
import { base58 } from "../src/encoding.js";
import { mintAccountLayout, tokenAccountLayout,
         durableNonceAccountLayout, addressLookupTableLayout,
         accountLayout, instructionLayout, eventLayout,
         discriminatorOf, addressItem, bumpItem,
         u64Item, vecBytesItem, vecArrayItem,
         cOptionItem, defaultOptionItem, cEnumItem, littleEndian } from "../src/index.js";

//fixtures captured from mainnet at slot ~437047333 (2026-08-03); expected values come from the
//  RPC's own jsonParsed responses for the same data, i.e. Solana's account parsers are the oracle

describe("mint account layout", () => {
  //USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  const data = base64.decode(
    "AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmbbw6eEsZJGwAGAQEAAABicKqKWcWUBbRShshncubN" +
    "Em6bil06OFNtN/e0FOi2Zw=="
  );

  it("deserializes the USDC mint", () => {
    const mint = deserialize(mintAccountLayout(), data);
    assert.strictEqual(mint.mintAuthority, "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG");
    assert.strictEqual(mint.supply, 7680939435888239n);
    assert.strictEqual(mint.decimals, 6);
    assert.strictEqual(mint.isInitialized, true);
    assert.strictEqual(mint.freezeAuthority, "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar");
  });

  it("round-trips byte-exactly", () => {
    assert.deepStrictEqual(
      serialize(mintAccountLayout(), deserialize(mintAccountLayout(), data)),
      data
    );
  });
});

describe("token account layout", () => {
  //plain USDC token account: Ac7YW6ktKRNX9aEFFes2NBsgYtz77PJX3CZg5KK7gx3B
  const usdcData = base64.decode(
    "xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWFBkiOb7GPMi1NAGOWDHGXebLXT8c1G9KNcuu8gXpunchH/+g" +
    "wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );

  //wrapped-SOL token account (isNative = Some(rentExemptReserve)):
  //  BRUkmtZMCSDjLeGZ7xYqan1eRMGpCqi3QHQX42VniBog, account lamports were 88880130
  //  = amount (86840850) + rentExemptReserve (2039280)
  const wsolData = base64.decode(
    "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAFIu8obxSchzt+Wm0fpE5FjWTep9c3QcJ4/b5fYCibP0BIWLQ" +
    "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAADwHR8AAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );

  it("deserializes a plain token account (all COptions None)", () => {
    const acc = deserialize(tokenAccountLayout(), usdcData);
    assert.strictEqual(acc.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.strictEqual(acc.owner, "5QxkJGkYTxkJBp575w39Qumi8v2g3bxLWaXjpJsquYky");
    assert.strictEqual(acc.amount, 217775889n);
    assert.strictEqual(acc.delegate, undefined);
    assert.strictEqual(acc.state, "Initialized");
    assert.strictEqual(acc.isNative, undefined);
    assert.strictEqual(acc.delegatedAmount, 0n);
    assert.strictEqual(acc.closeAuthority, undefined);
  });

  it("deserializes a wrapped-SOL account (isNative = Some)", () => {
    const acc = deserialize(tokenAccountLayout(), wsolData);
    assert.strictEqual(acc.mint, "So11111111111111111111111111111111111111112");
    assert.strictEqual(acc.owner, "5tvSJRH4BUgJD3sR83Exnn13Zi524Dzo48GB4QaiFu9H");
    assert.strictEqual(acc.amount, 86840850n);
    assert.strictEqual(acc.state, "Initialized");
    assert.strictEqual(acc.isNative, 2039280n);
  });

  it("round-trips both byte-exactly", () => {
    for (const data of [usdcData, wsolData])
      assert.deepStrictEqual(
        serialize(tokenAccountLayout(), deserialize(tokenAccountLayout(), data)),
        data,
      );
  });
});

describe("durable nonce account layout", () => {
  //nonce account: Cwe1oHwY8fnsQUAFiFYQDhGmm3ymiz7q9SjEdx4w7U1
  const data = base64.decode(
    "AQAAAAEAAABRzD93+UgC8ruAbsZZouskcvsl4VCp4hn4Mbxs13uUwojpyLEcg6gY8FvTMxSQWlRljYuk6Lba4cTl" +
    "h2CGLN4viBMAAAAAAAA="
  );

  it("deserializes a live nonce account", () => {
    const nonce = deserialize(durableNonceAccountLayout(), data);
    assert.strictEqual(nonce.version, "Current");
    assert.strictEqual(nonce.state, "Initialized");
    assert.strictEqual(nonce.authority, "6WJfN1fqrEEMSVKnzZkR4vJTMTxBaqvka2KA7aQHJMfF");
    assert.deepStrictEqual(
      nonce.blockhash,
      base58.decode("ADTCz2kc6p5FUYeUy1PyduFpAShacmtkvj3HLn6NZErJ"),
    );
    assert.strictEqual(nonce.lamportsPerSignature, 5000n);
  });

  //the data fields of an uninitialized allocation read as zeros: the zero address, a zero
  //  hash and no fee - conspicuous, not mistakable for a nonce
  it("decodes an uninitialized nonce account with zeroed data fields", () => {
    const uninitialized = new Uint8Array(80);
    uninitialized[0] = 1; //version Current, state Uninitialized, zeros after
    const nonce = deserialize(durableNonceAccountLayout(), uninitialized);
    assert.strictEqual(nonce.state, "Uninitialized");
    assert.strictEqual(nonce.authority, "11111111111111111111111111111111");
    assert.deepStrictEqual(nonce.blockhash, new Uint8Array(32));
    assert.strictEqual(nonce.lamportsPerSignature, 0n);
  });

  it("round-trips byte-exactly", () => {
    assert.deepStrictEqual(
      serialize(durableNonceAccountLayout(), deserialize(durableNonceAccountLayout(), data)),
      data,
    );
  });
});

describe("address lookup table layout", () => {
  //ALT: DWRWHuoNy96QQo9ysuJUV1XqieX9z7fbABqnfPWLmFkb (1784 bytes, 54 addresses)
  //exercises the bincode Option (1-byte tag) + alignment padding, i.e. the fixed 56-byte
  //  metadata offset preceding the raw address array
  const data = base64.decode(
    "AQAAANjPDBoAAAAA+8sMGgAAAAAbAcXYUt50YheTfh0YUVIOI8UfH32/qF7z7i6zJW0r/RhkAAAczr6UMQK55LvVC8Yx" +
    "Mvds2GRr4VcTGyM0Qh2Sg7KBqyIa2ZPkNU81v9+/fCnstPTWYw+dxgLew/MXQ1PwB8cjYlvcSzeOJwOc3c0FEY/yw9V8" +
    "r78fNAzjXI6bynZdG8tQtmWiMi4vMJ1D22cseinX+FQh1Zo7MXMHftnr9ZhT/ZoLt90K3gRTnhOiYUIFq7Vri6bP5Xis" +
    "nvfK7kUQhaosAm+MqHkZefPGtrWrnO0jSztRl+Wydi92y/QR4TCys2EHROekHFHeSPSpBkvEP+BMjUcMi8gFeiqacaMU" +
    "iAoETQi9QaU2CkdsfoCW9aBKp6XzGCxVV/u7dSIlCVowsHIGNM+hymKia+kozgBJp9Nr7IpLkFpuTr6+VefsG5JlI8ja" +
    "JikNa1ih8SEp5zZz2eZ6JnJqzyGORXnjxRRAscUyQQUwDM2CbsjpX2rDiUBEF2OL7VRLaKECqNccoFYzIklth6FZa3VA" +
    "aaHTqTtx9qnPVo7WdJvXyPDz/6tIK7vdOGsUqI0QmNrYcUyXXNRaC/VMTWaLad2Z0nyx5zlZ1SDRU4SQyr7qF4MIw75l" +
    "8SEAk/8lrI6BQEsM90auHVkgQd9hzhIo3T3Ec69WPg83NQHL6a8Ffa0sSiFcY4Jei2xcd5pka/B9ETId3VpydcPrG4jy" +
    "xzZ3WsBmFFcESFam7ZWwLMqBESDiJHKTUawtAbeSz7fQ3f2hEfpI7G3tAETbk98r0iIQc7aCxR1LWuMB7ri2xJYGYnBS" +
    "oXSSY83yaWiSEEaOEbuSYUUURVIBc8l33UibQFmi949j4xAgFdLNYWVbNIa5Gb9uEzG1BD8RRwVkD6dDcSzBnflDjDww" +
    "gv7qJK3nBSH2a4yhWaVkEKSXEqA2q2v6qdhw828m8QJwmPQXjUZZcAm+FyueQpEmUgEoBAYPwju2vSfkngSTwRijjvI1" +
    "YvrJ8EOLWP2OCpxg7UVqxZrlJPFtP2qBnqvnDAqvTXneXN/CTRy+frT3Q/48r3tEaZ1rVwOQAe5NyGonqHKT2dULHGGi" +
    "aoh4od07d/pbfJOKMuFzi4gpxeiihgYrGdFfg/McG3LMHBts9eWmXvwk9JKNaM8Js2yDptsgIELivhj4wm/xA3GkOxk/" +
    "Vl0mbw19In3I0KJG6Qj5LRp4LRreUDlZRKdQKsBOTHcfleG1Gn2/W8vqwt/gD76X5VpCnGVcK7M8sjfI5JXfLjRYmL4G" +
    "3jvDVmiK5TsqrtPN+wFL0jv9o1KKL/ILt1C222fS2ZrqGkyY2pfWt+8W2qdItAT77OwG05Dl4S9aG8I7xOv8JFzkE//V" +
    "UoikYinguVNrRRQrldR+3RxqqS12Y4FiylJZzpGqLHbismUwFImBhNq9lAMzJKCl+mA8yyWOLU0Jh+vrMtN5ng16pdt6" +
    "Hfj439OO9kc/bYslOgvwVCXQbMQe0xmmLWSHJbi7e0ixGoPIGukn2Zvis+7/EK3J1ckQDJlA31ve0TpvC5g5rz8yIufe" +
    "K6xX6qbiehvC9kchHRXerE80CJGMKs66FA6OVx+sMnQeonFSLHducLSGAGqAnfywqgAIB5Elqi5mYtsj+2Dm9N29vpHe" +
    "MBLxcd2xuUMIISCJcwzK9mOgd2ged8zbSaHrG/ZIytW1Jh7oDRLLhL2kWedGIo2hXpyRqu4SMjA/ZHSVK/obdchp9fAn" +
    "qqjc32jR7y5gH4VtB1nQYkyRsZErIvoPQkVfMdzbzB3srYjShOPe7uBZ9isiR28hgtnfJUYZYEI/7M2sberCe9awkgaV" +
    "SoWtmPn38gtPkkoo7+5Ne2tJXW28YS2481rYiORT2w/Mvq/ewBEWfqh+flvJhkkRSgeI6qyI+75lZUt4CsxLXdczbw8n" +
    "8S3OpGgWUVELZiWD57h525NyqE9ij0C6OnlXljr/pTFm7Ul5rsAqF9I2mTKjgSLgwtjxPCK1ux+4CNBDaj+kBrhulBG0" +
    "Bn3xNcuv9HngZo7Z6WlVMMqQavwoiPICUUK57KNDl6b86uJAYUImLc1NfQ7Fjdf45NwFt5HpCSXuS4oDoQ2yxw9oVgaW" +
    "a2C95UWNudBoR1JEBMrFarkvHCjjgZAUiQSkiWntTMuj/vNcmR7WXI+pzzhx0gzgJkvtIayN8JPLbuJF2ZhE80SpbDJp" +
    "FyCVudrOVxs3VlsPyE3riwW/lGx234+5guud5IZmjwwu3HgkcwMOV4fxrE6jbpLtpwqAYrDlhsO6YkWIMLbzuWZiSuUU" +
    "JBjQb/7YUInN3qKz8a/I4i9ZfcSBERJN6pNyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI="
  );

  it("deserializes a live lookup table", () => {
    const alt = deserialize(addressLookupTableLayout, data);
    assert.strictEqual(alt.deactivationSlot, 437047256n);
    assert.strictEqual(alt.lastExtendedSlot, 437046267n);
    assert.strictEqual(alt.lastExtendedSlotStartIndex, 27);
    assert.strictEqual(alt.authority, "EKJdnbDfAXv7UdBTApG6yNJ4vbNY2G82a3baNC39LLHZ");
    assert.strictEqual(alt.addresses.length, 54);
    assert.strictEqual(alt.addresses[0], "2wTGAGZYaxr8fDy3pcJy1QuLPBfg3HY7N9QQTfwWeHjG" as Address);
    assert.strictEqual(alt.addresses[53], "11111111111111111111111111111113" as Address);
  });

  it("round-trips byte-exactly", () => {
    assert.deepStrictEqual(
      serialize(addressLookupTableLayout, deserialize(addressLookupTableLayout, data)),
      data,
    );
  });
});

describe("layout items", () => {
  it("addressItem round-trips a base58 address", () => {
    const address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
    const encoded = serialize(addressItem, address);
    assert.strictEqual(encoded.length, 32);
    assert.deepStrictEqual(encoded, base58.decode(address));
    assert.strictEqual(deserialize(addressItem, encoded), address);
  });

  it("vecBytesItem and vecArrayItem use a u32 little-endian length prefix", () => {
    const bytesEncoded = serialize(vecBytesItem(), Uint8Array.from([1, 2, 3]));
    assert.deepStrictEqual(bytesEncoded, Uint8Array.from([3, 0, 0, 0, 1, 2, 3]));

    const arrayEncoded = serialize(vecArrayItem(bumpItem), [255, 254]);
    assert.deepStrictEqual(arrayEncoded, Uint8Array.from([2, 0, 0, 0, 255, 254]));
    assert.deepStrictEqual(deserialize(vecArrayItem(bumpItem), arrayEncoded), [255, 254]);
  });

  it("cOptionItem uses a 4-byte discriminant and round-trips both cases", () => {
    const item = cOptionItem(u64Item);
    assert.deepStrictEqual(serialize(item, undefined), new Uint8Array(12));
    assert.deepStrictEqual(
      serialize(item, 1n),
      Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    );
    assert.strictEqual(deserialize(item, new Uint8Array(12)), undefined);
    assert.strictEqual(deserialize(item, serialize(item, 7n)), 7n);
  });

  it("defaultOptionItem takes the tag width and the absent body's value", () => {
    //the 1-byte tag of the bincode-encoded lookup table
    const item = defaultOptionItem(u64Item, 0xffn, 1);
    assert.deepStrictEqual(serialize(item, undefined), Uint8Array.from([0, 0xff, 0, 0, 0, 0, 0, 0, 0]));
    assert.strictEqual(deserialize(item, serialize(item, undefined)), undefined);
    assert.strictEqual(deserialize(item, serialize(item, 7n)), 7n);
  });

  it("cOptionItem requires a body of static size", () => {
    assert.throws(() => cOptionItem(vecBytesItem()), /static size/);
  });

  it("littleEndian flips a big-endian layout", () => {
    const beItem = { binary: "uint", size: 4 } as const;
    assert.deepStrictEqual(serialize(beItem, 1), Uint8Array.from([0, 0, 0, 1]));
    assert.deepStrictEqual(serialize(littleEndian(beItem), 1), Uint8Array.from([1, 0, 0, 0]));
  });

  it("cEnumItem maps names to their index", () => {
    const item = cEnumItem(["a", "b", "c"] as const);
    assert.deepStrictEqual(serialize(item, "c"), Uint8Array.from([2]));
    assert.strictEqual(deserialize(item, Uint8Array.from([1])), "b");
    assert.throws(() => deserialize(item, Uint8Array.from([3])), /Invalid enum value/);
  });
});

describe("anchor-style discriminated layouts", () => {
  it("accountLayout prefixes the account discriminator and hides it from the type", () => {
    const layout = accountLayout("MyAccount", {
      owner:  addressItem,
      amount: u64Item,
    });
    const owner = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
    const encoded = serialize(layout, { owner, amount: 42n });
    assert.deepStrictEqual(encoded.subarray(0, 8), discriminatorOf("account", "MyAccount"));
    assert.strictEqual(encoded.length, 8 + 32 + 8);
    assert.deepStrictEqual(deserialize(layout, encoded), { owner, amount: 42n });
  });

  it("instructionLayout wraps a single item and rejects a foreign discriminator", () => {
    const layout = instructionLayout("initialize", u64Item);
    const encoded = serialize(layout, 1n);
    assert.deepStrictEqual(encoded.subarray(0, 8), discriminatorOf("instruction", "initialize"));
    assert.strictEqual(deserialize(layout, encoded), 1n);

    const wrong = Uint8Array.from(encoded);
    wrong[0] = wrong[0]! ^ 0xff;
    assert.throws(() => deserialize(layout, wrong));
  });

  //the generated field led as `discriminator`, so a layout's own field of that name displaced it
  it("keeps the prefix under a layout field named discriminator", () => {
    const layout = instructionLayout("initialize", { discriminator: bumpItem });
    const encoded = serialize(layout, { discriminator: 7 });
    assert.deepStrictEqual(encoded.subarray(0, 8), discriminatorOf("instruction", "initialize"));
    assert.strictEqual(encoded.length, 9);
    assert.deepStrictEqual(deserialize(layout, encoded), { discriminator: 7 });
  });

  it("eventLayout uses the event namespace", () => {
    const layout = eventLayout("MyEvent", {});
    assert.deepStrictEqual(serialize(layout, undefined), discriminatorOf("event", "MyEvent"));
  });
});
