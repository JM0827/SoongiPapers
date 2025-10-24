import type {
  ProjectMemory,
  SequentialStageJobSegment,
  SequentialStageResult,
  SequentialTranslationConfig,
} from "../types";

export const STYLE_SYSTEM_PROMPT = `You are refining a literal ko↔en translation to achieve the desired literary style.
- Preserve factual content, entities, symbolism, and sentence coverage from the literal draft.
- Do not introduce new opening lines, summaries, or transitions that are absent from the literal draft.
- Adjust rhythm, diction, and tone based on the project memory and configuration.
- Respond with the styled translation only.`;

interface StylePromptArgs {
  segment: SequentialStageJobSegment;
  literalResult: SequentialStageResult | undefined;
  config: SequentialTranslationConfig;
  memory: ProjectMemory | null;
}

export function buildStyleUserPrompt({
  segment,
  literalResult,
  config,
  memory,
}: StylePromptArgs): string {
  const literalDraft = literalResult?.textTarget ?? segment.textSource;
  const sections: string[] = [];
  sections.push(`Creative autonomy: ${config.creativeAutonomy ?? "light"}.`);
  if (config.register) {
    sections.push(`Target register: ${config.register}.`);
  }
  if (memory?.style_profile) {
    const { register, rhythm, avg_sentence_tokens } = memory.style_profile;
    sections.push(
      `Project style profile → register: ${register}, rhythm: ${rhythm ?? "n/a"}, avg sentence tokens: ${avg_sentence_tokens ?? "n/a"}.`,
    );
  }
  if (memory?.term_map?.source_to_target) {
    sections.push(
      `Term map size: ${Object.keys(memory.term_map.source_to_target).length}. Adhere to approved terms.`,
    );
  }
  sections.push(`Literal draft:\n${literalDraft}`);
  sections.push("Produce the styled translation while keeping factual fidelity.");
  return sections.join("\n\n");
}
