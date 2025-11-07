import { Queue } from "bullmq";

const queue = new Queue("translation_v2", {
  connection: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
});

async function main() {
  const waiting = await queue.getWaitingCount();
  const active = await queue.getActiveCount();
  const failed = await queue.getFailedCount();
  console.log({ waiting, active, failed });
}

void main();
