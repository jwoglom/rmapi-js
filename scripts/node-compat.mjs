/**
 * verify the built output actually runs on plain node
 *
 * The test suite runs under bun, which implements things node does not, so it
 * cannot catch either of the two ways this package has broken on node:
 *
 *   - an import that bundlers and bun resolve but node's ESM resolver does not
 *     (a missing file extension), which kills the CLI at startup
 *   - a method that only exists in bun and node 24+ (`Uint8Array#toHex`,
 *     `#toBase64`, `Uint8Array.fromHex`), which only fails on write paths, so
 *     reads look perfectly healthy right up until an upload
 *
 * Run against dist/ after building, on every node version `engines` claims to
 * support.
 */
import assert from "node:assert/strict";

const { toBase64, fromHex, toHex } = await import("../dist/utils.js");
// importing the entry points is itself a test: it walks the whole module graph
// through node's ESM resolver, which is what an extensionless import fails
await import("../dist/index.js");

// sha-256 of "abc", hex encoded exactly the way digest() in raw.ts does it
const enc = new TextEncoder();
const hashed = await crypto.subtle.digest("SHA-256", enc.encode("abc"));
const hex = toHex(new Uint8Array(hashed));
assert.equal(
  hex,
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "digest() hex encoding is wrong",
);

assert.equal(toHex(new Uint8Array([0, 1, 15, 255])), "00010fff");
assert.deepEqual(fromHex("00010fff"), new Uint8Array([0, 1, 15, 255]));
assert.deepEqual(fromHex(hex).length, 32);

// the crc32c header putFile sends with every uploaded file
const crc = new ArrayBuffer(4);
new DataView(crc).setInt32(0, -1, false);
assert.equal(toBase64(new Uint8Array(crc)), "/////w==");
assert.equal(toBase64(new Uint8Array([0, 1, 2, 253, 254, 255])), "AAEC/f7/");

// large enough that String.fromCharCode(...bytes) would exceed the argument limit
assert.equal(toBase64(new Uint8Array(200_000).fill(65)).length, 266_668);

console.log(`node-compat ok on ${process.version}`);
