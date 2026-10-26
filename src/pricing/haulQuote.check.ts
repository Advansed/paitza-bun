import assert from "node:assert/strict";
import { haulQuote, HaulQuoteError, URBAN_MAX_KM } from "./haulQuote.ts";

const byWeight = haulQuote({
  formula: 1,
  minTarif: 10,
  maxTarif: 20,
  distanceKm: 100,
  weight: 20,
});
assert.deepEqual(byWeight, {
  min: 20000,
  target: 30000,
  max: 40000,
  currency: "RUB",
  urbanApplied: false,
  urbanCoef: 3,
});

const byKm = haulQuote({
  formula: 2,
  minTarif: 10,
  maxTarif: 20,
  distanceKm: 100,
  weight: null,
});
assert.deepEqual(byKm, {
  min: 1000,
  target: 1500,
  max: 2000,
  currency: "RUB",
  urbanApplied: false,
  urbanCoef: 3,
});

const urban = haulQuote({
  formula: 2,
  minTarif: 10,
  maxTarif: 20,
  distanceKm: URBAN_MAX_KM,
  weight: null,
  urbanCoef: 3.5,
});
assert.equal(urban.urbanApplied, true);
assert.equal(urban.urbanCoef, 3.5);
assert.equal(urban.min, 10 * URBAN_MAX_KM * 3.5);
assert.equal(urban.max, 20 * URBAN_MAX_KM * 3.5);

assert.throws(
  () => haulQuote({ formula: 1, minTarif: 10, maxTarif: 20, distanceKm: 100, weight: null }),
  HaulQuoteError,
);
assert.throws(
  () => haulQuote({ formula: 2, minTarif: 10, maxTarif: 20, distanceKm: null, weight: 20 }),
  HaulQuoteError,
);
assert.throws(
  () => haulQuote({ formula: 1, minTarif: null, maxTarif: 20, distanceKm: 100, weight: 20 }),
  HaulQuoteError,
);

console.log("haulQuote ok");
