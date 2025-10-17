import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

const BASE_OPTIONS = {
  maxRetriesPerRequest: null as number | null,
  enableReadyCheck: true,
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
  return client;
}

export function getSharedRedisClient(): Redis {
  if (!sharedClient) {
    sharedClient = createRedisClient("server-shared");
  }
  return sharedClient;
}

export type RedisClient = Redis;
