import type { TranslationNotes } from "../../models/DocumentProfile";

const MAX_CHARACTER_ENTRIES = 5;
const MAX_ENTITY_ENTRIES = 8;
const MAX_MEASUREMENT_ENTRIES = 6;
const MAX_LINGUISTIC_ENTRIES = 6;

export interface DraftPromptContext {
  projectTitle?: string | null;
  authorName?: string | null;
  synopsis?: string | null;
  register?: string | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  translationNotes?: TranslationNotes | null;
}

const FALLBACK_SOURCE_LANG = "the original language";
const FALLBACK_TARGET_LANG = "English";

const GENERAL_GUARDLINES = [
  "Preserve plot, metaphors, humor, and cultural references even when awkward.",
  "Respect each segment's order; never merge or drop content.",
  "Fix OCR/PDF/HWP artifacts (broken lines, stray hyphenation, bullet fragments).",
  "Dialogue should read naturally for publication; keep inline emphasis markers when meaningful.",
  "Do not add commentary, summaries, or content that isn't in the source.",
];

function formatLanguage(label?: string | null, fallback = FALLBACK_SOURCE_LANG) {
  const normalized = label?.trim();
  return normalized && normalized.length ? normalized : fallback;
}

function formatBulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function truncateList<T>(values: T[], limit: number): T[] {
  if (!values?.length) return [];
  return values.slice(0, limit);
}

function buildCharacterSection(notes: TranslationNotes | null): string | null {
  if (!notes?.characters?.length) return null;
  const entries = truncateList(notes.characters, MAX_CHARACTER_ENTRIES).map(
    (character) => {
      const pieces: string[] = [];
      const displayName = character.targetName
        ? `${character.name} → ${character.targetName}`
        : character.name;
      pieces.push(displayName);
      const traits: string[] = [];
      if (character.age) traits.push(`age ${character.age}`);
      if (character.gender) traits.push(character.gender);
      if (character.traits?.length) {
        traits.push(`traits: ${truncateList(character.traits, 3).join(", ")}`);
      }
      if (traits.length) {
        pieces.push(traits.join("; "));
      }
      return pieces.join(" — ");
    },
  );
  return `Key characters:\n${formatBulletList(entries)}`;
}

function buildEntitySection(
  label: string,
  entries: TranslationNotes["namedEntities"],
): string | null {
  if (!entries?.length) return null;
  const list = truncateList(entries, MAX_ENTITY_ENTRIES).map((entity) => {
    if (entity.targetName && entity.targetName !== entity.name) {
      return `${entity.name} → ${entity.targetName}`;
    }
    return entity.name;
  });
  if (!list.length) return null;
  return `${label}:\n${formatBulletList(list)}`;
}

function buildMeasurementSection(notes: TranslationNotes | null): string | null {
  if (!notes?.measurementUnits?.length) return null;
  const list = truncateList(notes.measurementUnits, MAX_MEASUREMENT_ENTRIES).map(
    (entry) =>
      entry.target && entry.target !== entry.source
        ? `${entry.source} → ${entry.target}`
        : entry.source,
  );
  if (!list.length) return null;
  return `Measurement & units to respect:\n${formatBulletList(list)}`;
}

function buildLinguisticSection(notes: TranslationNotes | null): string | null {
  if (!notes?.linguisticFeatures?.length) return null;
  const list = truncateList(notes.linguisticFeatures, MAX_LINGUISTIC_ENTRIES).map(
    (entry) =>
      entry.target && entry.target !== entry.source
        ? `${entry.source} → ${entry.target}`
        : entry.source,
  );
  if (!list.length) return null;
  return `Key expressions / slang to keep consistent:\n${formatBulletList(list)}`;
}

function buildGlossarySection(notes: TranslationNotes | null): string | null {
  const glossaryPairs: Array<{ source: string; target: string | null }> = [];
  if (notes?.namedEntities?.length) {
    glossaryPairs.push(
      ...truncateList(notes.namedEntities, MAX_ENTITY_ENTRIES).map((entity) => ({
        source: entity.name,
        target: entity.targetName ?? null,
      })),
    );
  }
  if (notes?.locations?.length) {
    glossaryPairs.push(
      ...truncateList(notes.locations, MAX_ENTITY_ENTRIES).map((entity) => ({
        source: entity.name,
        target: entity.targetName ?? null,
      })),
    );
  }
  if (!glossaryPairs.length) return null;
  const entries = glossaryPairs.map((pair) => {
    if (pair.target && pair.target !== pair.source) {
      return `${pair.source} → ${pair.target}`;
    }
    return pair.source;
  });
  return `Glossary (these spellings are mandatory):\n${formatBulletList(entries)}`;
}

export function buildDraftSystemPrompt(context: DraftPromptContext): string {
  const {
    projectTitle,
    authorName,
    synopsis,
    register,
    sourceLanguage,
    targetLanguage,
    translationNotes,
  } = context;

  const headerLines: string[] = [
    "You are the Draft translator in a literary publishing pipeline. Produce a faithful, idiomatic translation for each provided segment.",
  ];
  if (projectTitle?.trim()) {
    headerLines.push(
      `Work: "${projectTitle.trim()}"${authorName?.trim() ? ` by ${authorName.trim()}` : ""}.`,
    );
  } else if (authorName?.trim()) {
    headerLines.push(`Author: ${authorName.trim()}.`);
  }
  headerLines.push(
    `Source language: ${formatLanguage(sourceLanguage, FALLBACK_SOURCE_LANG)}.`,
  );
  headerLines.push(
    `Target language: ${formatLanguage(targetLanguage, FALLBACK_TARGET_LANG)}.`,
  );
  if (register?.trim()) {
    headerLines.push(`Register & contract: ${register.trim()}.`);
  }

  const guidelineLines = [...GENERAL_GUARDLINES];
  if (translationNotes?.timePeriod) {
    guidelineLines.push(
      `Honor the historical/cultural context of ${translationNotes.timePeriod}.`,
    );
  }

  const sections: string[] = [headerLines.join("\n"), "\nGuidelines:", formatBulletList(guidelineLines)];

  if (synopsis?.trim()) {
    sections.push(`\nStory context:\n${synopsis.trim()}`);
  }

  const characterSection = buildCharacterSection(translationNotes ?? null);
  if (characterSection) {
    sections.push(`\n${characterSection}`);
  }

  const glossarySection = buildGlossarySection(translationNotes ?? null);
  if (glossarySection) {
    sections.push(`\n${glossarySection}`);
  }

  const entitySection = buildEntitySection(
    "Important named entities",
    translationNotes?.namedEntities ?? [],
  );
  if (entitySection) {
    sections.push(`\n${entitySection}`);
  }

  const locationSection = buildEntitySection(
    "Locations & places",
    translationNotes?.locations ?? [],
  );
  if (locationSection) {
    sections.push(`\n${locationSection}`);
  }

  const measurementSection = buildMeasurementSection(translationNotes ?? null);
  if (measurementSection) {
    sections.push(`\n${measurementSection}`);
  }

  const linguisticSection = buildLinguisticSection(translationNotes ?? null);
  if (linguisticSection) {
    sections.push(`\n${linguisticSection}`);
  }

  sections.push(
    `\nOutput format requirements:\n- Return valid JSON that matches the provided schema.\n- Each segment must reference the exact segmentId supplied in the user payload.\n- Do not include explanations outside the JSON schema.`,
  );

  return sections
    .filter((section) => section && section.trim().length)
    .join("\n\n")
    .trim();
}
