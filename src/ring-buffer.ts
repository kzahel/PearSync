export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be >= 1");
    this.capacity = capacity;
    this.items = new Array(capacity);
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Returns all items, newest first. */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      result.push(this.items[idx] as T);
    }
    return result;
  }

  /** Returns a slice of items (newest first), starting at offset. */
  slice(offset: number, limit: number): T[] {
    return this.toArray().slice(offset, offset + limit);
  }

  get size(): number {
    return this.count;
  }
}
