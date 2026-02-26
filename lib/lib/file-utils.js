import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const BLOCK_SIZE = 64 * 1024;
function chunkBuffer(data, blockSize = BLOCK_SIZE) {
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    chunks.push(data.subarray(offset, offset + blockSize));
  }
  return chunks;
}
async function hashFile(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}
function hashBuffer(data) {
  return createHash("sha256").update(data).digest("hex");
}
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function normalizePath(p) {
  return `/${p.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}
export {
  chunkBuffer,
  formatBytes,
  hashBuffer,
  hashFile,
  normalizePath
};
//# sourceMappingURL=file-utils.js.map
