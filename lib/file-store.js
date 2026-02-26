import { createHash } from "bare-crypto";
const DEFAULT_BLOCK_SIZE = 64 * 1024;
class FileStore {
  store;
  _core;
  blockSize;
  constructor(store, options) {
    this.store = store;
    this.blockSize = options?.blockSize ?? DEFAULT_BLOCK_SIZE;
    this._core = store.get({ name: options?.name ?? "file-data" });
  }
  get core() {
    return this._core;
  }
  async ready() {
    await this._core.ready();
  }
  async writeFile(data) {
    const hash = createHash("sha256").update(data).digest("hex");
    if (data.length === 0) {
      return { offset: this._core.length, length: 0, size: 0, hash };
    }
    const chunks = [];
    for (let i = 0; i < data.length; i += this.blockSize) {
      chunks.push(data.subarray(i, i + this.blockSize));
    }
    const result = await this._core.append(chunks);
    return {
      offset: result.length - chunks.length,
      length: chunks.length,
      size: data.length,
      hash
    };
  }
  async readFile(offset, length) {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    const blocks = [];
    for (let i = 0; i < length; i++) {
      const block = await this._core.get(offset + i);
      if (block === null) {
        throw new Error(`Missing block at index ${offset + i}`);
      }
      blocks.push(block);
    }
    return Buffer.concat(blocks);
  }
  async close() {
    await this._core.close();
  }
}
export {
  FileStore
};
//# sourceMappingURL=file-store.js.map
