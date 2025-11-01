import { useMemo } from "react";
import { useProofreadEditorContext } from "../../context/proofreadEditor";
import type { ProofreadingIssue } from "../../types/domain";

const severityBadgeClasses: Record<string, string> = {
  critical: "bg-rose-100 text-rose-700",
  high: "bg-rose-100 text-rose-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-emerald-100 text-emerald-700",
  default: "bg-slate-200 text-slate-700",
};

const guardBadgeClasses: Record<string, string> = {
  qa_also: "bg-amber-100 text-amber-700 border border-amber-200",
  llm_only: "bg-sky-100 text-sky-700 border border-sky-200",
  guard_only: "bg-slate-200 text-slate-600 border border-slate-200",
  default: "bg-slate-200 text-slate-600 border border-slate-200",
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

const normalizeSeverity = (value?: string | null) => {
  const normalized = String(value ?? "").toLowerCase();
  if (!normalized) return "default";
  if (
    normalized.includes("critical") ||
    normalized === "4" ||
    normalized === "5"
  ) {
    return "critical";
  }
  if (normalized.includes("high") || normalized === "3") {
    return "high";
  }
  if (normalized.includes("medium") || normalized === "2") {
    return "medium";
  }
  if (normalized.includes("low") || normalized === "1") {
    return "low";
  }
  return "default";
};

const severityLabel = (severity: string) => {
  switch (severity) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return "Unknown";
  }
};

const statusBadgeClasses: Record<string, string> = {
  applied: "bg-emerald-100 text-emerald-700",
  ignored: "bg-slate-200 text-slate-700",
  error: "bg-rose-100 text-rose-700",
  pending: "bg-amber-100 text-amber-700",
  default: "bg-slate-200 text-slate-700",
};

const statusLabel = (status?: string | null) => {
  const normalized = String(status ?? "").toLowerCase();
  switch (normalized) {
    case "applied":
      return "적용됨";
    case "ignored":
      return "무시됨";
    case "error":
      return "오류";
    case "pending":
    default:
      return "미적용";
  }
};

const formatTimestamp = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
};

export const ProofreadIssueTray = () => {
  const { segments, issues, issueAssignments, activeIssueId, selectIssue } =
    useProofreadEditorContext();

  const issuesById = useMemo(() => {
    const map = new Map<string, (typeof issues)[number]>();
    issues.forEach((issue) => {
      if (issue?.id) {
        map.set(issue.id, issue);
      }
    });
    return map;
  }, [issues]);

  const grouped = useMemo(() => {
    return segments
      .map((segment) => {
        const assignmentIds = issueAssignments[segment.segmentId] ?? [];
        const entries = assignmentIds
          .map((issueId) => issuesById.get(issueId))
          .filter((issue): issue is (typeof issues)[number] => Boolean(issue));
        if (!entries.length) return null;
        return { segment, entries };
      })
      .filter(
        (
          group,
        ): group is {
          segment: (typeof segments)[number];
          entries: (typeof issues)[number][];
        } => Boolean(group),
      );
  }, [segments, issueAssignments, issuesById]);

  if (!grouped.length) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-slate-200 bg-white p-4 text-xs text-slate-500">
        <h3 className="text-sm font-semibold text-slate-700">Issue Tray</h3>
        <p className="mt-2 text-slate-500">
          No issues found for this dataset yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-slate-200 bg-white">
      <header className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-700">Issue Tray</h3>
        <p className="text-xs text-slate-500">
          Select an issue to focus the editor.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        <ul className="divide-y divide-slate-100 text-sm text-slate-600">
          {grouped.map(({ segment, entries }) => (
            <li key={segment.segmentId}>
              <div className="bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500">
                Segment {segment.segmentIndex + 1}
              </div>
              <ul className="divide-y divide-slate-100">
                {entries.map((issue, index) => {
                  const severity = normalizeSeverity(issue.severity);
                  const severityClass =
                    severityBadgeClasses[severity] ??
                    severityBadgeClasses.default;
                  const title =
                    issue.issue?.issue_en ??
                    issue.issue?.issue_ko ??
                    issue.bucket?.subfeatureLabel ??
                    "Issue";
                  const recommendation =
                    issue.issue?.recommendation_en ??
                    issue.issue?.recommendation_ko ??
                    null;
                  const statusValue = String(
                    issue.status ?? "pending",
                  ).toLowerCase();
                  const statusClass =
                    statusBadgeClasses[statusValue] ??
                    statusBadgeClasses.default;
                  const timestamp = formatTimestamp(
                    issue.updatedAt ?? issue.createdAt,
                  );
                  const isActive = activeIssueId === issue.id;
                  const listKey = issue.id
                    ? `${issue.id}-${index}`
                    : `${issue.bucket?.subfeatureKey ?? issue.bucket?.group ?? "issue"}-${segment.segmentId}-${index}`;
                  const guardNotes = (
                    issue.notes as ProofreadingIssue["notes"] | undefined
                  )?.guardFindings;
                  const guardFindings = Array.isArray(guardNotes)
                    ? guardNotes.filter(
                        (finding) =>
                          typeof finding?.summary === "string" &&
                          finding.summary.length > 0,
                      )
                    : [];
                  return (
                    <li key={listKey}>
                      <button
                        type="button"
                        onClick={() => selectIssue(issue.id)}
                        className={`flex w-full flex-col gap-2 px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200 ${
                          isActive ? "bg-indigo-50" : "hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-700">
                            {title}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${severityClass}`}
                          >
                            {severityLabel(severity)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${statusClass}`}
                          >
                            {statusLabel(statusValue)}
                          </span>
                          {typeof issue.guardStatusLabel === "string" &&
                            issue.guardStatusLabel.trim().length > 0 &&
                            (() => {
                              const guardStatusKey =
                                typeof issue.guardStatus === "string" &&
                                issue.guardStatus.trim().length
                                  ? issue.guardStatus.trim()
                                  : "default";
                              return (
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${
                                    guardBadgeClasses[guardStatusKey] ??
                                    guardBadgeClasses.default
                                  }`}
                                >
                                  {issue.guardStatusLabel}
                                </span>
                              );
                            })()}
                          {timestamp && <span>{timestamp}</span>}
                        </div>
                        {guardFindings.length > 0 && (
                          <div className="flex flex-wrap gap-2 text-[10px]">
                            {guardFindings
                              .slice(0, 2)
                              .map((finding, guardIndex) => {
                                const guardType =
                                  typeof finding.type === "string" &&
                                  finding.type.trim().length
                                    ? finding.type
                                    : "guard";
                                const summary =
                                  typeof finding.summary === "string" &&
                                  finding.summary.trim().length
                                    ? finding.summary
                                    : null;
                                if (!summary) {
                                  return null;
                                }
                                return (
                                  <span
                                    key={`${issue.id}-guard-${guardIndex}`}
                                    className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-700"
                                  >
                                    <span className="font-semibold">
                                      {guardTypeLabel(guardType)}
                                    </span>
                                    <span>{summary}</span>
                                  </span>
                                );
                              })}
                            {guardFindings.length > 2 && (
                              <span className="text-rose-500">
                                +{guardFindings.length - 2} more
                              </span>
                            )}
                          </div>
                        )}
                        {recommendation && (
                          <p className="text-xs text-slate-500 line-clamp-3">
                            {recommendation}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
