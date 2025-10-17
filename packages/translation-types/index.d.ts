/**
 * Shared translation-pipeline type definitions.
 * These mirror the design contract documented in docs/sequential-translation-pipeline.md
 * so that server workers and clients stay aligned as the sequential pipeline rolls out.
 */

export type LanguageCode = "ko" | "en";

export type SegmentMode = "paragraph" | "sentence";

export interface BilingualValue {
  source: string;
  target: string;
}

export interface ProjectMemoryStyleProfile {
  register: string;
  rhythm?: string;
  avg_sentence_tokens?: number;
}

export interface ProjectMemoryTimePeriod {
  source?: string;
  target_notes?: string;
}

export interface ProjectMemoryCharacter {
  name: BilingualValue;
  role: string;
  voice?: string;
  honorifics?: Record<'source' | 'target', string>;
  description?: string;
}

export type MemoryEntityType = 'place' | 'person' | 'org' | 'object' | 'concept';

export interface ProjectMemoryEntity {
  label: BilingualValue;
  type: MemoryEntityType;
  aliases?: BilingualValue[];
  confidence?: number;
}

export interface ProjectMemorySymbol {
  target: string;
  connotations: string[];
  must_preserve?: boolean;
  approved_paraphrases?: string[];
  confidence?: number;
}

export interface ProjectMemoryTermMap {
  source_to_target: Record<string, string>;
  target_to_source: Record<string, string>;
  units?: Record<string, string>;
}

export interface ProjectMemoryLinguisticFeatures {
  source?: Record<string, string>;
  target?: Record<string, string>;
}

export type RomanizationPolicy = 'as-is' | 'rr' | 'none' | string;

export interface ProjectMemory {
  style_profile: ProjectMemoryStyleProfile;
  time_period?: ProjectMemoryTimePeriod;
  character_sheet?: ProjectMemoryCharacter[];
  named_entities?: ProjectMemoryEntity[];
  symbol_table?: Record<string, ProjectMemorySymbol>;
  term_map: ProjectMemoryTermMap;
  linguistic_features?: ProjectMemoryLinguisticFeatures;
  romanizationPolicy?: RomanizationPolicy;
  scene_summaries?: Record<string, string>;
  [key: string]: unknown;
}

export type TranslationStage = 'literal' | 'style' | 'emotion' | 'qa';

export interface EmotionBaseline {
  vector: number[];
  topLabels?: string[];
  strength?: number;
  confidence?: number;
}

export interface VividnessBaseline {
  sensory_density?: number;
  concreteness?: number;
  lexical_diversity?: number;
  vividness?: number;
  confidence?: number;
}

export interface MetaphorBaselineItem {
  phrase: string;
  type: 'image' | 'metaphor' | 'symbol-candidate';
  connotations?: string[];
  salience?: number;
}

export interface MetaphorBaseline {
  items: MetaphorBaselineItem[];
  confidence?: number;
}

export interface StyleRhythmBaseline {
  mean?: number;
  sd?: number;
}

export interface BaselineMetrics {
  emotion?: EmotionBaseline;
  vividness?: VividnessBaseline;
  metaphor?: MetaphorBaseline;
  styleRhythm?: StyleRhythmBaseline;
  [key: string]: unknown;
}

export interface MetricScores {
  fidelity?: number;
  fluency?: number;
  style?: number;
  cultural?: number;
  emotion?: number;
  vividness?: number;
  metaphor?: number;
  literaryValue?: number;
  [key: string]: number | undefined;
}

export interface GuardBooleans {
  parityOk?: boolean;
  metaphorOk?: boolean;
  namesOk?: boolean;
  registerOk?: boolean;
  culturalOk?: boolean;
  allOk?: boolean;
  [key: string]: boolean | undefined;
}

export interface GuardFindingDetail {
  type: string;
  ok: boolean;
  summary: string;
  segmentId?: string;
  score?: number;
  severity?: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

export interface SequentialTranslationTemps {
  literal: number;
  style: number;
  emotion: number;
}

export interface SequentialTranslationMBRConfig {
  enable: boolean;
  k: number;
  highQualityOnPivots?: boolean;
  applyTo?: string[];
}

export interface SequentialTranslationPivotConfig {
  autoDetect: boolean;
  allowOverrides: boolean;
}

export interface SequentialTranslationWeights {
  fidelity: number;
  fluency: number;
  style: number;
  cultural: number;
  emotion: number;
  vividness: number;
  metaphor: number;
  literaryValue: number;
  [key: string]: number;
}

export interface SequentialTranslationThresholds {
  fidelityMin: number;
  fluencyMin: number;
  literaryValueMin: number;
  emotionCorrMin: number;
  vividnessRelMin: number;
  [key: string]: number;
}

export interface SequentialTranslationProofreadConfig {
  topK: number;
  minSeverity: string;
  dedupBy?: string[];
  suppress?: string[];
  autoApplySafeFixes?: boolean;
}

export interface SequentialTranslationBatchingConfig {
  batchSize: number;
  workerConcurrency: number;
  apiRateLimitTPS: number;
}

export interface SequentialTranslationTokenBudget {
  promptMax: number;
  completionMax: number;
}

export interface ContextPolicyConfig {
  verbatimMax: number;
  summaryMax: number;
  mode: 'hybrid' | 'deterministic' | 'llm';
}

export interface SequentialTranslationConfig {
  translationMode: 'sequential';
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  segmentMode: SegmentMode | string;
  window: number;
  contextPolicy: ContextPolicyConfig;
  temps: SequentialTranslationTemps;
  register?: string;
  honorifics?: string;
  romanizationPolicy?: RomanizationPolicy;
  creativeAutonomy?: 'none' | 'light' | 'moderate';
  mbr?: SequentialTranslationMBRConfig;
  pivots?: SequentialTranslationPivotConfig;
  weights?: SequentialTranslationWeights;
  thresholds?: SequentialTranslationThresholds;
  proofread: SequentialTranslationProofreadConfig;
  batching: SequentialTranslationBatchingConfig;
  tokenBudget: SequentialTranslationTokenBudget;
  [key: string]: unknown;
}

export interface TranslateSegmentReq {
  segmentId: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  sourceText: string;
  prevCtx?: string;
  nextCtx?: string;
  memory: ProjectMemory;
  config: SequentialTranslationConfig;
}

export interface TranslateSegmentRes {
  segmentId: string;
  textTarget: string;
  baseline?: BaselineMetrics;
  scores?: MetricScores;
  guards?: GuardBooleans;
  notes?: unknown;
  [key: string]: unknown;
}

export interface SequentialStageResult extends TranslateSegmentRes {
  stage: TranslationStage;
}

export interface SequentialStagePayload extends TranslateSegmentReq {
  stage: TranslationStage;
}

export interface SequentialStageJobSegment {
  segmentId: string;
  segmentIndex: number;
  textSource: string;
  prevCtx?: string;
  nextCtx?: string;
  literalDraftId?: string;
  styleDraftId?: string;
  emotionDraftId?: string;
  baseline?: BaselineMetrics;
  stageOutputs?: Partial<Record<TranslationStage, SequentialStageResult>>;
}

export interface SequentialStageJob {
  jobId: string;
  projectId: string;
  workflowRunId?: string;
  sourceHash?: string;
  stage: TranslationStage;
  memoryVersion: number;
  config: SequentialTranslationConfig;
  segmentBatch: SequentialStageJobSegment[];
  batchNumber: number;
  batchCount: number;
  retryContext?: {
    attempt: number;
    reason?: string;
  };
  translationNotes?: unknown;
}
