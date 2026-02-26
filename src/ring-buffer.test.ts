import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("stores and retrieves items newest first", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([3, 2, 1]);
    expect(buf.size).toBe(3);
  });

  it("drops oldest items when capacity exceeded", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) buf.push(i);
    expect(buf.toArray()).toEqual([5, 4, 3]);
    expect(buf.size).toBe(3);
  });

  it("slice returns correct subset", () => {
    const buf = new RingBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.slice(0, 2)).toEqual(["d", "c"]);
    expect(buf.slice(1, 2)).toEqual(["c", "b"]);
    expect(buf.slice(3, 5)).toEqual(["a"]);
  });

  it("handles empty buffer", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.size).toBe(0);
    expect(buf.slice(0, 10)).toEqual([]);
  });

  it("rejects capacity < 1", () => {
    expect(() => new RingBuffer(0)).toThrow();
  });

  it("handles capacity of 1", () => {
    const buf = new RingBuffer<number>(1);
    buf.push(1);
    expect(buf.toArray()).toEqual([1]);
    buf.push(2);
    expect(buf.toArray()).toEqual([2]);
    expect(buf.size).toBe(1);
  });
});
