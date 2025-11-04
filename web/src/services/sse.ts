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

export type NdjsonEnvelope<TData = unknown> = {
  type: string;
  data?: TData;
};

export const parseNdjsonEnvelope = <TData = unknown>(
  value: unknown,
): NdjsonEnvelope<TData> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) return null;
  const dataSource = record.data as TData | undefined;
  if (dataSource !== undefined) {
    return { type, data: dataSource };
  }

  const fallbackKeys = Object.keys(record).filter((key) => key !== "type");
  if (!fallbackKeys.length) {
    return { type };
  }
  const fallbackData = fallbackKeys.reduce<Record<string, unknown>>(
    (acc, key) => {
      acc[key] = record[key];
      return acc;
    },
    {},
  );
  return { type, data: fallbackData as TData };
};
