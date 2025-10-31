export type GenerationFormat = "pdf" | "epub";

export interface TranslationSummary {
  exists: boolean;
  id?: string;
  qaScore?: number | null;
  targetLang: string;
}

export interface MetadataDraft {
  title: string;
  writer: string;
  translator: string;
  writerNote?: string | null;
  translatorNote?: string | null;
  language?: string | null;
  identifier?: string | null;
  modifiedISO?: string | null;
}

export interface EssentialsSnapshot {
  translation: TranslationSummary;
  meta: MetadataDraft;
  wantPDF: boolean;
  wantEPUB: boolean;
  accepted: boolean;
}

export type BuildState = "idle" | "running" | "done" | "error";

export type PromoState = "idle" | "scene" | "video" | "cards";

export interface GenerationProgressChip {
  format: GenerationFormat;
  status: "pending" | "running" | "done" | "error";
}

export const generationFormats: GenerationFormat[] = ["pdf", "epub"];

const languageCodes: Record<string, string> = {
  English: "EN",
  Korean: "KO",
  Japanese: "JA",
  Chinese: "ZH",
  Spanish: "ES",
  French: "FR",
  German: "DE",
};

export const langToCode = (name: string): string => {
  if (!name) return "TL";
  const match = languageCodes[name];
  if (match) return match;
  const trimmed = name.trim();
  if (!trimmed) return "TL";
  if (trimmed.includes("-")) {
    return trimmed.split("-")[0]?.slice(0, 2)?.toUpperCase() ?? "TL";
  }
  return trimmed.slice(0, 2).toUpperCase();
};

export const getGenerateQueue = (
  wantPDF: boolean,
  wantEPUB: boolean,
): GenerationFormat[] => {
  const queue: GenerationFormat[] = [];
  if (wantPDF) queue.push("pdf");
  if (wantEPUB) queue.push("epub");
  return queue;
};

export const formatDateLabel = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};
