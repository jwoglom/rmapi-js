import { describe, expect, test } from "bun:test";
import { mapPool } from "./utils.js";

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
