import { describe, expect, it } from "vitest";
import { chunkBuffer, formatBytes, hashBuffer, normalizePath } from "./file-utils";

describe("chunkBuffer", () => {
  it("returns single chunk for small data", () => {
    const data = Buffer.from("hello");
    const chunks = chunkBuffer(data);
    expect(chunks).toHaveLength(1);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });

  it("splits data into correct number of chunks", () => {
    const data = Buffer.alloc(64 * 1024 * 3 + 100); // 3 full blocks + 100 bytes
    const chunks = chunkBuffer(data);
    expect(chunks).toHaveLength(4);
    expect(Buffer.concat(chunks).length).toBe(data.length);
  });

  it("respects custom block size", () => {
    const data = Buffer.alloc(100);
    const chunks = chunkBuffer(data, 30);
    expect(chunks).toHaveLength(4); // 30 + 30 + 30 + 10
    expect(Buffer.concat(chunks).length).toBe(100);
  });
});

describe("hashBuffer", () => {
  it("returns consistent sha256 hex", () => {
    const hash1 = hashBuffer(Buffer.from("hello"));
    const hash2 = hashBuffer(Buffer.from("hello"));
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("returns different hashes for different data", () => {
    const hash1 = hashBuffer(Buffer.from("hello"));
    const hash2 = hashBuffer(Buffer.from("world"));
    expect(hash1).not.toBe(hash2);
  });
});

describe("formatBytes", () => {
  it("formats zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

describe("normalizePath", () => {
  it("adds leading slash", () => {
    expect(normalizePath("file.txt")).toBe("/file.txt");
  });

  it("normalizes backslashes", () => {
    expect(normalizePath("src\\lib\\file.ts")).toBe("/src/lib/file.ts");
  });

  it("deduplicates leading slashes", () => {
    expect(normalizePath("///file.txt")).toBe("/file.txt");
  });

  it("preserves nested paths", () => {
    expect(normalizePath("a/b/c/d.txt")).toBe("/a/b/c/d.txt");
  });
});
