import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import Editor, { type OnChange, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import {
  ShieldCheck,
  Loader2,
  XCircle,
  Check,
  Layers,
  Sparkles,
  Heart,
  Shield,
  BookOpenCheck,
  PenSquare,
  type LucideIcon,
} from "lucide-react";
import {
  useEditingCommandStore,
  type EditingEditorAdapter,
  type EditorSelectionContext,
} from "../../store/editingCommand.store";
import type {
  SelectionRange,
  ProofreadingIssue,
  TranslationStageKey,
  DocumentProfileSummary,
  DocumentSummaryFallback,
} from "../../types/domain";
import { useProofreadEditorContext } from "../../context/proofreadEditor";
import {
  useProofreadIssues,
  type ProofreadIssueEntry,
  type ProofreadHighlightSegment,
} from "../../context/ProofreadIssuesContext";
import { useUIStore } from "../../store/ui.store";
import { useAuthStore } from "../../store/auth.store";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";
import { useTranslationStageDrafts } from "../../hooks/useTranslationStageDrafts";
import { Modal } from "../common/Modal";

const RECORD_SEPARATOR = "\u241E";
const SEGMENT_DELIMITER = `\n${RECORD_SEPARATOR}\n`;

interface AggregatedSegmentMeta {
  segmentId: string;
  startOffset: number;
  endOffset: number;
  separatorStart: number | null;
  separatorLength: number;
  plainStartOffset: number;
  plainEndOffset: number;
  plainSeparatorLength: number;
}

interface AggregatedModel {
  value: string;
  segments: AggregatedSegmentMeta[];
  metaMap: Map<string, AggregatedSegmentMeta>;
}

const PLAIN_SEGMENT_SEPARATOR = "\n\n";

const LEGACY_STAGE_ORDER: TranslationStageKey[] = [
  "literal",
  "style",
  "emotion",
  "qa",
];

const V2_STAGE_ORDER: TranslationStageKey[] = [
  "draft",
  "revise",
  "micro-check",
];

const V2_STAGE_SET = new Set(V2_STAGE_ORDER);

const STAGE_META: Record<
  TranslationStageKey,
  { icon: LucideIcon; fallback: string; toneClass: string }
> = {
  literal: {
    icon: Layers,
    fallback: "Literal pass",
    toneClass: "text-sky-600",
  },
  style: {
    icon: Sparkles,
    fallback: "Style pass",
    toneClass: "text-indigo-600",
  },
  emotion: {
    icon: Heart,
    fallback: "Emotion pass",
    toneClass: "text-rose-600",
  },
  qa: { icon: Shield, fallback: "QA review", toneClass: "text-emerald-600" },
  draft: {
    icon: BookOpenCheck,
    fallback: "Draft pass",
    toneClass: "text-sky-600",
  },
  revise: {
    icon: PenSquare,
    fallback: "Revise pass",
    toneClass: "text-indigo-600",
  },
  "micro-check": {
    icon: ShieldCheck,
    fallback: "Micro-check",
    toneClass: "text-emerald-600",
  },
};

const buildAggregatedModel = (
  items: {
    segmentId: string;
    text: string;
  }[],
): AggregatedModel => {
  let cursor = 0;
  let plainCursor = 0;
  let value = "";
  const segments: AggregatedSegmentMeta[] = [];
  const metaMap = new Map<string, AggregatedSegmentMeta>();
  items.forEach((item, index) => {
    const startOffset = cursor;
    const plainStartOffset = plainCursor;
    value += item.text;
    cursor += item.text.length;
    const separatorString =
      index < items.length - 1 ? `\n${RECORD_SEPARATOR}\n` : "";
    const plainSeparatorString =
      index < items.length - 1 ? PLAIN_SEGMENT_SEPARATOR : "";
    const segmentMeta: AggregatedSegmentMeta = {
      segmentId: item.segmentId,
      startOffset,
      endOffset: cursor,
      separatorStart: separatorString ? cursor : null,
      separatorLength: separatorString.length,
      plainStartOffset,
      plainEndOffset: plainStartOffset + item.text.length,
      plainSeparatorLength: plainSeparatorString.length,
    };
    segments.push(segmentMeta);
    metaMap.set(item.segmentId, segmentMeta);
    if (separatorString) {
      value += separatorString;
      cursor += separatorString.length;
    }
    plainCursor += item.text.length;
    if (plainSeparatorString) {
      plainCursor += plainSeparatorString.length;
    }
  });
  return { value, segments, metaMap };
};

const splitAggregatedValue = (value: string, expectedLength: number) => {
  const parts = value.split(SEGMENT_DELIMITER);
  return parts.length === expectedLength ? parts : null;
};

const mapOffsetToSegment = (
  offset: number,
  model: AggregatedModel,
): string | null => {
  const entry = model.segments.find(
    (segment) => offset >= segment.startOffset && offset <= segment.endOffset,
  );
  return entry ? entry.segmentId : null;
};

interface SelectionOverlayState {
  context: EditorSelectionContext;
  x: number;
  y: number;
}

const severityToClass = (severity?: string | null) => {
  const normalized = String(severity ?? "").toLowerCase();
  if (normalized.includes("high") || normalized === "critical") {
    return "proofread-hl-critical";
  }
  if (normalized.includes("medium")) {
    return "proofread-hl-medium";
  }
  if (normalized.includes("low")) {
    return "proofread-hl-low";
  }
  return "proofread-hl-default";
};

const formatTimestamp = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
};

type IssueRange = {
  issueId: string;
  segmentId: string;
  startOffset: number;
  endOffset: number;
};

type SegmentSpanLike = {
  issueId: string;
  start?: number | null;
  end?: number | null;
  length?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
  segmentStart?: number | null;
  segmentEnd?: number | null;
  offset?: number | null;
  spanLength?: number | null;
  len?: number | null;
  [key: string]: unknown;
};

type DebuggableWindow = Window & {
  __BOOKKO_DEBUG_PROOFREAD__?: unknown;
};

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const looseMatchRange = (
  source: string,
  target?: string | null,
): { start: number; end: number } | null => {
  if (!target) return null;
  const variants = [target, target.trim()].filter(Boolean) as string[];
  for (const variant of variants) {
    if (!variant) continue;
    const regex = new RegExp(escapeRegex(variant).replace(/\s+/g, "\\s+"), "m");
    const match = regex.exec(source);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
};

const collectStringCandidates = (values: Array<unknown>): string[] => {
  const seen = new Set<string>();
  const results: string[] = [];
  values.forEach((value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    results.push(value);
  });
  return results;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const resolveSegmentSpanOffsets = (
  span: SegmentSpanLike,
  segmentMeta: AggregatedSegmentMeta,
  segmentText: string,
): { startOffset: number; endOffset: number } | null => {
  const rawStartCandidates: Array<unknown> = [
    span.start,
    span.startOffset,
    span.segmentStart,
    span.offset,
  ];
  const rawEndCandidates: Array<unknown> = [
    span.end,
    span.endOffset,
    span.segmentEnd,
  ];
  const rawLengthCandidates: Array<unknown> = [
    span.length,
    span.spanLength,
    span.len,
  ];

  let rawStart =
    rawStartCandidates
      .map(toFiniteNumber)
      .find((value): value is number => value !== null) ?? null;
  let rawEnd =
    rawEndCandidates
      .map(toFiniteNumber)
      .find((value): value is number => value !== null) ?? null;
  const rawLength =
    rawLengthCandidates
      .map(toFiniteNumber)
      .find((value): value is number => value !== null) ?? null;

  if (rawStart === null && rawEnd !== null && rawLength !== null) {
    rawStart = rawEnd - rawLength;
  } else if (rawEnd === null && rawStart !== null && rawLength !== null) {
    rawEnd = rawStart + rawLength;
  }

  if (rawStart === null || rawEnd === null) {
    return null;
  }

  const segmentLength = segmentText.length;
  const candidates: Array<{ start: number; end: number }> = [
    { start: rawStart, end: rawEnd },
    {
      start: rawStart - segmentMeta.startOffset,
      end: rawEnd - segmentMeta.startOffset,
    },
  ];

  const normalized = candidates
    .map(({ start, end }) => {
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const clampedStart = Math.max(0, Math.min(segmentLength, start));
      const clampedEnd = Math.max(0, Math.min(segmentLength, end));
      if (clampedEnd <= clampedStart) return null;
      return {
        start: Math.floor(clampedStart),
        end: Math.ceil(clampedEnd),
      };
    })
    .find((range): range is { start: number; end: number } => Boolean(range));

  if (!normalized) {
    return null;
  }

  return {
    startOffset: segmentMeta.startOffset + normalized.start,
    endOffset: segmentMeta.startOffset + normalized.end,
  };
};

const readHighlightDebugFlag = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const globalFlag = (window as DebuggableWindow).__BOOKKO_DEBUG_PROOFREAD__;
    if (typeof globalFlag === "boolean") {
      return globalFlag;
    }
    const raw = window.localStorage?.getItem(
      "bookko:debug-proofread-highlights",
    );
    if (!raw) {
      return false;
    }
    const normalized = raw.toString().trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  } catch {
    return false;
  }
};

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  default: 4,
};

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const AUTOSAVE_DELAY_MS = 2000;
const SELECTION_OVERLAY_DELAY_MS = 260;

const clampEditorRatio = (value: number) =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));

const editorSupportsHiddenAreas = (
  editor: Monaco.editor.IStandaloneCodeEditor,
): editor is Monaco.editor.IStandaloneCodeEditor & {
  setHiddenAreas: (ranges: Monaco.Range[]) => void;
} =>
  typeof (editor as { setHiddenAreas?: unknown }).setHiddenAreas === "function";

interface DualEditorPanelProps {
  originProfile: DocumentProfileSummary | null;
  originFallback: DocumentSummaryFallback | null;
}

const hasText = (value?: string | null) =>
  typeof value === "string" && value.trim().length > 0;

export const DualEditorPanel = ({
  originProfile,
  originFallback,
}: DualEditorPanelProps) => {
  const {
    dataset,
    segments,
    issues,
    issueAssignments,
    activeIssueId,
    collapsedSegmentIds,
    selectedSegmentId,
    editorRatio,
    setEditorRatio,
    editSegment,
    selectSegment,
    toggleSegmentCollapse,
    savePendingChanges,
    isSaving,
    lastSavedAt,
  } = useProofreadEditorContext();
  const {
    issues: proofIssues,
    handleApply,
    handleIgnore,
    issueStateById,
    highlights,
    syncTranslation,
  } = useProofreadIssues();
  const openQualityDialog = useUIStore((state) => state.openQualityDialog);
  const hasTranslationContent = useMemo(
    () =>
      segments.some((segment) =>
        Boolean(
          segment.translationText && segment.translationText.trim().length,
        ),
      ),
    [segments],
  );
  const qualityButtonClass = hasTranslationContent
    ? "inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-100 bg-white/70 text-emerald-600 transition hover:border-emerald-200 hover:bg-emerald-100 hover:text-emerald-700"
    : "inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-50 bg-transparent text-emerald-200 transition cursor-not-allowed";
  const qualityButtonTitle = hasTranslationContent
    ? "품질 검토 보기"
    : "번역본이 준비되면 품질 검토를 확인할 수 있습니다.";

  const proofIssuesById = useMemo(() => {
    const map = new Map<string, ProofreadIssueEntry>();
    proofIssues.forEach((entry) => {
      map.set(entry.issue.id, entry);
    });
    return map;
  }, [proofIssues]);
  const datasetIssuesById = useMemo(() => {
    const map = new Map<string, (typeof issues)[number]>();
    issues.forEach((entry) => {
      map.set(entry.id, entry);
    });
    return map;
  }, [issues]);

  const token = useAuthStore((state) => state.token);
  const projectId = dataset?.projectId ?? null;
  const datasetJobId = dataset?.jobId ?? null;
  const datasetTranslationFileId = dataset?.translationFileId ?? null;
  const canLoadStageDrafts = Boolean(
    token && projectId && (datasetJobId || datasetTranslationFileId),
  );
  const { locale } = useUILocale();
  const localize = useCallback(
    (
      key: string,
      fallback: string,
      params?: Record<string, string | number>,
    ) => {
      const resolved = translate(key, locale, params);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false);
  const originSummary = useMemo(
    () => originProfile?.summary ?? originFallback?.summary ?? null,
    [originFallback, originProfile],
  );
  const originMetrics = useMemo(
    () => originProfile?.metrics ?? originFallback?.metrics ?? null,
    [originFallback, originProfile],
  );
  const originSummaryTimestamp = useMemo(() => {
    if (originProfile?.updatedAt) return originProfile.updatedAt;
    if (originProfile?.createdAt) return originProfile.createdAt;
    return originFallback?.timestamp ?? null;
  }, [originFallback, originProfile]);
  const translationNotes = originProfile?.translationNotes ?? null;
  const characterEntries = useMemo(
    () =>
      (translationNotes?.characters ?? []).filter(
        (character) =>
          hasText(character?.name) ||
          hasText(character?.targetName) ||
          hasText(character?.age) ||
          hasText(character?.gender) ||
          (character?.traits?.length ?? 0) > 0,
      ),
    [translationNotes],
  );
  const measurementEntries = useMemo(
    () =>
      (translationNotes?.measurementUnits ?? []).filter(
        (entry) => hasText(entry?.source) || hasText(entry?.target),
      ),
    [translationNotes],
  );
  const linguisticEntries = useMemo(
    () =>
      (translationNotes?.linguisticFeatures ?? []).filter(
        (entry) => hasText(entry?.source) || hasText(entry?.target),
      ),
    [translationNotes],
  );
  const namedEntityEntries = useMemo(
    () =>
      (translationNotes?.namedEntities ?? []).filter(
        (entry) => hasText(entry?.name) || hasText(entry?.targetName),
      ),
    [translationNotes],
  );
  const locationEntries = useMemo(
    () =>
      (translationNotes?.locations ?? []).filter(
        (entry) => hasText(entry?.name) || hasText(entry?.targetName),
      ),
    [translationNotes],
  );
  const hasTranslationNotesContent = useMemo(
    () =>
      Boolean(
        (translationNotes && hasText(translationNotes.timePeriod)) ||
          characterEntries.length ||
          measurementEntries.length ||
          linguisticEntries.length ||
          namedEntityEntries.length ||
          locationEntries.length,
      ),
    [
      characterEntries,
      linguisticEntries,
      locationEntries,
      measurementEntries,
      namedEntityEntries,
      translationNotes,
    ],
  );
  const summaryButtonLabel = localize(
    "proofread_editor_origin_summary_button",
    "원작 요약 보기",
  );
  const summaryModalTitle = localize(
    "proofread_editor_origin_summary_modal_title",
    "원작 요약 & 번역 노트",
  );
  const summaryModalDescription = "";
  const summaryCloseLabel = localize(
    "proofread_editor_origin_summary_close",
    "원작 요약 닫기",
  );
  const summarySectionTitle = localize(
    "rightpanel_origin_summary_title",
    "원작 요약",
  );
  const notesSectionTitle = localize(
    "rightpanel_translation_notes_title",
    "번역 노트",
  );
  const summaryEmptyLabel = localize(
    "proofread_editor_origin_summary_empty",
    "원작 요약이 아직 준비되지 않았습니다.",
  );
  const notesEmptyLabel = localize(
    "proofread_editor_origin_notes_empty",
    "번역 노트가 아직 없습니다.",
  );
  const measurementUnitsLabel = localize(
    "rightpanel_translation_notes_measurement_units",
    "단위 정보",
  );
  const linguisticFeaturesLabel = localize(
    "rightpanel_translation_notes_linguistic_features",
    "언어 특징",
  );
  const charactersLabel = localize(
    "rightpanel_translation_notes_characters",
    "등장인물",
  );
  const namedEntitiesLabel = localize(
    "rightpanel_translation_notes_named_entities",
    "고유명사",
  );
  const locationsLabel = localize(
    "rightpanel_translation_notes_locations",
    "장소",
  );
  const timePeriodLabel = localize(
    "rightpanel_translation_notes_time_period",
    "시대 배경",
  );
  const traitsLabel = localize("rightpanel_translation_notes_traits", "특징");
  const nameLabel = localize("rightpanel_translation_notes_name", "이름");
  const ageLabel = localize("rightpanel_translation_notes_age", "나이");
  const genderLabel = localize("rightpanel_translation_notes_gender", "성별");
  const summaryTimestampLabel = useMemo(() => {
    if (!originSummaryTimestamp) return null;
    const date = new Date(originSummaryTimestamp);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  }, [originSummaryTimestamp]);
  const summaryMetricChips = useMemo(() => {
    const chips: string[] = [];
    if (
      originMetrics?.wordCount !== undefined &&
      originMetrics?.wordCount !== null
    ) {
      chips.push(
        localize(
          "rightpanel_summary_metric_words",
          `${originMetrics.wordCount.toLocaleString()} words`,
          { count: originMetrics.wordCount.toLocaleString() },
        ),
      );
    }
    if (
      originMetrics?.charCount !== undefined &&
      originMetrics?.charCount !== null
    ) {
      chips.push(
        localize(
          "rightpanel_summary_metric_characters",
          `${originMetrics.charCount.toLocaleString()} characters`,
          { count: originMetrics.charCount.toLocaleString() },
        ),
      );
    }
    if (
      originMetrics?.readingTimeMinutes !== undefined &&
      originMetrics?.readingTimeMinutes !== null
    ) {
      const minutes = Math.max(1, Math.round(originMetrics.readingTimeMinutes));
      chips.push(
        localize("rightpanel_summary_metric_minutes", `${minutes} mins`, {
          count: minutes,
        }),
      );
    }
    if (summaryTimestampLabel) {
      chips.push(
        localize(
          "rightpanel_summary_metric_updated",
          `업데이트: ${summaryTimestampLabel}`,
          { timestamp: summaryTimestampLabel },
        ),
      );
    }
    return chips;
  }, [localize, originMetrics, summaryTimestampLabel]);

  const renderPairSection = (
    title: string,
    entries: Array<{ source: string; target: string | null }>,
    keyPrefix: string,
  ): ReactElement | null => {
    if (!entries.length) return null;
    return (
      <div className="space-y-1" key={`${keyPrefix}-section`}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </p>
        <ul className="space-y-1 text-sm text-slate-700">
          {entries.map((entry, index) => (
            <li
              key={`${keyPrefix}-${index}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="font-medium text-slate-900">
                {hasText(entry.source) ? entry.source : "—"}
              </span>
              {hasText(entry.target) ? (
                <span className="text-slate-500">→ {entry.target}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const renderEntitySection = (
    title: string,
    entries: Array<{
      name: string;
      targetName: string | null;
      frequency?: number;
    }>,
    keyPrefix: string,
    options?: { twoColumn?: boolean },
  ): ReactElement | null => {
    if (!entries.length) return null;
    const twoColumn = options?.twoColumn ?? false;
    return (
      <div className="space-y-1" key={`${keyPrefix}-entities`}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </p>
        <div
          className={
            twoColumn
              ? "grid gap-2 text-sm text-slate-700 sm:grid-cols-2"
              : "space-y-1 text-sm text-slate-700"
          }
        >
          {entries.map((entry, index) => {
            const freqLabel =
              typeof entry.frequency === "number"
                ? localize(
                    "rightpanel_translation_notes_frequency_label",
                    `freq ${entry.frequency}`,
                    { count: entry.frequency },
                  )
                : null;
            return (
              <div
                key={`${keyPrefix}-entry-${index}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-medium text-slate-900">
                  {hasText(entry.name) ? entry.name : "—"}
                </span>
                {hasText(entry.targetName) ? (
                  <span className="text-slate-500">→ {entry.targetName}</span>
                ) : null}
                {freqLabel ? (
                  <span className="text-[11px] text-slate-400">
                    {freqLabel}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderCharacterSection = (): ReactElement | null => {
    if (!characterEntries.length) return null;
    return (
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {charactersLabel}
        </p>
        <div className="space-y-2">
          {characterEntries.map((character, index) => (
            <div
              key={`character-${index}`}
              className="space-y-1 text-sm text-slate-700"
            >
              <div className="flex flex-wrap items-center gap-2 text-slate-900">
                <span className="font-semibold">
                  {hasText(character.name) ? character.name : nameLabel}
                </span>
                {hasText(character.targetName) ? (
                  <span className="text-slate-500">
                    → {character.targetName}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
                {hasText(character.age) ? (
                  <span>
                    {ageLabel}: {character.age}
                  </span>
                ) : null}
                {hasText(character.gender) ? (
                  <span>
                    {genderLabel}: {character.gender}
                  </span>
                ) : null}
              </div>
              {character.traits?.length ? (
                <div className="flex flex-wrap gap-1 text-[11px] text-slate-500">
                  <span className="font-semibold text-slate-600">
                    {traitsLabel}:
                  </span>
                  {character.traits.map((trait, traitIndex) => (
                    <span key={`trait-${index}-${traitIndex}`}>{trait}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  };
  const getStageLabel = useCallback(
    (stage: TranslationStageKey) =>
      localize(`translation_stage_${stage}`, STAGE_META[stage].fallback),
    [localize],
  );
  const stageButtonTitle = useCallback(
    (stage: TranslationStageKey) =>
      localize("proofread_stage_button_view", "View {{stage}} draft", {
        stage: getStageLabel(stage),
      }),
    [getStageLabel, localize],
  );
  const [stageViewer, setStageViewer] = useState<{
    stage: TranslationStageKey | null;
    isOpen: boolean;
  }>({ stage: null, isOpen: false });
  const [knownAvailableStages, setKnownAvailableStages] = useState<
    TranslationStageKey[]
  >([]);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const stageDraftQuery = useTranslationStageDrafts({
    token,
    projectId,
    jobId: datasetJobId,
    translationFileId: datasetTranslationFileId,
    stage: stageViewer.stage,
    enabled: stageViewer.isOpen,
  });

  useEffect(() => {
    if (stageDraftQuery.data?.availableStages?.length) {
      setKnownAvailableStages((prev) => {
        const merged = new Set<TranslationStageKey>([
          ...prev,
          ...stageDraftQuery.data!.availableStages,
        ]);
        return Array.from(merged);
      });
    }
  }, [stageDraftQuery.data]);

  useEffect(() => {
    setCopyState("idle");
  }, [stageViewer.stage, stageViewer.isOpen]);

  const availableStageSet = useMemo(
    () => new Set<TranslationStageKey>(knownAvailableStages),
    [knownAvailableStages],
  );

  const stageOrder = useMemo(() => {
    const hasV2Stage = knownAvailableStages.some((stage) =>
      V2_STAGE_SET.has(stage),
    );
    return hasV2Stage ? V2_STAGE_ORDER : LEGACY_STAGE_ORDER;
  }, [knownAvailableStages]);

  const handleStageButtonClick = useCallback(
    (stageKey: TranslationStageKey) => {
      if (!canLoadStageDrafts) return;
      setStageViewer({ stage: stageKey, isOpen: true });
    },
    [canLoadStageDrafts],
  );

  const handleCloseStageViewer = useCallback(() => {
    setStageViewer({ stage: null, isOpen: false });
  }, []);

  const handleCopyStageDraft = useCallback(async () => {
    if (!stageDraftQuery.data?.joinedText) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(stageDraftQuery.data.joinedText);
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 2000);
      }
    } catch (error) {
      console.warn("[DualEditor] Failed to copy stage draft", error);
    }
  }, [stageDraftQuery.data]);

  const stageViewerTitle = stageViewer.stage
    ? localize(
        "proofread_stage_viewer_title",
        `${getStageLabel(stageViewer.stage)} draft`,
        { stageLabel: getStageLabel(stageViewer.stage) },
      )
    : localize("proofread_stage_viewer_title", "Stage draft");

  const viewerCountsLabel = stageDraftQuery.data?.counts
    ? localize(
        "proofread_stage_viewer_counts",
        "Segments: {{total}} · Needs review: {{needsReview}}",
        {
          total: stageDraftQuery.data.counts.total,
          needsReview: stageDraftQuery.data.counts.needsReview,
        },
      )
    : undefined;

  const stageDraftErrorMessage =
    stageDraftQuery.error instanceof Error
      ? stageDraftQuery.error.message
      : localize("proofread_stage_viewer_error", "Failed to load stage draft.");

  const stageDraftData = stageDraftQuery.data ?? null;
  const stageDraftSegments = stageDraftData?.segments ?? [];
  const stageDraftHasText = Boolean(
    stageDraftData?.joinedText && stageDraftData.joinedText.trim().length,
  );
  const copyLabel =
    copyState === "copied"
      ? localize("proofread_stage_viewer_copy_done", "Copied!")
      : localize("proofread_stage_viewer_copy", "Copy text");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const translationEditorRef =
    useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const originEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const monacoRef = useRef<typeof Monaco | null>(null);
  const scrollSyncingRef = useRef(false);
  const translationDecorationsRef = useRef<string[]>([]);
  const suppressTranslationChangeRef = useRef(false);
  const suppressOriginChangeRef = useRef(false);
  const pointerMoveHandlerRef = useRef<((event: PointerEvent) => void) | null>(
    null,
  );
  const pointerUpHandlerRef = useRef<((event: PointerEvent) => void) | null>(
    null,
  );
  const saveTimerRef = useRef<number | null>(null);
  const saveCallbackRef = useRef<(() => Promise<void>) | null>(null);
  const selectionOverlayTimerRef = useRef<number | null>(null);
  const latestSelectionRef = useRef<EditorSelectionContext | null>(null);
  const selectionDisposableRef = useRef<Monaco.IDisposable | null>(null);
  const selectionClearTimerRef = useRef<number | null>(null);
  const issueRangesRef = useRef<Record<string, IssueRange[]>>({});
  const issuePopoverRef = useRef<null | {
    issueId: string;
    x: number;
    y: number;
  }>(null);
  const lastSyncedTranslationRef = useRef<string>("");

  const translationModel = useMemo(
    () =>
      buildAggregatedModel(
        segments.map((segment) => ({
          segmentId: segment.segmentId,
          text: segment.translationText ?? "",
        })),
      ),
    [segments],
  );

  const originModel = useMemo(
    () =>
      buildAggregatedModel(
        segments.map((segment) => ({
          segmentId: segment.segmentId,
          text: segment.originText ?? "",
        })),
      ),
    [segments],
  );

  const plainTranslationValue = useMemo(
    () =>
      segments
        .map((segment) => segment.translationText ?? "")
        .join(PLAIN_SEGMENT_SEPARATOR),
    [segments],
  );

  const [dragging, setDragging] = useState(false);
  const [selectionOverlay, setSelectionOverlay] =
    useState<SelectionOverlayState | null>(null);
  const [issuePopover, setIssuePopover] = useState<null | {
    issueId: string;
    x: number;
    y: number;
  }>(null);
  const [popoverBusy, setPopoverBusy] = useState(false);
  const [popoverError, setPopoverError] = useState<string | null>(null);
  const [translationEditorReady, setTranslationEditorReady] = useState(false);
  const [showSavedIndicator, setShowSavedIndicator] = useState(false);

  useEffect(() => {
    issuePopoverRef.current = issuePopover;
  }, [issuePopover]);

  useEffect(() => {
    if (isSaving) {
      setShowSavedIndicator(false);
      return;
    }
    if (!lastSavedAt) {
      return;
    }
    setShowSavedIndicator(true);
    const timer = window.setTimeout(() => {
      setShowSavedIndicator(false);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [isSaving, lastSavedAt]);

  const setEditingSelection = useEditingCommandStore(
    (state) => state.setSelection,
  );
  const triggerEditingAction = useEditingCommandStore(
    (state) => state.triggerAction,
  );
  const registerEditorAdapter = useEditingCommandStore(
    (state) => state.registerEditorAdapter,
  );

  useEffect(() => {
    saveCallbackRef.current = savePendingChanges;
  }, [savePendingChanges]);

  useEffect(() => {
    if (issuePopover && !proofIssuesById.has(issuePopover.issueId)) {
      setIssuePopover(null);
    }
  }, [issuePopover, proofIssuesById]);

  useEffect(() => {
    if (!issuePopover) {
      setPopoverBusy(false);
      setPopoverError(null);
    }
  }, [issuePopover]);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const flushPendingChanges = useCallback(() => {
    clearSaveTimer();
    const callback = saveCallbackRef.current;
    if (callback) {
      void callback();
    }
  }, [clearSaveTimer]);

  const scheduleAutosave = useCallback(() => {
    clearSaveTimer();
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const callback = saveCallbackRef.current;
      if (callback) {
        void callback();
      }
    }, AUTOSAVE_DELAY_MS);
  }, [clearSaveTimer]);

  const cancelSelectionOverlayTimer = useCallback(() => {
    if (selectionOverlayTimerRef.current !== null) {
      window.clearTimeout(selectionOverlayTimerRef.current);
      selectionOverlayTimerRef.current = null;
    }
  }, []);

  const hideSelectionOverlay = useCallback(() => {
    cancelSelectionOverlayTimer();
    setSelectionOverlay(null);
  }, [cancelSelectionOverlayTimer]);

  const cancelDeferredSelectionClear = useCallback(() => {
    if (selectionClearTimerRef.current !== null) {
      window.clearTimeout(selectionClearTimerRef.current);
      selectionClearTimerRef.current = null;
    }
  }, []);

  const clearSelectionState = useCallback(() => {
    cancelDeferredSelectionClear();
    cancelSelectionOverlayTimer();
    latestSelectionRef.current = null;
    setSelectionOverlay(null);
    setEditingSelection(null);
    setIssuePopover(null);
  }, [
    cancelDeferredSelectionClear,
    cancelSelectionOverlayTimer,
    setEditingSelection,
  ]);

  const scheduleSelectionClear = useCallback(() => {
    cancelDeferredSelectionClear();
    selectionClearTimerRef.current = window.setTimeout(() => {
      selectionClearTimerRef.current = null;
      clearSelectionState();
    }, 120);
  }, [cancelDeferredSelectionClear, clearSelectionState]);

  const createEditorAdapter = useCallback((): EditingEditorAdapter | null => {
    const editor = translationEditorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return null;
    }

    const normalizeEol = (value: string) => value.replace(/\r\n/g, "\n");

    return {
      replaceText: ({ range, expectedText, nextText }) => {
        const model = editor.getModel();
        if (!model) {
          return {
            ok: false,
            message: "번역 편집기를 찾지 못했습니다.",
          };
        }

        const monacoRange = new monaco.Range(
          range.startLineNumber,
          range.startColumn,
          range.endLineNumber,
          range.endColumn,
        );
        const currentTextRaw = model.getValueInRange(monacoRange);
        const currentText = normalizeEol(currentTextRaw);
        const expected = normalizeEol(expectedText);
        if (currentText !== expected) {
          return {
            ok: false,
            message:
              "선택한 문장이 이미 다른 내용으로 바뀌었습니다. 다시 선택한 뒤 요청해 주세요.",
          };
        }

        const sanitizedNextText = normalizeEol(nextText);
        const startPosition = new monaco.Position(
          range.startLineNumber,
          range.startColumn,
        );
        const startOffset = model.getOffsetAt(startPosition);

        editor.pushUndoStop();
        editor.executeEdits("conversation-edit", [
          { range: monacoRange, text: sanitizedNextText },
        ]);
        editor.pushUndoStop();

        const endPosition = model.getPositionAt(
          startOffset + sanitizedNextText.length,
        );
        const appliedRange: SelectionRange = {
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: endPosition.lineNumber,
          endColumn: endPosition.column,
        };

        const selection = new monaco.Selection(
          appliedRange.startLineNumber,
          appliedRange.startColumn,
          appliedRange.endLineNumber,
          appliedRange.endColumn,
        );
        editor.setSelection(selection);
        editor.revealRangeInCenter(selection);
        editor.focus();

        clearSelectionState();

        return {
          ok: true,
          appliedRange,
          previousText: currentTextRaw,
        };
      },
    };
  }, [clearSelectionState]);

  const handleInlineRewrite = useCallback(() => {
    triggerEditingAction("rewrite");
    hideSelectionOverlay();
  }, [triggerEditingAction, hideSelectionOverlay]);

  const handleInlineNormalizeName = useCallback(() => {
    triggerEditingAction("normalizeName");
    hideSelectionOverlay();
  }, [triggerEditingAction, hideSelectionOverlay]);

  const handleInlineAdjustPronoun = useCallback(() => {
    triggerEditingAction("adjustPronoun");
    hideSelectionOverlay();
  }, [triggerEditingAction, hideSelectionOverlay]);

  const handleCancelSelection = useCallback(() => {
    clearSelectionState();
  }, [clearSelectionState]);

  const handleTranslationSelectionChange = useCallback(
    (event: Monaco.editor.ICursorSelectionChangedEvent) => {
      const editor = translationEditorRef.current;
      if (!editor) {
        clearSelectionState();
        return;
      }
      const model = editor.getModel();
      if (!model) {
        clearSelectionState();
        return;
      }

      const selection = event.selection;
      if (!selection || selection.isEmpty()) {
        clearSelectionState();
        return;
      }

      const rawText = model.getValueInRange(selection);
      const trimmed = rawText.trim();
      if (!trimmed) {
        clearSelectionState();
        return;
      }

      const container = containerRef.current;
      const domNode = editor.getDomNode();
      if (!container || !domNode) {
        clearSelectionState();
        return;
      }

      const visiblePosition = editor.getScrolledVisiblePosition(
        selection.getEndPosition(),
      );
      if (!visiblePosition) {
        clearSelectionState();
        return;
      }

      cancelDeferredSelectionClear();
      hideSelectionOverlay();

      const editorRect = domNode.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const rawLeft =
        editorRect.left - containerRect.left + visiblePosition.left;
      const rawTop =
        editorRect.top - containerRect.top + visiblePosition.top - 36;

      const range: SelectionRange = {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn,
      };

      const context: EditorSelectionContext = {
        id: `sel-${Date.now().toString(16)}-${Math.random()
          .toString(16)
          .slice(2, 6)}`,
        source: "translation",
        text: trimmed,
        rawText,
        range,
      };

      const startOffset = model.getOffsetAt(selection.getStartPosition());
      const segmentId = mapOffsetToSegment(startOffset, translationModel);
      if (segmentId) {
        context.meta = { segmentId };
      }

      setEditingSelection(context);
      latestSelectionRef.current = context;

      const clampedLeft = Math.max(
        Math.min(rawLeft, containerRect.width - 240),
        8,
      );
      const clampedTop = Math.max(rawTop, 8);

      selectionOverlayTimerRef.current = window.setTimeout(() => {
        selectionOverlayTimerRef.current = null;
        if (latestSelectionRef.current?.id !== context.id) {
          return;
        }
        setSelectionOverlay({
          context,
          x: clampedLeft,
          y: clampedTop,
        });
      }, SELECTION_OVERLAY_DELAY_MS);
  },
    [
      clearSelectionState,
      cancelDeferredSelectionClear,
      hideSelectionOverlay,
      setEditingSelection,
      translationModel,
      setSelectionOverlay,
    ],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;
      event.preventDefault();
      clearSelectionState();
      setDragging(true);

      const container = containerRef.current;

      const handleMove = (moveEvent: PointerEvent) => {
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const clampedX = Math.min(
          Math.max(moveEvent.clientX, rect.left),
          rect.right,
        );
        const offset = clampedX - rect.left;
        const nextRatio = clampEditorRatio(offset / rect.width);
        setEditorRatio(nextRatio);
      };

      const handleUp = () => {
        setDragging(false);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        pointerMoveHandlerRef.current = null;
        pointerUpHandlerRef.current = null;
      };

      pointerMoveHandlerRef.current = handleMove;
      pointerUpHandlerRef.current = handleUp;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      handleMove(event.nativeEvent);
    },
    [clearSelectionState, setEditorRatio],
  );

  const handleTranslationChange: OnChange = useCallback(
    (value) => {
      if (suppressTranslationChangeRef.current) return;
      const editor = translationEditorRef.current;
      if (!value || !editor) return;
      const nextSegments = splitAggregatedValue(value, segments.length);
      if (!nextSegments) {
        suppressTranslationChangeRef.current = true;
        editor.setValue(translationModel.value);
        suppressTranslationChangeRef.current = false;
        return;
      }
      let hasChanges = false;
      nextSegments.forEach((text, index) => {
        const segment = segments[index];
        if (!segment) return;
        if (segment.translationText !== text) {
          editSegment(segment.segmentId, "translation", text);
          hasChanges = true;
        }
      });
      if (hasChanges) {
        scheduleAutosave();
        hideSelectionOverlay();
      }
    },
    [
      segments,
      editSegment,
      translationModel.value,
      scheduleAutosave,
      hideSelectionOverlay,
    ],
  );

  const handleOriginChange: OnChange = useCallback(
    (value) => {
      if (suppressOriginChangeRef.current) return;
      const editor = originEditorRef.current;
      if (!value || !editor) return;
      const nextSegments = splitAggregatedValue(value, segments.length);
      if (!nextSegments) {
        suppressOriginChangeRef.current = true;
        editor.setValue(originModel.value);
        suppressOriginChangeRef.current = false;
        return;
      }
      let hasChanges = false;
      nextSegments.forEach((text, index) => {
        const segment = segments[index];
        if (!segment) return;
        if (segment.originText !== text) {
          editSegment(segment.segmentId, "origin", text);
          hasChanges = true;
        }
      });
      if (hasChanges) {
        scheduleAutosave();
      }
    },
    [segments, editSegment, originModel.value, scheduleAutosave],
  );

  const applyIssueLocally = useCallback(
    (entry: ProofreadIssueEntry) => {
      const issue = entry.issue;
      if (!issue?.id) return;
      const editor = translationEditorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;
      const model = editor.getModel();
      if (!model) return;
      const ranges = issueRangesRef.current[issue.id];
      const primaryRange = ranges?.[0];
      const datasetEntry = datasetIssuesById.get(issue.id);
      const datasetIssue = datasetEntry?.issue
        ? (datasetEntry.issue as Partial<ProofreadingIssue>)
        : undefined;
      const issueSegmentInfo = issue as {
        segmentId?: string | null;
        segment_id?: string | null;
        notes?: {
          guardFindings?: Array<{ segmentId?: string | null }>;
        };
      };
      const bucketSegmentId =
        (entry.bucket as { segmentId?: string | null } | undefined)
          ?.segmentId ?? null;
      const fallbackSegmentId =
        issueSegmentInfo.segmentId ??
        issueSegmentInfo.segment_id ??
        datasetEntry?.segmentId ??
        (datasetEntry as { segment_id?: string } | undefined)?.segment_id ??
        issueSegmentInfo.notes?.guardFindings?.[0]?.segmentId ??
        bucketSegmentId ??
        undefined;
      const segmentId = primaryRange?.segmentId ?? fallbackSegmentId ?? null;
      if (!segmentId) return;

      const segmentMeta = translationModel.metaMap.get(segmentId);
      if (!segmentMeta) return;

      const startOfSegment = model.getPositionAt(segmentMeta.startOffset);
      const endOfSegment = model.getPositionAt(segmentMeta.endOffset);
      const segmentRange = new monaco.Range(
        startOfSegment.lineNumber,
        startOfSegment.column,
        endOfSegment.lineNumber,
        endOfSegment.column,
      );
      const segmentText = model.getValueInRange(segmentRange);

      const lifecycle = issueStateById[issue.id] ?? "pending";

      const beforeCandidates = collectStringCandidates([
        issue.before,
        issue.translationExcerpt,
        datasetIssue?.before,
        datasetIssue?.translationExcerpt,
      ]);

      let replacementStartOffset: number | null = null;
      let replacementEndOffset: number | null = null;

      for (const candidate of beforeCandidates) {
        const match = looseMatchRange(segmentText, candidate);
        if (match) {
          replacementStartOffset = segmentMeta.startOffset + match.start;
          replacementEndOffset = segmentMeta.startOffset + match.end;
          break;
        }
      }

      if (replacementStartOffset === null || replacementEndOffset === null) {
        if (primaryRange) {
          replacementStartOffset = primaryRange.startOffset;
          replacementEndOffset = primaryRange.endOffset;
        } else {
          return;
        }
      }

      const replacementCandidates = [
        issue.after,
        datasetIssue?.after,
        lifecycle === "applied" ? issue.translationExcerpt : null,
      ];
      let replacementText: string | null = null;
      for (const candidate of replacementCandidates) {
        if (typeof candidate !== "string") continue;
        if (candidate.length === 0 || candidate.trim().length > 0) {
          replacementText = candidate;
          break;
        }
      }
      if (replacementText === null) return;

      const startPosition = model.getPositionAt(replacementStartOffset);
      const endPosition = model.getPositionAt(replacementEndOffset);
      const monacoRange = new monaco.Range(
        startPosition.lineNumber,
        startPosition.column,
        endPosition.lineNumber,
        endPosition.column,
      );

      suppressTranslationChangeRef.current = true;
      try {
        editor.pushUndoStop();
        editor.executeEdits("proofread-issue-apply", [
          { range: monacoRange, text: replacementText },
        ]);
        editor.pushUndoStop();
      } finally {
        suppressTranslationChangeRef.current = false;
      }

      const updatedValue = model.getValue();
      const nextSegments = splitAggregatedValue(
        updatedValue,
        translationModel.segments.length,
      );
      if (nextSegments) {
        let hasChanges = false;
        const joinedNextSegments = nextSegments.join(PLAIN_SEGMENT_SEPARATOR);
        nextSegments.forEach((text, index) => {
          const segment = segments[index];
          if (!segment) return;
          if (segment.translationText !== text) {
            editSegment(segment.segmentId, "translation", text);
            hasChanges = true;
          }
        });
        if (hasChanges) {
          scheduleAutosave();
          lastSyncedTranslationRef.current = joinedNextSegments;
          syncTranslation(joinedNextSegments);
        }
      }

      const newStartPosition = model.getPositionAt(replacementStartOffset);
      const newEndOffset = replacementStartOffset + replacementText.length;
      const newEndPosition = model.getPositionAt(newEndOffset);
      const selection = new monaco.Selection(
        newStartPosition.lineNumber,
        newStartPosition.column,
        newEndPosition.lineNumber,
        newEndPosition.column,
      );
      editor.setSelection(selection);
      editor.revealRangeInCenter(selection);
      setSelectionOverlay(null);
      latestSelectionRef.current = null;
    },
    [
      translationModel,
      segments,
      editSegment,
      scheduleAutosave,
      syncTranslation,
      setSelectionOverlay,
      datasetIssuesById,
      issueStateById,
    ],
  );

  const handleIssueApplied = useCallback(
    (entry: ProofreadIssueEntry) => {
      applyIssueLocally(entry);
    },
    [applyIssueLocally],
  );

  useEffect(() => {
    if (plainTranslationValue === lastSyncedTranslationRef.current) {
      return;
    }
    lastSyncedTranslationRef.current = plainTranslationValue;
    syncTranslation(plainTranslationValue);
  }, [plainTranslationValue, syncTranslation]);

  const applyHiddenAreas = useCallback(
    (
      editor: Monaco.editor.IStandaloneCodeEditor | null,
      aggregated: AggregatedModel,
    ) => {
      if (!editor || !monacoRef.current) return;
      const monaco = monacoRef.current;
      const model = editor.getModel();
      if (!model) return;
      const ranges: Monaco.Range[] = [];
      aggregated.segments.forEach((segment) => {
        if (!collapsedSegmentIds[segment.segmentId]) return;
        const start = model.getPositionAt(segment.startOffset);
        const end = model.getPositionAt(segment.endOffset);
        ranges.push(new monaco.Range(start.lineNumber, 1, end.lineNumber, 1));
        if (segment.separatorStart !== null) {
          const sepStart = model.getPositionAt(segment.separatorStart);
          const sepEnd = model.getPositionAt(
            segment.separatorStart + segment.separatorLength,
          );
          ranges.push(
            new monaco.Range(sepStart.lineNumber, 1, sepEnd.lineNumber, 1),
          );
        }
      });
      if (!editorSupportsHiddenAreas(editor)) return;
      editor.setHiddenAreas(ranges);
    },
    [collapsedSegmentIds],
  );

  const revealSelectedSegment = useCallback(
    (
      editor: Monaco.editor.IStandaloneCodeEditor | null,
      aggregated: AggregatedModel,
    ) => {
      if (!editor || !selectedSegmentId) return;
      const model = editor.getModel();
      if (!model) return;
      const meta = aggregated.metaMap.get(selectedSegmentId);
      if (!meta) return;
      const position = model.getPositionAt(meta.startOffset);
      editor.revealLineInCenter(position.lineNumber);
    },
    [selectedSegmentId],
  );

  const syncEditorsByRatio = useCallback(
    (
      source: Monaco.editor.IStandaloneCodeEditor,
      target: Monaco.editor.IStandaloneCodeEditor,
    ) => {
      const sourceDom = source.getDomNode();
      const targetDom = target.getDomNode();
      const sourceVisible = Math.max(sourceDom ? sourceDom.clientHeight : 0, 1);
      const targetVisible = Math.max(targetDom ? targetDom.clientHeight : 0, 1);
      const sourceScrollable = Math.max(
        source.getScrollHeight() - sourceVisible,
        1,
      );
      const ratio =
        sourceScrollable > 0 ? source.getScrollTop() / sourceScrollable : 0;
      const targetScrollable = Math.max(
        target.getScrollHeight() - targetVisible,
        1,
      );
      target.setScrollTop(ratio * targetScrollable);
      target.setScrollLeft(source.getScrollLeft());
    },
    [],
  );

  const handleTranslationMount: OnMount = useCallback(
    (editor, monaco) => {
      translationEditorRef.current = editor;
      monacoRef.current = monaco;
      applyHiddenAreas(editor, translationModel);
      revealSelectedSegment(editor, translationModel);
      setTranslationEditorReady(true);

      const adapter = createEditorAdapter();
      registerEditorAdapter(adapter);

      if (selectionDisposableRef.current) {
        selectionDisposableRef.current.dispose();
      }
      selectionDisposableRef.current = editor.onDidChangeCursorSelection(
        handleTranslationSelectionChange,
      );

      editor.onMouseDown(() => {
        setIssuePopover(null);
        setPopoverError(null);
      });

      editor.onMouseUp((event) => {
        if (!event?.event || event.event.detail > 1) return;
        if (event.event.rightButton || event.event.middleButton) return;
        if (event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
          setIssuePopover(null);
          return;
        }
        const position = event.target.position;
        if (!position) {
          setIssuePopover(null);
          return;
        }
        const model = editor.getModel();
        if (!model) return;
        const offset = model.getOffsetAt(position);
        const entryRanges = issueRangesRef.current;
        const matches: Array<{ issueId: string; range: IssueRange }> = [];
        Object.entries(entryRanges).forEach(([issueId, ranges]) => {
          const hit = ranges.find(
            (range) => offset >= range.startOffset && offset <= range.endOffset,
          );
          if (hit) {
            matches.push({ issueId, range: hit });
          }
        });
        if (!matches.length) {
          setIssuePopover(null);
          return;
        }
        const sortedMatches = matches.sort((a, b) => {
          const severityA =
            proofIssuesById.get(a.issueId)?.issue?.severity?.toLowerCase() ??
            "default";
          const severityB =
            proofIssuesById.get(b.issueId)?.issue?.severity?.toLowerCase() ??
            "default";
          const rankA = SEVERITY_ORDER[severityA] ?? SEVERITY_ORDER.default;
          const rankB = SEVERITY_ORDER[severityB] ?? SEVERITY_ORDER.default;
          return rankA - rankB;
        });
        const selected = sortedMatches[0];
        const container = containerRef.current;
        const domNode = editor.getDomNode();
        if (!container || !domNode) return;
        const visiblePosition = editor.getScrolledVisiblePosition(position);
        if (!visiblePosition) return;
        const containerRect = container.getBoundingClientRect();
        const editorRect = domNode.getBoundingClientRect();
        const rawLeft =
          editorRect.left - containerRect.left + visiblePosition.left;
        const rawTop =
          editorRect.top - containerRect.top + visiblePosition.top + 12;
        const clampedLeft = Math.max(
          Math.min(rawLeft, containerRect.width - 280),
          8,
        );
        const clampedTop = Math.max(rawTop, 8);
        selectSegment(selected.range.segmentId);
        setSelectionOverlay(null);
        setPopoverError(null);
        setIssuePopover({
          issueId: selected.issueId,
          x: clampedLeft,
          y: clampedTop,
        });
      });

      editor.onDidChangeCursorPosition((event) => {
        const model = editor.getModel();
        if (!model) return;
        const offset = model.getOffsetAt(event.position);
        const segmentId = mapOffsetToSegment(offset, translationModel);
        if (segmentId) {
          selectSegment(segmentId);
        }
      });

      editor.onDidBlurEditorWidget(() => {
        flushPendingChanges();
        if (!issuePopoverRef.current) {
          scheduleSelectionClear();
        }
      });

      editor.onDidFocusEditorWidget(() => {
        applyHiddenAreas(editor, translationModel);
        cancelDeferredSelectionClear();
      });

      editor.onDidScrollChange(() => {
        if (scrollSyncingRef.current) return;
        clearSelectionState();
        setIssuePopover(null);
        const originEditor = originEditorRef.current;
        if (!originEditor) return;
        scrollSyncingRef.current = true;
        syncEditorsByRatio(editor, originEditor);
        window.requestAnimationFrame(() => {
          scrollSyncingRef.current = false;
        });
      });
    },
    [
      applyHiddenAreas,
      translationModel,
      revealSelectedSegment,
      selectSegment,
      flushPendingChanges,
      syncEditorsByRatio,
      handleTranslationSelectionChange,
      clearSelectionState,
      createEditorAdapter,
      registerEditorAdapter,
      scheduleSelectionClear,
      cancelDeferredSelectionClear,
      proofIssuesById,
    ],
  );

  const handleOriginMount: OnMount = useCallback(
    (editor) => {
      originEditorRef.current = editor;
      applyHiddenAreas(editor, originModel);
      revealSelectedSegment(editor, originModel);

      editor.onDidChangeCursorPosition((event) => {
        const model = editor.getModel();
        if (!model) return;
        const offset = model.getOffsetAt(event.position);
        const segmentId = mapOffsetToSegment(offset, originModel);
        if (segmentId) {
          selectSegment(segmentId);
        }
      });

      editor.onDidBlurEditorWidget(() => {
        flushPendingChanges();
      });

      editor.onDidFocusEditorWidget(() => {
        applyHiddenAreas(editor, originModel);
      });

      editor.onDidScrollChange(() => {
        if (scrollSyncingRef.current) return;
        const translationEditor = translationEditorRef.current;
        if (!translationEditor) return;
        scrollSyncingRef.current = true;
        syncEditorsByRatio(editor, translationEditor);
        window.requestAnimationFrame(() => {
          scrollSyncingRef.current = false;
        });
      });
    },
    [
      applyHiddenAreas,
      originModel,
      revealSelectedSegment,
      selectSegment,
      flushPendingChanges,
      syncEditorsByRatio,
    ],
  );

  useEffect(() => {
    if (!translationEditorRef.current) return;
    const currentValue = translationEditorRef.current.getValue();
    if (currentValue !== translationModel.value) {
      suppressTranslationChangeRef.current = true;
      translationEditorRef.current.setValue(translationModel.value);
      suppressTranslationChangeRef.current = false;
    }
    applyHiddenAreas(translationEditorRef.current, translationModel);
    if (originEditorRef.current) {
      scrollSyncingRef.current = true;
      syncEditorsByRatio(translationEditorRef.current, originEditorRef.current);
      window.requestAnimationFrame(() => {
        scrollSyncingRef.current = false;
      });
    }
  }, [translationModel, applyHiddenAreas, syncEditorsByRatio]);

  useEffect(() => {
    clearSelectionState();
  }, [translationModel, clearSelectionState]);

  useEffect(() => {
    if (!originEditorRef.current) return;
    const currentValue = originEditorRef.current.getValue();
    if (currentValue !== originModel.value) {
      suppressOriginChangeRef.current = true;
      originEditorRef.current.setValue(originModel.value);
      suppressOriginChangeRef.current = false;
    }
    applyHiddenAreas(originEditorRef.current, originModel);
    if (translationEditorRef.current) {
      scrollSyncingRef.current = true;
      syncEditorsByRatio(originEditorRef.current, translationEditorRef.current);
      window.requestAnimationFrame(() => {
        scrollSyncingRef.current = false;
      });
    }
  }, [originModel, applyHiddenAreas, syncEditorsByRatio]);

  useEffect(() => {
    const editor = translationEditorRef.current;
    const monaco = monacoRef.current;
    const highlightDebug = readHighlightDebugFlag();
    if (!editor || !monaco || !translationEditorReady) {
      if (highlightDebug) {
        console.debug("[dual-editor] decoration skipped (editor not ready)", {
          hasEditor: Boolean(editor),
          hasMonaco: Boolean(monaco),
          translationEditorReady,
        });
      }
      return;
    }
    const model = editor.getModel();
    if (!model) return;

    const decorationEntries: Array<{
      issueId: string;
      decoration: Monaco.editor.IModelDeltaDecoration;
    }> = [];
    const collectedIssueRanges: IssueRange[] = [];
    const decoratedIssueIds = new Set<string>();

    if (highlightDebug) {
      console.debug("[dual-editor] decoration effect", {
        segmentCount: segments.length,
        highlightCount: highlights.length,
        issueCount: issues.length,
        assignmentCount: Object.keys(issueAssignments).length,
      });
    }

    const registerDecoration = (
      issueId: string,
      segmentId: string,
      startOffset: number,
      endOffset: number,
      inlineClassName: string,
      hoverMessage: Monaco.IMarkdownString[] | undefined,
      source: "dataset-span" | "synthesized" | "project-highlight",
    ): boolean => {
      if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
        console.warn("[dual-editor] refusing to decorate invalid range", {
          issueId,
          segmentId,
          startOffset,
          endOffset,
          source,
        });
        return false;
      }
      const start = model.getPositionAt(Math.max(0, startOffset));
      const end = model.getPositionAt(Math.max(0, endOffset));
      decorationEntries.push({
        issueId,
        decoration: {
          range: new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column,
          ),
          options: {
            inlineClassName,
            hoverMessage: highlightDebug ? hoverMessage : undefined,
          },
        },
      });
      collectedIssueRanges.push({
        issueId,
        segmentId,
        startOffset,
        endOffset,
      });
      decoratedIssueIds.add(issueId);
      if (highlightDebug) {
        console.debug("[dual-editor] register decoration", {
          issueId,
          segmentId,
          startOffset,
          endOffset,
          source,
          inlineClassName,
        });
      }
      return true;
    };

    const addDecorationForIssue = (
      issueId: string,
      segmentId: string,
      startOffset: number,
      endOffset: number,
      source: "dataset-span" | "synthesized" | "project-highlight",
    ): boolean => {
      const datasetIssue = datasetIssuesById.get(issueId);
      const reportEntry = proofIssuesById.get(issueId);
      if (!datasetIssue && !reportEntry && highlightDebug) {
        console.debug(
          "[dual-editor] no dataset/report entry for issue",
          issueId,
        );
      }
      const severityValue =
        reportEntry?.issue?.severity ?? datasetIssue?.severity ?? null;
      const severityClass = severityToClass(severityValue);
      const isActive = activeIssueId === issueId;
      const lifecycle = issueStateById[issueId] ?? "pending";
      const isResolved = lifecycle === "applied" || lifecycle === "ignored";
      const inlineClassName = isActive
        ? `${severityClass} proofread-hl-active${
            isResolved ? " proofread-hl-resolved" : ""
          }`
        : `${severityClass}${isResolved ? " proofread-hl-resolved" : ""}`;
      const hoverMessage = buildHover(
        issueId,
        datasetIssue,
        reportEntry,
        severityValue,
      );
      return registerDecoration(
        issueId,
        segmentId,
        startOffset,
        endOffset,
        inlineClassName,
        hoverMessage,
        source,
      );
    };

    const buildHover = (
      issueId: string,
      datasetIssue: (typeof issues)[number] | undefined,
      reportEntry: ProofreadIssueEntry | undefined,
      severityValue: string | null,
    ) => {
      const hoverLines: string[] = [];
      const status =
        issueStateById[issueId] ??
        datasetIssue?.status ??
        reportEntry?.issue?.status ??
        "pending";
      if (status) {
        hoverLines.push(`Status: ${status}`);
      }
      if (severityValue) {
        hoverLines.push(`Severity: ${severityValue}`);
      }
      const featureLabel =
        reportEntry?.bucket?.subfeatureLabel ??
        reportEntry?.bucket?.group ??
        datasetIssue?.bucket?.subfeatureLabel ??
        datasetIssue?.bucket?.group ??
        undefined;
      if (featureLabel) {
        hoverLines.push(`Feature: ${featureLabel}`);
      }
      const updatedAt =
        datasetIssue?.updatedAt ??
        datasetIssue?.createdAt ??
        reportEntry?.issue?.appliedAt ??
        null;
      const formattedTimestamp = formatTimestamp(updatedAt);
      if (formattedTimestamp) {
        hoverLines.push(`Updated: ${formattedTimestamp}`);
      }
      const issueText =
        reportEntry?.issue?.issue_en ??
        reportEntry?.issue?.issue_ko ??
        datasetIssue?.issue?.issue_en ??
        datasetIssue?.issue?.issue_ko ??
        undefined;
      if (issueText) {
        hoverLines.push(issueText);
      }
      const recommendation =
        reportEntry?.issue?.recommendation_en ??
        reportEntry?.issue?.recommendation_ko ??
        datasetIssue?.issue?.recommendation_en ??
        datasetIssue?.issue?.recommendation_ko ??
        undefined;
      if (recommendation) {
        hoverLines.push(`Recommendation: ${recommendation}`);
      }
      return hoverLines.length
        ? hoverLines.map<Monaco.IMarkdownString>((value) => ({ value }))
        : undefined;
    };

    const locateSnippet = (
      segmentText: string,
      issueId: string,
      datasetEntry: (typeof issues)[number] | undefined,
      reportEntry: ProofreadIssueEntry | undefined,
    ): Array<{ start: number; end: number }> => {
      const payload = (reportEntry?.issue ?? datasetEntry?.issue) as
        | (Partial<ProofreadingIssue> & {
            spans?:
              | Array<{ start?: number | null; end?: number | null }>
              | { start?: number | null; end?: number | null }
              | null;
          })
        | undefined;
      if (!payload) return [];

      const lifecycle = issueStateById[issueId] ?? "pending";
      const candidates: string[] = [];

      const beforeText = (() => {
        if (
          typeof payload.before === "string" &&
          payload.before.trim().length
        ) {
          return payload.before;
        }
        if (
          typeof payload.translationExcerpt === "string" &&
          payload.translationExcerpt.trim().length
        ) {
          return payload.translationExcerpt;
        }
        return undefined;
      })();

      const afterText =
        typeof payload.after === "string" && payload.after.trim().length
          ? payload.after
          : undefined;

      if (lifecycle === "applied") {
        if (afterText) {
          candidates.push(afterText);
        }
        if (beforeText && beforeText !== afterText) {
          candidates.push(beforeText);
        }
      } else {
        if (beforeText) {
          candidates.push(beforeText);
        }
        if (afterText && afterText !== beforeText) {
          candidates.push(afterText);
        }
      }

      (payload.alternatives ?? []).forEach((candidate) => {
        if (typeof candidate === "string" && candidate.trim().length) {
          candidates.push(candidate);
        }
      });

      for (const candidate of candidates) {
        const match = looseMatchRange(segmentText, candidate);
        if (match) {
          return [match];
        }
      }

      const spanCandidates: Array<{
        start?: number | null;
        end?: number | null;
      }> = [];
      if (datasetEntry?.spans?.length) {
        spanCandidates.push(datasetEntry.spans[0]);
      }
      if (payload.spans) {
        if (Array.isArray(payload.spans) && payload.spans.length) {
          spanCandidates.push(payload.spans[0]);
        } else if (!Array.isArray(payload.spans)) {
          spanCandidates.push(payload.spans);
        }
      }

      for (const span of spanCandidates) {
        if (!span) continue;
        const start = toFiniteNumber(span.start) ?? 0;
        const end = toFiniteNumber(span.end) ?? start;
        if (end > start && end <= segmentText.length) {
          return [{ start, end }];
        }
      }

      return [];
    };

    segments.forEach((segment) => {
      const segmentMeta = translationModel.metaMap.get(segment.segmentId);
      if (!segmentMeta) {
        console.warn(
          "[dual-editor] missing meta for segment",
          segment.segmentId,
        );
        return;
      }
      if (collapsedSegmentIds[segment.segmentId]) return;

      const segmentText = segment.translationText ?? "";
      const assignmentIds = issueAssignments[segment.segmentId] ?? [];
      const spans = segment.spans ?? [];
      const datasetCandidateIds = issues
        .filter((entry) => entry.segmentId === segment.segmentId)
        .map((entry) => entry.id);
      const candidateIssueIds = assignmentIds.length
        ? assignmentIds
        : datasetCandidateIds.length
          ? datasetCandidateIds
          : assignmentIds;
      if (!candidateIssueIds.length && !spans.length && highlightDebug) {
        console.debug("[dual-editor] no candidates or spans for segment", {
          segmentId: segment.segmentId,
          segmentLength: segmentText.length,
        });
      }
      const decoratedForSegment = new Set<string>();

      spans.forEach((spanRaw) => {
        const span = spanRaw as SegmentSpanLike;
        const issueId = span.issueId;
        if (
          candidateIssueIds.length > 0 &&
          !candidateIssueIds.includes(issueId)
        ) {
          return;
        }
        const resolved = resolveSegmentSpanOffsets(
          span,
          segmentMeta,
          segmentText,
        );
        if (!resolved) {
          console.warn("[dual-editor] ignoring invalid span", {
            issueId,
            segmentId: segment.segmentId,
            span,
          });
          return;
        }
        if (
          addDecorationForIssue(
            issueId,
            segment.segmentId,
            resolved.startOffset,
            resolved.endOffset,
            "dataset-span",
          )
        ) {
          decoratedForSegment.add(issueId);
        }
      });

      if (
        !spans.length ||
        decoratedForSegment.size < candidateIssueIds.length
      ) {
        candidateIssueIds.forEach((issueId) => {
          if (decoratedForSegment.has(issueId)) return;
          const datasetEntry = datasetIssuesById.get(issueId);
          const reportEntry = proofIssuesById.get(issueId);
          if (!datasetEntry && !reportEntry) return;
          const matches = locateSnippet(
            segmentText,
            issueId,
            datasetEntry,
            reportEntry,
          );
          if (!matches.length && highlightDebug) {
            console.debug("[dual-editor] no snippet match", {
              issueId,
              segmentId: segment.segmentId,
              hasDatasetEntry: Boolean(datasetEntry),
              hasReportEntry: Boolean(reportEntry),
            });
          }
          matches.forEach((match) => {
            const startOffset = segmentMeta.startOffset + match.start;
            const endOffset = segmentMeta.startOffset + match.end;
            if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
              console.warn("[dual-editor] synthesized range invalid", {
                issueId,
                segmentId: segment.segmentId,
                match,
              });
              return;
            }
            if (
              addDecorationForIssue(
                issueId,
                segment.segmentId,
                startOffset,
                endOffset,
                "synthesized",
              )
            ) {
              decoratedForSegment.add(issueId);
            }
          });
        });
      }
    });

    const projectHighlightToAggregated = (
      highlight: ProofreadHighlightSegment,
    ) => {
      if (
        !Number.isFinite(highlight.start) ||
        !Number.isFinite(highlight.end)
      ) {
        console.warn(
          "[dual-editor] highlight missing numeric range",
          highlight,
        );
        return null;
      }
      for (const segment of segments) {
        const segmentMeta = translationModel.metaMap.get(segment.segmentId);
        if (!segmentMeta) {
          continue;
        }
        if (
          highlight.start >= segmentMeta.plainStartOffset &&
          highlight.start < segmentMeta.plainEndOffset
        ) {
          if (highlight.end > segmentMeta.plainEndOffset) {
            return null;
          }
          const localStart = highlight.start - segmentMeta.plainStartOffset;
          const localEnd = highlight.end - segmentMeta.plainStartOffset;
          if (localEnd <= localStart) {
            return null;
          }
          return {
            segmentId: segment.segmentId,
            startOffset: segmentMeta.startOffset + localStart,
            endOffset: segmentMeta.startOffset + localEnd,
          };
        }
      }
      if (highlightDebug) {
        console.debug(
          "[dual-editor] highlight did not map to segment",
          highlight,
        );
      }
      return null;
    };

    highlights.forEach((highlight) => {
      const issueId = highlight.issueId;
      if (!issueId || decoratedIssueIds.has(issueId)) return;
      const range = projectHighlightToAggregated(highlight);
      if (!range) {
        console.warn("[dual-editor] highlight mapping failed", highlight);
        return;
      }
      addDecorationForIssue(
        issueId,
        range.segmentId,
        range.startOffset,
        range.endOffset,
        "project-highlight",
      );
    });

    const nextDecorations = decorationEntries.map((entry) => entry.decoration);
    translationDecorationsRef.current = model.deltaDecorations(
      translationDecorationsRef.current,
      nextDecorations,
    );
    if (highlightDebug) {
      console.debug(
        "[dual-editor] applied decoration count",
        decorationEntries.length,
      );
      console.debug(
        "[dual-editor] total decorated issue ids",
        decoratedIssueIds.size,
      );
    }

    issueRangesRef.current = collectedIssueRanges.reduce<
      Record<string, IssueRange[]>
    >((acc, range) => {
      if (!acc[range.issueId]) {
        acc[range.issueId] = [];
      }
      acc[range.issueId].push(range);
      return acc;
    }, {});

    return () => {
      translationDecorationsRef.current = model.deltaDecorations(
        translationDecorationsRef.current,
        [],
      );
      issueRangesRef.current = {};
    };
  }, [
    segments,
    issueAssignments,
    issues,
    translationModel,
    activeIssueId,
    collapsedSegmentIds,
    proofIssuesById,
    issueStateById,
    highlights,
    translationEditorReady,
    datasetIssuesById,
  ]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPendingChanges();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (pointerMoveHandlerRef.current) {
        window.removeEventListener(
          "pointermove",
          pointerMoveHandlerRef.current,
        );
        pointerMoveHandlerRef.current = null;
      }
      if (pointerUpHandlerRef.current) {
        window.removeEventListener("pointerup", pointerUpHandlerRef.current);
        pointerUpHandlerRef.current = null;
      }
      if (selectionDisposableRef.current) {
        selectionDisposableRef.current.dispose();
        selectionDisposableRef.current = null;
      }
      flushPendingChanges();
      clearSaveTimer();
      clearSelectionState();
      setTranslationEditorReady(false);
    };
  }, [
    flushPendingChanges,
    clearSaveTimer,
    clearSelectionState,
    setTranslationEditorReady,
  ]);

  useEffect(
    () => () => {
      clearSaveTimer();
      clearSelectionState();
      if (selectionDisposableRef.current) {
        selectionDisposableRef.current.dispose();
        selectionDisposableRef.current = null;
      }
      registerEditorAdapter(null);
      cancelDeferredSelectionClear();
    },
    [
      clearSaveTimer,
      clearSelectionState,
      registerEditorAdapter,
      cancelDeferredSelectionClear,
    ],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedSegmentId) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "[") {
        if (!collapsedSegmentIds[selectedSegmentId]) {
          event.preventDefault();
          toggleSegmentCollapse(selectedSegmentId);
        }
      }
      if (event.key === "]") {
        if (collapsedSegmentIds[selectedSegmentId]) {
          event.preventDefault();
          toggleSegmentCollapse(selectedSegmentId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedSegmentId, collapsedSegmentIds, toggleSegmentCollapse]);

  return (
    <div
      ref={containerRef}
      className="relative grid h-full w-full items-stretch gap-0"
      style={{
        gridTemplateColumns: `${editorRatio}fr 12px ${1 - editorRatio}fr`,
      }}
    >
      {selectionOverlay && (
        <div
          className="pointer-events-auto absolute z-20 flex flex-wrap items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs text-slate-700 shadow"
          style={{ top: selectionOverlay.y, left: selectionOverlay.x }}
        >
          <span className="hidden max-w-[200px] truncate md:inline">
            “{selectionOverlay.context.text}”
          </span>
          <button
            type="button"
            onClick={handleInlineRewrite}
            className="rounded-full bg-neutral-900 px-3 py-0.5 text-xs font-medium text-white hover:bg-neutral-800"
          >
            문장 다듬기
          </button>
          <button
            type="button"
            onClick={handleInlineNormalizeName}
            className="rounded-full bg-slate-900/5 px-3 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-200"
          >
            이름 통일
          </button>
          <button
            type="button"
            onClick={handleInlineAdjustPronoun}
            className="rounded-full bg-slate-900/5 px-3 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-200"
          >
            대명사 조정
          </button>
          <button
            type="button"
            onClick={handleCancelSelection}
            className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-300 hover:text-slate-700"
          >
            취소
          </button>
        </div>
      )}
      <div className="flex h-full flex-col overflow-hidden rounded border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 bg-sky-50 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-900">
              {localize("proofread_editor_origin_label", "Manuscript")}
            </span>
            <button
              type="button"
              onClick={() => setIsSummaryModalOpen(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              aria-label={summaryButtonLabel}
              title={summaryButtonLabel}
            >
              <BookOpenCheck className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="flex-1">
          <Editor
            height="100%"
            defaultLanguage="plaintext"
            value={originModel.value}
            onChange={handleOriginChange}
            onMount={handleOriginMount}
            options={{
              lineNumbers: "on",
              lineNumbersMinChars: 2,
              minimap: { enabled: false },
              smoothScrolling: true,
              scrollbar: { verticalScrollbarSize: 16 },
              wordWrap: "on",
              wordWrapColumn: 120,
              wrappingStrategy: "advanced",
            }}
          />
        </div>
      </div>
      <div
        className={`flex h-full cursor-col-resize select-none items-center justify-center bg-white transition hover:bg-slate-50 ${
          dragging ? "bg-slate-50" : ""
        } border-x border-slate-200`}
        onPointerDown={handlePointerDown}
      >
        <div className="h-10 w-px bg-slate-200" />
      </div>
      <div className="flex h-full flex-col overflow-hidden rounded border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 bg-sky-50 px-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-900">
                {localize("proofread_editor_translation_label", "Translation")}
              </span>
              <button
                type="button"
                onClick={openQualityDialog}
                disabled={!hasTranslationContent}
                className={qualityButtonClass}
                title={qualityButtonTitle}
                aria-label="Open quality assessment"
              >
                <ShieldCheck className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              {stageOrder.map((stageKey) => {
                const meta = STAGE_META[stageKey];
                const Icon = meta.icon;
                const isActive =
                  stageViewer.isOpen && stageViewer.stage === stageKey;
                const isAvailable = availableStageSet.has(stageKey);
                const disabled = !canLoadStageDrafts;
                const showSpinner =
                  isActive &&
                  stageDraftQuery.isLoading &&
                  stageViewer.stage === stageKey;
                const buttonClass = [
                  "inline-flex items-center justify-center rounded-full border px-2 py-1 text-[11px] transition",
                  disabled
                    ? "cursor-not-allowed border-slate-100 text-slate-300"
                    : "border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-700",
                  isAvailable ? meta.toneClass : "",
                  isActive ? "bg-slate-100 border-slate-200" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    key={stageKey}
                    type="button"
                    className={buttonClass}
                    title={stageButtonTitle(stageKey)}
                    aria-pressed={isActive}
                    disabled={disabled}
                    onClick={() => handleStageButtonClick(stageKey)}
                  >
                    {showSpinner ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Icon className="h-3.5 w-3.5" />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="min-w-[80px] text-right">
              {isSaving ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Saving…
                </span>
              ) : showSavedIndicator ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  Saved
                  <Check className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </div>
          </div>
        </header>
        <div className="flex-1">
          <Editor
            height="100%"
            defaultLanguage="plaintext"
            value={translationModel.value}
            onChange={handleTranslationChange}
            onMount={handleTranslationMount}
            options={{
              lineNumbers: "on",
              lineNumbersMinChars: 2,
              minimap: { enabled: false },
              smoothScrolling: true,
              scrollbar: { verticalScrollbarSize: 16 },
              wordWrap: "on",
              wordWrapColumn: 120,
              wrappingStrategy: "advanced",
            }}
          />
        </div>
      </div>
      {issuePopover && proofIssuesById.has(issuePopover.issueId) && (
        <IssuePopover
          x={issuePopover.x}
          y={issuePopover.y}
          issueEntry={proofIssuesById.get(issuePopover.issueId)!}
          onClose={() => setIssuePopover(null)}
          onApply={handleApply}
          onIgnore={handleIgnore}
          onApplied={handleIssueApplied}
          busy={popoverBusy}
          setBusy={setPopoverBusy}
          error={popoverError}
          setError={setPopoverError}
          issueState={issueStateById[issuePopover.issueId] ?? "pending"}
        />
      )}
      {stageViewer.isOpen && (
        <Modal
          title={stageViewerTitle}
          description={viewerCountsLabel}
          onClose={handleCloseStageViewer}
          maxWidthClass="max-w-3xl"
          showCloseButton
          closeLabel={localize("proofread_stage_viewer_close", "Close")}
        >
          <div className="space-y-4 text-sm text-slate-700">
            {knownAvailableStages.length ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-semibold">
                  {localize(
                    "proofread_stage_viewer_available_label",
                    "Captured stages:",
                  )}
                </span>
                {knownAvailableStages.map((stageKey) => (
                  <span
                    key={`${stageKey}-chip`}
                    className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600"
                  >
                    {getStageLabel(stageKey)}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              {viewerCountsLabel ? <span>{viewerCountsLabel}</span> : <span />}
              {stageDraftHasText && (
                <button
                  type="button"
                  onClick={handleCopyStageDraft}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                >
                  {copyLabel}
                </button>
              )}
            </div>
            {stageDraftQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {localize(
                  "proofread_stage_viewer_loading",
                  "Loading stage draft…",
                )}
              </div>
            ) : stageDraftQuery.error ? (
              <p className="text-sm text-rose-600">{stageDraftErrorMessage}</p>
            ) : stageDraftSegments.length ? (
              <>
                <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
                  {stageDraftHasText
                    ? stageDraftData?.joinedText
                    : localize(
                        "proofread_stage_viewer_empty",
                        "No draft output is available for this stage yet.",
                      )}
                </div>
                <div className="max-h-60 overflow-y-auto rounded border border-slate-100">
                  <ul className="divide-y divide-slate-100 text-xs text-slate-600">
                    {stageDraftSegments.map((segment) => (
                      <li
                        key={`${segment.segmentId}-${segment.segmentIndex}`}
                        className="px-3 py-2"
                      >
                        <p className="font-semibold text-slate-700">
                          {localize(
                            "proofread_stage_viewer_segment_label",
                            "Segment {{index}}",
                            { index: segment.segmentIndex + 1 },
                          )}
                        </p>
                        <p className="whitespace-pre-wrap text-slate-600">
                          {segment.text?.trim().length
                            ? segment.text
                            : localize(
                                "proofread_stage_viewer_segment_empty",
                                "No text captured for this segment.",
                              )}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">
                {localize(
                  "proofread_stage_viewer_empty",
                  "No draft output is available for this stage yet.",
                )}
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleCloseStageViewer}
                className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
              >
                {localize("proofread_stage_viewer_close", "Close")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {isSummaryModalOpen && (
        <Modal
          title={summaryModalTitle}
          description={summaryModalDescription}
          onClose={() => setIsSummaryModalOpen(false)}
          maxWidthClass="max-w-2xl"
          showCloseButton
          closeLabel={summaryCloseLabel}
        >
          <div className="max-h-[65vh] space-y-4 overflow-y-auto text-sm text-slate-700">
            <section className="space-y-2">
              <h3 className="text-base font-semibold text-slate-900">
                {summarySectionTitle}
              </h3>
              {originSummary ? (
                <div className="space-y-3">
                  {originSummary.intention ? (
                    <p className="text-sm text-slate-800">
                      <span className="font-semibold text-slate-900">
                        {localize(
                          "rightpanel_summary_intention_label",
                          "작가의도:",
                        )}
                      </span>{" "}
                      <span className="whitespace-pre-wrap">
                        {originSummary.intention}
                      </span>
                    </p>
                  ) : null}
                  {originSummary.story ? (
                    <p className="text-sm text-slate-800">
                      <span className="font-semibold text-slate-900">
                        {localize("rightpanel_summary_story_label", "줄거리:")}
                      </span>{" "}
                      <span className="whitespace-pre-wrap">
                        {originSummary.story}
                      </span>
                    </p>
                  ) : null}
                  {originSummary.readerPoints?.length ? (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {localize(
                          "rightpanel_summary_reader_points_label",
                          "독자 포인트",
                        )}
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
                        {originSummary.readerPoints.map((point, index) => (
                          <li key={`reader-point-${index}`}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {summaryMetricChips.length ? (
                    <ul className="flex flex-wrap gap-2 text-[11px] text-slate-500">
                      {summaryMetricChips.map((chip, index) => (
                        <li
                          key={`summary-metric-${index}`}
                          className="rounded-full bg-slate-100 px-2 py-0.5"
                        >
                          {chip}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-slate-500">{summaryEmptyLabel}</p>
              )}
            </section>
            <section className="space-y-2">
              <h3 className="text-base font-semibold text-slate-900">
                {notesSectionTitle}
              </h3>
              {hasTranslationNotesContent ? (
                <div className="space-y-3">
                  {translationNotes && hasText(translationNotes.timePeriod) ? (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {timePeriodLabel}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-slate-800">
                        {translationNotes.timePeriod}
                      </p>
                    </div>
                  ) : null}
                  {renderCharacterSection()}
                  {renderEntitySection(
                    namedEntitiesLabel,
                    namedEntityEntries,
                    "entities",
                    { twoColumn: true },
                  )}
                  {renderEntitySection(
                    locationsLabel,
                    locationEntries,
                    "locations",
                    { twoColumn: true },
                  )}
                  {renderPairSection(
                    measurementUnitsLabel,
                    measurementEntries,
                    "measurement",
                  )}
                  {renderPairSection(
                    linguisticFeaturesLabel,
                    linguisticEntries,
                    "linguistic",
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500">{notesEmptyLabel}</p>
              )}
            </section>
          </div>
        </Modal>
      )}
    </div>
  );
};

const IssuePopover = ({
  x,
  y,
  issueEntry,
  onClose,
  onApply,
  onIgnore,
  onApplied,
  busy,
  setBusy,
  error,
  setError,
  issueState,
}: {
  x: number;
  y: number;
  issueEntry: ProofreadIssueEntry;
  onClose: () => void;
  onApply: (issue: ProofreadingIssue) => Promise<boolean>;
  onIgnore: (issue: ProofreadingIssue) => Promise<boolean>;
  onApplied?: (entry: ProofreadIssueEntry) => void;
  busy: boolean;
  setBusy: (next: boolean) => void;
  error: string | null;
  setError: (message: string | null) => void;
  issueState: string;
}) => {
  const issue = issueEntry.issue;
  const severity = (issue.severity ?? "unknown").toString();
  const title = issue.issue_en ?? issue.issue_ko ?? "Proofreading issue";
  const beforeText = issue.before ?? issue.translationExcerpt ?? "";
  const afterText = issue.after ?? "";

  const runAction = async (
    executor: (payload: ProofreadingIssue) => Promise<boolean>,
    onSuccess?: () => void,
  ) => {
    setError(null);
    setBusy(true);
    try {
      const success = await executor(issue);
      if (success) {
        onSuccess?.();
        onClose();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "문제를 처리하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };

  const isApplied = issueState === "applied";
  const isIgnored = issueState === "ignored";

  return (
    <div
      className="pointer-events-auto absolute z-30 w-72 max-w-xs rounded-md border border-slate-200 bg-white p-4 shadow-xl"
      style={{ top: y, left: x }}
      onMouseDown={(event) => {
        event.stopPropagation();
        const native = event.nativeEvent as {
          stopImmediatePropagation?: () => void;
        };
        native.stopImmediatePropagation?.();
      }}
      onMouseUp={(event) => {
        event.stopPropagation();
        const native = event.nativeEvent as {
          stopImmediatePropagation?: () => void;
        };
        native.stopImmediatePropagation?.();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-800">{title}</p>
          <p className="text-xs text-slate-500">Severity: {severity}</p>
          <p className="text-xs text-slate-500">Status: {issueState}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-slate-200 p-1 text-slate-400 transition hover:border-slate-300 hover:text-slate-600"
          aria-label="닫기"
        >
          <XCircle className="h-4 w-4" />
        </button>
      </div>
      {beforeText && (
        <div className="mt-3">
          <span className="text-xs font-semibold uppercase text-slate-500">
            Before
          </span>
          <p className="mt-1 whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 p-2 text-xs text-slate-600">
            {beforeText}
          </p>
        </div>
      )}
      {afterText && (
        <div className="mt-3">
          <span className="text-xs font-semibold uppercase text-emerald-600">
            After
          </span>
          <p className="mt-1 whitespace-pre-wrap rounded border border-emerald-100 bg-emerald-50 p-2 text-xs text-emerald-700">
            {afterText}
          </p>
        </div>
      )}
      {issue.recommendation_en && (
        <p className="mt-2 text-xs text-slate-500">{issue.recommendation_en}</p>
      )}
      {error && (
        <p className="mt-2 flex items-center gap-1 text-xs text-rose-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void runAction(onIgnore)}
          disabled={busy || isIgnored}
          className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Ignore
        </button>
        <button
          type="button"
          onClick={() =>
            void runAction(onApply, () => {
              onApplied?.(issueEntry);
            })
          }
          disabled={busy || isApplied}
          className="inline-flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Apply
        </button>
      </div>
    </div>
  );
};
