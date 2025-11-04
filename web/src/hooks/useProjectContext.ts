import { useCallback, useMemo, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectStore } from "../store/project.store";
import { useUIStore } from "../store/ui.store";
import {
  projectKeys,
  useProjectContent,
  useProjectJobs,
} from "./useProjectData";
import type { ProjectContextSnapshotPayload } from "../types/domain";
import { isOriginPrepReady } from "../lib/originPrep";

export type ProjectContextSnapshot = ProjectContextSnapshotPayload;

const truncateText = (value: string | null | undefined, limit = 240) => {
  if (!value) return null;
  const condensed = value.replace(/\s+/g, " ").trim();
  if (!condensed) return null;
  return condensed.length > limit ? `${condensed.slice(0, limit)}…` : condensed;
};

const readRecordString = (source: unknown, key: string): string | null => {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
};

const pickString = (
  ...values: Array<string | null | undefined>
): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
};

const buildSnapshot = (params: {
  projectId: string | null;
  projectTitle: string | null;
  projectTargetLang: string | null;
  content: ReturnType<typeof useProjectContent>["data"];
  jobs: ReturnType<typeof useProjectJobs>["data"];
  uiState: {
    rightPanelTab: string;
  };
}): ProjectContextSnapshot => {
  const { projectId, projectTitle, projectTargetLang, content, jobs, uiState } =
    params;
  const originMeta = content?.content?.origin ?? null;
  const translationMeta = content?.content?.translation ?? null;
  const originPrep = content?.originPrep ?? null;
  const latestJobRaw = content?.latestJob ?? null;
  const proofreadingMeta = content?.proofreading ?? null;
  const qualityMeta = content?.qualityAssessment ?? null;
  const ebookMeta = content?.ebook ?? null;

  const translationJobs = (jobs ?? []).filter(
    (job) => job.type === "translate",
  );
  const activeJob =
    translationJobs.find(
      (job) => job.status === "running" || job.status === "queued",
    ) ?? null;
  const batches = activeJob?.batches ?? [];
  const completed =
    batches.filter((batch) => batch.status === "done").length || null;
  const total = batches.length || null;

  const originUpdatedAt = pickString(
    originMeta?.timestamp,
    readRecordString(originMeta, "updatedAt"),
    readRecordString(originMeta, "updated_at"),
  );
  const translationUpdatedAt = pickString(
    translationMeta?.timestamp,
    readRecordString(translationMeta, "updatedAt"),
    readRecordString(translationMeta, "updated_at"),
  );

  let translationStage:
    | "none"
    | "origin-only"
    | "translating"
    | "translated"
    | "failed" = "none";
  let translationJobId: string | null = null;
  if (originMeta?.content?.trim()) {
    translationStage = "origin-only";
  }
  const latestJobType =
    (typeof latestJobRaw?.type === "string" && latestJobRaw.type) ||
    readRecordString(latestJobRaw, "jobType") ||
    "translate";
  const latestJob =
    latestJobRaw && latestJobType === "translate" ? latestJobRaw : null;

  if (latestJob) {
    translationJobId =
      latestJob.jobId ?? readRecordString(latestJob, "id") ?? null;
    const status =
      latestJob.status ?? readRecordString(latestJob, "stage") ?? "";
    if (typeof status === "string") {
      const normalized = status.toLowerCase();
      if (normalized.includes("fail")) translationStage = "failed";
      else if (normalized === "done" || normalized.includes("complete"))
        translationStage = "translated";
      else translationStage = "translating";
    }
  }

  const proofreadingStatusRaw = (proofreadingMeta?.stage ??
    proofreadingMeta?.status ??
    "") as string;
  let proofreadingStage:
    | "none"
    | "running"
    | "queued"
    | "done"
    | "failed"
    | "unknown" = "none";
  if (proofreadingStatusRaw) {
    const normalized = proofreadingStatusRaw.toLowerCase();
    if (normalized.includes("running")) proofreadingStage = "running";
    else if (normalized.includes("queue")) proofreadingStage = "queued";
    else if (normalized.includes("done") || normalized.includes("complete"))
      proofreadingStage = "done";
    else if (normalized.includes("fail")) proofreadingStage = "failed";
    else proofreadingStage = "unknown";
  }

  const qualityStage: "none" | "running" | "done" | "failed" = (() => {
    if (!qualityMeta) return "none";
    const status = (qualityMeta.status ?? "") as string;
    if (status) {
      const normalized = status.toLowerCase();
      if (normalized.includes("run")) return "running";
      if (normalized.includes("fail")) return "failed";
    }
    return "done";
  })();

  const publishingStage: "none" | "exporting" | "exported" = (() => {
    const status = ebookMeta?.status ?? readRecordString(ebookMeta, "status");
    if (!status) return "none";
    const normalized = typeof status === "string" ? status.toLowerCase() : "";
    if (normalized.includes("export") && !normalized.includes("done"))
      return "exporting";
    if (
      normalized.includes("done") ||
      normalized.includes("complete") ||
      normalized.includes("ready")
    )
      return "exported";
    return "none";
  })();

  const timeline: ProjectContextSnapshot["timeline"] = [];
  const originTimelineState = (() => {
    const filenameNote = (() => {
      if (originMeta?.filename) return originMeta.filename;
      const camel = (originMeta as { fileName?: string | null } | null)?.fileName;
      if (camel) return camel;
      const legacy = (originMeta as { original_filename?: string | null } | null)
        ?.original_filename;
      return legacy ?? undefined;
    })();
    const analysisUpdatedAt =
      originPrep?.analysis.updatedAt ??
      originPrep?.analysis.job?.updatedAt ??
      null;
    const notesUpdatedAt = originPrep?.notes.updatedAt ?? null;

    if (!originPrep) {
      return {
        status: originMeta?.content?.trim()
          ? "origin-uploaded"
          : "origin-upload-pending",
        updatedAt: originMeta?.content?.trim() ? originUpdatedAt : null,
        note: filenameNote,
      };
    }

    if (originPrep.analysis.status === "running") {
      return {
        status: "origin-analysis-running",
        updatedAt: analysisUpdatedAt,
        note: originPrep.analysis.job?.jobId ?? filenameNote,
      };
    }

    if (
      originPrep.analysis.status === "stale" ||
      originPrep.notes.status === "stale"
    ) {
      return {
        status: "origin-analysis-stale",
        updatedAt: analysisUpdatedAt,
        note: filenameNote,
      };
    }

    if (
      originPrep.analysis.status === "missing" &&
      originPrep.upload.status === "uploaded"
    ) {
      return {
        status: "origin-analysis-pending",
        updatedAt: originPrep.upload.updatedAt ?? originUpdatedAt,
        note: filenameNote,
      };
    }

    if (isOriginPrepReady(originPrep)) {
      return {
        status: "origin-ready",
        updatedAt: notesUpdatedAt ?? analysisUpdatedAt ?? originUpdatedAt,
        note: filenameNote,
      };
    }

    return {
      status: "origin-uploaded",
      updatedAt: originPrep.upload.updatedAt ?? originUpdatedAt,
      note: filenameNote,
    };
  })();

  timeline.push({
    phase: "origin",
    status: originTimelineState.status,
    updatedAt: originTimelineState.updatedAt,
    note: originTimelineState.note,
  });
  if (translationStage !== "none" && translationStage !== "origin-only") {
    timeline.push({
      phase: "translation",
      status: translationStage,
      updatedAt:
        translationUpdatedAt ??
        latestJob?.updatedAt ??
        readRecordString(latestJob, "updated_at") ??
        null,
      note:
        translationStage === "translating"
          ? `${completed ?? 0}/${total ?? 0} batches complete`
          : translationStage === "failed"
            ? "translation job reported a failure"
            : undefined,
    });
  }
  if (proofreadingStage !== "none") {
    timeline.push({
      phase: "proofreading",
      status: proofreadingStage,
      updatedAt:
        proofreadingMeta?.timestamp ??
        readRecordString(proofreadingMeta, "updated_at") ??
        null,
      note: proofreadingMeta?.stageDetail ?? undefined,
    });
  }
  if (qualityStage !== "none") {
    timeline.push({
      phase: "quality",
      status: qualityStage,
      updatedAt: qualityMeta?.timestamp ?? null,
      note:
        typeof qualityMeta?.overallScore === "number"
          ? `score=${qualityMeta.overallScore}`
          : undefined,
    });
  }
  if (publishingStage !== "none") {
    timeline.push({
      phase: "publishing",
      status: publishingStage,
      updatedAt:
        ebookMeta?.updatedAt ??
        readRecordString(ebookMeta, "finishedAt") ??
        readRecordString(ebookMeta, "finished_at") ??
        null,
      note: ebookMeta?.ebookId ?? undefined,
    });
  }

  return {
    projectId,
    projectTitle,
    targetLang: projectTargetLang,
    lifecycle: {
      translation: {
        stage: translationStage,
        lastUpdatedAt:
          translationUpdatedAt ??
          latestJob?.updatedAt ??
          readRecordString(latestJob, "updated_at") ??
          null,
        jobId: translationJobId,
      },
      proofreading: {
        stage: proofreadingStage,
        lastUpdatedAt:
          proofreadingMeta?.timestamp ??
          readRecordString(proofreadingMeta, "updated_at") ??
          null,
        jobId: (proofreadingMeta?.jobId ?? proofreadingMeta?.job_id ?? null) as
          | string
          | null,
      },
      quality: {
        stage: qualityStage,
        lastUpdatedAt: qualityMeta?.timestamp ?? null,
        score:
          typeof qualityMeta?.overallScore === "number"
            ? qualityMeta.overallScore
            : null,
      },
      publishing: {
        stage: publishingStage,
        lastUpdatedAt:
          ebookMeta?.updatedAt ??
          readRecordString(ebookMeta, "finishedAt") ??
          readRecordString(ebookMeta, "finished_at") ??
          null,
        ebookId: ebookMeta?.ebookId ?? null,
      },
    },
    timeline,
    origin: {
      hasContent: Boolean(originMeta?.content?.trim?.()),
      lastUpdatedAt: originUpdatedAt,
      filename:
        originMeta?.filename ??
        (originMeta as { fileName?: string | null } | null)?.fileName ??
        (originMeta as { original_filename?: string | null } | null)
          ?.original_filename ??
        null,
    },
    translation: {
      hasContent: Boolean(translationMeta?.content?.trim?.()),
      lastUpdatedAt: translationUpdatedAt,
    },
    originPrep,
    excerpts: {
      originPreview: truncateText(originMeta?.content),
      translationPreview: truncateText(translationMeta?.content),
    },
    ui: uiState,
    jobs: {
      status:
        activeJob?.status ?? readRecordString(activeJob, "status") ?? null,
      activeJobId: activeJob?.id ?? readRecordString(activeJob, "id") ?? null,
      lastCheckedAt: activeJob ? Date.now() : null,
      batchesCompleted: completed,
      batchesTotal: total,
    },
    refreshedAt: Date.now(),
  };
};

export const useProjectContext = () => {
  const projectId = useProjectStore((state) => state.activeProjectId);
  const projectTitle = useProjectStore((state) => state.activeProjectName);
  const projects = useProjectStore((state) => state.projects);
  const setActiveProjectName = useProjectStore(
    (state) => state.setActiveProjectName,
  );
  const rightPanelTab = useUIStore((state) => state.rightPanelTab);
  const queryClient = useQueryClient();

  const projectSummary = useMemo(
    () => projects.find((project) => project.project_id === projectId) ?? null,
    [projects, projectId],
  );

  useEffect(() => {
    if (!projectId && projectTitle) {
      setActiveProjectName(null);
    }
  }, [projectId, projectTitle, setActiveProjectName]);

  const { data: content, isLoading: isContentLoading } =
    useProjectContent(projectId);
  const { data: jobs, isLoading: isJobsLoading } = useProjectJobs(projectId);

  const normalizedContent = useMemo(() => {
    if (!content) return null;
    if (projectId && content.projectId && content.projectId !== projectId) {
      return null;
    }
    return content;
  }, [content, projectId]);

  const contentRefreshRef = useRef<Promise<void> | null>(null);
  const jobsRefreshRef = useRef<Promise<void> | null>(null);

  const snapshot = useMemo(() => {
    if (!projectId || !projectSummary) {
      return buildSnapshot({
        projectId: null,
        projectTitle: null,
        projectTargetLang: null,
        content: null,
        jobs: [],
        uiState: {
          rightPanelTab,
        },
      });
    }

    return buildSnapshot({
      projectId,
      projectTitle: projectTitle ?? projectSummary?.title ?? null,
      projectTargetLang: projectSummary?.target_lang ?? null,
      content: normalizedContent,
      jobs: jobs ?? [],
      uiState: {
        rightPanelTab,
      },
    });
  }, [
    projectId,
    projectTitle,
    projectSummary,
    normalizedContent,
    jobs,
    rightPanelTab,
  ]);

  const refreshContent = useCallback(async () => {
    if (!projectId) return;
    if (contentRefreshRef.current) {
      await contentRefreshRef.current;
      return;
    }
    const promise = queryClient
      .refetchQueries({ queryKey: projectKeys.content(projectId), exact: true })
      .then(() => undefined)
      .finally(() => {
        contentRefreshRef.current = null;
      });
    contentRefreshRef.current = promise;
    await promise;
  }, [projectId, queryClient]);

  const refreshJobs = useCallback(async () => {
    if (!projectId) return;
    if (jobsRefreshRef.current) {
      await jobsRefreshRef.current;
      return;
    }
    const promise = queryClient
      .refetchQueries({ queryKey: projectKeys.jobs(projectId), exact: true })
      .then(() => undefined)
      .finally(() => {
        jobsRefreshRef.current = null;
      });
    jobsRefreshRef.current = promise;
    await promise;
  }, [projectId, queryClient]);

  const refresh = useCallback(
    async (scope: "content" | "jobs" | "all" = "all") => {
      if (!projectId) return;
      if (scope === "content") {
        await refreshContent();
        return;
      }
      if (scope === "jobs") {
        await refreshJobs();
        return;
      }
      await Promise.all([refreshContent(), refreshJobs()]);
    },
    [projectId, refreshContent, refreshJobs],
  );

  return {
    snapshot,
    content: projectId ? normalizedContent : null,
    jobs: projectId ? (jobs ?? []) : [],
    refresh,
    isLoading: isContentLoading || isJobsLoading,
    isContentLoading,
    isJobsLoading,
  };
};
