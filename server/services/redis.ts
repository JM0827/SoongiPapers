import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

const BASE_OPTIONS = {
  maxRetriesPerRequest: null as number | null,
  // ❗연결 지연 방지: 2초 내 준비 안 되면 빨리 실패
  connectTimeout: 2000,
  enableReadyCheck: true,
  lazyConnect: false,
};

let sharedClient: Redis | null = null;

function assertRedisConfigured() {
  if (!REDIS_URL) {
    throw new Error("REDIS_URL is not configured");
  }
}

export function createRedisClient(connectionName?: string): Redis {
  assertRedisConfigured();
  const client = new Redis(REDIS_URL as string, {
    ...BASE_OPTIONS,
    connectionName,
  });
  client.on("error", (error) => {
    console.error("[REDIS] Connection error", error);
  });
  client.on("connect", () => {
    console.log("[REDIS] connect ok", { url: REDIS_URL, connectionName });
  });
  client.on("ready", () => {
    console.log("[REDIS] ready");
  });
  return client;
}

export function getSharedRedisClient(): Redis {
  if (!sharedClient) {
    sharedClient = createRedisClient("server-shared");
  }
  return sharedClient;
}

export type RedisClient = Redis;
