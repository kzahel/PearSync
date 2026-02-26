import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const BLOCK_SIZE = 64 * 1024; // 64KB

export function chunkBuffer(data: Buffer, blockSize = BLOCK_SIZE): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    chunks.push(data.subarray(offset, offset + blockSize));
  }
  return chunks;
}

export async function hashFile(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export function hashBuffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function normalizePath(p: string): string {
  return `/${p.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}
