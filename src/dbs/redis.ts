import Redis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

let client: { instanceConnect: Redis | null } = { instanceConnect: null },
  connectionTimeout = null,
  statusConnectRedis = {
    CONNECT: "connect",
    END: "end",
    RECONNECT: "reconnecting",
    ERROR: "error",
  };

const REDIS_CONNECT_TIMEOUT = 10000,
  REDIS_CONNECT_MESSAGE = {
    code: -99,
    message: {
      vn: "Kết nối Redis thất bại",
      en: "Redis connection failed",
    },
  };

const handleTimeoutError = () => {
  connectionTimeout = setTimeout(() => {
    console.error(
      "[redis] connect timeout after",
      REDIS_CONNECT_TIMEOUT,
      "ms —",
      REDIS_CONNECT_MESSAGE.message.en
    );
  }, REDIS_CONNECT_TIMEOUT);
};

const handleEventConnection = ({ connectionRedis }) => {
  connectionRedis.on(statusConnectRedis.CONNECT, () => {
    console.log("Redis connected successfully");
    clearTimeout(connectionTimeout);
  });
  connectionRedis.on(statusConnectRedis.END, () => {
    console.log("Redis connection ended");
    handleTimeoutError();
  });
  connectionRedis.on(statusConnectRedis.RECONNECT, () => {
    console.log("Redis connection reconnected");
    clearTimeout(connectionTimeout);
  });
  connectionRedis.on(statusConnectRedis.ERROR, (error) => {
    console.log("Redis connection error", error);
    handleTimeoutError();
  });
};

const initRedis = () => {
  const instanceRedis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
  });
  handleEventConnection({ connectionRedis: instanceRedis });
  client.instanceConnect = instanceRedis;
};

const getRedisInstance = () => client.instanceConnect;

const setCache = async (
  key: string,
  value: any,
  ttlSeconds?: number
): Promise<"OK"> => {
  const redisInstance = getRedisInstance();
  if (!redisInstance) {
    throw new Error("Redis instance not found");
  }
  const stringValue = JSON.stringify(value);
  if (ttlSeconds) {
    return redisInstance.setex(key, ttlSeconds, stringValue);
  }
  return redisInstance.set(key, stringValue);
};

const getCache = async <T>(key: string): Promise<T | null> => {
  const redisInstance = getRedisInstance();
  if (!redisInstance) {
    throw new Error("Redis instance not found");
  }
  const value = await redisInstance.get(key);
  if (!value) return null;
  return JSON.parse(value) as T;
};

const deleteCache = async (key: string): Promise<number> => {
  const redisInstance = getRedisInstance();
  if (!redisInstance) {
    throw new Error("Redis instance not found");
  }
  return redisInstance.del(key);
};

const clearCache = async (): Promise<"OK"> => {
  const redisInstance = getRedisInstance();
  if (!redisInstance) {
    throw new Error("Redis instance not found");
  }
  return redisInstance.flushall();
};

export { setCache, getCache, deleteCache, clearCache, getRedisInstance };
export default initRedis;
