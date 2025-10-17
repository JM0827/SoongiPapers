const rawApiBase = import.meta.env.VITE_API_BASE ?? "";
const API_BASE = rawApiBase.endsWith("/")
  ? rawApiBase.slice(0, -1)
  : rawApiBase;
const NEWLINE = String.fromCharCode(10);

const normalize = (word: string) =>
  word.replace(/[^\p{L}'-]/gu, "").toLowerCase();

const CACHE_LIMIT = 32;
const cache = new Map<string, string | null>();

const buildUrl = (word: string) => {
  const base = API_BASE ? `${API_BASE}` : "";
  return `${base}/api/dictionary?word=${encodeURIComponent(word)}`;
};

const formatDefinitions = (definitions: string[]) =>
  definitions
    .slice(0, 2)
    .map((definition, index) => `${index + 1}. ${definition}`)
    .join(`${NEWLINE}${NEWLINE}`);

const remember = (word: string, definition: string | null) => {
  if (cache.size >= CACHE_LIMIT) {
    const iterator = cache.keys().next();
    if (!iterator.done) {
      cache.delete(iterator.value);
    }
  }
  cache.set(word, definition);
};

export async function lookupDefinition(
  rawWord: string,
  token?: string | null,
): Promise<string | null> {
  const word = normalize(rawWord);
  if (!word) return null;

  if (cache.has(word)) {
    return cache.get(word) ?? null;
  }

  try {
    const response = await fetch(buildUrl(word), {
      method: "GET",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      remember(word, null);
      return null;
    }

    const payload = (await response.json()) as { definitions?: string[] };
    const definitions = payload?.definitions ?? [];
    if (!definitions.length) {
      remember(word, null);
      return null;
    }

    const formatted = formatDefinitions(definitions);
    remember(word, formatted);
    return formatted;
  } catch (error) {
    console.warn("[dictionary] lookup failed", error);
    remember(word, null);
    return null;
  }
}
