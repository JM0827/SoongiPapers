export type NDJSONCallback<T> = (event: T) => void;

export const streamNdjson = async <T>(
  response: Response,
  onEvent: NDJSONCallback<T>,
) => {
  if (!response.body) throw new Error("Streaming body is not supported");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch (err) {
        console.warn("[streamNdjson] Failed to parse chunk", err);
      }
    }
  }
};
