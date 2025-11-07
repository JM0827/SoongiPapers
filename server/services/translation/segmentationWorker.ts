import { parentPort } from "node:worker_threads";

import type {
  CanonicalSegmentationOptions,
  CanonicalSegmentationResult,
} from "./segmentationEngine";
import { segmentCanonicalText } from "./segmentationEngine";

if (!parentPort) {
  throw new Error("Segmentation worker requires a parent port");
}

parentPort.on("message", async (
  message: {
    id: string;
    options: CanonicalSegmentationOptions & { runId: string };
  },
) => {
  const respond = (payload: {
    id: string;
    result?: CanonicalSegmentationResult;
    error?: string;
  }) => {
    parentPort?.postMessage(payload);
  };

  try {
    const result = await segmentCanonicalText(message.options);
    respond({ id: message.id, result });
  } catch (error) {
    respond({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
