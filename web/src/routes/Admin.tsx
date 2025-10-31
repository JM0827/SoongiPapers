import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, RefreshCcw } from "lucide-react";

import { AppShell } from "../components/layout/AppShell";
import { useAuthStore } from "../store/auth.store";
import { useProjectList } from "../hooks/useProjectData";
import { useProjectStore } from "../store/project.store";
import { api } from "../services/api";

const formatDateTime = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatTokens = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "-";

const truncateText = (value: string, max = 48) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

export const Admin = () => {
  const token = useAuthStore((state) => state.token);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const { data: projects } = useProjectList();

  const [projectFilter, setProjectFilter] = useState<string>(
    activeProjectId ?? "all",
  );
  const [limit, setLimit] = useState<number>(100);

  const {
    data: logs = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: [
      "admin",
      "proofreadingLogs",
      projectFilter,
      limit,
      token,
    ],
    enabled: Boolean(token),
    queryFn: async () => {
      if (!token) throw new Error("Missing authentication token");
      const projectId = projectFilter === "all" ? undefined : projectFilter;
      return api.fetchProofreadingLogs(token, {
        projectId,
        limit,
      });
    },
    staleTime: 30_000,
  });

  const {
    data: drafts = [],
    isLoading: isLoadingDrafts,
    isError: isDraftError,
    error: draftError,
    refetch: refetchDrafts,
    isFetching: isFetchingDrafts,
  } = useQuery({
    queryKey: [
      "admin",
      "translationDrafts",
      projectFilter,
      limit,
      token,
    ],
    enabled: Boolean(token),
    queryFn: async () => {
      if (!token) throw new Error("Missing authentication token");
      const projectId = projectFilter === "all" ? undefined : projectFilter;
      return api.fetchTranslationDraftRuns(token, {
        projectId,
        limit,
      });
    },
    staleTime: 30_000,
  });

  const summary = useMemo(() => {
    if (!logs.length) {
      return {
        total: 0,
        truncated: 0,
        avgTokens: 0,
        fallback: 0,
        avgAttempts: 0,
      };
    }

    const truncatedCount = logs.filter((entry) => entry.truncated).length;
    const avgTokens =
      logs.reduce((acc, entry) => acc + (entry.usageTotalTokens ?? 0), 0) /
      logs.length;
    const fallbackCount = logs.filter((entry) => entry.model !== 'gpt-5').length;
    const avgAttemptsRaw =
      logs.reduce((acc, entry) => acc + (entry.attempts ?? 0), 0) / logs.length;

    return {
      total: logs.length,
      truncated: truncatedCount,
      avgTokens: Math.round(avgTokens),
      fallback: fallbackCount,
      avgAttempts: Number.isFinite(avgAttemptsRaw)
        ? Number(avgAttemptsRaw.toFixed(2))
        : 0,
    };
  }, [logs]);

  const draftSummary = useMemo(() => {
    if (!drafts.length) {
      return {
        total: 0,
        truncated: 0,
        fallback: 0,
        avgAttempts: 0,
      };
    }

    const truncatedCount = drafts.filter((run) => run.truncated).length;
    const fallbackCount = drafts.filter((run) => run.fallbackModelUsed).length;
    const avgAttemptsRaw =
      drafts.reduce((acc, run) => {
        const attemptCount = run.attempts ?? run.retryCount + 1;
        return acc + attemptCount;
      }, 0) / drafts.length;

    return {
      total: drafts.length,
      truncated: truncatedCount,
      fallback: fallbackCount,
      avgAttempts: Number.isFinite(avgAttemptsRaw)
        ? Number(avgAttemptsRaw.toFixed(2))
        : 0,
    };
  }, [drafts]);

  const activeProjectName = useMemo(() => {
    if (!projects?.length) return "";
    const match = projects.find(
      (project) => project.project_id === projectFilter,
    );
    return match?.title ?? "";
  }, [projects, projectFilter]);

  const limitOptions = [25, 50, 100, 200, 500];

  const rightPanel = (
    <div className="flex h-full flex-col gap-5 bg-white p-6 text-sm text-slate-600">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-800">
          Proofreading Monitor
        </h2>
        <p className="text-xs leading-relaxed text-slate-500">
          Inspect GPT-5 proofreading runs, including token budgets, retry
          counts, truncation flags, and guard context.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3 text-xs">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <dt className="font-semibold text-slate-600">Selected project</dt>
          <dd className="truncate text-slate-700">
            {projectFilter === "all"
              ? "All projects"
              : activeProjectName || projectFilter}
          </dd>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <dt className="font-semibold text-slate-600">Proofreading rows</dt>
          <dd className="text-slate-700">{summary.total.toLocaleString()}</dd>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <dt className="font-semibold text-slate-600">Truncated runs</dt>
          <dd className="text-slate-700">
            {summary.truncated.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <dt className="font-semibold text-slate-600">
            Avg total tokens (per call)
          </dt>
          <dd className="text-slate-700">
            {summary.avgTokens.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <dt className="font-semibold text-slate-600">Fallback (mini) runs</dt>
          <dd className="text-slate-700">{summary.fallback.toLocaleString()}</dd>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <dt className="font-semibold text-slate-600">Avg attempts</dt>
          <dd className="text-slate-700">{summary.avgAttempts}</dd>
        </div>
      </dl>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">
          Translation draft runs
        </h3>
        <dl className="grid grid-cols-1 gap-3 text-xs">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <dt className="font-semibold text-slate-600">Draft rows</dt>
            <dd className="text-slate-700">
              {draftSummary.total.toLocaleString()}
            </dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <dt className="font-semibold text-slate-600">Truncated drafts</dt>
            <dd className="text-slate-700">
              {draftSummary.truncated.toLocaleString()}
            </dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <dt className="font-semibold text-slate-600">Fallback used</dt>
            <dd className="text-slate-700">
              {draftSummary.fallback.toLocaleString()}
            </dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <dt className="font-semibold text-slate-600">Avg attempts</dt>
            <dd className="text-slate-700">{draftSummary.avgAttempts}</dd>
          </div>
        </dl>
      </div>
    </div>
  );

  const isFetchingAny = isFetching || isFetchingDrafts;

  const handleRefresh = () => {
    void Promise.all([refetch(), refetchDrafts()]);
  };

  const content = (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">
                Admin · LLM Run Monitor
              </h1>
              <p className="text-xs text-slate-500">
                Inspect GPT-5 proofreading and translation draft telemetry,
                focusing on retries, truncation, and fallback behaviour.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isFetchingAny}
            className="inline-flex items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
          >
            <RefreshCcw className="h-4 w-4" aria-hidden />
            {isFetchingAny ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col text-xs font-semibold text-slate-600">
            Project filter
            <select
              className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="all">All projects</option>
              {(projects ?? []).map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.title ?? project.project_id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-semibold text-slate-600">
            Row limit
            <select
              className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {limitOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <section className="flex flex-1 flex-col">
          <h2 className="pb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Proofreading runs
          </h2>
          {isError ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              {(error as Error)?.message || "Failed to load logs."}
            </div>
          ) : null}
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Loading proofreading logs…
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Timestamp</th>
                    <th className="px-3 py-2 text-left">Project</th>
                    <th className="px-3 py-2 text-left">Tier</th>
                    <th className="px-3 py-2 text-left">Subfeature</th>
                    <th className="px-3 py-2 text-left">Model</th>
                    <th className="px-3 py-2 text-left">Tokens (prompt / completion / total)</th>
                    <th className="px-3 py-2 text-left">Attempts</th>
                    <th className="px-3 py-2 text-left">Truncated</th>
                    <th className="px-3 py-2 text-left">Guard seg.</th>
                    <th className="px-3 py-2 text-left">Memory ver.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {logs.map((entry) => (
                    <tr key={entry.id} className="text-slate-700">
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {truncateText(entry.projectId, 12)}
                      </td>
                      <td className="px-3 py-2 text-xs capitalize text-slate-600">
                        {entry.tier}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {truncateText(entry.subfeatureLabel, 32)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.model}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {formatTokens(entry.usagePromptTokens)} / {" "}
                        {formatTokens(entry.usageCompletionTokens)} / {" "}
                        {formatTokens(entry.usageTotalTokens)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.attempts}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold ${
                            entry.truncated
                              ? "bg-rose-100 text-rose-700"
                              : "bg-emerald-100 text-emerald-700"
                          }`}
                        >
                          {entry.truncated ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.guardSegments}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {entry.memoryVersion ?? "-"}
                      </td>
                    </tr>
                  ))}
                  {!logs.length && !isLoading ? (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-3 py-6 text-center text-xs text-slate-500"
                      >
                        No logs were found for the current filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-8 flex flex-1 flex-col">
          <h2 className="pb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Translation draft runs
          </h2>
          {isDraftError ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              {(draftError as Error)?.message ||
                "Failed to load translation draft runs."}
            </div>
          ) : null}
          {isLoadingDrafts ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Loading translation draft runs…
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Timestamp</th>
                    <th className="px-3 py-2 text-left">Project</th>
                    <th className="px-3 py-2 text-left">Model</th>
                    <th className="px-3 py-2 text-left">Verbosity / Effort</th>
                    <th className="px-3 py-2 text-left">Max tokens</th>
                    <th className="px-3 py-2 text-left">Attempts</th>
                    <th className="px-3 py-2 text-left">Retry count</th>
                    <th className="px-3 py-2 text-left">Truncated</th>
                    <th className="px-3 py-2 text-left">Fallback</th>
                    <th className="px-3 py-2 text-left">Tokens (prompt / output)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {drafts.map((run) => {
                    const attemptCount = run.attempts ?? run.retryCount + 1;
                    return (
                      <tr key={run.id} className="text-slate-700">
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                          {formatDateTime(run.finishedAt ?? run.updatedAt)}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {truncateText(run.projectId, 12)}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {run.model ?? "-"}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {`${run.verbosity ?? "-"} / ${run.reasoningEffort ?? "-"}`}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {run.maxOutputTokens?.toLocaleString() ?? "-"}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {attemptCount}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {run.retryCount}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span
                            className={`rounded-full px-2 py-0.5 font-semibold ${
                              run.truncated
                                ? "bg-rose-100 text-rose-700"
                                : "bg-emerald-100 text-emerald-700"
                            }`}
                          >
                            {run.truncated ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span
                            className={`rounded-full px-2 py-0.5 font-semibold ${
                              run.fallbackModelUsed
                                ? "bg-amber-100 text-amber-700"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {run.fallbackModelUsed ? "Used" : "Primary"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {formatTokens(run.usageInputTokens)} / {" "}
                          {formatTokens(run.usageOutputTokens)}
                        </td>
                      </tr>
                    );
                  })}
                  {!drafts.length && !isLoadingDrafts ? (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-3 py-6 text-center text-xs text-slate-500"
                      >
                        No translation draft runs were found for the current filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );

  return <AppShell right={rightPanel}>{content}</AppShell>;
};
