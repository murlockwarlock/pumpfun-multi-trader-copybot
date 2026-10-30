import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } = require(
  "../vendor/bigint-buffer"
);

test("pure JavaScript bigint-buffer override preserves endian conversions", () => {
  const value = 0x0123456789abcdefn;
  const bigEndian = Buffer.from("0123456789abcdef", "hex");
  const littleEndian = Buffer.from(bigEndian).reverse();
  assert.deepEqual(toBufferBE(value, 8), bigEndian);
  assert.deepEqual(toBufferLE(value, 8), littleEndian);
  assert.equal(toBigIntBE(bigEndian), value);
  assert.equal(toBigIntLE(littleEndian), value);
});

test("pure JavaScript bigint-buffer override validates unsafe input", () => {
  assert.throws(() => toBufferBE(-1n, 8), /unsigned/);
  assert.throws(() => toBufferLE(1n, -1), /Width/);
  assert.throws(() => toBigIntBE("not-a-buffer"), /Buffer/);
});
