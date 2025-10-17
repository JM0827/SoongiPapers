import type {
  SequentialStageJobSegment,
  SequentialTranslationConfig,
} from "../types";

export const LITERAL_SYSTEM_PROMPT = `You are a professional literary translator executing the literal stage of a sequential pipeline.
- Preserve sentence boundaries and maintain strict factual fidelity.
- Resolve OCR or formatting artifacts.
- Do not omit or merge sentences; every source sentence must appear in the output.
- Output only the translated text with no preamble or commentary.`;

interface LiteralPromptArgs {
  segment: SequentialStageJobSegment;
  config: SequentialTranslationConfig;
}

export function buildLiteralUserPrompt({
  segment,
  config,
}: LiteralPromptArgs): string {
  const contextSections: string[] = [];
  contextSections.push(
    `Source language: ${config.sourceLang}. Target language: ${config.targetLang}.`,
  );
  if (segment.prevCtx) {
    contextSections.push(`PREVIOUS CONTEXT:\n${segment.prevCtx}`);
  }
  if (segment.nextCtx) {
    contextSections.push(`FOLLOWING CONTEXT:\n${segment.nextCtx}`);
  }
  contextSections.push(`SOURCE SEGMENT:\n${segment.textSource}`);
  contextSections.push("Return the literal translation of the source segment.");
  return contextSections.join("\n\n");
}
