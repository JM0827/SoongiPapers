import { OpenAI } from "openai";

let cachedClient: OpenAI | null = null;

export const getOpenAIClient = (): OpenAI => {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  cachedClient = new OpenAI({
    apiKey,
    maxRetries: 2,
    timeout: 60_000,
  });

  return cachedClient;
};

export const resetOpenAIClientForTests = () => {
  if (process.env.NODE_ENV === "test") {
    cachedClient = null;
  }
};
