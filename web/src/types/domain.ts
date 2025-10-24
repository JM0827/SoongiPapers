export type Locale = "ko" | "en";

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export interface ProjectMeta {
  llmModel?: string;
  [key: string]: unknown;
}

export interface ProjectSummary {
  project_id: string;
  title: string;
  book_title?: string | null;
  author_name?: string | null;
  translator_name?: string | null;
  description?: string;
  intention?: string;
  status?: string;
  origin_lang: string;
  target_lang: string;
  created_at?: string;
  updated_at?: string;
  meta?: ProjectMeta | null;
}

export interface JobSummary {
  id: string;
  document_id?: string;
  project_id?: string;
  type: "translate" | "analyze" | "profile";
  status: string;
  origin_lang?: string;
  target_lang?: string;
  created_at?: string;
  updated_at?: string;
  finished_at?: string;
  last_error?: string | null;
  batches?: Array<{
    id: string;
    batch_index: number;
    status: string;
    started_at?: string;
    finished_at?: string;
    error?: string;
  }>;
  drafts?: TranslationDraftSummary[];
  finalTranslation?: TranslationFinalSummary | null;
  sequential?: JobSequentialSummary | null;
}

export interface JobSequentialSummary {
  stageCounts: Record<string, number>;
  totalSegments: number;
  needsReviewCount: number;
  completedStages: string[];
  currentStage: string | null;
  guardFailures?: Record<string, number>;
  flaggedSegments?: Array<{
    segmentIndex: number;
    segmentId: string;
    guards?: Record<string, unknown> | null;
    guardFindings?: Array<{
      type: string;
      summary: string;
      ok?: boolean;
      severity?: string;
      segmentId?: string;
      details?: Record<string, unknown> | null;
    }>;
  }>;
}

export interface TranslationDraftSummary {
  id: string;
  runOrder: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  model?: string | null;
  temperature?: number | null;
  topP?: number | null;
}

export interface TranslationFinalSummary {
  id: string;
  projectId: string | null;
  jobId: string | null;
  completedAt: string | null;
  segments?: number | null;
  sourceHash?: string | null;
}

export type WorkflowType = "translation" | "proofread" | "quality";

export type WorkflowRunStatus =
  | "running"
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkflowStateItem {
  type: WorkflowType;
  status: WorkflowRunStatus | "idle";
  label: string | null;
  currentRunId: string | null;
  updatedAt: string | null;
}

export interface WorkflowRunRecord {
  runId: string;
  projectId: string;
  type: WorkflowType;
  status: WorkflowRunStatus;
  requestedBy: string | null;
  intentText: string | null;
  label: string | null;
  parentRunId: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  sequence: number;
}

export interface WorkflowSummary {
  state: WorkflowStateItem[];
  recentRuns: WorkflowRunRecord[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  updatedAt: string | null;
}

export interface UsageEventGroup {
  eventType: "translate" | "quality" | "proofread" | "ebook";
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export interface QualityAssessmentMeta {
  model?: string;
  chunks?: number;
  chunkSize?: number;
  [key: string]: unknown;
}

export interface QualityAssessmentResultPayload {
  overallScore?: number | null;
  meta?: QualityAssessmentMeta;
  quantitative?: Record<string, unknown> | null;
  qualitative?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ProjectUsageResponse {
  projectTotals: UsageTotals;
  jobs: Array<{
    jobId: string;
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
  }>;
  eventsByType: UsageEventGroup[];
}

export type ProofreadingSeverity = "low" | "medium" | "high";

export interface ProofreadingIssue {
  id: string;
  kr_sentence_id?: number | null;
  en_sentence_id?: number | null;
  issue_ko: string;
  issue_en: string;
  recommendation_ko: string;
  recommendation_en: string;
  before?: string;
  after: string;
  alternatives?: string[];
  rationale_ko: string;
  rationale_en: string;
  spans?: { start: number; end: number } | null;
  confidence: number;
  severity: ProofreadingSeverity;
  source?: string;
  sourceExcerpt?: string;
  translationExcerpt?: string;
  tags?: string[];
  status?: string;
  appliedAt?: string | null;
  applied_at?: string | null;
  notes?: {
    guardFindings?: Array<{
      type: string;
      summary: string;
      segmentId?: string;
      severity?: string;
      needsReview?: boolean;
      details?: Record<string, unknown> | null;
    }>;
    styleGuard?: string[];
    references?: string[];
    [key: string]: unknown;
  };
}

export interface ProofreadingBucket {
  group: string;
  subfeatureKey: string;
  subfeatureLabel: string;
  items: ProofreadingIssue[];
}

export interface ProofreadingReportSummary {
  countsBySubfeature?: Record<string, number>;
  notes_ko?: string;
  notes_en?: string;
}

export interface ProofreadingReport {
  meta?: {
    schemaVersion?: string;
    source?: { lang: string; path: string };
    target?: { lang: string; path: string };
    alignment?: string;
    generatedAt?: string;
  };
  results?: ProofreadingBucket[];
  summary?: ProofreadingReportSummary;
  appliedTranslation?: string | null;
  [key: string]: unknown;
}

export interface ProofreadEditorDatasetSummary {
  id: string;
  projectId: string;
  translationFileId: string;
  jobId: string | null;
  variant: string | null;
  source: string | null;
  updatedAt: string | null;
  segmentCount: number;
  originVersion: string | null;
  translationVersion: string | null;
  proofreadingId: string | null;
  proofreadingStage: string | null;
  proofreadUpdatedAt: string | null;
}

export interface ProofreadEditorSegmentPayload {
  segmentId: string;
  segmentIndex: number;
  origin: {
    text: string;
    lastSavedAt: string | null;
  };
  translation: {
    text: string;
    lastSavedAt: string | null;
  };
  issues: string[];
  spans: Array<{ issueId: string; start: number; end: number }>;
  annotations: unknown[];
}

export interface ProofreadEditorIssueEntry {
  id: string;
  segmentId?: string | null;
  severity?: string | null;
  status?: string | null;
  bucket?: {
    group?: string | null;
    subfeatureLabel?: string | null;
    subfeatureKey?: string | null;
  } | null;
  issue?: {
    issue_en?: string | null;
    issue_ko?: string | null;
    recommendation_en?: string | null;
    recommendation_ko?: string | null;
    before?: string | null;
    after?: string | null;
  } | null;
  spans?: Array<{ start: number; end: number }>;
  documentSpan?: { start?: number | null; end?: number | null } | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  [key: string]: unknown;
}

export interface ProofreadEditorVersions {
  documentVersion: string;
  translationVersion: string;
}

export interface ProofreadEditorResponse {
  dataset: ProofreadEditorDatasetSummary;
  segments: ProofreadEditorSegmentPayload[];
  issues: ProofreadEditorIssueEntry[];
  issueAssignments: Record<string, string[]>;
  versions: ProofreadEditorVersions;
  featureToggles: Record<string, boolean>;
}

export interface ProofreadEditorPatchSegmentInput {
  segmentId: string;
  column: 'origin' | 'translation';
  text: string;
}

export interface ProofreadEditorPatchPayload {
  translationFileId: string;
  documentVersion: string;
  segments: ProofreadEditorPatchSegmentInput[];
  projectId?: string;
  jobId?: string | null;
  clientMutationId?: string | null;
}

export interface ProofreadEditorPatchResponse extends ProofreadEditorResponse {
  clientMutationId?: string | null;
}

export interface ProofreadEditorConflictResponse {
  code: 'CONFLICT';
  message: string;
  documentVersion?: string;
  serverSegments?: ProofreadEditorSegmentPayload[];
  details?: Record<string, unknown>;
}

export interface ProofreadEditorStreamEvent {
  type: 'proofread.update' | 'proofread.ready';
  projectId: string;
  translationFileId?: string | null;
  jobId?: string | null;
  documentVersion?: string;
  clientMutationId?: string | null;
  emittedAt?: string;
  [key: string]: unknown;
}

export interface DocumentProfileSummary {
  id: string;
  projectId: string;
  type: "origin" | "translation";
  version: number;
  language: string | null;
  jobId: string | null;
  metrics: {
    wordCount: number;
    charCount: number;
    paragraphCount: number;
    readingTimeMinutes: number;
    readingTimeLabel: string;
  };
  summary: {
    story: string;
    intention: string;
    readerPoints: string[];
  };
  references: {
    originFileId: string | null;
    translationFileId: string | null;
    qualityAssessmentId: string | null;
    proofreadingId: string | null;
  };
  translationNotes: {
    characters: Array<{
      name: string;
      age: string | null;
      gender: string | null;
      traits: string[];
    }>;
    namedEntities: Array<{ name: string; frequency: number }>;
    timePeriod: string | null;
    locations: Array<{ name: string; frequency: number }>;
    measurementUnits: string[];
    linguisticFeatures: string[];
  } | null;
  source?: {
    hash: string | null;
    preview: string | null;
  };
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectContent {
  projectId: string;
  projectProfile?: {
    id?: string;
    title?: string;
    status?: string;
    intention?: string | null;
    description?: string | null;
    memo?: string | null;
    originLang?: string | null;
    targetLang?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    bookTitle?: string | null;
    authorName?: string | null;
    translatorName?: string | null;
    meta?: {
      author?: string | null;
      translator?: string | null;
      bookTitleEn?: string | null;
      originalAuthorNotes?: string | null;
      translatorNotes?: string | null;
      context?: string | null;
      notes?: string | null;
      translationDirection?: string | null;
    } | null;
  } | null;
  latestJob?: {
    jobId: string;
    status: string;
    type?: string;
    createdAt?: string | null;
    updatedAt?: string | null;
    batchCount?: number;
    completedBatchCount?: number;
    errorBatchCount?: number;
    stage?: string | null;
    batches?: Array<{
      batchId: string;
      index: number;
      status: string;
      startedAt?: string;
      finishedAt?: string;
      error?: string | null;
      mongoBatchId?: string | null;
    }>;
  } | null;
  content?: {
    origin?: {
      content?: string;
      timestamp?: string;
      filename?: string | null;
      language?: string | null;
    };
    translation?: {
      content?: string;
      isPartial?: boolean;
      timestamp?: string;
      jobId?: string | null;
      translationFileId?: string | null;
      language?: string | null;
    };
    batchesMetadata?: Array<{
      batchId: string;
      index: number;
      status: string;
      startedAt?: string;
      finishedAt?: string;
      error?: string | null;
    }>;
    batchesActualData?: unknown[];
  };
  documentProfiles?: {
    origin: DocumentProfileSummary | null;
    translation: DocumentProfileSummary | null;
  };
  qualityAssessment?: {
    assessmentId?: string;
    jobId?: string;
    timestamp?: string;
    overallScore?: number;
    modelUsed?: string;
    qualityResult?: QualityAssessmentResultPayload | null;
    meta?: QualityAssessmentMeta;
    [key: string]: unknown;
  } | null;
  proofreading?: {
    exists: boolean;
    stage: string;
    id?: string;
    jobId?: string;
    job_id?: string | null;
    status?: string | null;
    stageDetail?: string | null;
    statusMessage?: string | null;
    note?: string | null;
    applied?: boolean;
    appliedIssueIds?: string[];
    appliedTranslation?: string | null;
    report?: ProofreadingReport | null;
    quickReport?: ProofreadingReport | null;
    deepReport?: ProofreadingReport | null;
    timestamp?: string;
    updatedAt?: string | null;
  } | null;
  translationStage?: string;
  qualityAssessmentStage?: string;
  proofreadingStage?: string;
  available?: {
    origin: boolean;
    translation: boolean;
    qualityAssessment: boolean;
    proofreading: boolean;
  };
  ebook?: {
    ebookId?: string;
    format?: string;
    status?: string;
    filename?: string;
    storageRef?: string;
    updatedAt?: string | null;
  } | null;
}

export interface TranslationRecommendation {
  translationFileId: string;
  jobId: string | null;
  completedAt: string | null;
  qualityScore: number;
  qualityAssessmentId: string | null;
}

export interface ProjectTranslationOption {
  translationFileId: string;
  filename: string | null;
  jobId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  qualityScore: number | null;
  qualityAssessmentId: string | null;
}

export interface EbookResponse {
  success?: boolean;
  requiresConfirmation?: boolean;
  recommendation?: TranslationRecommendation;
  ebook?: {
    ebookId: string;
    format: string;
    status: string;
    filename: string;
    storageRef: string;
    qualityAssessmentId: string | null;
    qualityScore: number | null;
    coverUrl?: string | null;
    versionId?: string;
    assetId?: string;
  };
}

export type CoverStatus = "queued" | "generating" | "ready" | "failed";
export type CoverAssetRole = "front" | "back" | "spine" | "wrap";

export interface CoverAssetInfo {
  assetId: string;
  role: CoverAssetRole;
  publicUrl: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  checksum: string;
}

export interface CoverSetInfo {
  coverSetId: string;
  status: CoverStatus;
  isCurrent: boolean;
  generatedAt: string;
  createdBy: string | null;
  prompt?: string | null;
  summary?: string | null;
  failureReason?: string | null;
  assets: CoverAssetInfo[];
}

export interface CoverInfo {
  projectId: string;
  currentSetId: string | null;
  coverSets: CoverSetInfo[];
  fallbackUrl: string | null;
}

export interface EbookAssetInfo {
  assetId: string;
  fileName: string;
  publicUrl: string;
  mimeType: string;
  filePath: string;
  sizeBytes: number;
  checksum: string;
}

export interface EbookVersionInfo {
  ebookVersionId: string;
  versionNumber: number;
  translationFileId: string | null;
  qualityAssessmentId: string | null;
  format: string;
  wordCount: number | null;
  characterCount: number | null;
  createdAt: string | null;
  createdBy: string | null;
  asset: EbookAssetInfo | null;
}

export interface EbookMetadataInfo {
  writerNote: string | null;
  translatorNote: string | null;
  isbn: string | null;
}

export interface EbookDistributionInfo {
  channel: string;
  status: string;
  listingId?: string | null;
  price?: number | null;
  currency?: string | null;
  plannedPublishAt?: string | null;
  publishedAt?: string | null;
  lastSyncedAt?: string | null;
  failureReason?: string | null;
}

export interface EbookDetails {
  projectId: string;
  status: string;
  ebook: {
    ebookId: string;
    title: string | null;
    author: string | null;
    translator: string | null;
    synopsis: string | null;
    sourceLanguage: string | null;
    targetLanguage: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    currentVersionId: string | null;
  } | null;
  metadata: EbookMetadataInfo;
  latestVersion: EbookVersionInfo | null;
  distribution: EbookDistributionInfo[];
}

export type ChatMessageRole = "assistant" | "user" | "system";

export interface ChatMessagePayload {
  role: ChatMessageRole;
  content: string;
}

export interface ProjectContextSnapshotPayload {
  projectId: string | null;
  projectTitle: string | null;
  targetLang: string | null;
  lifecycle: {
    translation: {
      stage: "none" | "origin-only" | "translating" | "translated" | "failed";
      lastUpdatedAt: string | null;
      jobId: string | null;
    };
    proofreading: {
      stage: "none" | "running" | "queued" | "done" | "failed" | "unknown";
      lastUpdatedAt: string | null;
      jobId: string | null;
    };
    quality: {
      stage: "none" | "running" | "done" | "failed";
      lastUpdatedAt: string | null;
      score: number | null;
    };
    publishing: {
      stage: "none" | "exporting" | "exported";
      lastUpdatedAt: string | null;
      ebookId: string | null;
    };
  };
  timeline: Array<{
    phase: "origin" | "translation" | "proofreading" | "quality" | "publishing";
    status: string;
    updatedAt: string | null;
    note?: string;
  }>;
  origin: {
    hasContent: boolean;
    lastUpdatedAt: string | null;
    filename: string | null;
  };
  translation: {
    hasContent: boolean;
    lastUpdatedAt: string | null;
  };
  excerpts: {
    originPreview: string | null;
    translationPreview: string | null;
  };
  ui: {
    rightPanelTab: string;
    originExpanded: boolean;
    translationExpanded: boolean;
  };
  jobs: {
    status: string | null;
    activeJobId: string | null;
    lastCheckedAt: number | null;
    batchesCompleted: number | null;
    batchesTotal: number | null;
  };
  refreshedAt: number;
}

export interface SelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditingSelectionPayload {
  source: "origin" | "translation";
  text: string;
  rawText?: string | null;
  range: SelectionRange;
  meta?: Record<string, unknown> | null;
}

export interface EditingSuggestionResponse {
  suggestionId: string;
  resultText: string;
  explanation?: string | null;
  warnings?: string[];
  tokens?: {
    prompt?: number | null;
    completion?: number | null;
    total?: number | null;
  } | null;
}

interface BaseChatAction {
  reason?: string;
  label?: string | null;
  allowParallel?: boolean;
  autoStart?: boolean;
}

export type ChatAction =
  | ({
      type: "startTranslation";
    } & BaseChatAction)
  | ({
      type: "startUploadFile";
    } & BaseChatAction)
  | ({
      type: "viewTranslationStatus";
    } & BaseChatAction)
  | ({
      type: "cancelTranslation";
      jobId?: string | null;
      workflowRunId?: string | null;
    } & BaseChatAction)
  | ({
      type: "startProofread";
    } & BaseChatAction)
  | ({
      type: "startQuality";
    } & BaseChatAction)
  | ({
      type: "viewQualityReport";
    } & BaseChatAction)
  | ({
      type: "openExportPanel";
    } & BaseChatAction)
  | ({
      type: "viewTranslatedText";
    } & BaseChatAction)
  | ({
      type: "openProofreadTab";
    } & BaseChatAction)
  | ({
      type: "describeProofSummary";
    } & BaseChatAction)
  | ({
      type: "acknowledge";
    } & BaseChatAction)
  | ({
      type: "createProject";
    } & BaseChatAction)
  | ({
      type: "applyEditingSuggestion";
      suggestionId: string;
    } & BaseChatAction)
  | ({
      type: "undoEditingSuggestion";
      suggestionId: string;
    } & BaseChatAction)
  | ({
      type: "dismissEditingSuggestion";
      suggestionId: string;
    } & BaseChatAction);

export interface ChatResponse {
  reply: string;
  actions: ChatAction[];
  profileUpdates?: {
    author?: string;
    context?: string;
    translationDirection?: string;
    memo?: string;
  };
  model?: string;
}

export interface ChatHistoryItem {
  id: string;
  projectId: string;
  role: ChatMessageRole;
  content: string;
  actions?: ChatAction[];
  created_at: string;
}

export interface ChatLogRequest {
  projectId: string;
  role: Extract<ChatMessageRole, "assistant" | "system">;
  content: string;
  actions?: ChatAction[];
}
