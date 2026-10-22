import assert from "node:assert/strict";
import { quoteToCny } from "./cny.ts";
import { haulQuote } from "./haulQuote.ts";

const byWeight = haulQuote({
  formula: 1,
  minTarif: 10,
  maxTarif: 20,
  distanceKm: 100,
  weight: 20,
});
assert.deepEqual(quoteToCny(byWeight, 10, "2026-10-22"), {
  min: 2000,
  target: 3000,
  max: 4000,
  currency: "CNY",
  rate: 10,
  rateDate: "2026-10-22",
});

const byKm = haulQuote({
  formula: 2,
  minTarif: 10,
  maxTarif: 20,
  distanceKm: 100,
  weight: null,
});
const fen = quoteToCny(byKm, 11.5, "2026-10-22T00:00:00");
assert.equal(fen.min, 86.96);
assert.equal(fen.target, 130.43);
assert.equal(fen.max, 173.91);
assert.equal(fen.currency, "CNY");
assert.equal(fen.rate, 11.5);

assert.throws(() => quoteToCny(byWeight, 0, "2026-10-22"));

console.log("cny ok");
