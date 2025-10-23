import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, X, Loader2, CheckCircle2, Circle } from "lucide-react";
import { useUIStore } from "../../store/ui.store";
import type {
  RightPanelBaseTab,
  RightPanelExtraTab,
} from "../../store/ui.store";
import { useAuthStore } from "../../store/auth.store";
import { useAuth } from "../../hooks/useAuth";
import { useProjectStore } from "../../store/project.store";
import { TranslationCanvas } from "../preview/TranslationCanvas";
import { ProofList } from "../proofreading/ProofList";
import {
  ProofreadIssuesProvider,
  useProofreadIssues,
  type ProofreadHighlightSegment,
} from "../../context/ProofreadIssuesContext";
import { ProofreadEditorProvider } from "../../context/proofreadEditor";
import { ProofreadEditorTab } from "../proofreading/ProofreadEditorTab";
import { ExportPanel } from "../export/ExportPanel";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";
import { ProjectProfileCard } from "../project/ProjectProfileCard";
import { QualityAssessmentDialog } from "../quality/QualityAssessmentDialog";
import type {
  DocumentProfileSummary,
  JobSummary,
  JobSequentialSummary,
  ProjectContent,
} from "../../types/domain";
import { api } from "../../services/api";
import { useWorkflowStore } from "../../store/workflow.store";
import { projectKeys } from "../../hooks/useProjectData";

const TRANSLATION_PIPELINE_STAGE_ORDER = [
  "literal",
  "style",
  "emotion",
  "qa",
] as const;

type PipelineStageKey = (typeof TRANSLATION_PIPELINE_STAGE_ORDER)[number];
type StageKey = PipelineStageKey | "finalizing";

type StageStatusKey =
  | "ready"
  | "queued"
  | "inProgress"
  | "completed"
  | "failed";

type LocalizeFn = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) => string;

const TRANSLATION_STAGE_LABEL_META: Record<
  StageKey,
  { key: string; fallback: string }
> = {
  literal: {
    key: "translation_stage_literal",
    fallback: "Literal pass",
  },
  style: {
    key: "translation_stage_style",
    fallback: "Style pass",
  },
  emotion: {
    key: "translation_stage_emotion",
    fallback: "Emotion pass",
  },
  qa: {
    key: "translation_stage_qa",
    fallback: "QA review",
  },
  finalizing: {
    key: "translation_stage_finalizing",
    fallback: "Finalizing",
  },
};

const STAGE_STATUS_META: Record<
  StageStatusKey,
  { key: string; fallback: string }
> = {
  ready: {
    key: "timeline_status_ready",
    fallback: "Ready",
  },
  queued: {
    key: "timeline_status_queued",
    fallback: "Queued",
  },
  inProgress: {
    key: "timeline_status_in_progress",
    fallback: "In Progress",
  },
  completed: {
    key: "timeline_status_completed",
    fallback: "Completed",
  },
  failed: {
    key: "timeline_status_failed",
    fallback: "Failed",
  },
};

const applyParams = (
  template: string,
  params?: Record<string, string | number>,
): string => {
  if (!params) return template;
  return template.replace(/{{(\w+)}}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(params, token)) {
      return String(params[token]);
    }
    return match;
  });
};

const inferCurrentPipelineStage = (
  sequential: JobSequentialSummary,
): PipelineStageKey | null => {
  if (!sequential.totalSegments) return null;
  if (sequential.currentStage) {
    const normalized = sequential.currentStage.toLowerCase();
    if (
      (TRANSLATION_PIPELINE_STAGE_ORDER as readonly string[]).includes(
        normalized,
      )
    ) {
      return normalized as PipelineStageKey;
    }
  }
  return (
    TRANSLATION_PIPELINE_STAGE_ORDER.find((stage) => {
      const count = sequential.stageCounts?.[stage] ?? 0;
      return count < sequential.totalSegments;
    }) ??
    TRANSLATION_PIPELINE_STAGE_ORDER[
      TRANSLATION_PIPELINE_STAGE_ORDER.length - 1
    ]
  );
};

const resolveStageStatusKey = (
  job: JobSummary,
  stageKey: StageKey,
  sequential: JobSequentialSummary,
  total: number,
): StageStatusKey => {
  const normalizedJobStatus = job.status?.toLowerCase() ?? "";
  const translationDone =
    normalizedJobStatus === "done" ||
    normalizedJobStatus === "succeeded" ||
    normalizedJobStatus === "completed" ||
    normalizedJobStatus === "success" ||
    Boolean(job.finalTranslation);
  const currentStage = inferCurrentPipelineStage(sequential);
  const completedStages = new Set(
    (sequential.completedStages ?? []).map((stage) => stage.toLowerCase()),
  );
  const stageCount = sequential.stageCounts?.[stageKey] ?? 0;
  const pipelineStageCount = sequential.stageCounts ?? {};
  const qaCount = pipelineStageCount.qa ?? 0;
  const qaComplete =
    total > 0 ? qaCount >= total : completedStages.has("qa");

  if (stageKey === "finalizing") {
    if (normalizedJobStatus === "failed" || normalizedJobStatus === "cancelled") {
      return "failed";
    }
    if (completedStages.has("finalizing") || translationDone) {
      return "completed";
    }
    if (qaComplete) {
      return normalizedJobStatus === "running" ? "inProgress" : "ready";
    }
    return "queued";
  }

  const completed = total > 0 && stageCount >= total;

  if (completed || completedStages.has(stageKey)) {
    return "completed";
  }

  if (normalizedJobStatus === "failed" || normalizedJobStatus === "cancelled") {
    if (currentStage === stageKey || (!currentStage && stageCount < total)) {
      return "failed";
    }
    return "queued";
  }

  if (currentStage === stageKey) {
    if (normalizedJobStatus === "queued" || normalizedJobStatus === "pending") {
      return "queued";
    }
    return "inProgress";
  }

  const stageIndex = TRANSLATION_PIPELINE_STAGE_ORDER.indexOf(stageKey);
  const currentIndex = currentStage
    ? TRANSLATION_PIPELINE_STAGE_ORDER.indexOf(currentStage)
    : -1;

  if (currentIndex >= 0) {
    if (stageIndex < currentIndex) {
      return "completed";
    }
    if (stageIndex === currentIndex + 1) {
      return normalizedJobStatus === "running" ? "ready" : "queued";
    }
    if (stageIndex > currentIndex + 1) {
      return "queued";
    }
  } else {
    if (normalizedJobStatus === "queued" || normalizedJobStatus === "pending") {
      return "queued";
    }
    if (normalizedJobStatus === "running") {
      if (stageIndex === 0) {
        return "inProgress";
      }
      const previousStage = TRANSLATION_PIPELINE_STAGE_ORDER[stageIndex - 1];
      const previousComplete =
        (sequential.stageCounts?.[previousStage] ?? 0) >= total ||
        completedStages.has(previousStage);
      return previousComplete ? "ready" : "queued";
    }
    if (
      normalizedJobStatus === "succeeded" ||
      normalizedJobStatus === "completed"
    ) {
      return "completed";
    }
  }

  return stageCount > 0 ? "inProgress" : "queued";
};

const formatSequentialStageStatus = (
  job: JobSummary,
  localize: LocalizeFn,
): string | null => {
  const sequential = job.sequential;
  if (!sequential || !sequential.totalSegments) {
    return null;
  }
  const total = sequential.totalSegments;
  const normalizedJobStatus = job.status?.toLowerCase() ?? "";
  const pipelineStage = inferCurrentPipelineStage(sequential);
  const completedStages = new Set(
    (sequential.completedStages ?? []).map((stage) => stage.toLowerCase()),
  );
  const qaCount = sequential.stageCounts?.qa ?? 0;
  const qaComplete =
    total > 0 ? qaCount >= total : completedStages.has("qa");
  const translationDone =
    normalizedJobStatus === "done" ||
    normalizedJobStatus === "succeeded" ||
    normalizedJobStatus === "completed" ||
    normalizedJobStatus === "success" ||
    Boolean(job.finalTranslation);

  const stageKey: StageKey = (() => {
    if (
      (qaComplete &&
        normalizedJobStatus !== "failed" &&
        normalizedJobStatus !== "cancelled" &&
        !translationDone) ||
      translationDone
    ) {
      return "finalizing";
    }
    if (pipelineStage) {
      return pipelineStage;
    }
    return TRANSLATION_PIPELINE_STAGE_ORDER[
      TRANSLATION_PIPELINE_STAGE_ORDER.length - 1
    ];
  })();
  const stageMeta = TRANSLATION_STAGE_LABEL_META[stageKey] ?? {
    key: stageKey,
    fallback: stageKey,
  };
  const stageLabel = localize(stageMeta.key, stageMeta.fallback);
  const completedSegments = Math.min(
    sequential.stageCounts?.[stageKey] ?? 0,
    total,
  );
  const statusKey = resolveStageStatusKey(
    job,
    stageKey,
    sequential,
    total,
  );
  const statusMeta = STAGE_STATUS_META[statusKey];
  const statusLabel = localize(statusMeta.key, statusMeta.fallback);

  if (stageKey === "finalizing") {
    return localize(
      "rightpanel_job_stage_finalizing",
      "Job {{jobId}} · {{stageLabel}} ({{statusLabel}})",
      {
        jobId: job.id,
        stageLabel,
        statusLabel,
      },
    );
  }

  return localize(
    "rightpanel_job_stage_progress",
    "Job {{jobId}} · {{stageLabel}} ({{statusLabel}}) {{completed}}/{{total}}",
    {
      jobId: job.id,
      stageLabel,
      statusLabel,
      completed: completedSegments,
      total,
    },
  );
};

interface RightPanelProps {
  content?: ProjectContent | null;
  isContentLoading?: boolean;
  jobs?: JobSummary[] | null;
  isJobsLoading?: boolean;
  onProfileUpdated?: () => void;
  onRefreshContent?: () => Promise<void> | void;
}

const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, [data-collapsible-ignore]";

const isEventFromInteractive = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  Boolean(target.closest(INTERACTIVE_SELECTOR));

const handleKeyboardToggle = <T extends HTMLElement>(
  event: ReactKeyboardEvent<T>,
  toggle: () => void,
) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggle();
  }
};

const USER_MENU_ITEMS: Array<{ key: RightPanelExtraTab; label: string }> = [
  { key: "profile", label: "My profile" },
  { key: "settings", label: "My settings" },
  { key: "activity", label: "My activity" },
  { key: "terms", label: "Terms" },
  { key: "privacy", label: "Privacy" },
];

const SummaryCard = ({
  title,
  summary,
  fullText,
  expanded,
  timestamp,
  onToggle,
  highlights,
  editable = false,
  onSave,
  autoSaveDelay = 5000,
  placeholder,
  statusLabel,
}: {
  title: string;
  summary?: string | null;
  fullText?: string | null;
  expanded: boolean;
  timestamp?: string | null;
  onToggle: (expanded: boolean) => void;
  highlights?: ProofreadHighlightSegment[];
  editable?: boolean;
  onSave?: (nextValue: string) => Promise<void>;
  autoSaveDelay?: number;
  placeholder?: string;
  statusLabel?: string;
}) => {
  const baseText = fullText ?? summary ?? "";
  const [draft, setDraft] = useState(baseText);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "dirty" | "saving" | "saved" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!dirty) {
      setDraft(baseText);
      setStatus("idle");
      setErrorMessage(null);
    }
  }, [baseText, dirty]);

  useEffect(() => {
    if (status === "saved") {
      const id = window.setTimeout(() => {
        if (isMountedRef.current) {
          setStatus("idle");
        }
      }, 1500);
      return () => window.clearTimeout(id);
    }
  }, [status]);

  const clearTimer = () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  };

  const flushSave = useCallback(async () => {
    if (!editable || !onSave || !dirty) return;
    clearTimer();
    setStatus("saving");
    try {
      await onSave(draft);
      if (!isMountedRef.current) return;
      setStatus("saved");
      setErrorMessage(null);
      setDirty(false);
    } catch (err) {
      if (!isMountedRef.current) return;
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "저장에 실패했습니다.",
      );
    }
  }, [editable, onSave, dirty, draft]);

  const flushSaveRef = useRef(flushSave);

  useEffect(() => {
    flushSaveRef.current = flushSave;
  }, [flushSave]);

  useEffect(
    () => () => {
      void flushSaveRef.current?.();
      clearTimer();
    },
    [],
  );

  const scheduleSave = useCallback(() => {
    if (!editable || !onSave) return;
    clearTimer();
    saveTimerRef.current = window.setTimeout(() => {
      void flushSave();
    }, autoSaveDelay);
  }, [editable, onSave, autoSaveDelay, flushSave]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setDirty(true);
      setStatus("dirty");
      setErrorMessage(null);
      scheduleSave();
    },
    [scheduleSave],
  );

  const handleBlur = useCallback(() => {
    void flushSave();
  }, [flushSave]);

  const handleFocus = useCallback(() => {
    if (!expanded) {
      onToggle(true);
    }
  }, [expanded, onToggle]);

  const displayText = expanded ? draft : draft.slice(0, 400);
  const truncated = !expanded && draft.length > 400;

  const renderWithHighlights = (value: string) => {
    if (!highlights?.length) {
      return <>{value}</>;
    }
    const segments = [...highlights]
      .filter((segment) => segment.start < value.length && segment.end > 0)
      .sort((a, b) => a.start - b.start);
    const nodes: ReactNode[] = [];
    let cursor = 0;
    segments.forEach((segment, index) => {
      const clampedStart = Math.max(segment.start, 0);
      const clampedEnd = Math.min(segment.end, value.length);
      if (clampedStart > cursor) {
        nodes.push(
          <span key={`plain-${index}-${cursor}`}>
            {value.slice(cursor, clampedStart)}
          </span>,
        );
      }
      nodes.push(
        <span
          key={`hl-${index}-${segment.start}`}
          className={`${segment.colorClass} rounded px-0.5`}
          title={segment.tooltip}
        >
          {value.slice(clampedStart, clampedEnd)}
        </span>,
      );
      cursor = clampedEnd;
    });
    if (cursor < value.length) {
      nodes.push(<span key={`tail-${cursor}`}>{value.slice(cursor)}</span>);
    }
    return nodes;
  };

  const handleHeaderClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isEventFromInteractive(event.target)) {
      return;
    }
    onToggle(!expanded);
  };

  const handleHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEventFromInteractive(event.target)) {
      return;
    }
    handleKeyboardToggle(event, () => onToggle(!expanded));
  };

  const containerClass = expanded
    ? "flex h-full flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm"
    : "flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm";
  const bodyClass = expanded
    ? "flex-1 overflow-y-auto whitespace-pre-wrap text-slate-700"
    : "max-h-80 overflow-y-auto whitespace-pre-wrap text-slate-700";

  return (
    <div className={containerClass}>
      <header className="flex items-start justify-between gap-3">
        <div
          className="flex flex-1 cursor-pointer flex-col gap-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKeyDown}
        >
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          {statusLabel ? (
            <p className="text-xs text-slate-500">{statusLabel}</p>
          ) : null}
          {timestamp ? (
            <p className="text-xs text-slate-400">
              업데이트: {new Date(timestamp).toLocaleString()}
            </p>
          ) : null}
        </div>
        <button
          className="flex items-center justify-center rounded px-2 py-1 text-slate-600 transition hover:text-slate-800 focus:outline-none"
          onClick={() => onToggle(!expanded)}
          aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          title={expanded ? `${title} 접기` : `${title} 펼치기`}
          data-collapsible-ignore
        >
          {expanded ? <OpenBookIcon /> : <ClosedBookIcon />}
        </button>
      </header>
      <div className={`${bodyClass} relative`}>
        <div className="pointer-events-none whitespace-pre-wrap text-slate-800">
          {draft ? (
            renderWithHighlights(displayText)
          ) : (
            <span className="text-slate-400">
              {placeholder ?? `${title} 자료가 아직 없습니다.`}
            </span>
          )}
          {draft && !expanded && truncated && "…"}
        </div>
        {editable ? (
          <textarea
            className="absolute inset-0 h-full w-full resize-none border-none bg-transparent text-transparent caret-slate-800 focus:outline-none"
            value={draft}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            placeholder={placeholder}
            spellCheck={false}
            style={{ color: "transparent" }}
          />
        ) : null}
      </div>
      {editable && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {status === "saving" && "저장 중…"}
            {status === "saved" && "저장되었습니다."}
            {status === "dirty" && "변경 사항이 자동 저장을 기다리고 있습니다."}
            {status === "error" && (errorMessage ?? "저장에 실패했습니다.")}
          </span>
          {dirty && status !== "saving" && status !== "error" && (
            <span>자동 저장 예정</span>
          )}
        </div>
      )}
    </div>
  );
};

interface UserMenuProps {
  avatarInitial: string | null;
  avatarTone: string;
  avatarPreview: string | null;
  userName: string | null;
  userEmail: string | null;
  onOpenTab: (tab: RightPanelExtraTab, label: string) => void;
  onLogout: () => void;
  advancedProofreadEnabled: boolean;
  onToggleAdvancedProofread: () => void;
}

const UserMenu = ({
  avatarInitial,
  avatarTone,
  avatarPreview,
  userName,
  userEmail,
  onOpenTab,
  onLogout,
  advancedProofreadEnabled,
  onToggleAdvancedProofread,
}: UserMenuProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [menuOpen]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        className={`ml-2 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${avatarPreview ? "bg-slate-200" : avatarTone}`}
        onClick={() => setMenuOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {avatarPreview ? (
          <img
            src={avatarPreview}
            alt={userName ?? "User avatar"}
            className="h-full w-full object-cover"
          />
        ) : (
          <span>{avatarInitial ?? "?"}</span>
        )}
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-3 w-56 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg"
        >
          <div className="mb-3 border-b border-slate-100 pb-2">
            <p className="text-xs uppercase text-slate-400">Signed in</p>
            <p className="font-semibold text-slate-700">
              {userName ?? "Current user"}
            </p>
            <p className="text-xs text-slate-500">
              {userEmail ?? "No email on file"}
            </p>
          </div>
          <div className="flex flex-col gap-1" role="none">
            {USER_MENU_ITEMS.map((item) => (
              <button
                key={item.key}
                className="rounded px-3 py-2 text-left text-slate-700 transition hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenTab(item.key, item.label);
                  setMenuOpen(false);
                }}
              >
                {item.label}
              </button>
            ))}
            <button
              className="rounded px-3 py-2 text-left text-slate-700 transition hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleAdvancedProofread();
                setMenuOpen(false);
              }}
            >
              {advancedProofreadEnabled ? 'Hide Advanced Proofread' : 'Advanced Proofread'}
            </button>
            <button
              className="rounded px-3 py-2 text-left text-rose-600 transition hover:bg-rose-50 focus:bg-rose-50 focus:outline-none"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onLogout();
              }}
            >
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const TranslationSummaryCard = ({
  projectKey,
  timestamp,
  expanded,
  onToggle,
  onSave,
}: {
  projectKey: string;
  timestamp?: string | null;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  onSave: (nextValue: string) => Promise<void>;
}) => {
  const { translationText, highlights } = useProofreadIssues();
  return (
    <SummaryCard
      key={`translation-${projectKey}`}
      title="Translation"
      summary={translationText.slice(0, 400)}
      fullText={translationText}
      timestamp={timestamp ?? null}
      expanded={expanded}
      onToggle={onToggle}
      editable
      onSave={onSave}
      autoSaveDelay={5000}
      placeholder="번역문을 입력해 주세요."
      highlights={highlights}
    />
  );
};

type SummaryStatus = "pending" | "running" | "done";

const DocumentSummaryCard = ({
  title,
  profile,
  isLoading = false,
  defaultOpen = true,
  status = "pending",
  fallbackSummary,
  fallbackMetrics,
  fallbackTimestamp,
  fallbackLanguage,
  fallbackVersion,
}: {
  title: string;
  profile: DocumentProfileSummary | null;
  isLoading?: boolean;
  defaultOpen?: boolean;
  status?: SummaryStatus;
  fallbackSummary?: {
    story?: string | null;
    intention?: string | null;
    readerPoints?: string[];
  } | null;
  fallbackMetrics?: {
    wordCount?: number | null;
    charCount?: number | null;
    paragraphCount?: number | null;
    readingTimeMinutes?: number | null;
    readingTimeLabel?: string | null;
  } | null;
  fallbackTimestamp?: string | null;
  fallbackLanguage?: string | null;
  fallbackVersion?: number | null;
}) => {
  const effectiveTimestamp =
    profile?.updatedAt ?? profile?.createdAt ?? fallbackTimestamp ?? null;
  const timestampLabel = effectiveTimestamp
    ? new Date(effectiveTimestamp).toLocaleString()
    : null;
  const summary =
    profile?.summary ??
    (fallbackSummary
      ? {
          story: fallbackSummary.story ?? "",
          intention: fallbackSummary.intention ?? "",
          readerPoints: fallbackSummary.readerPoints ?? [],
        }
      : null);
  const metrics = profile?.metrics ?? fallbackMetrics ?? null;
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const hasFallback = Boolean(fallbackSummary);
  const isToggleDisabled = !profile && !hasFallback && !isLoading;

  const formatMinutes = (value: number | undefined) => {
    if (value === undefined || Number.isNaN(value)) return null;
    return Math.max(1, Math.round(value)).toString();
  };

  const wordsLabel =
    metrics?.wordCount !== undefined && metrics?.wordCount !== null
      ? Number(metrics.wordCount).toLocaleString()
      : null;
  const charsLabel =
    metrics?.charCount !== undefined && metrics?.charCount !== null
      ? Number(metrics.charCount).toLocaleString()
      : null;
  const minutesLabel = formatMinutes(metrics?.readingTimeMinutes ?? undefined);

  const toggle = () => {
    if (!profile && !isLoading) return;
    setIsOpen((prev) => !prev);
  };

  const handleHeaderClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isToggleDisabled || isEventFromInteractive(event.target)) {
      return;
    }
    toggle();
  };

  const handleHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isToggleDisabled || isEventFromInteractive(event.target)) {
      return;
    }
    handleKeyboardToggle(event, toggle);
  };

  const headerClass = isToggleDisabled
    ? "flex flex-1 cursor-default flex-col gap-1 focus:outline-none"
    : "flex flex-1 cursor-pointer flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

  const renderFooter = () => {
    const parts = [
      wordsLabel ? `${wordsLabel} words` : null,
      charsLabel ? `${charsLabel} characters` : null,
      minutesLabel ? `${minutesLabel} mins` : null,
      timestampLabel ? `update: ${timestampLabel}` : null,
    ].filter(Boolean);
    if (!parts.length) return null;
    return <p className="mt-4 text-[11px] text-slate-400">{parts.join(" ")}</p>;
  };

  const statusIcon = () => {
    if (status === "running") {
      return (
        <Loader2
          className="h-4 w-4 animate-spin text-indigo-500"
          aria-hidden="true"
        />
      );
    }
    if (status === "done") {
      return (
        <CheckCircle2
          className="h-4 w-4 text-emerald-500"
          aria-hidden="true"
        />
      );
    }
    return <Circle className="h-4 w-4 text-slate-300" aria-hidden="true" />;
  };

  const statusDescription = (() => {
    if (profile) {
      return (
        <p className="text-xs text-slate-500">
          version v{profile.version}
          {profile.language ? `.${profile.language}` : ""}
        </p>
      );
    }
    if (fallbackSummary) {
      return (
        <p className="text-xs text-slate-500">
          임시 요약 제공
          {fallbackVersion ? ` · v${fallbackVersion}` : ""}
          {fallbackLanguage ? `.${fallbackLanguage}` : ""}
        </p>
      );
    }
    if (status === "running" || isLoading) {
      return (
        <p className="text-xs text-slate-500">분석 정보를 불러오는 중입니다…</p>
      );
    }
    return (
      <p className="text-xs text-slate-400">
        아직 분석 정보가 생성되지 않았습니다.
      </p>
    );
  })();

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div
          className={headerClass}
          role="button"
          tabIndex={isToggleDisabled ? -1 : 0}
          aria-expanded={isOpen}
          aria-disabled={isToggleDisabled}
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKeyDown}
        >
          <div className="flex items-center gap-2">
            {statusIcon()}
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          </div>
          {statusDescription}
        </div>
        <button
          type="button"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-xs text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
          onClick={toggle}
          aria-label={isOpen ? `${title} 접기` : `${title} 펼치기`}
          disabled={isToggleDisabled}
          data-collapsible-ignore
        >
          {isOpen ? "˄" : "˅"}
        </button>
      </header>
      {isOpen &&
        (summary ? (
          <>
            {summary.intention && (
              <div className="mt-4 text-sm text-slate-700">
                <span className="font-medium text-slate-800">작가의도:</span>{" "}
                <span className="whitespace-pre-wrap text-slate-600">
                  {summary.intention}
                </span>
              </div>
            )}
            {summary.story && (
              <div className="mt-3 text-sm text-slate-700">
                <span className="font-medium text-slate-800">줄거리:</span>{" "}
                <span className="whitespace-pre-wrap text-slate-600">
                  {summary.story}
                </span>
              </div>
            )}
        {summary.readerPoints?.length ? (
          <div className="mt-4 space-y-1 text-sm text-slate-700">
            <p className="font-medium text-slate-800">독자 포인트</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
              {summary.readerPoints.map((point, index) => (
                <li key={`${profile?.id ?? "fallback"}-point-${index}`}>
                  {point}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {renderFooter()}
      </>
    ) : status === "running" || isLoading ? (
          <p className="mt-4 text-sm text-slate-500">
            분석 정보를 불러오는 중입니다…
          </p>
        ) : (
          <p className="mt-4 text-sm text-slate-500">
            텍스트가 저장되면 자동으로 문서 요약이 생성됩니다.
          </p>
        ))}
    </section>
  );
};
const DocumentSummarySection = ({
  origin,
  translation,
  isLoading = false,
  onSaveTranslationNotes,
  translationNotesEditable = false,
  translationNotesSaving = false,
  translationNotesError = null,
  originStatus = "pending",
  translationStatus = "pending",
  translationFallback = null,
  originFallback = null,
}: {
  origin: DocumentProfileSummary | null;
  translation: DocumentProfileSummary | null;
  isLoading?: boolean;
  onSaveTranslationNotes?: (
    notes: DocumentProfileSummary["translationNotes"] | null,
  ) => Promise<void>;
  translationNotesEditable?: boolean;
  translationNotesSaving?: boolean;
  translationNotesError?: string | null;
  originStatus?: SummaryStatus;
  translationStatus?: SummaryStatus;
  translationFallback?: {
    summary: {
      story: string;
      intention: string | null;
      readerPoints: string[];
    };
    metrics: {
      wordCount: number;
      charCount: number;
      paragraphCount: number;
      readingTimeMinutes: number;
      readingTimeLabel: string;
    };
    timestamp: string | null;
    language: string | null;
  } | null;
  originFallback?: {
    summary: {
      story: string;
      intention: string | null;
      readerPoints: string[];
    };
    metrics: {
      wordCount: number;
      charCount: number;
      paragraphCount: number;
      readingTimeMinutes: number;
      readingTimeLabel: string;
    };
    timestamp: string | null;
    language: string | null;
  } | null;
}) => (
  <div className="space-y-4">
    <DocumentSummaryCard
      title="Origin summary"
      profile={origin}
      isLoading={isLoading && !origin}
      status={originStatus}
      fallbackSummary={originFallback?.summary}
      fallbackMetrics={originFallback?.metrics}
      fallbackTimestamp={originFallback?.timestamp ?? null}
      fallbackLanguage={originFallback?.language ?? null}
      fallbackVersion={originFallback ? 0 : null}
    />
    <TranslationNotesSection
      notes={origin?.translationNotes ?? null}
      editable={translationNotesEditable}
      onSave={onSaveTranslationNotes}
      isSaving={translationNotesSaving}
      error={translationNotesError}
    />
    <DocumentSummaryCard
      title="Translation summary"
      profile={translation}
      isLoading={isLoading && !translation}
      status={translationStatus}
      fallbackSummary={translationFallback?.summary}
      fallbackMetrics={translationFallback?.metrics}
      fallbackTimestamp={translationFallback?.timestamp ?? null}
      fallbackLanguage={translationFallback?.language ?? null}
      fallbackVersion={translationFallback ? 0 : null}
    />
  </div>
);

// Translation notes editor/display component definitions inserted here (see below).
type NotesCharacterDraft = {
  id: string;
  name: string;
  age: string;
  gender: string;
  traits: string;
};

type NotesEntityDraft = {
  id: string;
  name: string;
  frequency: string;
};

type TranslationNotesDraft = {
  timePeriod: string;
  characters: NotesCharacterDraft[];
  namedEntities: NotesEntityDraft[];
  locations: NotesEntityDraft[];
  measurementUnits: string;
  linguisticFeatures: string;
};

const createCharacterDraft = (): NotesCharacterDraft => ({
  id: `character-${Math.random().toString(36).slice(2, 10)}`,
  name: "",
  age: "",
  gender: "",
  traits: "",
});

const createEntityDraft = (prefix: string): NotesEntityDraft => ({
  id: `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
  name: "",
  frequency: "",
});

const notesToDraft = (
  notes: DocumentProfileSummary["translationNotes"] | null,
): TranslationNotesDraft => ({
  timePeriod: notes?.timePeriod ?? "",
  characters: (notes?.characters ?? []).map((character) => ({
    id: `character-${character.name}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    name: character.name,
    age: character.age ?? "",
    gender: character.gender ?? "",
    traits: (character.traits ?? []).join(", "),
  })),
  namedEntities: (notes?.namedEntities ?? []).map((entity) => ({
    id: `entity-${entity.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: entity.name,
    frequency: String(
      Number.isFinite(entity.frequency) ? entity.frequency : "",
    ),
  })),
  locations: (notes?.locations ?? []).map((location) => ({
    id: `location-${location.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: location.name,
    frequency: String(
      Number.isFinite(location.frequency) ? location.frequency : "",
    ),
  })),
  measurementUnits: (notes?.measurementUnits ?? []).join("\n"),
  linguisticFeatures: (notes?.linguisticFeatures ?? []).join("\n"),
});

const draftToNotes = (
  draft: TranslationNotesDraft,
): DocumentProfileSummary["translationNotes"] | null => {
  const sanitizeLines = (value: string) =>
    value
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const parseTraits = (value: string) =>
    value
      .split(/[,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const characters = draft.characters
    .map((character) => {
      const name = character.name.trim();
      if (!name) return null;
      return {
        name,
        age: character.age.trim() || null,
        gender: character.gender.trim() || null,
        traits: parseTraits(character.traits),
      };
    })
    .filter((character): character is NonNullable<typeof character> =>
      Boolean(character),
    );

  const parseEntities = (entities: NotesEntityDraft[]) =>
    entities
      .map((entity) => {
        const name = entity.name.trim();
        if (!name) return null;
        const parsedFrequency = Number.parseInt(entity.frequency.trim(), 10);
        return {
          name,
          frequency: Number.isFinite(parsedFrequency)
            ? Math.max(0, parsedFrequency)
            : 0,
        };
      })
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity));

  const namedEntities = parseEntities(draft.namedEntities);
  const locations = parseEntities(draft.locations);
  const measurementUnits = sanitizeLines(draft.measurementUnits);
  const linguisticFeatures = sanitizeLines(draft.linguisticFeatures);
  const timePeriod = draft.timePeriod.trim() || null;

  if (
    !characters.length &&
    !namedEntities.length &&
    !locations.length &&
    !measurementUnits.length &&
    !linguisticFeatures.length &&
    !timePeriod
  ) {
    return null;
  }

  return {
    characters,
    namedEntities,
    locations,
    measurementUnits,
    linguisticFeatures,
    timePeriod,
  };
};

const TranslationNotesSection = ({
  notes,
  editable = false,
  onSave,
  isSaving = false,
  error,
}: {
  notes: DocumentProfileSummary["translationNotes"] | null;
  editable?: boolean;
  onSave?: (
    next: DocumentProfileSummary["translationNotes"] | null,
  ) => Promise<void>;
  isSaving?: boolean;
  error?: string | null;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<TranslationNotesDraft>(() =>
    notesToDraft(notes),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    if (mode === "view") {
      setDraft(notesToDraft(notes));
      setFormError(null);
    }
  }, [notes, mode]);

  useEffect(() => {
    if (!editable) {
      setMode("view");
      setFormError(null);
    }
  }, [editable]);

  const handleEdit = () => {
    setDraft(notesToDraft(notes));
    setFormError(null);
    setIsOpen(true);
    setMode("edit");
  };

  const handleCancel = () => {
    setDraft(notesToDraft(notes));
    setFormError(null);
    setMode("view");
  };

  const handleSave = async () => {
    const payload = draftToNotes(draft);
    if (!onSave) {
      setMode("view");
      return;
    }
    try {
      await onSave(payload);
      setMode("view");
      setFormError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "저장에 실패했습니다.";
      setFormError(message);
    }
  };

  const handleClear = async () => {
    if (!onSave) return;
    try {
      await onSave(null);
      setDraft(notesToDraft(null));
      setMode("view");
      setFormError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "삭제에 실패했습니다.";
      setFormError(message);
    }
  };

  const hasNotes = Boolean(
    notes?.timePeriod ||
      (notes?.characters?.length ?? 0) > 0 ||
      (notes?.namedEntities?.length ?? 0) > 0 ||
      (notes?.locations?.length ?? 0) > 0 ||
      (notes?.measurementUnits?.length ?? 0) > 0 ||
      (notes?.linguisticFeatures?.length ?? 0) > 0,
  );

  const renderTagList = (items: string[]) => (
    <ul className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
      {items.map((item, index) => (
        <li
          key={`${item}-${index}`}
          className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700"
        >
          {item}
        </li>
      ))}
    </ul>
  );

  if (!editable && !hasNotes && mode === "view") {
    return null;
  }

  const handleToggle = () => {
    if (mode === "edit") return;
    setIsOpen((prev) => !prev);
  };

  const actionNode =
    editable && mode === "view"
      ? (
          <button
            type="button"
            className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
            onClick={handleEdit}
          >
            {hasNotes ? "Edit notes" : "Add notes"}
          </button>
        )
      : undefined;

  const editContent = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">
          Editing translation notes
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={handleClear}
            disabled={isSaving}
          >
            Clear all
          </button>
          <button
            type="button"
            className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={handleCancel}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-slate-800 px-3 py-1 text-xs font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Time period
          </label>
          <input
            value={draft.timePeriod}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                timePeriod: event.target.value,
              }))
            }
            className="w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
            placeholder="e.g., Late Joseon Dynasty"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Measurement units
          </label>
          <textarea
            value={draft.measurementUnits}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                measurementUnits: event.target.value,
              }))
            }
            className="h-24 w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
            placeholder="One unit per line"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Linguistic features / slang
          </label>
          <textarea
            value={draft.linguisticFeatures}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                linguisticFeatures: event.target.value,
              }))
            }
            className="h-24 w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
            placeholder="One entry per line"
          />
        </div>
      </div>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Characters
          </p>
          <button
            type="button"
            className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                characters: [...prev.characters, createCharacterDraft()],
              }))
            }
            disabled={isSaving}
          >
            Add character
          </button>
        </div>
        {draft.characters.length ? (
          <div className="space-y-3">
            {draft.characters.map((character, index) => (
              <div key={character.id} className="rounded border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-slate-600">
                    Character #{index + 1}
                  </p>
                  <button
                    type="button"
                    className="text-xs text-rose-500 transition hover:text-rose-600"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        characters: prev.characters.filter(
                          (entry) => entry.id !== character.id,
                        ),
                      }))
                    }
                    disabled={isSaving}
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      Name
                    </label>
                    <input
                      value={character.name}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? {
                                  ...entry,
                                  name: event.target.value,
                                }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder="Character name"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      Age
                    </label>
                    <input
                      value={character.age}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? {
                                  ...entry,
                                  age: event.target.value,
                                }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder="Age or descriptor"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      Gender
                    </label>
                    <input
                      value={character.gender}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? {
                                  ...entry,
                                  gender: event.target.value,
                                }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder="Gender or pronouns"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      Traits (comma-separated)
                    </label>
                    <input
                      value={character.traits}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? {
                                  ...entry,
                                  traits: event.target.value,
                                }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder="e.g., stubborn, loyal"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">No characters added yet.</p>
        )}
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        {[
          {
            label: "Named entities",
            items: draft.namedEntities,
            setter: (next: NotesEntityDraft[]) =>
              setDraft((prev) => ({ ...prev, namedEntities: next })),
            create: () => createEntityDraft("entity"),
          },
          {
            label: "Locations",
            items: draft.locations,
            setter: (next: NotesEntityDraft[]) =>
              setDraft((prev) => ({ ...prev, locations: next })),
            create: () => createEntityDraft("location"),
          },
        ].map(({ label, items, setter, create }) => (
          <div key={label} className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label}
              </p>
              <button
                type="button"
                className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
                onClick={() => setter([...items, create()])}
                disabled={isSaving}
              >
                Add
              </button>
            </div>
            {items.length ? (
              <div className="space-y-3">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded border border-slate-200 p-2"
                  >
                    <input
                      value={item.name}
                      onChange={(event) =>
                        setter(
                          items.map((entry) =>
                            entry.id === item.id
                              ? {
                                  ...entry,
                                  name: event.target.value,
                                }
                              : entry,
                          ),
                        )
                      }
                      className="flex-1 rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder="Name"
                    />
                    <input
                      value={item.frequency}
                      onChange={(event) =>
                        setter(
                          items.map((entry) =>
                            entry.id === item.id
                              ? {
                                  ...entry,
                                  frequency: event.target.value,
                                }
                              : entry,
                          ),
                        )
                      }
                      className="w-24 rounded border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder="Freq"
                    />
                    <button
                      type="button"
                      className="text-xs text-rose-500 transition hover:text-rose-600"
                      onClick={() => setter(items.filter((entry) => entry.id !== item.id))}
                      disabled={isSaving}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No entries yet.</p>
            )}
          </div>
        ))}
      </section>
    </div>
  );

  const viewContent = hasNotes ? (
    <div className="space-y-4 text-sm text-slate-700">
      {notes?.timePeriod ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Time period
          </p>
          <p className="mt-1 text-slate-700">{notes.timePeriod}</p>
        </div>
      ) : null}
      {notes?.characters?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Characters
          </p>
          <ul className="mt-2 space-y-2 text-slate-700">
            {notes.characters.map((character) => {
              const details: string[] = [];
              if (character.age) details.push(character.age);
              if (character.gender) details.push(character.gender);
              if (character.traits?.length)
                details.push(character.traits.join(", "));
              return (
                <li key={character.name}>
                  <span className="font-medium text-slate-800">
                    {character.name}
                  </span>
                  {details.length ? (
                    <span className="text-slate-600">
                      {" "}— {details.join(" · ")}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {notes?.namedEntities?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Named entities
          </p>
          <ul className="mt-2 grid gap-1 text-slate-700 sm:grid-cols-2">
            {notes.namedEntities.map((entity) => (
              <li key={`${entity.name}-${entity.frequency}`}>
                <span className="font-medium text-slate-800">
                  {entity.name}
                </span>
                {Number.isFinite(entity.frequency) && entity.frequency > 0 ? (
                  <span className="text-slate-500"> · {entity.frequency}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes?.locations?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Locations
          </p>
          <ul className="mt-2 grid gap-1 text-slate-700 sm:grid-cols-2">
            {notes.locations.map((location) => (
              <li key={`${location.name}-${location.frequency}`}>
                <span className="font-medium text-slate-800">
                  {location.name}
                </span>
                {Number.isFinite(location.frequency) &&
                location.frequency > 0 ? (
                  <span className="text-slate-500">
                    {" "}· {location.frequency}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes?.measurementUnits?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Measurement units
          </p>
          {renderTagList(notes.measurementUnits)}
        </div>
      ) : null}
      {notes?.linguisticFeatures?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Linguistic features
          </p>
          {renderTagList(notes.linguisticFeatures)}
        </div>
      ) : null}
    </div>
  ) : editable ? (
    <p className="text-xs text-slate-500">
      Translation notes have not been documented yet. Click “Add notes” to
      capture key characters, entities, and terminology before synthesis.
    </p>
  ) : null;

  return (
    <Collapsible
      title="Translation notes"
      isOpen={mode === "edit" ? true : isOpen}
      onToggle={handleToggle}
      keepMounted
      action={actionNode}
    >
      {mode === "edit" ? editContent : viewContent}
      {(formError || error) && (
        <p className="text-xs text-rose-500">
          {formError || error || ""}
        </p>
      )}
    </Collapsible>
  );
};

const iconClass = "h-5 w-5";

const OpenBookIcon = () => (
  <svg
    className={iconClass}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 5c-1.8-1.2-4.1-1.7-7-1.7v13.4c2.9 0 5.2.5 7 1.7 1.8-1.2 4.1-1.7 7-1.7V3.3C16.1 3.3 13.8 3.8 12 5Z" />
    <path d="M12 5v13.4" />
  </svg>
);

const ClosedBookIcon = () => (
  <svg
    className={iconClass}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6.5 4h9.5a2 2 0 0 1 2 2v12h-8.5a2 2 0 0 0-2 2V6a2 2 0 0 1 1-1.732" />
    <path d="M7.5 4.5a2 2 0 0 0-2 2V22" />
  </svg>
);

const Collapsible = ({
  title,
  caption,
  isOpen,
  onToggle,
  children,
  action,
  showDivider = true,
  keepMounted = false,
}: {
  title: string;
  caption?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  action?: ReactNode;
  showDivider?: boolean;
  keepMounted?: boolean;
}) => {
  const handleHeaderClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isEventFromInteractive(event.target)) {
      return;
    }
    onToggle();
  };

  const handleHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEventFromInteractive(event.target)) {
      return;
    }
    handleKeyboardToggle(event, onToggle);
  };

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div
          className="flex flex-1 cursor-pointer flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKeyDown}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
            {action ? <span data-collapsible-ignore>{action}</span> : null}
          </div>
          {caption && <p className="text-xs text-slate-500">{caption}</p>}
        </div>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-xs text-slate-500 transition hover:bg-slate-100"
          onClick={onToggle}
          aria-label={isOpen ? `${title} 접기` : `${title} 펼치기`}
          data-collapsible-ignore
        >
          {isOpen ? "˄" : "˅"}
        </button>
      </header>
      {keepMounted ? (
        <div
          className={
            isOpen
              ? showDivider
                ? "mt-4 border-t border-slate-200 pt-4"
                : "mt-0 pt-0"
              : "hidden"
          }
        >
          {children}
        </div>
      ) : (
        isOpen && (
          <div
            className={
              showDivider ? "mt-4 border-t border-slate-200 pt-4" : "mt-0 pt-0"
            }
          >
            {children}
          </div>
        )
      )}
    </section>
  );
};

export const RightPanel = ({
  content,
  isContentLoading,
  jobs: jobsProp = [],
  isJobsLoading = false,
  onProfileUpdated,
  onRefreshContent,
}: RightPanelProps) => {
  const queryClient = useQueryClient();
  const activeTab = useUIStore((state) => state.rightPanelTab);
  const setTab = useUIStore((state) => state.setRightPanelTab);
  const extraTab = useUIStore((state) => state.extraTab);
  const openExtraTab = useUIStore((state) => state.openExtraTab);
  const clearExtraTab = useUIStore((state) => state.clearExtraTab);
  const previewExpanded = useUIStore((state) => state.previewExpanded);
  const setPreviewExpanded = useUIStore((state) => state.setPreviewExpanded);
  const qualityDialogOpen = useUIStore((state) => state.qualityDialogOpen);
  const closeQualityDialog = useUIStore((state) => state.closeQualityDialog);
  const advancedProofreadEnabled = useUIStore(
    (state) => state.advancedProofreadEnabled,
  );
  const setAdvancedProofreadEnabled = useUIStore(
    (state) => state.setAdvancedProofreadEnabled,
  );
  const toggleAdvancedProofread = useUIStore(
    (state) => state.toggleAdvancedProofread,
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileControls, setProfileControls] = useState<{
    isEditing: boolean;
    startEdit: () => void;
  } | null>(null);
  const previousProofStageRef = useRef<string | null>(null);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const { logout } = useAuth();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const previousProjectRef = useRef<string | null>(activeProjectId ?? null);
  const { locale, setLocale } = useUILocale();
  const projectJobs = useMemo<JobSummary[]>(
    () => (Array.isArray(jobsProp) ? jobsProp : []),
    [jobsProp],
  );

  const localize = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const resolved = translate(key, locale, params);
      if (resolved === key) {
        return applyParams(fallback, params);
      }
      return resolved;
    },
    [locale],
  );

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFileName, setAvatarFileName] = useState<string | null>(null);
  const [careerSummary, setCareerSummary] = useState("");
  const [careerSavedAt, setCareerSavedAt] = useState<string | null>(null);
  const [settingsState, setSettingsState] = useState({
    emailUpdates: true,
    pushNotifications: false,
    locale: locale,
    tokenAlerts: true,
    theme: "system" as "system" | "light" | "dark",
  });
  const [settingsSavedAt, setSettingsSavedAt] = useState<string | null>(null);
  const [isSavingTranslationNotes, setSavingTranslationNotes] = useState(false);
  const [translationNotesError, setTranslationNotesError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setTranslationNotesError(null);
    setSavingTranslationNotes(false);
  }, [activeProjectId]);

  const projectSummary = useMemo(
    () =>
      projects.find((project) => project.project_id === activeProjectId) ??
      null,
    [projects, activeProjectId],
  );

  const appliedTranslation = content?.proofreading?.appliedTranslation ?? null;

  const originFilename = useMemo(() => {
    const originMeta = content?.content?.origin;
    if (!originMeta) return undefined;
    if (
      typeof originMeta.filename === "string" &&
      originMeta.filename.length > 0
    ) {
      return originMeta.filename;
    }
    const legacy = originMeta as { original_filename?: string | null };
    if (
      typeof legacy.original_filename === "string" &&
      legacy.original_filename.length > 0
    ) {
      return legacy.original_filename;
    }
    return undefined;
  }, [content]);

  const translationJobId = useMemo(() => {
    const translationMeta = content?.content?.translation;
    if (translationMeta?.jobId) return translationMeta.jobId;
    if ((translationMeta as { job_id?: string | null } | undefined)?.job_id) {
      return (translationMeta as { job_id?: string | null }).job_id ?? null;
    }
    return content?.latestJob?.jobId ?? null;
  }, [content]);

  const translationAgentState = useWorkflowStore((state) => state.translation);
  const proofreadingAgentState = useWorkflowStore((state) => state.proofreading);

  const resolvedTabs = useMemo<Array<{ key: RightPanelBaseTab; label: string }>>(
    () => {
      const tabs: Array<{ key: RightPanelBaseTab; label: string }> = [
        { key: 'preview', label: 'Overview' },
        { key: 'proofread:editing', label: 'Editor' },
      ];
      if (advancedProofreadEnabled) {
        tabs.push({ key: 'proofread:findings', label: 'Finder' });
      }
      tabs.push({ key: 'export', label: 'eBook' });
      return tabs;
    },
    [advancedProofreadEnabled],
  );

  const prevAdvancedRef = useRef(advancedProofreadEnabled);

  useEffect(() => {
    if (!prevAdvancedRef.current && advancedProofreadEnabled) {
      setTab('proofread:findings');
    } else if (
      prevAdvancedRef.current &&
      !advancedProofreadEnabled &&
      activeTab === 'proofread:findings'
    ) {
      setTab('proofread:editing');
    }
    prevAdvancedRef.current = advancedProofreadEnabled;
  }, [advancedProofreadEnabled, activeTab, setTab]);

  const handleAdvancedProofreadToggle = useCallback(() => {
    toggleAdvancedProofread();
  }, [toggleAdvancedProofread]);


  const originProfile = content?.documentProfiles?.origin ?? null;
  const translationProfile = content?.documentProfiles?.translation ?? null;
  const originContentAvailable = Boolean(
    content?.content?.origin?.content?.trim().length,
  );
  const translationContentFromBatches = useMemo(() => {
    const batches = content?.content?.batchesActualData;
    if (!Array.isArray(batches) || !batches.length) return null;
    const fragments = batches
      .map((batch) => {
        if (!batch) return "";
        const candidate =
          (batch as { translated_text?: unknown; translatedText?: unknown })
            .translated_text ??
          (batch as { translated_text?: unknown; translatedText?: unknown })
            .translatedText ??
          null;
        return typeof candidate === "string" ? candidate.trim() : "";
      })
      .filter((fragment) => fragment.length > 0);
    if (!fragments.length) return null;
    return fragments.join("\n\n");
  }, [content?.content?.batchesActualData]);

  const translationText = useMemo(() => {
    const translationMeta = content?.content?.translation;
    const primary = translationMeta?.content;
    if (typeof primary === "string" && primary.length > 0) {
      return primary;
    }
    if (typeof appliedTranslation === "string" && appliedTranslation.length > 0) {
      return appliedTranslation;
    }
    if (typeof translationContentFromBatches === "string") {
      return translationContentFromBatches;
    }
    return "";
  }, [content, appliedTranslation, translationContentFromBatches]);
  const translationContentAvailable = Boolean(
    content?.content?.translation?.content?.trim().length ||
      translationContentFromBatches?.trim().length ||
      appliedTranslation?.trim?.().length,
  );

  const originFallback = useMemo(() => {
    if (originProfile || !originContentAvailable) return null;
    const raw = content?.content?.origin?.content ?? "";
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const preview = paragraphs.length
      ? paragraphs.slice(0, 2).join("\n\n")
      : trimmed.slice(0, 600);
    const previewLimited =
      preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const charCount = trimmed.length;
    const paragraphCount = paragraphs.length || 1;
    const readingTimeMinutes = Number((wordCount / 220).toFixed(2));

    return {
      summary: {
        story: previewLimited,
        intention: null,
        readerPoints: [] as string[],
      },
      metrics: {
        wordCount,
        charCount,
        paragraphCount,
        readingTimeMinutes,
        readingTimeLabel: "",
      },
      timestamp: content?.content?.origin?.timestamp ?? null,
      language:
        content?.content?.origin?.language ??
        (content?.content?.origin as { lang?: string } | undefined)?.lang ??
        null,
    };
  }, [content?.content?.origin, originContentAvailable, originProfile]);

  const originSummaryStatus: SummaryStatus = originProfile
    ? "done"
    : originContentAvailable
      ? "done"
      : "pending";

  const translationSummaryStatus: SummaryStatus = translationProfile
    ? "done"
    : translationAgentState.status === "running" ||
        translationAgentState.status === "queued"
      ? "running"
      : translationAgentState.status === "failed"
        ? "pending"
        : translationContentAvailable
          ? "done"
          : "pending";
  const originLangLabel =
    projectSummary?.origin_lang ??
    content?.projectProfile?.originLang ??
    (content?.content?.origin as { lang?: string } | undefined)?.lang ??
    null;
  const targetLangLabel =
    projectSummary?.target_lang ??
    content?.projectProfile?.targetLang ??
    (content?.content?.translation as { lang?: string } | undefined)?.lang ??
    null;

  const translationFallback = useMemo(() => {
    if (translationProfile) return null;
    const primary = content?.content?.translation?.content ?? "";
    const source =
      appliedTranslation && appliedTranslation.trim().length
        ? appliedTranslation
        : primary.trim().length
          ? primary
          : translationContentFromBatches ?? "";
    const trimmed = source.trim();
    if (!trimmed) return null;
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const preview = paragraphs.length
      ? paragraphs.slice(0, 2).join("\n\n")
      : trimmed.slice(0, 600);
    const previewLimited =
      preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const charCount = trimmed.length;
    const paragraphCount = paragraphs.length || 1;
    const readingTimeMinutes = Number((wordCount / 220).toFixed(2));

    return {
      summary: {
        story: previewLimited,
        intention: null,
        readerPoints: [] as string[],
      },
      metrics: {
        wordCount,
        charCount,
        paragraphCount,
        readingTimeMinutes,
        readingTimeLabel: "",
      },
      timestamp:
        content?.content?.translation?.timestamp ??
        content?.proofreading?.updatedAt ??
        null,
      language:
        content?.content?.translation?.language ??
        (content?.content?.translation as { lang?: string } | undefined)?.lang ??
        null,
    };
  }, [
    content?.content?.translation,
    content?.proofreading?.updatedAt,
    translationContentFromBatches,
    translationProfile,
  ]);

  const serverProofreadingStage = useMemo(() => {
    const proofMeta = content?.proofreading;
    return (
      content?.proofreadingStage ??
      proofMeta?.stage ??
      (proofMeta as { status?: string | null } | null)?.status ??
      null
    );
  }, [content]);

  const translationRefreshAttemptsRef = useRef(0);

  useEffect(() => {
    if (translationSummaryStatus !== "done") {
      translationRefreshAttemptsRef.current = 0;
      return;
    }
    const hasText =
      Boolean(translationContentAvailable) ||
      Boolean(translationFallback);
    if (hasText || !onRefreshContent) {
      translationRefreshAttemptsRef.current = 0;
      return;
    }
    if (translationRefreshAttemptsRef.current >= 6) {
      return;
    }
    translationRefreshAttemptsRef.current += 1;
    const delay = 1000 * translationRefreshAttemptsRef.current;
    const timeoutId = window.setTimeout(() => {
      void onRefreshContent();
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [
    translationSummaryStatus,
    translationContentAvailable,
    translationFallback,
    onRefreshContent,
  ]);

  const handleRefreshContent = useCallback(async () => {
    if (onRefreshContent) {
      await onRefreshContent();
    }
  }, [onRefreshContent]);

  const shouldPollProofreading = useMemo(() => {
    const normalized = serverProofreadingStage?.toString().toLowerCase() ?? "";
    if (!normalized) return false;
    return ["running", "queued", "in-progress", "inprogress"].some((state) =>
      normalized.includes(state),
    );
  }, [serverProofreadingStage]);

  useEffect(() => {
    if (typeof window === "undefined" || !shouldPollProofreading)
      return undefined;

    const intervalId = window.setInterval(() => {
      void handleRefreshContent();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [shouldPollProofreading, handleRefreshContent]);

  useEffect(() => {
    const previous = previousProofStageRef.current?.toLowerCase() ?? null;
    const current = serverProofreadingStage?.toString().toLowerCase() ?? null;
    previousProofStageRef.current = serverProofreadingStage ?? null;

    const isCompleted = current
      ? ["done", "completed", "complete", "finished"].some((state) =>
          current.includes(state),
        )
      : false;
    const wasCompleted = previous
      ? ["done", "completed", "complete", "finished"].some((state) =>
          previous.includes(state),
        )
      : false;

    if (isCompleted && !wasCompleted) {
      void handleRefreshContent();
    }
  }, [serverProofreadingStage, handleRefreshContent]);

  const handleSaveOrigin = useCallback(
    async (nextValue: string) => {
      if (!token || !activeProjectId) {
        throw new Error("로그인 상태를 확인해 주세요.");
      }
      const response = await api.saveOrigin(token, activeProjectId, {
        content: nextValue,
        filename: originFilename,
      });
      queryClient.setQueryData<ProjectContent | null>(
        projectKeys.content(activeProjectId),
        (previous) => {
          if (!previous) return previous;
          const originPayload =
            (response as { origin?: { content?: string; updated_at?: string; filename?: string | null } }).origin ??
            null;
          const updatedContent = originPayload?.content ?? nextValue;
          const updatedTimestamp =
            originPayload?.updated_at ?? new Date().toISOString();
          const updatedFilename = originPayload?.filename ?? null;

          const previousContent = previous.content ?? {};
          const nextContent = {
            ...previousContent,
            origin: {
              ...(previousContent.origin ?? {}),
              content: updatedContent,
              timestamp: updatedTimestamp,
              filename:
                updatedFilename ?? previousContent.origin?.filename ?? null,
            },
          };

          return {
            ...previous,
            content: nextContent,
          } as ProjectContent;
        },
      );
      await handleRefreshContent();
    },
    [
      token,
      activeProjectId,
      originFilename,
      handleRefreshContent,
      queryClient,
    ],
  );

  const handleSaveTranslation = useCallback(
    async (nextValue: string) => {
      if (!token || !activeProjectId) {
        throw new Error("로그인 상태를 확인해 주세요.");
      }
      if (!nextValue.trim().length) {
        return;
      }
      await api.saveTranslation(token, activeProjectId, {
        content: nextValue,
        jobId: translationJobId ?? undefined,
      });
      await handleRefreshContent();
    },
    [token, activeProjectId, translationJobId, handleRefreshContent],
  );

  const handleSaveTranslationNotes = useCallback(
    async (nextNotes: DocumentProfileSummary["translationNotes"] | null) => {
      if (!token || !activeProjectId) {
        throw new Error("로그인 상태를 확인해 주세요.");
      }
      setTranslationNotesError(null);
      setSavingTranslationNotes(true);
      try {
        await api.updateTranslationNotes(token, activeProjectId, {
          translationNotes: nextNotes,
        });
        await handleRefreshContent();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "번역 노트를 저장하지 못했습니다.";
        setTranslationNotesError(message);
        throw err;
      } finally {
        setSavingTranslationNotes(false);
      }
    },
    [token, activeProjectId, handleRefreshContent],
  );

  const avatarInitial =
    user?.name?.trim()?.charAt(0)?.toUpperCase() ??
    projectSummary?.title?.trim()?.charAt(0)?.toUpperCase() ??
    null;
  const avatarTone = useMemo(() => {
    const seed = user?.id ?? projectSummary?.project_id ?? null;
    if (!seed) return "bg-indigo-500";
    const palette = [
      "bg-indigo-500",
      "bg-emerald-500",
      "bg-amber-500",
      "bg-rose-500",
      "bg-slate-600",
    ];
    const hash = seed
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return palette[hash % palette.length];
  }, [user?.id, projectSummary?.project_id]);
  const activityEntries = useMemo(() => {
    type ActivityEntry = { timestamp: string; label: string };
    const entries: ActivityEntry[] = [];
    const pushEntry = (timestamp?: string | null, label?: string) => {
      if (!timestamp || !label) return;
      const parsed = new Date(timestamp);
      if (Number.isNaN(parsed.getTime())) return;
      entries.push({ timestamp: parsed.toISOString(), label });
    };

    pushEntry(projectSummary?.created_at ?? null, "Project created");
    pushEntry(projectSummary?.updated_at ?? null, "Project updated");

    if (content?.content?.origin?.timestamp) {
      pushEntry(content.content.origin.timestamp, "Origin manuscript uploaded");
    }
    if (content?.content?.translation?.timestamp) {
      pushEntry(content.content.translation.timestamp, "Translation compiled");
    }
    if (content?.latestJob?.createdAt) {
      pushEntry(
        content.latestJob.createdAt,
        `Job ${content.latestJob.jobId} created`,
      );
    }
    if (content?.latestJob?.updatedAt) {
      pushEntry(
        content.latestJob.updatedAt,
        `Job ${content.latestJob.jobId} ${content.latestJob.status.toLowerCase()}`,
      );
    }
    if (content?.qualityAssessment?.timestamp) {
      pushEntry(
        content.qualityAssessment.timestamp,
        "Quality assessment completed",
      );
    }
    if (content?.proofreading?.timestamp) {
      pushEntry(
        content.proofreading.timestamp,
        content.proofreading.applied
          ? "Proofreading applied to translation"
          : "Proofreading results available",
      );
    }

    content?.content?.batchesMetadata?.forEach((batch) => {
      pushEntry(
        batch.startedAt,
        `Batch #${batch.index + 1} processing started`,
      );
      pushEntry(
        batch.finishedAt,
        `Batch #${batch.index + 1} processing finished`,
      );
    });

    projectJobs.forEach((job) => {
      pushEntry(
        job.created_at ?? null,
        `${job.type === "translate" ? "Translation" : "Analysis"} job ${job.id} queued`,
      );
      const sequentialStatus = formatSequentialStageStatus(job, localize);
      const statusLabel = sequentialStatus
        ? sequentialStatus
        : `Job ${job.id} status updated to ${job.status}`;
      pushEntry(job.updated_at ?? null, statusLabel);
      const completionLabel = (() => {
        if (job.status === "failed") {
          return `Job ${job.id} 실패`;
        }
        if (job.status === "cancelled") {
          return `Job ${job.id} 취소됨`;
        }
        if (job.sequential && job.sequential.totalSegments) {
          return `Job ${job.id} 완료`;
        }
        return `Job ${job.id} completed`;
      })();
      pushEntry(job.finished_at ?? null, completionLabel);
      job.batches?.forEach((batch) => {
        pushEntry(
          batch.started_at ?? null,
          `Job ${job.id} · batch ${batch.batch_index + 1} started`,
        );
        pushEntry(
          batch.finished_at ?? null,
          `Job ${job.id} · batch ${batch.batch_index + 1} finished`,
        );
      });
    });

    return entries
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, 50);
  }, [projectSummary, content, projectJobs]);

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setAvatarFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAvatarPreview(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCareerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCareerSavedAt(new Date().toISOString());
  };

  const handleSettingsToggle = (
    key: "emailUpdates" | "pushNotifications" | "tokenAlerts",
  ) => {
    setSettingsState((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSettingsSelect = <K extends "locale" | "theme">(
    key: K,
    value: (typeof settingsState)[K],
  ) => {
    setSettingsState((prev) => ({ ...prev, [key]: value }));
    if (key === "locale") {
      setLocale(value as typeof settingsState.locale);
    }
  };

  const handleSettingsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSettingsSavedAt(new Date().toISOString());
  };

  useEffect(() => {
    setSettingsState((prev) =>
      prev.locale === locale ? prev : { ...prev, locale },
    );
  }, [locale]);

  useEffect(() => {
    if (
      previousProjectRef.current &&
      previousProjectRef.current !== activeProjectId
    ) {
      clearExtraTab();
      setTab("preview");
    }
    previousProjectRef.current = activeProjectId ?? null;
  }, [activeProjectId, clearExtraTab, setTab]);

  if (!content) {
    return (
      <div className="flex h-full flex-col gap-4 bg-white px-4 py-6 text-slate-800">
        <div>
          <h3 className="text-xl font-semibold text-slate-900">
            {translate("rightpanel_empty_title", locale)}
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {translate("rightpanel_empty_subtitle", locale)}
          </p>
        </div>
        <ol className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
          <li>{translate("rightpanel_empty_step_upload", locale)}</li>
          <li>{translate("rightpanel_empty_step_chat", locale)}</li>
          <li>{translate("rightpanel_empty_step_tour", locale)}</li>
        </ol>
      </div>
    );
  }

  return (
    <ProofreadIssuesProvider
      token={token ?? undefined}
      content={content ?? null}
      translationText={translationText}
      refreshContent={handleRefreshContent}
      projectId={content?.projectId ?? activeProjectId ?? null}
    >
      <div className="flex h-full flex-col">
        <div className="relative flex items-center justify-between border-b border-slate-200 px-2">
          <div className="flex flex-1 items-stretch">
            {resolvedTabs.map((tab) => {
              const isActive = activeTab === tab.key;
              const isAdvancedTab = tab.key === 'proofread:findings';
              return (
                <button
                  key={tab.key}
                  className={`flex-1 px-4 py-2 text-sm font-medium ${
                    isActive
                      ? 'border-b-2 border-indigo-500 text-indigo-600'
                      : 'text-slate-500'
                  }`}
                  onClick={() => setTab(tab.key)}
                >
                  <span className="flex items-center justify-center gap-2">
                    {tab.label}
                    {isAdvancedTab ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Close advanced proofread"
                        className="inline-flex h-4 w-4 items-center justify-center rounded text-xs text-slate-400 transition hover:bg-slate-200 hover:text-slate-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
                        onClick={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          setAdvancedProofreadEnabled(false);
                          setTab('proofread:editing');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.stopPropagation();
                            event.preventDefault();
                            setAdvancedProofreadEnabled(false);
                            setTab('proofread:editing');
                          }
                        }}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {extraTab && (
              <button
                key={extraTab.key}
                className={`ml-2 px-4 py-2 text-sm font-medium ${
                  activeTab === extraTab.key
                    ? "border-b-2 border-indigo-500 text-indigo-600"
                    : "text-slate-500"
                }`}
                onClick={() => setTab(extraTab.key)}
              >
                {extraTab.label}
              </button>
            )}
          </div>
          <UserMenu
            avatarInitial={avatarInitial}
            avatarTone={avatarTone}
            avatarPreview={avatarPreview}
            userName={user?.name ?? null}
            userEmail={user?.email ?? null}
            onOpenTab={(tabKey, label) => openExtraTab({ key: tabKey, label })}
            onLogout={logout}
            advancedProofreadEnabled={advancedProofreadEnabled}
            onToggleAdvancedProofread={handleAdvancedProofreadToggle}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {activeTab === "preview" && (
            <div className="flex h-full flex-col p-4">
              <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <header className="mb-3 flex flex-col gap-1">
                    <h2 className="text-base font-semibold text-slate-800">
                      {projectSummary?.title ?? "Untitled project"}
                    </h2>
                    <p className="text-xs text-slate-500">
                      {originLangLabel && targetLangLabel
                        ? `${originLangLabel} → ${targetLangLabel}`
                        : originLangLabel || targetLangLabel || "언어 정보 없음"}
                    </p>
                    {projectSummary?.updated_at && (
                      <p className="text-xs text-slate-400">
                        {new Date(projectSummary.updated_at).toLocaleString()}
                      </p>
                    )}
                  </header>
                  <TranslationCanvas
                    content={content}
                    isLoading={isContentLoading}
                  />
                </section>
                <Collapsible
                  title="Profile"
                  isOpen={profileOpen}
                  onToggle={() => setProfileOpen((prev) => !prev)}
                  showDivider={false}
                  keepMounted
                  action={
                    profileControls && !profileControls.isEditing ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!profileOpen) {
                            setProfileOpen(true);
                          }
                          profileControls.startEdit();
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:text-slate-700"
                        aria-label="Edit profile"
                        title="Edit profile"
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                    ) : null
                  }
                >
                  <ProjectProfileCard
                    content={content}
                    onUpdated={onProfileUpdated}
                    onActionReady={setProfileControls}
                  />
                </Collapsible>
              </div>
              <div className="mt-4 space-y-4">
                <DocumentSummarySection
                  origin={originProfile}
                  translation={translationProfile}
                  isLoading={Boolean(isContentLoading)}
                  originStatus={originSummaryStatus}
                  translationStatus={translationSummaryStatus}
                  translationFallback={translationFallback}
                  originFallback={originFallback}
                  onSaveTranslationNotes={handleSaveTranslationNotes}
                  translationNotesEditable={Boolean(
                    token && activeProjectId && originProfile,
                  )}
                  translationNotesSaving={isSavingTranslationNotes}
                  translationNotesError={translationNotesError}
                />
                <div className="grid gap-4 md:grid-cols-2">
                  <SummaryCard
                    key={`origin-${content?.projectId ?? activeProjectId ?? "unknown"}`}
                    title="Origin"
                    summary={
                      content?.content?.origin?.content?.slice(0, 400) ?? ""
                    }
                    fullText={content?.content?.origin?.content ?? ""}
                    timestamp={content?.content?.origin?.timestamp ?? null}
                    expanded={previewExpanded.origin}
                    onToggle={(expanded) =>
                      setPreviewExpanded("origin", expanded)
                    }
                    editable
                    onSave={handleSaveOrigin}
                    autoSaveDelay={5000}
                    placeholder="원문을 입력해 주세요."
                  />
                  <TranslationSummaryCard
                    projectKey={
                      content?.projectId ?? activeProjectId ?? "unknown"
                    }
                    timestamp={content?.content?.translation?.timestamp ?? null}
                    expanded={previewExpanded.translation}
                    onToggle={(expanded) =>
                      setPreviewExpanded("translation", expanded)
                    }
                    onSave={handleSaveTranslation}
                  />
                </div>
              </div>
            </div>
          )}
          {activeTab === "proofread:findings" && (
            <ProofList agentState={proofreadingAgentState} />
          )}
          {activeTab === "proofread:editing" && (
            <ProofreadEditorProvider
              token={token ?? null}
              projectId={content?.projectId ?? activeProjectId ?? null}
              jobId={
                content?.proofreading?.jobId ??
                content?.content?.translation?.jobId ??
                content?.latestJob?.jobId ??
                null
              }
              translationFileId={null}
            >
              <ProofreadEditorTab />
            </ProofreadEditorProvider>
          )}
          {activeTab === "export" && <ExportPanel content={content} />}
          {activeTab === "profile" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  Account overview
                </h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">Name</dt>
                    <dd className="font-medium text-slate-800">
                      {user?.name ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">Email</dt>
                    <dd className="font-medium text-slate-800">
                      {user?.email ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">Plan</dt>
                    <dd className="font-medium text-slate-800">
                      Studio (beta)
                    </dd>
                  </div>
                  {projectSummary?.created_at && (
                    <div className="flex items-center justify-between">
                      <dt className="text-slate-500">Project since</dt>
                      <dd className="font-medium text-slate-800">
                        {new Date(projectSummary.created_at).toLocaleString()}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  Avatar
                </h3>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-lg font-semibold text-slate-600">
                    {avatarPreview ? (
                      <img
                        src={avatarPreview}
                        alt="Avatar preview"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span>{avatarInitial ?? "?"}</span>
                    )}
                  </div>
                  <div className="space-y-2 text-xs text-slate-500">
                    <p>
                      PNG or JPG up to 1 MB. Stored locally until profile sync
                      is available.
                    </p>
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
                      Upload
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        className="hidden"
                        onChange={handleAvatarChange}
                      />
                    </label>
                    {avatarFileName && (
                      <p className="text-xs text-slate-500">
                        Selected: {avatarFileName}
                      </p>
                    )}
                  </div>
                </div>
              </section>
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <form onSubmit={handleCareerSubmit} className="space-y-3">
                  <header className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-slate-800">
                        Career update
                      </h3>
                      <p className="text-xs text-slate-500">
                        Share recent publications or achievements to help
                        reviewers understand context.
                      </p>
                    </div>
                    <button
                      type="submit"
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                    >
                      Save note
                    </button>
                  </header>
                  <textarea
                    value={careerSummary}
                    onChange={(event) => setCareerSummary(event.target.value)}
                    className="h-32 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="Example: 2024 Sejong Literary Award finalist; specializing in speculative fiction translation."
                  />
                  {careerSavedAt && (
                    <p className="text-xs text-emerald-600">
                      Saved locally{" "}
                      {new Date(careerSavedAt).toLocaleTimeString()}.
                    </p>
                  )}
                </form>
              </section>
            </div>
          )}
          {activeTab === "settings" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <form onSubmit={handleSettingsSubmit} className="space-y-4">
                  <header className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-slate-800">
                        Workspace settings
                      </h3>
                      <p className="text-xs text-slate-500">
                        Adjust notification preferences and defaults for this
                        session.
                      </p>
                    </div>
                    <button
                      type="submit"
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                    >
                      Save settings
                    </button>
                  </header>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">
                        Email updates
                      </span>
                      <input
                        type="checkbox"
                        checked={settingsState.emailUpdates}
                        onChange={() => handleSettingsToggle("emailUpdates")}
                        className="h-4 w-4"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">
                        Push notifications
                      </span>
                      <input
                        type="checkbox"
                        checked={settingsState.pushNotifications}
                        onChange={() =>
                          handleSettingsToggle("pushNotifications")
                        }
                        className="h-4 w-4"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">
                        Token usage alerts
                      </span>
                      <input
                        type="checkbox"
                        checked={settingsState.tokenAlerts}
                        onChange={() => handleSettingsToggle("tokenAlerts")}
                        className="h-4 w-4"
                      />
                    </label>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm text-slate-700">
                        Preferred language
                      </label>
                      <select
                        value={settingsState.locale}
                        onChange={(event) =>
                          handleSettingsSelect(
                            "locale",
                            event.target.value as "ko" | "en",
                          )
                        }
                        className="rounded border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="ko">한국어</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm text-slate-700">Theme</label>
                      <select
                        value={settingsState.theme}
                        onChange={(event) =>
                          handleSettingsSelect(
                            "theme",
                            event.target.value as "system" | "light" | "dark",
                          )
                        }
                        className="rounded border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="system">Follow system</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </div>
                  </div>
                  {settingsSavedAt && (
                    <p className="text-xs text-emerald-600">
                      Settings captured{" "}
                      {new Date(settingsSavedAt).toLocaleTimeString()}.
                    </p>
                  )}
                </form>
              </section>
            </div>
          )}
          {activeTab === "activity" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <header className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-slate-800">
                      Recent activity
                    </h3>
                    <p className="text-xs text-slate-500">
                      Merged from jobs, batches, proofreading, and quality
                      records. Showing the latest 50 events.
                    </p>
                  </div>
                  {isJobsLoading && (
                    <span className="text-xs text-slate-400">Loading…</span>
                  )}
                </header>
                <div className="mt-3 space-y-2 text-xs text-slate-600">
                  {activityEntries.length === 0 && (
                    <p>No activity captured yet for this project.</p>
                  )}
                  {activityEntries.map((entry) => (
                    <p
                      key={`${entry.timestamp}-${entry.label}`}
                      className="flex justify-between gap-3"
                    >
                      <span>{new Date(entry.timestamp).toLocaleString()}</span>
                      <span className="text-right text-slate-500">
                        {entry.label}
                      </span>
                    </p>
                  ))}
                </div>
              </section>
            </div>
          )}
          {activeTab === "terms" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  Terms of use
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Preview of the upcoming legal document. Place the finalized
                  markdown file at{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                    docs/legal/terms.md
                  </code>{" "}
                  and this panel will render it in a future update.
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Current placeholder last updated{" "}
                  {new Date().toLocaleDateString()}.
                </p>
              </section>
            </div>
          )}
          {activeTab === "privacy" && (
            <div className="space-y-4 p-4 text-sm text-slate-700">
              <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-base font-semibold text-slate-800">
                  Privacy notice
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  The canonical policy will be read from{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                    docs/legal/privacy.md
                  </code>
                  . Until then, use this placeholder to verify layout and links.
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500">
                  <li>
                    Collection: translation manuscripts, quality scores,
                    proofreading decisions.
                  </li>
                  <li>
                    Processing: OpenAI endpoints configured per project plan.
                  </li>
                  <li>
                    Retention: project artifacts kept for 90 days unless
                    extended by editors.
                  </li>
                </ul>
              </section>
            </div>
          )}
        </div>
      </div>
      <QualityAssessmentDialog
        open={qualityDialogOpen}
        onClose={closeQualityDialog}
        stage={content?.qualityAssessmentStage}
        latest={content?.qualityAssessment ?? null}
      />
    </ProofreadIssuesProvider>
  );
};
