import { describe, expect, test } from "bun:test";
import { fromHex, mapPool, toBase64, toHex } from "./utils.js";

/** resolve after yielding to the event loop `times` times */
async function ticks(times: number): Promise<void> {
  for (let i = 0; i < times; ++i) {
    await Promise.resolve();
  }
}

describe("mapPool()", () => {
  test("preserves order", async () => {
    const items = [5, 4, 3, 2, 1, 0];
    // later items resolve sooner, so completion order isn't input order
    const res = await mapPool(items, 2, async (val, index) => {
      await ticks(val);
      return `${index}:${val}`;
    });
    expect(res).toEqual(["0:5", "1:4", "2:3", "3:2", "4:1", "5:0"]);
  });

  test("never exceeds the limit", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await mapPool(items, 4, async (val) => {
      ++inFlight;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await ticks(3);
      --inFlight;
      return val * 2;
    });
    expect(res).toEqual(items.map((val) => val * 2));
    expect(maxInFlight).toBe(4);
    expect(inFlight).toBe(0);
  });

  test("uses fewer workers than the limit for small inputs", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    await mapPool([1, 2], 16, async (val) => {
      ++inFlight;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await ticks(2);
      --inFlight;
      return val;
    });
    expect(maxInFlight).toBe(2);
  });

  test("propagates rejections", async () => {
    const started: number[] = [];
    const prom = mapPool([0, 1, 2, 3, 4, 5], 2, async (val) => {
      started.push(val);
      await ticks(1);
      if (val === 1) {
        throw new Error(`failed on ${val}`);
      }
      return val;
    });
    await expect(prom).rejects.toThrow("failed on 1");
    // the failing worker stops pulling work, but the other keeps going until
    // the pool settles, so we never start everything
    expect(started.length).toBeLessThan(6);
  });

  test("propagates synchronous throws", async () => {
    await expect(
      mapPool([1], 1, () => {
        throw new Error("sync fail");
      }),
    ).rejects.toThrow("sync fail");
  });

  test("handles empty input", async () => {
    let called = 0;
    const res = await mapPool([], 4, () => {
      ++called;
      return 0;
    });
    expect(res).toEqual([]);
    expect(called).toBe(0);
  });

  test("accepts synchronous mappers", async () => {
    const res = await mapPool([1, 2, 3], 2, (val) => val + 1);
    expect(res).toEqual([2, 3, 4]);
  });

  test("rejects a non-positive limit", async () => {
    await expect(mapPool([1], 0, (val) => val)).rejects.toThrow(
      "limit must be a positive integer, but got 0",
    );
  });
});

describe("toHex()", () => {
  test("encodes bytes", () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 253, 254, 255]))).toBe(
      "00010f10fdfeff",
    );
  });

  test("zero pads single digits", () => {
    // the bug this guards against is a missing pad producing a short hash
    expect(toHex(new Uint8Array([1, 2, 3]))).toBe("010203");
  });

  test("encodes empty input", () => {
    expect(toHex(new Uint8Array([]))).toBe("");
  });

  // this mirrors digest() in raw.ts exactly. That function is module private, but
  // it is the one that broke under node 22 when it used Uint8Array#toHex, and it
  // produces the content hashes every write is addressed by, so a regression here
  // corrupts uploads rather than merely erroring.
  test("hex-encodes a sha-256 the way digest() does", async () => {
    const enc = new TextEncoder();
    for (const [input, expected] of [
      [
        "abc",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ],
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ] as const) {
      const buff = enc.encode(input);
      const hashed = await crypto.subtle.digest(
        "SHA-256",
        buff as unknown as ArrayBuffer,
      );
      const hex = toHex(new Uint8Array(hashed));
      expect(hex).toBe(expected);
      expect(hex).toHaveLength(64);
    }
  });
});

describe("fromHex()", () => {
  test("round trips with toHex", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  test("decodes empty input", () => {
    expect(fromHex("")).toEqual(new Uint8Array([]));
  });

  test("throws on an odd length", () => {
    expect(() => fromHex("abc")).toThrow("even length");
  });

  test("throws on a non-hex digit", () => {
    // parseInt would otherwise yield NaN, which coerces to a silent 0 byte
    expect(() => fromHex("00zz")).toThrow("invalid hex digit");
  });
});

describe("toBase64()", () => {
  test("encodes bytes", () => {
    expect(toBase64(new Uint8Array([0, 1, 2, 253, 254, 255]))).toBe("AAEC/f7/");
  });

  test("encodes the crc32c header the way putFile does", () => {
    const buff = new ArrayBuffer(4);
    new DataView(buff).setInt32(0, -1, false);
    expect(toBase64(new Uint8Array(buff))).toBe("/////w==");
  });

  test("encodes empty input", () => {
    expect(toBase64(new Uint8Array([]))).toBe("");
  });

  test("handles input larger than the argument limit", () => {
    // String.fromCharCode(...bytes) would throw for an input this size
    const big = new Uint8Array(200_000).fill(65);
    expect(toBase64(big)).toHaveLength(Math.ceil(200_000 / 3) * 4);
  });
});
