import { NdjsonBuffer } from "../lib/ndjsonBuffer";

export type NDJSONCallback<T> = (event: T) => void;

export const streamNdjson = async <T>(
  response: Response,
  onEvent: NDJSONCallback<T>,
  onError?: (error: Error, payload: string) => void,
) => {
  if (!response.body) throw new Error("Streaming body is not supported");
  const reader = response.body.getReader();
  const buffer = new NdjsonBuffer<T>(onEvent, onError);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      buffer.append(value);
    }
  }

  buffer.flush();
};
