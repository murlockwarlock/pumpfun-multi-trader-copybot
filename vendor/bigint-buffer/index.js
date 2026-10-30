"use strict";

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("Expected a Buffer or Uint8Array");
}

function widthBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Width must be a non-negative safe integer");
  }
  return value;
}

function unsigned(value) {
  const result = BigInt(value);
  if (result < 0n) throw new RangeError("Only unsigned BigInt values are supported");
  return result;
}

function toBigIntBE(value) {
  const hex = bytes(value).toString("hex");
  return hex ? BigInt(`0x${hex}`) : 0n;
}

function toBigIntLE(value) {
  return toBigIntBE(Buffer.from(bytes(value)).reverse());
}

function toBufferBE(value, width) {
  const size = widthBytes(width);
  if (size === 0) return Buffer.alloc(0);
  const hex = unsigned(value).toString(16).padStart(size * 2, "0");
  return Buffer.from(hex.slice(-size * 2), "hex");
}

function toBufferLE(value, width) {
  return Buffer.from(toBufferBE(value, width)).reverse();
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
