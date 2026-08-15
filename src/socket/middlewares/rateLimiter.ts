import logger from "../../core/logger.js";

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

interface ClientRecord {
  timestamps: number[];
}

export class SocketRateLimiter {
  private records = new Map<string, ClientRecord>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    public readonly name: string,
    public readonly config: RateLimitConfig
  ) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 120_000);
    this.cleanupInterval.unref?.();
  }

  public check(key: string): { allowed: boolean; retryAfterMs?: number } {
    if (!key) return { allowed: true };

    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.records.set(key, record);
    }

    record.timestamps = record.timestamps.filter((t) => t > windowStart);

    if (record.timestamps.length >= this.config.max) {
      const oldestInWindow = record.timestamps[0];
      const retryAfterMs = Math.max(0, oldestInWindow + this.config.windowMs - now);
      logger.warn(
        { limiter: this.name, key, limit: this.config.max, windowMs: this.config.windowMs },
        "Socket event rate limit exceeded"
      );
      return { allowed: false, retryAfterMs };
    }

    record.timestamps.push(now);
    return { allowed: true };
  }

  public reset(key?: string): void {
    if (key) {
      this.records.delete(key);
    } else {
      this.records.clear();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    for (const [key, record] of this.records.entries()) {
      record.timestamps = record.timestamps.filter((t) => t > windowStart);
      if (record.timestamps.length === 0) {
        this.records.delete(key);
      }
    }
  }

  public destroy(): void {
    clearInterval(this.cleanupInterval);
    this.records.clear();
  }
}

// 1. Message send limiter: max 5 messages per 1 second per user
export const messageSendLimiter = new SocketRateLimiter("message_send", {
  windowMs: 1000,
  max: 5,
});

// 2. Action limiter (react, retrieve, change setting, seen): max 15 actions per 1 second
export const messageActionLimiter = new SocketRateLimiter("message_action", {
  windowMs: 1000,
  max: 15,
});

// 3. Query limiter (getConversations, getMessages, search): max 25 queries per 1 second
export const messageQueryLimiter = new SocketRateLimiter("message_query", {
  windowMs: 1000,
  max: 25,
});
