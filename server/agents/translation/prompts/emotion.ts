import type {
  ProjectMemory,
  SequentialStageJobSegment,
  SequentialStageResult,
  SequentialTranslationConfig,
} from "../types";

export const EMOTION_SYSTEM_PROMPT = `You are aligning an already-styled translation to the source emotional arc.
- Preserve imagery, symbolism, and key motifs from the project memory.
- Adjust emotional intensity and metaphors as needed but avoid factual drift.
- Return only the updated translation text.`;

interface EmotionPromptArgs {
  segment: SequentialStageJobSegment;
  styleResult: SequentialStageResult | undefined;
  config: SequentialTranslationConfig;
  memory: ProjectMemory | null;
}

export function buildEmotionUserPrompt({
  segment,
  styleResult,
  config,
  memory,
}: EmotionPromptArgs): string {
  const styledDraft = styleResult?.textTarget ?? segment.textSource;
  const sections: string[] = [];
  if (memory?.symbol_table) {
    const symbols = Object.entries(memory.symbol_table)
      .slice(0, 5)
      .map(([key, value]) => `${key}: ${value.connotations.join(", ")}`)
      .join("; ");
    sections.push(`Symbols to respect: ${symbols}`);
  }
  sections.push(
    `Honorific policy: ${config.honorifics ?? "preserve"}. Romanization: ${config.romanizationPolicy ?? "as-is"}.`,
  );
  sections.push(`Styled translation:\n${styledDraft}`);
  sections.push("Align the emotional tone and imagery while keeping the narrative accurate.");
  return sections.join("\n\n");
}
