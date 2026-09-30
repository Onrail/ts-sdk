import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonStringify, jsonParse, bigintCodec } from "@onrail-xyz/utils";
import { Amount, Rational, kind } from "../src/index.js";
import { amountCodec, rateCodec, rationalCodec } from "../src/jsonCodecs.js";

const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "ETH" }] },
    { symbols: [{ symbol: "wei" }], oom: -18 } ],
  { human: "ETH", atomic: "wei" },
);
const eth = Amount.ofKind(ETH);

const USD = kind(
  "USD",
  [ { symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }] },
    { symbols: [{ symbol: "c" }], oom: -2 } ],
  { human: "$", atomic: "c" },
);
const usd = Amount.ofKind(USD);

const codecs = [amountCodec([ETH, USD]), rateCodec(USD, ETH), rationalCodec, bigintCodec];
const roundTrip = (value: unknown) => jsonParse(jsonStringify(value, codecs), codecs);

describe("jsonCodecs", () => {
  it("round-trips amounts of every exactness class", () => {
    for (const amount of [eth(1.5), eth(1).div(3), eth(-1).div(3), usd("0.01"), usd(0)]) {
      const back = roundTrip(amount) as Amount<typeof ETH | typeof USD>;
      assert(back.eq(amount as never), amount.toJSON());
      assert(Amount.isOfKind(back, amount.kind));
    }
  });

  it("round-trips rationals and conversions", () => {
    const third = Rational.from(1n, 3n);
    assert(Rational.from(roundTrip(third) as Rational).eq(third));

    const price  = usd(3000).per(ETH);
    const thirds = price.div(3);
    for (const conversion of [price, thirds])
      assert((roundTrip(conversion) as typeof price).eq(conversion));
  });

  it("round-trips mixed structures", () => {
    const value = {
      balances: [eth(1).div(3), usd("1,000.50")],
      price:    usd(3000).per(ETH),
      ratio:    Rational.from(22n, 7n),
      nonce:    123456789012345678901234567890n,
    };
    const back = roundTrip(value) as typeof value;
    assert(back.balances[0]!.eq(value.balances[0] as never));
    assert(back.balances[1]!.eq(value.balances[1] as never));
    assert(back.price.eq(value.price));
    assert(back.ratio.eq(value.ratio));
    assert.strictEqual(back.nonce, value.nonce);
  });

  it("names the kind on the wire", () => {
    assert.strictEqual(
      jsonStringify(eth(1).div(3), codecs),
      '{"$type":"Amount","value":{"kind":"ETH","value":"1/3 ETH"}}',
    );
    assert.strictEqual(
      jsonStringify(usd(3000).per(ETH), codecs),
      '{"$type":"Rate","value":{"num":"USD","den":"ETH","value":"$3,000/ETH"}}',
    );
  });

  // Regression: the kind used to be recovered from the rendering alone, so two candidates
  // sharing a unit symbol made identifyKind ambiguous and the round-trip threw on the way
  // back in - after the data had already been written.
  it("round-trips kinds that share a unit symbol", () => {
    const Fee = kind("Fee", [{ symbols: [{ symbol: "%" }] }], { human: "%" });
    const Apy = kind("Apy", [{ symbols: [{ symbol: "%" }] }], { human: "%" });
    const shared = [amountCodec([Fee, Apy])];

    const fee = Amount.from(5, Fee);
    const backFee = jsonParse(jsonStringify(fee, shared), shared) as Amount<typeof Fee>;
    assert(backFee.eq(fee));
    assert.strictEqual(backFee.kind.name, "Fee");

    //the identical rendering "5 %" decodes to the other kind purely on the wire's kind name
    const apy = Amount.from(5, Apy);
    const backApy = jsonParse(jsonStringify(apy, shared), shared) as Amount<typeof Apy>;
    assert(backApy.eq(apy));
    assert.strictEqual(backApy.kind.name, "Apy");
  });

  it("decoding an amount whose kind is not a candidate fails loudly", () => {
    const BTC = kind("BTC", [{ symbols: [{ symbol: "BTC" }] }], { human: "BTC" });
    const btcOnly = [amountCodec([BTC])];
    const json = jsonStringify(eth(1), btcOnly); //encoding is total: test claims any Amount
    assert.throws(() => jsonParse(json, btcOnly), /No candidate kind named "ETH"/);
  });

  it("rejects a malformed payload", () => {
    const ethOnly = [amountCodec([ETH])];
    for (const bogus of ['{"$type":"Amount","value":"1 ETH"}',
                         '{"$type":"Amount","value":{"kind":"ETH"}}',
                         '{"$type":"Amount","value":{"kind":1,"value":"1 ETH"}}'])
      assert.throws(() => jsonParse(bogus, ethOnly), /Invalid Amount payload/);
  });
});
