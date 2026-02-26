class RingBuffer {
  items;
  head = 0;
  count = 0;
  capacity;
  constructor(capacity) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be >= 1");
    this.capacity = capacity;
    this.items = new Array(capacity);
  }
  push(item) {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  /** Returns all items, newest first. */
  toArray() {
    const result = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      result.push(this.items[idx]);
    }
    return result;
  }
  /** Returns a slice of items (newest first), starting at offset. */
  slice(offset, limit) {
    return this.toArray().slice(offset, offset + limit);
  }
  get size() {
    return this.count;
  }
}
export {
  RingBuffer
};
//# sourceMappingURL=ring-buffer.js.map
