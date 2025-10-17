import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { getSubfeatureColor } from "../../utils/proofreadingColors";
import {
  useProofreadIssues,
  type ProofreadIssueLifecycleState,
  type ProofreadIssueStatus,
} from "../../context/ProofreadIssuesContext";
import type { ProofreadingBucket, ProofreadingIssue } from "../../types/domain";
import type { ProofreadingAgentState } from "../../store/workflow.store";
import { ProofreadActivityFeed } from "./ProofreadActivityFeed";
import { useProofreadCommandStore } from "../../store/proofreadCommand.store";

interface ProofListProps {
  agentState?: ProofreadingAgentState;
}

const formatDateTime = (value?: string | null) => {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

const formatStageProgress = (value?: string | null) => {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("done") || normalized.includes("complete"))
    return "완료";
  if (normalized.includes("fail")) return "실패";
  if (normalized.includes("queue")) return "대기 중";
  return "진행 중";
};

const formatRelativeTime = (value?: string | null) => {
  if (!value) return "기록 없음";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "알 수 없음";
  const diff = Date.now() - timestamp;
  if (diff < 0) return "방금 전";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "방금 전";
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
};

const severityAliases: Record<string, "low" | "medium" | "high" | "critical"> =
  {
    low: "low",
    minor: "low",
    "1": "low",
    "1.0": "low",
    medium: "medium",
    moderate: "medium",
    "2": "medium",
    "2.0": "medium",
    high: "high",
    severe: "high",
    "3": "high",
    "3.0": "high",
    critical: "critical",
    urgent: "critical",
    extreme: "critical",
    "4": "critical",
    "4.0": "critical",
    "5": "critical",
    "5.0": "critical",
  };

const normalizeSeverity = (
  value?: string | null,
): "low" | "medium" | "high" | "critical" | undefined => {
  if (!value) return undefined;
  const raw = String(value).trim();
  const key = raw.toLowerCase();
  if (severityAliases[key]) return severityAliases[key];
  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) {
    if (numeric <= 1.5) return "low";
    if (numeric <= 2.5) return "medium";
    if (numeric <= 3.5) return "high";
    return "critical";
  }
  return undefined;
};

const formatSeverityLabel = (
  severity: "low" | "medium" | "high" | "critical",
) => {
  switch (severity) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    default:
      return "Low";
  }
};

const severityTone: Record<string, string> = {
  low: "bg-slate-200 text-slate-700",
  medium: "bg-amber-200 text-amber-800",
  high: "bg-rose-200 text-rose-800",
  critical: "bg-red-500 text-white",
};

const guardBadgeTone: Record<string, string> = {
  error: "border-rose-200 bg-rose-50 text-rose-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  info: "border-slate-200 bg-slate-50 text-slate-600",
  default: "border-slate-200 bg-slate-50 text-slate-600",
};

const guardTypeLabel = (type: string) => {
  const normalized = type.toLowerCase();
  switch (normalized) {
    case "named-entity":
      return "Entity";
    case "term-map":
      return "Term Map";
    case "back-translation":
      return "Back Translation";
    case "length-parity":
      return "Length";
    case "register":
      return "Register";
    default:
      return type;
  }
};

const INTERACTIVE_TARGET_SELECTOR =
  "button, a, input, textarea, select, label, [data-prevent-collapse]";

const isInteractiveTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  Boolean(target.closest(INTERACTIVE_TARGET_SELECTOR));

const IssueCard = ({
  issue,
  bucket,
  onApply,
  onIgnore,
  onRollback,
  isApplying,
  lifecycle,
  status: statusInfo,
  collapsed,
  onToggleCollapsed,
}: {
  issue: ProofreadingIssue;
  bucket: ProofreadingBucket;
  onApply: (issue: ProofreadingIssue) => void;
  onIgnore: (issue: ProofreadingIssue) => void;
  onRollback: (issue: ProofreadingIssue) => void;
  isApplying: boolean;
  lifecycle: ProofreadIssueLifecycleState;
  status?: ProofreadIssueStatus;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) => {
  const severity = normalizeSeverity(issue.severity) ?? "low";
  const badgeClass = severityTone[severity] ?? severityTone.low;
  const subfeatureKey =
    bucket.subfeatureKey ?? bucket.subfeatureLabel ?? bucket.group ?? "unknown";
  const color = getSubfeatureColor(String(subfeatureKey));
  const sourceText = issue.sourceExcerpt ?? issue.source ?? null;
  const translationText = issue.before ?? issue.translationExcerpt ?? null;
  const appliedAt =
    issue.appliedAt ||
    issue.applied_at ||
    (lifecycle === "applied" ? statusInfo?.timestamp : undefined);
  const isApplied = lifecycle === "applied";
  const isIgnored = lifecycle === "ignored";
  const ignoredAt = isIgnored ? (statusInfo?.timestamp ?? null) : null;
  const hasMetaBadges =
    typeof issue.confidence === "number" || Boolean(issue.tags?.length);
  const guardFindings = Array.isArray(issue.notes?.guardFindings)
    ? issue.notes!.guardFindings.filter(
        (finding) => typeof finding?.summary === "string" && finding.summary.length > 0,
      )
    : [];

  const handleCardClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (isInteractiveTarget(event.target)) return;
      const selection = window.getSelection();
      if (selection && selection.toString()) return;
      onToggleCollapsed();
    },
    [onToggleCollapsed],
  );

  const handleCardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onToggleCollapsed();
      }
    },
    [onToggleCollapsed],
  );

  return (
    <article
      className={`cursor-pointer rounded border ${isApplied ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white"} px-4 py-3 text-sm shadow-sm transition hover:border-emerald-200/70 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      tabIndex={0}
      aria-expanded={!collapsed}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${badgeClass}`}
          >
            {formatSeverityLabel(severity)}
          </span>
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium ${color.bg} ${color.text}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${color.border}`}
              aria-hidden
            />
            {bucket.group} · {bucket.subfeatureLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {typeof issue.confidence === "number" && (
            <span>Confidence {formatPercent(issue.confidence)}</span>
          )}
          {issue.tags?.length ? (
            <span className="flex flex-wrap gap-1">
              {issue.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-slate-200 px-2 py-0.5 text-[10px] text-slate-600"
                >
                  #{tag}
                </span>
              ))}
            </span>
          ) : null}
          {(isApplied && appliedAt) || (isIgnored && ignoredAt) ? (
            <div
              className={`flex items-center gap-2${hasMetaBadges ? " ml-auto" : ""}`}
            >
              {isApplied && appliedAt && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                  Applied at {new Date(appliedAt).toLocaleString()}
                </span>
              )}
              {isIgnored && ignoredAt && (
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                  Ignored at {new Date(ignoredAt).toLocaleString()}
                </span>
              )}
            </div>
          ) : null}
        </div>
      </header>

      {guardFindings.length > 0 && (
        <div className="mt-2 space-y-1 text-[11px]">
          <p className="font-medium text-amber-700">
            QA 단계 가드가 아래 항목을 점검했습니다. 검토 후 적용 여부를 결정해 주세요.
          </p>
          <div className="flex flex-wrap gap-2">
            {guardFindings.map((finding, index) => {
              const tone = finding.severity
                ? guardBadgeTone[finding.severity] ?? guardBadgeTone.default
                : guardBadgeTone.default;
              return (
                <span
                  key={`${finding.type}-${index}`}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${tone}`}
                >
                  <span className="font-semibold">
                    {guardTypeLabel(finding.type)}
                  </span>
                  <span>{finding.summary}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {lifecycle === "error" && statusInfo?.message && (
        <p className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
          적용 중 오류가 발생했습니다:{" "}
          {statusInfo.message ?? "다시 시도해 주세요."}
        </p>
      )}

      {!collapsed && (
        <div className="space-y-2">
          <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                Detected Issue (KO)
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-slate-800">
                {issue.issue_ko}
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                Detected Issue (EN)
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-slate-800">
                {issue.issue_en}
              </p>
            </div>
          </div>

          <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                Recommendation (KO)
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">
                {issue.recommendation_ko}
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                Recommendation (EN)
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">
                {issue.recommendation_en}
              </p>
            </div>
          </div>

      {sourceText && (
        <div className="mt-2 text-xs">
          <h4 className="text-[11px] font-semibold uppercase text-slate-500">
            Origin
          </h4>
          <p className="mt-1 whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 p-2 text-slate-700">
            {sourceText}
          </p>
        </div>
      )}

      {(translationText || issue.after) && (
        <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
          {translationText && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                Current Translation
              </h4>
              <p className="mt-1 whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 p-2 text-slate-700">
                {translationText}
              </p>
            </div>
          )}
          {issue.after && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                After
              </h4>
              <p className="mt-1 whitespace-pre-wrap rounded border border-emerald-100 bg-emerald-50 p-2 text-slate-700">
                {issue.after}
              </p>
            </div>
          )}
        </div>
      )}

          <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
            <div>
              <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                Rationale (KO)
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-slate-600">
                {issue.rationale_ko}
              </p>
            </div>
            <div>
              <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                Rationale (EN)
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-slate-600">
                {issue.rationale_en}
              </p>
            </div>
          </div>

          {issue.alternatives?.length ? (
            <div className="mt-2 text-xs">
              <h4 className="text-[11px] font-semibold uppercase text-slate-500">
                Alternatives
              </h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-600">
                {issue.alternatives.map((alt, idx) => (
                  <li key={idx}>{alt}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center justify-start gap-2 text-xs">
        <div className="flex items-center gap-2">
          {!isApplied && !isIgnored && (
            <button
              type="button"
              onClick={() => onApply(issue)}
              disabled={isApplying}
              data-prevent-collapse
              className={`rounded px-3 py-1 font-semibold transition ${
                isApplying
                  ? "cursor-not-allowed bg-slate-300 text-slate-500"
                  : "bg-emerald-600 text-white hover:bg-emerald-700"
              }`}
            >
              {isApplying ? "적용 중…" : "적용"}
            </button>
          )}
          {!isApplied && !isIgnored && (
            <button
              type="button"
              onClick={() => onIgnore(issue)}
              disabled={isApplying}
              data-prevent-collapse
              className="rounded border border-slate-300 px-3 py-1 font-semibold text-slate-600 transition hover:bg-slate-100"
            >
              무시
            </button>
          )}
          {(isApplied || isIgnored) && (
            <button
              type="button"
              onClick={() => onRollback(issue)}
              disabled={isApplying}
              data-prevent-collapse
              className="rounded border border-emerald-200 bg-white px-3 py-1 font-semibold text-emerald-700 transition hover:bg-emerald-50"
            >
              되돌리기
            </button>
          )}
        </div>
      </footer>
    </article>
  );
};

const computeSeverityCounts = (entries: Array<{ issue: ProofreadingIssue }>) =>
  entries.reduce(
    (acc, { issue }) => {
      const key = normalizeSeverity(issue.severity) ?? "low";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<"low" | "medium" | "high" | "critical", number>,
  );

const severityDisplayOrder: Array<"critical" | "high" | "medium" | "low"> = [
  "critical",
  "high",
  "medium",
  "low",
];

interface SubfeatureStat {
  key: string;
  label: string;
  total: number;
  applied: number;
  ignored: number;
  pending: number;
  resolved: number;
  open: number;
  color: ReturnType<typeof getSubfeatureColor>;
}

export const ProofList = ({ agentState }: ProofListProps) => {
  const [showSummary, setShowSummary] = useState<boolean>(true);
  const [collapsedIssueIds, setCollapsedIssueIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [isStartingDeep, setIsStartingDeep] = useState(false);
  const {
    proofreading: proofread,
    issues,
    totalIssueCount,
    hiddenIssueCount,
    showAllIssues,
    toggleShowAllIssues,
    issueStatuses: statusMap,
    issueStateById,
    applyingMap: applyingState,
    handleApply: applyIssue,
    handleIgnore: ignoreIssue,
    handleRollback: rollbackIssue,
    broadcastRecap,
    stage: providerStage,
  } = useProofreadIssues();
  const startProofreadCommand = useProofreadCommandStore(
    (state) => state.startProofread,
  );

  const appliedKey = useMemo(
    () => (proofread?.appliedIssueIds ?? []).join("|"),
    [proofread?.appliedIssueIds],
  );

  useEffect(() => {
    setCollapsedIssueIds(new Set(proofread?.appliedIssueIds ?? []));
  }, [proofread?.id, proofread?.timestamp, proofread?.appliedIssueIds, appliedKey]);

  const proofStage = providerStage ?? null;
  const rawStage = proofread?.stage ?? proofStage ?? "none";
  const agentStatus = agentState?.status ?? "idle";
  const inflightStages = agentState?.stageStatuses ?? [];
  const agentRunning = agentStatus === "running" || agentStatus === "queued";
  const normalizedStage = (rawStage ?? "none").toLowerCase();
  const tierSummaries = agentState?.tierSummaries ?? {};
  const completionSummary = agentState?.completionSummary ?? null;
  const heartbeatSource = agentState?.lastHeartbeatAt ?? proofread?.timestamp ?? null;
  const heartbeatRelative = formatRelativeTime(heartbeatSource);
  const heartbeatExact = heartbeatSource ? formatDateTime(heartbeatSource) : "기록 없음";
  const isStalled = agentState?.isStalled ?? false;
  const deepTierSummary = tierSummaries?.deep ?? undefined;
  const hasDeepResults = Boolean(deepTierSummary);
  const deepInProgress = inflightStages.some(
    (entry) =>
      (entry.tier ?? "") === "deep" &&
      !String(entry.status ?? "").toLowerCase().includes("done"),
  );

  const handleRunDeep = useCallback(async () => {
    if (!startProofreadCommand) return;
    setIsStartingDeep(true);
    try {
      await startProofreadCommand({
        label: "Deep proofread",
        allowParallel: true,
        runDeep: true,
      });
    } catch (error) {
      console.error("Failed to start deep proofread", error);
    } finally {
      setIsStartingDeep(false);
    }
  }, [startProofreadCommand]);
  const hasProofreading = Boolean(proofread?.exists);
  const primaryReport =
    proofread?.report ??
    proofread?.quickReport ??
    proofread?.deepReport ??
    null;
  const entries = issues;
  const displayedIssueCount = entries.length;
  const totalIssues = totalIssueCount;
  const rawSeverityCounts = computeSeverityCounts(entries);
  const severityCounts = severityDisplayOrder.reduce(
    (acc, key) => {
      acc[key] = rawSeverityCounts[key] ?? 0;
      return acc;
    },
    {} as Record<"critical" | "high" | "medium" | "low", number>,
  );
  const summaryNote = useMemo(() => {
    const note =
      primaryReport?.summary?.notes_ko ??
      primaryReport?.summary?.notes_en ??
      undefined;
    if (!note) return undefined;
    const trimmed = note.trim();
    const lowered = trimmed.toLowerCase();
    if (trimmed === "교정 완료" || lowered === "proofreading complete") {
      return undefined;
    }
    return note;
  }, [primaryReport]);

  const completionTopSubfeatures = useMemo(
    () =>
      completionSummary
        ? Object.entries(completionSummary.countsBySubfeature ?? {})
            .filter(([, value]) =>
              typeof value === "number" && Number.isFinite(value) && value > 0,
            )
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
        : [],
    [completionSummary],
  );

  const formatStageLabel = (value?: string) => {
    switch ((value ?? "").toLowerCase()) {
      case "running":
      case "in-progress":
      case "inprogress":
      case "progress":
        return "진행 중";
      case "done":
      case "completed":
        return "완료";
      case "queued":
      case "queue":
        return "대기 중";
      case "error":
        return "오류";
      case "none":
      case "":
        return "미실행";
      default:
        return value ?? "미확인";
    }
  };

  const handledDisplayCount = entries.filter(({ issue }) => {
    const state = issueStateById[issue.id] ?? "pending";
    return state === "applied" || state === "ignored";
  }).length;

  const timestampLabel = proofread?.timestamp
    ? new Date(proofread.timestamp).toLocaleString()
    : "최근 기록";

  const rawStageValue = proofread?.stage ?? rawStage ?? "";
  const readableStage = formatStageLabel(rawStageValue);

  const hasRun = readableStage !== "미실행" || totalIssues > 0;
  let summaryLine: string;
  if (agentRunning) {
    summaryLine =
      "교정 작업을 진행 중입니다. 결과가 준비되면 이 영역에 요약과 자세한 이슈가 표시됩니다.";
  } else if (hasRun) {
    if (!showAllIssues && hiddenIssueCount > 0) {
      summaryLine = `${timestampLabel}에 교정을 위한 분석을 진행하여 ${readableStage} 되었으며, 총 이슈 ${totalIssues}건 중 중요 이슈 ${displayedIssueCount}건(적용/무시 ${handledDisplayCount}건)을 우선 표시합니다. 낮은 중요도 ${hiddenIssueCount}건은 숨겨진 상태입니다.`;
    } else {
      summaryLine = `${timestampLabel}에 교정을 위한 분석을 진행하여 ${readableStage} 되었으며, 총 이슈 ${totalIssues}건 중 ${handledDisplayCount}건이 번역문에 반영(적용/무시)되었습니다.`;
    }
  } else {
    summaryLine =
      "아직 교정을 위한 분석이 진행되지 않았습니다. 챗창에 말씀하시면 진행 가능하며, 완료되면 이곳에 요약이 표시됩니다.";
  }

  const subfeatureStats = useMemo<SubfeatureStat[]>(() => {
    const report =
      proofread?.report ??
      proofread?.quickReport ??
      proofread?.deepReport ??
      null;
    const results = Array.isArray(report?.results) ? report.results : [];

    const statsMap = new Map<string, SubfeatureStat>();

    results.forEach((bucket) => {
      const key =
        bucket.subfeatureKey ??
        bucket.subfeatureLabel ??
        bucket.group ??
        "unknown";
      const label = bucket.subfeatureLabel ?? bucket.group ?? key;
      const color = getSubfeatureColor(String(key));

      const existing = statsMap.get(String(key));
      const stat: SubfeatureStat = existing ?? {
        key: String(key),
        label,
        total: 0,
        applied: 0,
        ignored: 0,
        pending: 0,
        resolved: 0,
        open: 0,
        color,
      };

      (bucket.items ?? []).forEach((issue) => {
        stat.total += 1;
        const lifecycle = issueStateById[issue.id] ?? "pending";
        if (lifecycle === "ignored") {
          stat.ignored += 1;
        } else if (lifecycle === "applied") {
          stat.applied += 1;
        }
      });

      stat.resolved = stat.applied + stat.ignored;
      stat.pending = Math.max(stat.total - stat.resolved, 0);
      stat.open = stat.pending;
      statsMap.set(String(key), stat);
    });

    return Array.from(statsMap.values());
  }, [proofread, issueStateById]);

  const handleApply = useCallback(
    (issue: ProofreadingIssue) => {
      void (async () => {
        const success = await applyIssue(issue);
        if (success) {
          setCollapsedIssueIds((prev) => {
            const next = new Set(prev);
            next.add(issue.id);
            return next;
          });
          broadcastRecap();
        }
      })();
    },
    [applyIssue, broadcastRecap],
  );

  const handleIgnore = useCallback(
    (issue: ProofreadingIssue) => {
      void (async () => {
        const success = await ignoreIssue(issue);
        if (success) {
          setCollapsedIssueIds((prev) => {
            const next = new Set(prev);
            next.add(issue.id);
            return next;
          });
          broadcastRecap();
        }
      })();
    },
    [ignoreIssue, broadcastRecap],
  );

  const handleRollback = useCallback(
    (issue: ProofreadingIssue) => {
      void (async () => {
        const success = await rollbackIssue(issue);
        if (success) {
          setCollapsedIssueIds((prev) => {
            const next = new Set(prev);
            next.delete(issue.id);
            return next;
          });
          broadcastRecap();
        }
      })();
    },
    [rollbackIssue, broadcastRecap],
  );

  if (!hasProofreading) {
    const stageMessage = agentRunning
      ? "교정 작업을 진행 중입니다. 단계별 결과가 준비되면 바로 이곳에 표시됩니다."
      : proofStage && proofStage !== "no-proofreading"
        ? `현재 교정 단계: ${proofStage}. 진행 상황이 완료되면 요약이 표시됩니다.`
        : "번역이 완료된 후 교정을 요청하면 요약과 자세한 이슈가 이 영역에 표시됩니다.";

    return (
      <div className="space-y-3 p-6 text-sm text-slate-600">
        <p className="font-medium text-slate-800">
          아직 실행된 교정 작업이 없습니다.
        </p>
        <p className="text-slate-500">{stageMessage}</p>
      </div>
    );
  }

  if (!proofread) {
    return null;
  }

  const isProofCompleted =
    normalizedStage === "done" || normalizedStage === "completed";
  const stageCardClass = isProofCompleted
    ? "overflow-hidden rounded border border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm"
    : "overflow-hidden rounded border border-slate-200 bg-white text-slate-700 shadow-sm";
  const stageHeaderClass = isProofCompleted
    ? "text-sm font-semibold text-emerald-700"
    : "text-sm font-semibold text-slate-800";
  const chevronClass = isProofCompleted
    ? "text-base text-emerald-600"
    : "text-base text-slate-500";
  const summaryTextClass = isProofCompleted
    ? "border-t border-emerald-100 p-4 space-y-2 text-sm text-emerald-700"
    : "border-t border-slate-200 p-4 space-y-2 text-sm text-slate-700";
  const summaryMetaClass = isProofCompleted
    ? "text-xs text-emerald-600"
    : "text-xs text-slate-500";
  const summaryValueClass = isProofCompleted
    ? "font-semibold text-emerald-700"
    : "font-semibold text-slate-800";

  return (
    <div className="space-y-4 p-4 text-sm text-slate-700">
      <section className={stageCardClass}>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
          onClick={() => setShowSummary((prev) => !prev)}
        >
          <h3 className={stageHeaderClass}>교정 상태</h3>
          <span className={chevronClass} aria-hidden="true">
            {showSummary ? "^" : "∨"}
          </span>
        </button>
        {showSummary && (
          <div className={summaryTextClass}>
            <p>{summaryLine}</p>
            {agentRunning && inflightStages.length > 0 && (
              <div className="mt-2 space-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <p className="font-semibold text-slate-500">
                  세부 단계 진행 현황
                </p>
                <ul className="mt-1 space-y-1">
                  {inflightStages.map((entry, index) => {
                    const key = `${entry.tier ?? "tier"}-${entry.key ?? index}`;
                    const statusLabel = formatStageProgress(entry.status);
                    const normalized = (entry.status ?? "").toLowerCase();
                    const isDone =
                      normalized.includes("done") ||
                      normalized.includes("complete");
                    const isFailed = normalized.includes("fail");
                    const isQueued = normalized.includes("queue");
                    const loaderClass = isFailed
                      ? "text-rose-500"
                      : isQueued
                        ? "text-amber-500"
                        : "text-indigo-500 animate-spin";
                    return (
                      <li key={key} className="flex items-center gap-2">
                        {isDone ? (
                          <CheckCircle2
                            className="h-3.5 w-3.5 text-emerald-500"
                            aria-hidden
                          />
                        ) : (
                          <Loader2
                            className={`h-3.5 w-3.5 ${loaderClass}`}
                            aria-hidden
                          />
                        )}
                        <span>
                          {entry.label ?? entry.key ?? "단계"}
                          {entry.tier ? ` (${entry.tier})` : ""} · {statusLabel}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {Object.keys(tierSummaries).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600">
                {Object.entries(tierSummaries).map(([tier, info]) => (
                  <span
                    key={tier}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 font-medium text-slate-600"
                  >
                    <span className="rounded bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
                      {tier}
                    </span>
                    <span>
                      {info.itemCount}건 · {formatRelativeTime(info.completedAt)} 완료
                    </span>
                  </span>
                ))}
              </div>
            )}
            {completionSummary && completionTopSubfeatures.length > 0 && (
              <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-[11px] text-slate-600">
                <p className="font-semibold text-slate-500">주요 서브피처 이슈</p>
                <ul className="mt-1 space-y-1">
                  {completionTopSubfeatures.map(([subfeature, count]) => (
                    <li key={subfeature} className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-700">{subfeature}</span>
                      <span>{count}건</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {isStalled && (
              <p className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
                ⚠️ 최근 2분 동안 교정 이벤트가 수신되지 않았습니다. 작업이 중단된 것 같다면 다시 요청하거나 관리자에게 문의해 주세요.
              </p>
            )}
            <p className={summaryMetaClass}>
              단계: <span className={summaryValueClass}>{readableStage}</span>
              {" · "}최근 업데이트:{" "}
              <span
                className={summaryValueClass}
                title={heartbeatExact ?? undefined}
              >
                {heartbeatRelative}
              </span>
              {" · "}적용 여부:{" "}
              <span className={summaryValueClass}>
                {proofread.applied ? "적용 완료" : "미적용"}
              </span>
            </p>
          </div>
        )}
      </section>

      <ProofreadActivityFeed />

      <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
        {!showAllIssues && hiddenIssueCount > 0 && (
          <span>
            중요 이슈 {displayedIssueCount}건 표시 중 · 낮은 중요도 {hiddenIssueCount}건 숨김
          </span>
        )}
        {showAllIssues && hiddenIssueCount > 0 && (
          <span>모든 이슈 {totalIssues}건 표시 중</span>
        )}
        <button
          type="button"
          onClick={toggleShowAllIssues}
          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 font-medium text-slate-600 transition hover:bg-slate-100"
        >
          {showAllIssues ? "핵심 이슈만 보기" : "모든 이슈 보기"}
        </button>
        {!hasDeepResults && !deepInProgress && startProofreadCommand && (
          <button
            type="button"
            onClick={handleRunDeep}
            disabled={isStartingDeep || agentRunning}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 font-medium transition ${
              isStartingDeep || agentRunning
                ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                : "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
            }`}
          >
            {isStartingDeep ? "심층 교정 실행 중…" : "심층 교정 실행"}
          </button>
        )}
        {deepInProgress && (
          <span className="inline-flex items-center gap-1 text-indigo-600">
            <Loader2 className="h-3 w-3 animate-spin" /> 심층 교정 진행 중…
          </span>
        )}
        {hasDeepResults && (
          <span className="inline-flex items-center gap-1 text-emerald-600">
            <CheckCircle2 className="h-3 w-3" /> 심층 교정 완료됨
          </span>
        )}
      </div>

      <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <h4 className="text-xs font-semibold uppercase text-slate-500">
          Aggregated Summary
        </h4>
        <p className="mt-3 text-sm text-slate-600">
          총 이슈 {totalIssues}건
          {!showAllIssues && hiddenIssueCount > 0
            ? ` · 핵심 ${displayedIssueCount}건 표시`
            : ''}
          {severityCounts.critical > 0
            ? ` · Critical ${severityCounts.critical}건`
            : ""}
          {severityCounts.high > 0 ? ` · High ${severityCounts.high}건` : ""}
          {severityCounts.medium > 0
            ? ` · Medium ${severityCounts.medium}건`
            : ""}
          {severityCounts.low > 0 ? ` · Low ${severityCounts.low}건` : ""}
        </p>
        <div className="mt-4">
          {subfeatureStats.length ? (
            <ul className="mt-2 space-y-2 text-xs">
              {subfeatureStats.map((stat) => {
                const allClear =
                  stat.total === 0 || stat.resolved === stat.total;
                const issuesOpen = stat.total > 0 && stat.resolved < stat.total;
                return (
                  <li
                    key={stat.key}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded border ${stat.color.border} bg-white px-3 py-2`}
                  >
                    <div className="flex items-center gap-2">
                      {allClear ? (
                        <CheckCircle2
                          className="h-4 w-4 text-emerald-500"
                          aria-hidden
                        />
                      ) : (
                        <span
                          className={`h-3 w-3 rounded-full ${stat.color.bg}`}
                          aria-hidden
                        />
                      )}
                      <span className="font-semibold text-slate-700">
                        {stat.label}
                      </span>
                    </div>
                    {issuesOpen && (
                      <div className="flex items-center gap-3 text-xs text-slate-600">
                        <span>
                          Issues {stat.total} /{" "}
                          <span className="text-emerald-600">
                            Applied {stat.resolved}
                          </span>
                        </span>
                        {stat.open > 0 && (
                          <span className="text-amber-600">
                            Open {stat.open}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500">교정 이슈가 없습니다.</p>
          )}
        </div>
        {summaryNote && (
          <p className="mt-3 rounded border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
            {summaryNote}
          </p>
        )}
      </section>

      <div className="space-y-3">
        {issues.map(({ issue, bucket }, index) => {
          const listKey = issue.id
            ? `${issue.id}-${index}`
            : `${bucket.subfeatureKey ?? bucket.group ?? "issue"}-${index}`;
          return (
            <IssueCard
              key={listKey}
              issue={issue}
              bucket={bucket}
              onApply={handleApply}
              onIgnore={handleIgnore}
              onRollback={handleRollback}
              isApplying={Boolean(applyingState[issue.id])}
              lifecycle={issueStateById[issue.id] ?? "pending"}
              status={statusMap[issue.id]}
              collapsed={collapsedIssueIds.has(issue.id)}
              onToggleCollapsed={() =>
                setCollapsedIssueIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(issue.id)) next.delete(issue.id);
                  else next.add(issue.id);
                  return next;
                })
              }
            />
          );
        })}
        {!issues.length && (
          <p className="rounded border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
            {hiddenIssueCount > 0
              ? '핵심 이슈가 없습니다. "모든 이슈 보기"를 눌러 추가 결과를 확인하세요.'
              : '교정 이슈가 감지되지 않았습니다.'}
          </p>
        )}
      </div>
    </div>
  );
};
