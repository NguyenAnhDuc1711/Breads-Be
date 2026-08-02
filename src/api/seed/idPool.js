import mongoose from "mongoose";

// Fixed-capacity pool of ObjectIds backed by a flat Buffer instead of an
// array of Mongoose ObjectId instances (~200 bytes/object). At millions of
// ids this keeps memory at ~12 bytes/id instead of hundreds of MB/GB.
// Only the first `capacity` ids pushed are kept; extra pushes are dropped —
// fine for seeding purposes, we just need a large enough random author pool.
export class ObjectIdPool {
  constructor(capacity) {
    this.capacity = Math.max(capacity, 0);
    this.store = Buffer.allocUnsafe(this.capacity * 12);
    this.count = 0;
  }

  push(objectId) {
    if (this.count >= this.capacity) return false;
    objectId.buffer.copy(this.store, this.count * 12);
    this.count++;
    return true;
  }

  get size() {
    return this.count;
  }

  sample() {
    if (this.count === 0) {
      throw new Error("ObjectIdPool is empty");
    }
    const idx = Math.floor(Math.random() * this.count);
    return new mongoose.Types.ObjectId(
      this.store.subarray(idx * 12, idx * 12 + 12)
    );
  }
}
