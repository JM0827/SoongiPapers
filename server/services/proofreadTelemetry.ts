import type { ProofreadingLogEntry } from '../db/proofreadingLog';

const MAX_ENTRIES = 2000;
const telemetry: ProofreadingLogEntry[] = [];

export function recordProofreadLog(entry: ProofreadingLogEntry): void {
  telemetry.unshift(entry);
  if (telemetry.length > MAX_ENTRIES) {
    telemetry.length = MAX_ENTRIES;
  }
}

export function listProofreadLogsFromMemory(config: {
  projectId?: string;
  limit?: number;
}): ProofreadingLogEntry[] {
  const { projectId, limit } = config;
  const filtered = projectId
    ? telemetry.filter((entry) => entry.project_id === projectId)
    : telemetry;
  return filtered.slice(0, Math.max(0, limit ?? 100));
}
