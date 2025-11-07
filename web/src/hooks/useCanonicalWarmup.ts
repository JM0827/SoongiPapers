import { useEffect } from "react";

import { api } from "../services/api";
import type { CanonicalCacheState } from "../types/domain";

const inflightWarmups = new Set<string>();

interface UseCanonicalWarmupParams {
  token: string | null;
  projectId: string | null;
  jobId: string | null;
  cacheState?: CanonicalCacheState | null;
}

export function useCanonicalWarmup({
  token,
  projectId,
  jobId,
  cacheState,
}: UseCanonicalWarmupParams) {
  useEffect(() => {
    const normalizedProjectId = projectId?.trim();
    const normalizedJobId = jobId?.trim();
    if (!token || !normalizedProjectId || !normalizedJobId) {
      return;
    }
    if (cacheState !== "missing") {
      if (cacheState === "ready") {
        inflightWarmups.delete(`${normalizedProjectId}:${normalizedJobId}`);
      }
      return;
    }

    const key = `${normalizedProjectId}:${normalizedJobId}`;
    if (inflightWarmups.has(key)) {
      return;
    }
    inflightWarmups.add(key);
    let canceled = false;

    void api
      .warmupCanonicalCache({
        token,
        projectId: normalizedProjectId,
        jobId: normalizedJobId,
      })
      .catch((error) => {
        console.warn("[canonicalWarmup] request failed", error);
        if (!canceled) {
          inflightWarmups.delete(key);
        }
      });

    return () => {
      canceled = true;
    };
  }, [token, projectId, jobId, cacheState]);
}
