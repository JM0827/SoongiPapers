import { OpenAI } from 'openai';
import pLimit from 'p-limit';
import type { GuardFindingDetail, ProjectMemory } from '@bookko/translation-types';

import { safeExtractOpenAIResponse, estimateTokens } from '../../services/llm';
import { runResponsesWithRetry } from '../../services/openaiResponses';
import { getProofreadModelSequence } from '../../config/modelDefaults';
import type { TranslationNotes } from '../../models/DocumentProfile';
import type { IssueItem, GuardFinding } from './config';

export type ResponseVerbosity = 'low' | 'medium' | 'high';
export type ResponseReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

type Tier = 'quick' | 'deep';

type LLMUsageSnapshot = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type ProofreadingMemoryContext = {
  version: number | null;
  styleProfile?: {
    register?: string | null;
    rhythm?: string | null;
    avgSentenceTokens?: number | null;
  };
  romanizationPolicy?: string | null;
  timePeriod?: string | null;
  characters?: Array<{
    name: string;
    targetName?: string | null;
    gender?: string | null;
    age?: string | null;
    traits?: string[];
  }>;
  namedEntities?: Array<{
    name: string;
    targetName?: string | null;
  }>;
  terminology?: Array<{
    source: string;
    target?: string | null;
  }>;
  measurementUnits?: Array<{
    source: string;
    target?: string | null;
  }>;
  linguisticFeatures?: Array<{
    source: string;
    target?: string | null;
  }>;
};

type GuardWorkerSegment = {
  segment_id: string;
  segment_index: number;
  needs_review: boolean;
  guard_findings?: GuardFindingDetail[];
  guards?: Record<string, unknown> | null;
  source_excerpt?: string;
  target_excerpt?: string;
};

type GenericWorkerParams = {
  model?: string | null;
  systemPrompt: string;
  subKey: string;
  tier: Tier;
  kr: string;
  en: string;
  kr_id: number | null;
  en_id: number | null;
  guardContext?: { segments: GuardWorkerSegment[] };
  memoryContext?: ProofreadingMemoryContext | null;
  verbosity?: ResponseVerbosity;
  reasoningEffort?: ResponseReasoningEffort;
  maxOutputTokens?: number;
  retryLimit?: number;
};

type ProofreadingEvidence = {
  reference: 'source' | 'target' | 'memory' | 'other';
  quote: string;
  note?: string;
};

type NormalizedLLMItem = IssueItem;

export type GenericWorkerMeta = {
  model: string;
  requestId: string | null;
  maxOutputTokens: number;
  attempts: number;
  truncated: boolean;
  verbosity: ResponseVerbosity;
  reasoningEffort: ResponseReasoningEffort;
  usage: LLMUsageSnapshot;
  guardSegments: number;
  memoryContextVersion: number | null;
};

export type GenericWorkerResult = {
  items: NormalizedLLMItem[];
  meta: GenericWorkerMeta;
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const limit = pLimit(Number(process.env.MAX_WORKERS || 4));

const GLOBAL_MAX_OUTPUT_TOKENS = process.env.PROOFREADING_MAX_OUTPUT_TOKENS
  ? Number(process.env.PROOFREADING_MAX_OUTPUT_TOKENS)
  : process.env.PROOFREAD_MAX_OUTPUT_TOKENS
    ? Number(process.env.PROOFREAD_MAX_OUTPUT_TOKENS)
    : undefined;
const DEFAULT_MAX_OUTPUT_TOKENS_QUICK = Number(
  process.env.PROOFREAD_QUICK_MAX_OUTPUT_TOKENS ?? GLOBAL_MAX_OUTPUT_TOKENS ?? 800,
);
const DEFAULT_MAX_OUTPUT_TOKENS_DEEP = Number(
  process.env.PROOFREAD_DEEP_MAX_OUTPUT_TOKENS ?? GLOBAL_MAX_OUTPUT_TOKENS ?? 1200,
);
const MAX_OUTPUT_TOKENS_CAP = Number(
  process.env.PROOFREADING_MAX_OUTPUT_TOKENS_CAP ??
    process.env.PROOFREAD_MAX_OUTPUT_TOKENS_CAP ??
    2400,
);
const GLOBAL_VERBOSITY =
  (process.env.PROOFREADING_VERBOSITY as ResponseVerbosity | undefined) ?? undefined;
const DEFAULT_VERBOSITY_QUICK =
  (process.env.PROOFREAD_QUICK_VERBOSITY as ResponseVerbosity | undefined) ??
  GLOBAL_VERBOSITY ??
  'low';
const DEFAULT_VERBOSITY_DEEP =
  (process.env.PROOFREAD_DEEP_VERBOSITY as ResponseVerbosity | undefined) ??
  GLOBAL_VERBOSITY ??
  'medium';
const GLOBAL_EFFORT =
  (process.env.PROOFREADING_REASONING_EFFORT as ResponseReasoningEffort | undefined) ??
  undefined;
const DEFAULT_EFFORT_QUICK =
  (process.env.PROOFREAD_QUICK_EFFORT as ResponseReasoningEffort | undefined) ??
  GLOBAL_EFFORT ??
  'minimal';
const DEFAULT_EFFORT_DEEP =
  (process.env.PROOFREAD_DEEP_EFFORT as ResponseReasoningEffort | undefined) ??
  GLOBAL_EFFORT ??
  'medium';
const DEFAULT_RETRY_LIMIT = Number(
  process.env.PROOFREAD_RESPONSES_MAX_RETRIES ?? 3,
);

const PROOFREAD_RESPONSE_SCHEMA_NAME = 'proofreading_items_schema_v1';
const PROOFREAD_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kr_sentence_id',
          'en_sentence_id',
          'issue_ko',
          'issue_en',
          'recommendation_ko',
          'recommendation_en',
          'before',
          'after',
          'alternatives',
          'rationale_ko',
          'rationale_en',
          'spans',
          'confidence',
          'severity',
          'source',
          'tags',
          'sourceExcerpt',
          'translationExcerpt',
          'evidence',
          'guardStatus',
          'guardStatusLabel',
          'notes',
        ],
        properties: {
          id: { type: 'string' },
          kr_sentence_id: { type: ['number', 'null'] },
          en_sentence_id: { type: ['number', 'null'] },
          issue_ko: { type: 'string' },
          issue_en: { type: 'string' },
          recommendation_ko: { type: 'string' },
          recommendation_en: { type: 'string' },
          before: { type: ['string', 'null'] },
          after: { type: ['string', 'null'] },
          alternatives: {
            type: 'array',
            items: { type: 'string' },
          },
          rationale_ko: { type: 'string' },
          rationale_en: { type: 'string' },
          spans: {
            type: ['object', 'null'],
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
            },
            required: ['start', 'end'],
            additionalProperties: false,
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          severity: { type: 'string' },
          source: { type: ['string', 'null'] },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          sourceExcerpt: { type: ['string', 'null'] },
          translationExcerpt: { type: ['string', 'null'] },
          evidence: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['reference', 'quote', 'note'],
              properties: {
                reference: {
                  type: 'string',
                  enum: ['source', 'target', 'memory', 'other'],
                  default: 'source',
                },
                quote: { type: 'string' },
                note: { type: ['string', 'null'] },
              },
            },
          },
          guardStatus: {
            type: 'string',
            enum: ['qa_also', 'llm_only', 'guard_only'],
          },
          guardStatusLabel: { type: 'string' },
          notes: {
            type: 'object',
            additionalProperties: false,
            required: ['styleGuard', 'references', 'guardFindings'],
            properties: {
              styleGuard: {
                type: 'array',
                items: { type: 'string' },
              },
              references: {
                type: 'array',
                items: { type: 'string' },
              },
              guardFindings: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'summary', 'severity', 'segmentId', 'needsReview'],
                  properties: {
                    type: { type: 'string' },
                    summary: { type: 'string' },
                    severity: { type: 'string' },
                    segmentId: { type: 'string' },
                    needsReview: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export async function runGenericWorker(
  params: GenericWorkerParams,
): Promise<GenericWorkerResult> {
  return limit(() => callWithRetries(params));
}

async function callWithRetries(
  params: GenericWorkerParams,
): Promise<GenericWorkerResult> {
  const guardPayload = buildGuardPayload(params.guardContext);
  const memoryPayload = sanitizeMemoryContext(params.memoryContext ?? null);
  const guardSegmentsCount = params.guardContext?.segments?.length ?? 0;
  const memoryVersion = params.memoryContext?.version ?? null;

  const userPayload: Record<string, unknown> = {
    task: params.subKey,
    instruction:
      "Return a JSON object with shape {items:[{issue_ko,issue_en,recommendation_ko,recommendation_en,before,after,alternatives,rationale_ko,rationale_en,confidence,severity,tags,sourceExcerpt,translationExcerpt,evidence:[{reference,quote,note}],notes:{styleGuard,references,guardFindings}}]}",
    constraints: [
      'Preserve semantic content and voice.',
      'Minimize edits unless clearly better.',
      'If no issues, return items:[]',
    ],
    source_text: params.kr,
    target_text: params.en,
  };

  if (guardPayload) {
    userPayload.guard_context = guardPayload;
  }
  if (memoryPayload) {
    userPayload.memory_context = memoryPayload;
  }

  const serializedPayload = JSON.stringify(userPayload);
  const baseInput = [
    {
      role: 'system' as const,
      content: [{ type: 'input_text' as const, text: params.systemPrompt }],
    },
    {
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text: serializedPayload }],
    },
  ];

  const baseMaxTokens = computeDynamicMaxTokens(params, guardSegmentsCount);

  const verbosity =
    params.verbosity ??
    (params.tier === 'deep' ? DEFAULT_VERBOSITY_DEEP : DEFAULT_VERBOSITY_QUICK);
  const reasoningEffort =
    params.reasoningEffort ??
    (params.tier === 'deep' ? DEFAULT_EFFORT_DEEP : DEFAULT_EFFORT_QUICK);
  const retryLimit = Math.max(1, params.retryLimit ?? DEFAULT_RETRY_LIMIT);

  let modelSequence = getProofreadModelSequence(params.model);
  if (params.tier === 'quick') {
    const withoutMini = modelSequence.filter((model) => model !== 'gpt-5-mini');
    modelSequence = ['gpt-5-mini', ...withoutMini];
  }

  let aggregateAttempts = 0;
  let truncatedEncountered = false;
  let lastError: unknown = null;

  for (const modelName of modelSequence) {
    try {
      const runResult = await runResponsesWithRetry({
        client,
        initialMaxOutputTokens: baseMaxTokens,
        maxOutputTokensCap: MAX_OUTPUT_TOKENS_CAP,
        maxAttempts: retryLimit,
        minOutputTokens: 200,
        buildRequest: ({ maxOutputTokens }) =>
          client.responses.create({
            model: modelName,
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: 'json_schema',
                name: PROOFREAD_RESPONSE_SCHEMA_NAME,
                schema: PROOFREAD_RESPONSE_SCHEMA,
                strict: true,
              },
              verbosity,
            },
            reasoning: { effort: reasoningEffort },
            input: baseInput,
          }),
      });

      aggregateAttempts += runResult.attempts;
      truncatedEncountered = truncatedEncountered || runResult.truncated;

      const { parsedJson, text, usage: responseUsage, requestId } =
        safeExtractOpenAIResponse(runResult.response);
      const payload =
        (parsedJson as { items?: unknown[] }) ??
        (text ? (JSON.parse(text) as { items?: unknown[] }) : null);

      if (!payload || !Array.isArray(payload.items)) {
        throw new Error('Proofreading response missing items array');
      }

      const items = normalizeItems(payload.items, params, {
        guardContext: params.guardContext,
      });

      const usageSnapshot: LLMUsageSnapshot = {
        promptTokens: responseUsage?.prompt_tokens ?? null,
        completionTokens: responseUsage?.completion_tokens ?? null,
        totalTokens: responseUsage?.total_tokens ?? null,
      };

      const resolvedModel = runResult.response.model ?? modelName;

      return {
        items,
        meta: {
          model: resolvedModel,
          requestId: requestId ?? runResult.response.id ?? null,
          maxOutputTokens: runResult.maxOutputTokens,
          attempts: aggregateAttempts,
          truncated: truncatedEncountered,
          verbosity,
          reasoningEffort,
          usage: usageSnapshot,
          guardSegments: guardSegmentsCount,
          memoryContextVersion: memoryVersion,
        },
      } satisfies GenericWorkerResult;
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Proofreading run failed after trying all configured models');
}

function normalizeItems(
  rawItems: unknown[],
  params: GenericWorkerParams,
  context: { guardContext?: { segments: GuardWorkerSegment[] } },
): IssueItem[] {
  const guardNotes = buildGuardNotes(context.guardContext);
  const guardSegments = Array.isArray(context.guardContext?.segments)
    ? context.guardContext!.segments
    : [];
  const guardSource =
    guardSegments.find((segment) => segment.source_excerpt)?.source_excerpt ??
    null;
  const guardTarget =
    guardSegments.find((segment) => segment.target_excerpt)?.target_excerpt ??
    null;

  const sourceSentences = splitChunkSentences(params.kr);
  const targetSentences = splitChunkSentences(params.en);

  return rawItems
    .map((item, index) =>
      normalizeSingleItem(
        item,
        params,
        index,
        sourceSentences,
        targetSentences,
        guardSource,
        guardTarget,
        guardNotes,
      ),
    )
    .filter((value): value is NormalizedLLMItem => Boolean(value));
}

function normalizeSingleItem(
  raw: unknown,
  params: GenericWorkerParams,
  index: number,
  sourceSentences: string[],
  targetSentences: string[],
  guardSource: string | null,
  guardTarget: string | null,
  guardNotes: ReturnType<typeof buildGuardNotes>,
): IssueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Record<string, unknown>;

  const issueKo = toTrimmedString(it.issue_ko);
  const issueEn = toTrimmedString(it.issue_en);
  const recKo = toTrimmedString(it.recommendation_ko);
  const recEn = toTrimmedString(it.recommendation_en);
  const rationaleKo = toTrimmedString(it.rationale_ko);
  const rationaleEn = toTrimmedString(it.rationale_en);

  if (!issueKo || !issueEn || !recKo || !recEn || !rationaleKo || !rationaleEn) {
    return null;
  }

  const translationFragment =
    toTrimmedString(it.translationExcerpt) ??
    toTrimmedString(it.after) ??
    guardTarget ??
    null;

  const targetSelection = selectSentence(targetSentences, translationFragment);
  const sourceSelection = selectSentence(
    sourceSentences,
    toTrimmedString(it.sourceExcerpt) ?? guardSource,
  );

  const fallbackSource =
    sourceSelection.text ??
    (targetSelection.index >= 0
      ? sourceSentences[targetSelection.index]
      : guardSource ?? sourceSentences[0] ?? params.kr);
 const fallbackTarget =
   targetSelection.text ??
   (sourceSelection.index >= 0
     ? targetSentences[sourceSelection.index]
     : guardTarget ?? translationFragment ?? targetSentences[0] ?? params.en);

  const guardStatus = guardNotes.length ? 'qa_also' : 'llm_only';
  const guardStatusLabel =
    guardStatus === 'qa_also' ? '번역 QA에서도 확인' : '교정 AI만 발견';

  const spans = normalizeSpan(it.spans);
  const evidence = normalizeEvidence(it.evidence, fallbackSource, fallbackTarget);
  const notes = normalizeNotes(it.notes, guardNotes);

  return {
    id: `${params.subKey}-${params.en_id}-${index}`,
    kr_sentence_id: params.kr_id,
    en_sentence_id: params.en_id,
    issue_ko: issueKo,
    issue_en: issueEn,
    recommendation_ko: recKo,
    recommendation_en: recEn,
    before: toTrimmedString(it.before) ?? fallbackSource ?? '',
    after: toTrimmedString(it.after) ?? fallbackTarget ?? '',
    alternatives: Array.isArray(it.alternatives)
      ? it.alternatives.filter((entry): entry is string => typeof entry === 'string')
      : [],
    rationale_ko: rationaleKo,
    rationale_en: rationaleEn,
    spans,
    confidence: clampConfidence(it.confidence),
    severity: normalizeSeverityValue(it.severity),
    tags: Array.isArray(it.tags)
      ? it.tags.filter((entry): entry is string => typeof entry === 'string')
      : [],
    source: toTrimmedString(it.source) ?? fallbackSource ?? '',
    sourceExcerpt: toTrimmedString(it.sourceExcerpt) ?? fallbackSource ?? '',
    translationExcerpt: translationFragment ?? fallbackTarget ?? '',
    evidence,
    notes,
    guardStatus,
    guardStatusLabel,
  };
}

function normalizeSpan(value: unknown): { start: number; end: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const start = typeof record.start === 'number' ? record.start : null;
  const end = typeof record.end === 'number' ? record.end : null;
  if (start === null || end === null) return null;
  return { start, end };
}

function normalizeEvidence(
  value: unknown,
  fallbackSource: string | null,
  fallbackTarget: string | null,
): ProofreadingEvidence[] {
  if (!Array.isArray(value)) {
    return [buildDefaultEvidence(fallbackSource, fallbackTarget)];
  }
  const entries = value
    .map((entry) => normalizeSingleEvidence(entry))
    .filter((entry): entry is ProofreadingEvidence => Boolean(entry));

  if (entries.length === 0) {
    entries.push(buildDefaultEvidence(fallbackSource, fallbackTarget));
  }
  return entries;
}

function normalizeSingleEvidence(value: unknown): ProofreadingEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const quote = toTrimmedString(record.quote);
  if (!quote) return null;
  const referenceRaw = toTrimmedString(record.reference);
  const reference: ProofreadingEvidence['reference'] = (referenceRaw &&
    ['source', 'target', 'memory', 'other'].includes(referenceRaw))
    ? (referenceRaw as ProofreadingEvidence['reference'])
    : 'source';
  const noteValue = toTrimmedString(record.note) ?? '';
  return { reference, quote, note: noteValue };
}

function buildDefaultEvidence(
  fallbackSource: string | null,
  fallbackTarget: string | null,
): ProofreadingEvidence {
  const quote = fallbackTarget || fallbackSource || '[context unavailable]';
  return { reference: fallbackTarget ? 'target' : 'source', quote, note: '' };
}

function normalizeNotes(
  value: unknown,
  guardNotes: ReturnType<typeof buildGuardNotes>,
): IssueItem['notes'] {
  const styleGuard =
    value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).styleGuard)
      ? ((value as Record<string, unknown>).styleGuard as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
  const references =
    value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).references)
      ? ((value as Record<string, unknown>).references as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
  const guardFindings: GuardFinding[] = guardNotes.map((note) => ({
    type: note.type,
    summary: note.summary,
    severity: note.severity,
    segmentId: note.segmentId,
    needsReview: note.needsReview,
  }));

  return {
    styleGuard,
    references,
    guardFindings,
  };
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0.7;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSeverityValue(value: unknown): 'low' | 'medium' | 'high' {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'low' || lowered === 'medium' || lowered === 'high') {
      return lowered;
    }
  }
  return 'low';
}

function computeDynamicMaxTokens(
  params: GenericWorkerParams,
  guardSegmentsCount: number,
): number {
  const manualCap = Math.min(params.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CAP, MAX_OUTPUT_TOKENS_CAP);
  const sourceTokens = estimateTokens(params.kr);
  const targetTokens = estimateTokens(params.en);
  const guardPadding = guardSegmentsCount > 0 ? 150 : 0;
  const baseEstimate = targetTokens + Math.ceil(sourceTokens * 0.35) + guardPadding;
  const multiplier = params.tier === 'deep' ? 1.8 : 1.35;
  const padding = params.tier === 'deep' ? 250 : 120;
  const lowerBound = params.tier === 'deep' ? 1500 : 600;
  const estimated = Math.round((baseEstimate + padding) * multiplier);
  const upperCap = Math.max(lowerBound, manualCap);
  return Math.max(lowerBound, Math.min(estimated, upperCap));
}

function buildGuardPayload(context?: GenericWorkerParams['guardContext']) {
  if (!context?.segments?.length) return undefined;
  return {
    flagged_segments: context.segments.map((segment) => ({
      segment_id: segment.segment_id,
      segment_index: segment.segment_index,
      needs_review: segment.needs_review,
      guard_checks: segment.guards ?? null,
      guard_findings: Array.isArray(segment.guard_findings)
        ? segment.guard_findings.map((finding) => ({
            type: finding.type,
            summary: finding.summary,
            severity: finding.severity ?? null,
          }))
        : [],
      source_excerpt: segment.source_excerpt ?? null,
      target_excerpt: segment.target_excerpt ?? null,
    })),
  };
}

function buildGuardNotes(context?: GenericWorkerParams['guardContext']) {
  if (!context?.segments?.length) return [];
  const notes: Array<{
    type: string;
    summary: string;
    segmentId: string;
    severity?: string;
    needsReview?: boolean;
  }> = [];

  for (const segment of context.segments) {
    const findings = Array.isArray(segment.guard_findings)
      ? segment.guard_findings
      : [];
    for (const finding of findings) {
      notes.push({
        type: finding.type,
        summary: finding.summary,
        segmentId: segment.segment_id,
        severity: finding.severity ?? undefined,
        needsReview: segment.needs_review,
      });
    }
  }

  return notes;
}

function sanitizeMemoryContext(
  context: ProofreadingMemoryContext | null,
): ProofreadingMemoryContext | null {
  if (!context) return null;
  return {
    version: context.version ?? null,
    styleProfile: context.styleProfile ?? undefined,
    romanizationPolicy: context.romanizationPolicy ?? undefined,
    timePeriod: context.timePeriod ?? undefined,
    characters: context.characters ?? undefined,
    namedEntities: context.namedEntities ?? undefined,
    terminology: context.terminology ?? undefined,
    measurementUnits: context.measurementUnits ?? undefined,
    linguisticFeatures: context.linguisticFeatures ?? undefined,
  };
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function splitChunkSentences(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n\r?\n+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function selectSentence(
  sentences: string[],
  fragment?: string | null,
): { text: string | null; index: number } {
  if (fragment) {
    const index = sentences.findIndex((sentence) => sentence.includes(fragment));
    if (index >= 0) {
      return { text: sentences[index], index };
    }
  }
  return { text: null, index: -1 };
}

export function buildProofreadingMemoryContext(params: {
  memory: ProjectMemory | null;
  translationNotes: TranslationNotes | null;
  version: number | null;
}): ProofreadingMemoryContext | null {
  const { memory: _memory, translationNotes, version } = params;
  void _memory;
  if (!translationNotes && version === null) return null;

  const context: ProofreadingMemoryContext = {
    version,
  };

  if (translationNotes?.timePeriod) {
    context.timePeriod = translationNotes.timePeriod;
  }
  if (Array.isArray(translationNotes?.characters)) {
    context.characters = translationNotes.characters.map((character) => ({
      name: character.name,
      targetName: character.targetName ?? null,
      gender: character.gender ?? null,
      age: character.age ?? null,
      traits: Array.isArray(character.traits)
        ? character.traits.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }));
  }
  if (Array.isArray(translationNotes?.namedEntities)) {
    context.namedEntities = translationNotes.namedEntities.map((entity) => ({
      name: entity.name,
      targetName: entity.targetName ?? null,
    }));
  }
  if (Array.isArray(translationNotes?.measurementUnits)) {
    context.measurementUnits = translationNotes.measurementUnits.map((entry) => ({
      source: entry.source,
      target: entry.target ?? null,
    }));
  }
  if (Array.isArray(translationNotes?.linguisticFeatures)) {
    context.linguisticFeatures = translationNotes.linguisticFeatures.map((entry) => ({
      source: entry.source,
      target: entry.target ?? null,
    }));
  }

  return context;
}
