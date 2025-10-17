import type {
  ProjectMemory,
  SequentialStageJobSegment,
  SequentialStageResult,
  SequentialTranslationConfig,
} from "../types";

export const QA_SYSTEM_PROMPT = `You are validating a translation segment.
- Provide a concise back-translation of the candidate into the source language.
- List any potential issues with parity, entities, register, or cultural terms.
- Respond as JSON with keys backTranslation (string) and issues (string array).`;

interface QaPromptArgs {
  segment: SequentialStageJobSegment;
  emotionResult: SequentialStageResult | undefined;
  config: SequentialTranslationConfig;
  memory: ProjectMemory | null;
}

export function buildQaUserPrompt({
  segment,
  emotionResult,
  config,
  memory,
}: QaPromptArgs): string {
  const finalDraft = emotionResult?.textTarget ?? segment.textSource;
  const sections: string[] = [];
  sections.push(
    `Direction: ${config.sourceLang}→${config.targetLang}. Romanization policy: ${config.romanizationPolicy ?? "as-is"}.`,
  );
  if (memory?.term_map?.source_to_target) {
    sections.push(
      `Known term mappings (${Object.keys(memory.term_map.source_to_target).length} entries) must be honored.`,
    );
  }
  sections.push(`Candidate translation:\n${finalDraft}`);
  sections.push("Return JSON only.");
  return sections.join("\n\n");
}
