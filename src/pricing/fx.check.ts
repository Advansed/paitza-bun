import assert from "node:assert/strict";
import { convertAmount, crossRate } from "./fx.ts";

assert.equal(convertAmount(100, 12, 1.2), 1000);
assert.equal(crossRate(12, 1.2), 10);
assert.equal(convertAmount(100, 12, 12), 100);
assert.equal(crossRate(12, 12), 1);
assert.throws(() => convertAmount(100, 0, 1));

console.log("fx ok");
