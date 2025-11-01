import type { WorkflowSummary } from "./workflowManager";

export interface StatusSnapshot {
  translation?: string;
  proofreading?: string;
  quality?: string;
  anyRunning: boolean;
}

const statusLabel = (value: string | null | undefined) => {
  const normalized = (value ?? "idle").toLowerCase();
  switch (normalized) {
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "succeeded":
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return normalized || "idle";
  }
};

export const buildStatusSnapshot = (
  summary: WorkflowSummary | null,
): StatusSnapshot => {
  const defaults: StatusSnapshot = {
    translation: "translation: idle",
    proofreading: "proofreading: idle",
    quality: "quality: idle",
    anyRunning: false,
  };

  if (!summary) {
    return defaults;
  }

  const snapshot = { ...defaults };

  for (const state of summary.state ?? []) {
    const label = statusLabel(state.status);
    const decorated = state.label ? `${label} (${state.label})` : label;
    if (label === "running" || label === "pending") {
      snapshot.anyRunning = true;
    }
    switch (state.type) {
      case "translation":
        snapshot.translation = `translation: ${decorated}`;
        break;
      case "proofread":
        snapshot.proofreading = `proofreading: ${decorated}`;
        break;
      case "quality":
        snapshot.quality = `quality: ${decorated}`;
        break;
      default:
        break;
    }
  }

  return snapshot;
};

export const formatStatusSnapshotForLlm = (snapshot: StatusSnapshot): string =>
  [snapshot.translation, snapshot.proofreading, snapshot.quality].join(" | ");
