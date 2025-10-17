import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../services/api";
import { getSubfeatureColor } from "../utils/proofreadingColors";
import type {
  ProjectContent,
  ProofreadingBucket,
  ProofreadingIssue,
  ProofreadingReport,
} from "../types/domain";
import { useChatInsightStore } from "../store/chatInsight.store";
import { useProofreadIssueActionStore } from "../store/proofreadIssueAction.store";

interface ApplyProofreadingResponse {
  updated_at?: string;
  applied_translated_content?: string;
  report?: ProofreadingReport | null;
  quick_report?: ProofreadingReport | null;
  deep_report?: ProofreadingReport | null;
}

export type ProofreadIssueStatusState = "applied" | "ignored" | "error";

export interface ProofreadIssueStatus {
  status: ProofreadIssueStatusState;
  timestamp: string;
  message?: string;
}

export type ProofreadIssueLifecycleState =
  | "pending"
  | "applied"
  | "ignored"
  | "error";

export interface ProofreadIssueEntry {
  issue: ProofreadingIssue;
  bucket: ProofreadingBucket;
  bucketIndex: number;
  issueIndex: number;
}

export interface ProofreadHighlightSegment {
  start: number;
  end: number;
  colorClass: string;
  editorClass: string;
  editorColor: string;
  tooltip?: string;
  issueId: string;
  status: ProofreadIssueLifecycleState;
  issue: {
    id: string;
    severity?: string;
    feature?: string;
    issueKo?: string;
    issueEn?: string;
    recommendationKo?: string;
    recommendationEn?: string;
  };
}

interface ProofreadIssuesContextValue {
  isReady: boolean;
  proofreading: ProjectContent["proofreading"] | null;
  issues: ProofreadIssueEntry[];
  totalIssueCount: number;
  hiddenIssueCount: number;
  showAllIssues: boolean;
  toggleShowAllIssues: () => void;
  issueStatuses: Record<string, ProofreadIssueStatus>;
  issueStateById: Record<string, ProofreadIssueLifecycleState>;
  applyingMap: Record<string, boolean>;
  translationText: string;
  highlights: ProofreadHighlightSegment[];
  stage: string | null;
  handleApply: (issue: ProofreadingIssue) => Promise<boolean>;
  handleIgnore: (issue: ProofreadingIssue) => Promise<boolean>;
  handleRollback: (issue: ProofreadingIssue) => Promise<boolean>;
  refreshContent?: () => Promise<void> | void;
  syncTranslation: (next: string) => void;
  broadcastRecap: () => void;
}

interface ProofreadIssuesProviderProps {
  token?: string | null;
  content?: ProjectContent | null;
  translationText?: string | null;
  refreshContent?: () => Promise<void> | void;
  projectId?: string | null;
  children: ReactNode;
}

const ProofreadIssuesContext = createContext<
  ProofreadIssuesContextValue | undefined
>(undefined);

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSeverity = (
  value?: string | null,
): "low" | "medium" | "high" | "critical" | undefined => {
  if (!value) return undefined;
  const raw = String(value).trim();
  const key = raw.toLowerCase();
  const severityAliases: Record<
    string,
    "low" | "medium" | "high" | "critical"
  > = {
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

const findMatchRange = (text: string, target?: string | null) => {
  if (!target) return null;
  const candidates = [target, target.trim()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const regex = new RegExp(
      escapeRegex(candidate).replace(/\s+/g, "\\s+"),
      "m",
    );
    const match = regex.exec(text);
    if (match) {
      return {
        start: match.index,
        end: match.index + match[0].length,
      };
    }
  }
  return null;
};

const buildInitialStatuses = (
  proofreading: ProjectContent["proofreading"] | null,
): Record<string, ProofreadIssueStatus> => {
  const applied = proofreading?.appliedIssueIds ?? [];
  if (!applied.length) return {};
  const timestamp = proofreading?.timestamp ?? new Date().toISOString();
  return applied.reduce<Record<string, ProofreadIssueStatus>>((acc, id) => {
    acc[id] = { status: "applied", timestamp };
    return acc;
  }, {});
};

const computeLifecycleState = (
  issue: ProofreadingIssue,
  appliedIds: Set<string>,
  statuses: Record<string, ProofreadIssueStatus>,
): ProofreadIssueLifecycleState => {
  const localStatus = statuses[issue.id];
  if (localStatus) {
    if (localStatus.status === "error") return "error";
    return localStatus.status;
  }
  if (appliedIds.has(issue.id)) return "applied";
  const normalized = String(issue.status ?? "").toLowerCase();
  if (normalized === "applied") return "applied";
  if (normalized === "ignored") return "ignored";
  return "pending";
};

const mergeProofreading = (
  previous: ProjectContent["proofreading"] | null,
  response: ApplyProofreadingResponse,
  fallbackTranslation: string,
  nextIssueIds: string[],
): ProjectContent["proofreading"] | null => {
  if (!previous) return previous;
  return {
    ...previous,
    applied: nextIssueIds.length > 0,
    appliedIssueIds: nextIssueIds,
    appliedTranslation:
      response.applied_translated_content ?? fallbackTranslation,
    report: response.report ?? previous.report,
    quickReport: response.quick_report ?? previous.quickReport,
    deepReport: response.deep_report ?? previous.deepReport,
    timestamp: response.updated_at ?? previous.timestamp,
  };
};

const registerRange = (
  ranges: Array<{ start: number; end: number }>,
  candidate: { start: number; end: number } | null,
) => {
  if (!candidate) return null;
  const overlaps = ranges.some(
    (range) => !(candidate.end <= range.start || candidate.start >= range.end),
  );
  if (overlaps) return null;
  ranges.push(candidate);
  return candidate;
};

const statusHighlightTone: Record<
  ProofreadIssueLifecycleState,
  { colorClass: string; editorClass: string; editorColor: string }
> = {
  applied: {
    colorClass: "bg-emerald-200/80",
    editorClass: "proof-hl-emerald",
    editorColor: "rgba(16, 185, 129, 0.35)",
  },
  ignored: {
    colorClass: "bg-slate-200/80",
    editorClass: "proof-hl-slate",
    editorColor: "rgba(148, 163, 184, 0.35)",
  },
  pending: {
    colorClass: "bg-amber-200/80",
    editorClass: "proof-hl-amber",
    editorColor: "rgba(245, 158, 11, 0.35)",
  },
  error: {
    colorClass: "bg-rose-200/80",
    editorClass: "proof-hl-rose",
    editorColor: "rgba(244, 63, 94, 0.3)",
  },
};

const severityOrder: Array<"critical" | "high" | "medium" | "low"> = [
  "critical",
  "high",
  "medium",
  "low",
];

const severityRank: Record<(typeof severityOrder)[number], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const describeIssueLocation = (entry: ProofreadIssueEntry) => {
  if (typeof entry.issue.kr_sentence_id === "number") {
    return `원문 문장 ${entry.issue.kr_sentence_id}`;
  }
  if (typeof entry.issue.en_sentence_id === "number") {
    return `번역 문장 ${entry.issue.en_sentence_id}`;
  }
  const guardSegment = entry.issue.notes?.guardFindings?.[0]?.segmentId;
  if (guardSegment) {
    return `세그먼트 ${guardSegment}`;
  }
  return null;
};

const deriveIssueTitle = (entry: ProofreadIssueEntry) =>
  entry.issue.issue_ko ||
  entry.issue.issue_en ||
  entry.issue.recommendation_ko ||
  entry.issue.recommendation_en ||
  entry.bucket.subfeatureLabel ||
  entry.bucket.group ||
  "교정 제안";

type ProofreadRecapSnapshot = {
  proofreadingId: string | null;
  totalCount: number;
  pendingCount: number;
  appliedCount: number;
  ignoredCount: number;
  resolvedCount: number;
  errorCount: number;
  counts: Record<(typeof severityOrder)[number], number>;
  segmentCount: number;
  exampleIssues: Array<{
    issueId: string;
    title: string;
    severity: (typeof severityOrder)[number];
    location?: string | null;
  }>;
  readyForQuality: boolean;
};

const resolveIssuesFromReport = (
  report: ProofreadingReport | null,
): ProofreadIssueEntry[] => {
  if (!report) return [];
  const buckets = Array.isArray(report.results) ? report.results ?? [] : [];
  return buckets
    .flatMap((bucket, bucketIndex) =>
      (bucket.items ?? []).map((issue, issueIndex) => ({
        issue,
        bucket,
        bucketIndex,
        issueIndex,
      })),
    )
    .sort((a, b) => {
      const severityA = normalizeSeverity(a.issue.severity) ?? "low";
      const severityB = normalizeSeverity(b.issue.severity) ?? "low";
      const rankDiff = severityRank[severityA] - severityRank[severityB];
      if (rankDiff !== 0) return rankDiff;
      const confidenceDiff =
        (b.issue.confidence ?? 0) - (a.issue.confidence ?? 0);
      if (confidenceDiff !== 0) return confidenceDiff;
      if (a.bucketIndex !== b.bucketIndex) {
        return a.bucketIndex - b.bucketIndex;
      }
      return a.issueIndex - b.issueIndex;
    });
};

const resolveIssuesFromSession = (
  session: ProjectContent["proofreading"] | null,
): ProofreadIssueEntry[] => {
  if (!session) return [];
  const report =
    session.report ?? session.quickReport ?? session.deepReport ?? null;
  return resolveIssuesFromReport(report);
};

export const ProofreadIssuesProvider = ({
  token,
  content,
  translationText,
  refreshContent,
  projectId,
  children,
}: ProofreadIssuesProviderProps) => {
  const proofreading = content?.proofreading ?? null;
  const [session, setSession] = useState<ProjectContent["proofreading"] | null>(
    proofreading ?? null,
  );
  const sessionRef = useRef<ProjectContent["proofreading"] | null>(
    proofreading ?? null,
  );
  const [issueStatuses, setIssueStatuses] = useState<
    Record<string, ProofreadIssueStatus>
  >(() => buildInitialStatuses(proofreading ?? null));
  const issueStatusesRef = useRef<Record<string, ProofreadIssueStatus>>(
    buildInitialStatuses(proofreading ?? null),
  );
  const [applyingMap, setApplyingMap] = useState<Record<string, boolean>>({});
  const [currentTranslation, setCurrentTranslation] = useState<string>(
    translationText ?? "",
  );
  const translationRef = useRef(currentTranslation);
  const upsertProofSummary = useChatInsightStore((state) => state.upsertProofSummary);
  const setProofIssueHandlers = useProofreadIssueActionStore(
    (state) => state.setHandlers,
  );
  const resetHandlers = useProofreadIssueActionStore(
    (state) => state.resetHandlers,
  );
  const summaryDigestRef = useRef<string | null>(null);

  const prevProjectRef = useRef<string | null>(null);

  useEffect(() => {
    const currentProject = projectId ?? content?.projectId ?? null;
    const previousProject = prevProjectRef.current;
    const changed = previousProject !== currentProject;
    if (changed) {
      prevProjectRef.current = currentProject ?? null;
      setSession(proofreading ?? null);
      sessionRef.current = proofreading ?? null;
      const initialStatuses = buildInitialStatuses(proofreading ?? null);
      setIssueStatuses(initialStatuses);
      issueStatusesRef.current = initialStatuses;
      setApplyingMap({});
      setShowAllIssues(false);
      const nextTranslation = translationText ?? "";
      setCurrentTranslation(nextTranslation);
      translationRef.current = nextTranslation;
      summaryDigestRef.current = null;
      return;
    }

    // No project change but proofreading data updated (e.g., apply/refresh)
    setSession(proofreading ?? null);
    sessionRef.current = proofreading ?? null;
    const initialStatuses = buildInitialStatuses(proofreading ?? null);
    setIssueStatuses(initialStatuses);
    issueStatusesRef.current = initialStatuses;
    setApplyingMap((prev) => prev);
    setShowAllIssues(false);
    summaryDigestRef.current = null;
  }, [projectId, content?.projectId, proofreading, translationText]);

  useEffect(() => {
    translationRef.current = currentTranslation;
  }, [currentTranslation]);

  useEffect(() => {
    issueStatusesRef.current = issueStatuses;
  }, [issueStatuses]);

  useEffect(() => {
    setCurrentTranslation(translationText ?? "");
    translationRef.current = translationText ?? "";
  }, [translationText]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const report = useMemo<ProofreadingReport | null>(() => {
    if (!session) return null;
    return session.report ?? session.quickReport ?? session.deepReport ?? null;
  }, [session]);

  const allIssues = useMemo<ProofreadIssueEntry[]>(
    () => resolveIssuesFromReport(report),
    [report],
  );

  const [showAllIssues, setShowAllIssues] = useState(false);

  const issues = useMemo<ProofreadIssueEntry[]>(() => {
    if (showAllIssues) return allIssues;
    return allIssues.filter(({ issue }) => {
      const severity = normalizeSeverity(issue.severity) ?? "low";
      return severity === "critical" || severity === "high" || severity === "medium";
    });
  }, [allIssues, showAllIssues]);

  const hiddenIssueCount = Math.max(allIssues.length - issues.length, 0);
  const toggleShowAllIssues = useCallback(() => {
    setShowAllIssues((prev) => !prev);
  }, []);

  const appliedIdSet = useMemo(() => {
    const applied = session?.appliedIssueIds ?? [];
    return new Set<string>(applied);
  }, [session?.appliedIssueIds]);

  const issueStateById = useMemo(() => {
    const map: Record<string, ProofreadIssueLifecycleState> = {};
    allIssues.forEach(({ issue }) => {
      map[issue.id] = computeLifecycleState(issue, appliedIdSet, issueStatuses);
    });
    return map;
  }, [allIssues, appliedIdSet, issueStatuses]);

  const highlights = useMemo<ProofreadHighlightSegment[]>(() => {
    if (!issues.length || !currentTranslation) return [];
    const usedRanges: Array<{ start: number; end: number }> = [];
    const segments: ProofreadHighlightSegment[] = [];

    issues.forEach(({ issue, bucket }) => {
      const status = issueStateById[issue.id] ?? "pending";
      const colorMeta = getSubfeatureColor(
        String(bucket.subfeatureKey ?? bucket.subfeatureLabel ?? bucket.group),
      );
      const tone =
        status === "pending"
          ? {
              colorClass: colorMeta.highlight,
              editorClass: colorMeta.highlightClass,
              editorColor: colorMeta.highlightColor,
            }
          : statusHighlightTone[status];

      const tooltipPieces = [
        issue.severity
          ? `Severity ${(issue.severity ?? "").toString().toUpperCase()}`
          : null,
        bucket.subfeatureLabel ?? bucket.group ?? "Unknown feature",
        issue.issue_en ?? issue.issue_ko ?? null,
      ].filter(Boolean);

      const beforeText = issue.before ?? issue.translationExcerpt ?? null;
      const afterText = issue.after ?? null;
      const targets: Array<string | null | undefined> =
        status === "applied"
          ? [afterText, beforeText]
          : [beforeText, afterText];

      let match: { start: number; end: number } | null = null;
      for (const target of targets) {
        const candidate = findMatchRange(currentTranslation, target);
        const registered = registerRange(usedRanges, candidate);
        if (registered) {
          match = registered;
          break;
        }
      }
      if (!match) return;

      segments.push({
        start: match.start,
        end: match.end,
        colorClass: tone.colorClass,
        editorClass: tone.editorClass,
        editorColor: tone.editorColor,
        tooltip: tooltipPieces.join(" · "),
        issueId: issue.id,
        status,
        issue: {
          id: issue.id,
          severity: issue.severity,
          feature: bucket.subfeatureLabel ?? bucket.group ?? undefined,
          issueKo: issue.issue_ko,
          issueEn: issue.issue_en,
          recommendationKo: issue.recommendation_ko,
          recommendationEn: issue.recommendation_en,
        },
      });
    });

    return segments.sort((a, b) => a.start - b.start);
  }, [issues, issueStateById, currentTranslation]);

  const stage = useMemo(() => {
    if (session?.stage) return session.stage;
    if (content?.proofreadingStage) return content.proofreadingStage;
    return null;
  }, [session?.stage, content?.proofreadingStage]);

  const isReady = useMemo(() => {
    const stage = (session?.stage ?? content?.proofreadingStage ?? "")
      .toString()
      .toLowerCase();
    if (!session?.exists) return false;
    if (!stage) return false;
    return stage.includes("done") || stage.includes("complete");
  }, [session?.exists, session?.stage, content?.proofreadingStage]);

  const runApplyProofreading = useCallback(
    async (nextIds: string[], translatedContent: string) => {
      const snapshot = sessionRef.current;
      if (!token) {
        throw new Error("로그인 상태를 확인해 주세요.");
      }
      if (!snapshot?.id) {
        throw new Error("교정 세션 정보를 찾을 수 없습니다.");
      }
      const response = (await api.applyProofreading(token, snapshot.id, {
        appliedIssueIds: nextIds,
        translatedContent,
      })) as ApplyProofreadingResponse;
      const merged = mergeProofreading(
        snapshot,
        response,
        translatedContent,
        nextIds,
      );
      setSession(merged);
      sessionRef.current = merged;
      const nextTranslation =
        response.applied_translated_content ?? translatedContent;
      setCurrentTranslation(nextTranslation);
      translationRef.current = nextTranslation;
      await refreshContent?.();
      return response.updated_at
        ? new Date(response.updated_at).toISOString()
        : new Date().toISOString();
    },
    [token, refreshContent],
  );

  const handleApply = useCallback(
    async (target: ProofreadingIssue) => {
      if (!target?.id) return false;
      const current = translationRef.current;
      if (!current) {
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "error",
            timestamp: new Date().toISOString(),
            message: "번역본을 불러오지 못했습니다.",
          },
        }));
        return false;
      }
      const match = findMatchRange(current, target.before ?? "");
      if (!match) {
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "error",
            timestamp: new Date().toISOString(),
            message: "번역본에서 수정 대상 문장을 찾지 못했습니다.",
          },
        }));
        return false;
      }
      const updatedTranslation =
        current.slice(0, match.start) +
        (target.after ?? "") +
        current.slice(match.end);
      const snapshot = sessionRef.current;
      const nextIds = Array.from(
        new Set([...(snapshot?.appliedIssueIds ?? []), target.id]),
      );

      setApplyingMap((prev) => ({ ...prev, [target.id]: true }));
      let success = false;
      try {
        const timestamp = await runApplyProofreading(
          nextIds,
          updatedTranslation,
        );
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "applied",
            timestamp,
          },
        }));
        success = true;
      } catch (error) {
        console.warn("[proofread] apply failed", error);
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "error",
            timestamp: new Date().toISOString(),
            message:
              error instanceof Error ? error.message : "적용에 실패했습니다.",
          },
        }));
      } finally {
        setApplyingMap((prev) => ({ ...prev, [target.id]: false }));
      }
      return success;
    },
    [runApplyProofreading],
  );

  const handleIgnore = useCallback(
    async (target: ProofreadingIssue) => {
      if (!target?.id) return false;
      const snapshot = sessionRef.current;
      const nextIds = Array.from(
        new Set([...(snapshot?.appliedIssueIds ?? []), target.id]),
      );
      setApplyingMap((prev) => ({ ...prev, [target.id]: true }));
      let success = false;
      try {
        const timestamp = await runApplyProofreading(
          nextIds,
          translationRef.current,
        );
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "ignored",
            timestamp,
          },
        }));
        success = true;
      } catch (error) {
        console.warn("[proofread] ignore failed", error);
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "error",
            timestamp: new Date().toISOString(),
            message:
              error instanceof Error ? error.message : "무시에 실패했습니다.",
          },
        }));
      } finally {
        setApplyingMap((prev) => ({ ...prev, [target.id]: false }));
      }
      return success;
    },
    [runApplyProofreading],
  );

  const handleRollback = useCallback(
    async (target: ProofreadingIssue) => {
      if (!target?.id) return false;
      const snapshot = sessionRef.current;
      const current = translationRef.current;
      if (!snapshot) return false;
      const remaining = (snapshot.appliedIssueIds ?? []).filter(
        (id) => id !== target.id,
      );
      let nextTranslation = current;
      const appliedState = computeLifecycleState(
        target,
        new Set(snapshot.appliedIssueIds ?? []),
        issueStatuses,
      );
      if (appliedState === "applied" && current) {
        const match = findMatchRange(current, target.after ?? "");
        if (match) {
          nextTranslation =
            current.slice(0, match.start) +
            (target.before ?? "") +
            current.slice(match.end);
        }
      }
      setApplyingMap((prev) => ({ ...prev, [target.id]: true }));
      let success = false;
      try {
        await runApplyProofreading(remaining, nextTranslation);
        setIssueStatuses((prev) => {
          const next = { ...prev };
          delete next[target.id];
          return next;
        });
        success = true;
      } catch (error) {
        console.warn("[proofread] rollback failed", error);
        setIssueStatuses((prev) => ({
          ...prev,
          [target.id]: {
            status: "error",
            timestamp: new Date().toISOString(),
            message:
              error instanceof Error
                ? error.message
                : "되돌리기에 실패했습니다.",
          },
        }));
      } finally {
        setApplyingMap((prev) => ({ ...prev, [target.id]: false }));
      }
      return success;
    },
    [runApplyProofreading, issueStatuses],
  );

  const syncTranslation = useCallback((next: string) => {
    setCurrentTranslation(next);
    translationRef.current = next;
    setSession((prev) =>
      prev
        ? {
            ...prev,
            appliedTranslation: next,
          }
        : prev,
    );
    sessionRef.current = sessionRef.current
      ? { ...sessionRef.current, appliedTranslation: next }
      : sessionRef.current;
  }, []);

  const computeRecapSnapshot = useCallback((): ProofreadRecapSnapshot => {
    const totals: Record<(typeof severityOrder)[number], number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    let pendingCount = 0;
    let appliedCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;

    const segmentLabels = new Set<string>();
    const exampleCandidates: Array<{
      entry: ProofreadIssueEntry;
      severity: (typeof severityOrder)[number];
      location: string | null;
    }> = [];

    const sessionSnapshot = sessionRef.current;
    const issueEntries = resolveIssuesFromSession(sessionSnapshot);
    const appliedSet = new Set(sessionSnapshot?.appliedIssueIds ?? []);
    const statuses = issueStatusesRef.current;

    issueEntries.forEach((entry) => {
      const lifecycle = computeLifecycleState(
        entry.issue,
        appliedSet,
        statuses,
      );
      if (lifecycle === "applied") {
        appliedCount += 1;
      } else if (lifecycle === "ignored") {
        ignoredCount += 1;
      } else if (lifecycle === "error") {
        errorCount += 1;
        pendingCount += 1;
      } else {
        pendingCount += 1;
      }

      if (lifecycle === "pending" || lifecycle === "error") {
        const severity = normalizeSeverity(entry.issue.severity) ?? "low";
        totals[severity] += 1;
        const location = describeIssueLocation(entry);
        if (location) {
          segmentLabels.add(location);
        }
        exampleCandidates.push({
          entry,
          severity,
          location,
        });
      }
    });

    const exampleIssues = exampleCandidates
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
      .slice(0, 3)
      .map(({ entry, severity, location }) => ({
        issueId: entry.issue.id,
        severity,
        title: deriveIssueTitle(entry),
        location,
      }));

    const resolvedCount = appliedCount + ignoredCount;

    return {
      proofreadingId: sessionSnapshot?.id ?? null,
      totalCount: issueEntries.length,
      pendingCount,
      appliedCount,
      ignoredCount,
      resolvedCount,
      errorCount,
      counts: totals,
      segmentCount: segmentLabels.size,
      exampleIssues,
      readyForQuality:
        issueEntries.length > 0 && pendingCount === 0 && errorCount === 0,
    };
  }, []);

  const broadcastRecap = useCallback(() => {
    const snapshot = computeRecapSnapshot();
    const digestParts = [
      snapshot.proofreadingId ?? "none",
      snapshot.totalCount.toString(),
      snapshot.pendingCount.toString(),
      snapshot.appliedCount.toString(),
      snapshot.ignoredCount.toString(),
      snapshot.errorCount.toString(),
      snapshot.segmentCount.toString(),
      snapshot.readyForQuality ? "1" : "0",
      severityOrder.map((key) => snapshot.counts[key]).join(","),
      snapshot.exampleIssues
        .map(
          (item) =>
            `${item.issueId}:${item.severity}:${item.location ?? ""}`,
        )
        .join("|"),
    ].join(";");

    if (summaryDigestRef.current === digestParts) {
      return;
    }

    summaryDigestRef.current = digestParts;

    upsertProofSummary({
      proofreadingId: snapshot.proofreadingId,
      totalCount: snapshot.totalCount,
      pendingCount: snapshot.pendingCount,
      appliedCount: snapshot.appliedCount,
      ignoredCount: snapshot.ignoredCount,
      resolvedCount: snapshot.resolvedCount,
      errorCount: snapshot.errorCount,
      counts: snapshot.counts,
      segmentCount: snapshot.segmentCount,
      exampleIssues: snapshot.exampleIssues,
      readyForQuality: snapshot.readyForQuality,
      issuedAt: new Date().toISOString(),
    });
  }, [computeRecapSnapshot, upsertProofSummary]);

  useEffect(() => {
    broadcastRecap();
  }, [broadcastRecap]);

  useEffect(() => {
    setProofIssueHandlers({
      applyIssue: async (issueId: string) => {
        const entry = allIssues.find((item) => item.issue.id === issueId);
        if (!entry) return false;
        return handleApply(entry.issue);
      },
      ignoreIssue: async (issueId: string) => {
        const entry = allIssues.find((item) => item.issue.id === issueId);
        if (!entry) return false;
        return handleIgnore(entry.issue);
      },
    });
    return () => {
      resetHandlers();
    };
  }, [allIssues, handleApply, handleIgnore, setProofIssueHandlers, resetHandlers]);

  const value = useMemo<ProofreadIssuesContextValue>(
    () => ({
      isReady,
      proofreading: session,
      issues,
      totalIssueCount: allIssues.length,
      hiddenIssueCount,
      showAllIssues,
      toggleShowAllIssues,
      issueStatuses,
      issueStateById,
      applyingMap,
      translationText: currentTranslation,
      highlights,
      stage,
      handleApply,
      handleIgnore,
      handleRollback,
      refreshContent,
      syncTranslation,
      broadcastRecap,
    }),
    [
      isReady,
      session,
      issues,
      allIssues.length,
      hiddenIssueCount,
      showAllIssues,
      toggleShowAllIssues,
      issueStatuses,
      issueStateById,
      applyingMap,
      currentTranslation,
      highlights,
      stage,
      handleApply,
      handleIgnore,
      handleRollback,
      refreshContent,
      syncTranslation,
      broadcastRecap,
    ],
  );

  return (
    <ProofreadIssuesContext.Provider value={value}>
      {children}
    </ProofreadIssuesContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useProofreadIssues = () => {
  const context = useContext(ProofreadIssuesContext);
  if (!context) {
    throw new Error(
      "useProofreadIssues must be used within a ProofreadIssuesProvider",
    );
  }
  return context;
};
