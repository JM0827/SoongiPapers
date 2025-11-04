import type { ProjectMemory } from "../../agents/translation";
import { query } from "../../db";

export interface ProjectMemoryRecord {
  project_id: string;
  memory: ProjectMemory;
  version: number;
  updated_at: Date;
}

function createBaseMemory(seed?: Partial<ProjectMemory>): ProjectMemory {
  const baseTermMap: Partial<ProjectMemory["term_map"]> = seed?.term_map ?? {};
  return {
    style_profile: {
      register: seed?.style_profile?.register ?? "literary",
      rhythm: seed?.style_profile?.rhythm ?? "balanced",
      avg_sentence_tokens: seed?.style_profile?.avg_sentence_tokens ?? 18,
    },
    time_period: seed?.time_period,
    character_sheet: seed?.character_sheet ?? [],
    named_entities: seed?.named_entities ?? [],
    symbol_table: seed?.symbol_table ?? {},
    term_map: {
      source_to_target: baseTermMap.source_to_target ?? {},
      target_to_source: baseTermMap.target_to_source ?? {},
      units: baseTermMap.units ?? {},
    },
    linguistic_features: seed?.linguistic_features ?? {},
    romanizationPolicy: seed?.romanizationPolicy ?? "as-is",
    scene_summaries: seed?.scene_summaries ?? {},
  } satisfies ProjectMemory;
}

function mergeMemory(
  base: ProjectMemory,
  patch: Partial<ProjectMemory>,
): ProjectMemory {
  const merged: ProjectMemory = {
    ...base,
    ...patch,
    style_profile: {
      ...base.style_profile,
      ...(patch.style_profile ?? {}),
    },
    term_map: {
      source_to_target: {
        ...base.term_map.source_to_target,
        ...(patch.term_map?.source_to_target ?? {}),
      },
      target_to_source: {
        ...base.term_map.target_to_source,
        ...(patch.term_map?.target_to_source ?? {}),
      },
      units: {
        ...base.term_map.units,
        ...(patch.term_map?.units ?? {}),
      },
    },
    symbol_table: {
      ...base.symbol_table,
      ...(patch.symbol_table ?? {}),
    },
    named_entities: patch.named_entities ?? base.named_entities,
    character_sheet: patch.character_sheet ?? base.character_sheet,
    linguistic_features: {
      source: {
        ...(base.linguistic_features?.source ?? {}),
        ...(patch.linguistic_features?.source ?? {}),
      },
      target: {
        ...(base.linguistic_features?.target ?? {}),
        ...(patch.linguistic_features?.target ?? {}),
      },
    },
    scene_summaries: {
      ...(base.scene_summaries ?? {}),
      ...(patch.scene_summaries ?? {}),
    },
  };

  if (!merged.romanizationPolicy && base.romanizationPolicy) {
    merged.romanizationPolicy = base.romanizationPolicy;
  }

  return merged;
}

export async function getCurrentMemoryRecord(
  projectId: string,
): Promise<ProjectMemoryRecord | null> {
  const { rows } = await query(
    `SELECT project_id, memory, version, updated_at
       FROM translation_memory
      WHERE project_id = $1
      LIMIT 1`,
    [projectId],
  );
  if (!rows.length) {
    return null;
  }
  const row = rows[0];
  return {
    project_id: row.project_id as string,
    memory: row.memory as ProjectMemory,
    version: Number(row.version ?? 1),
    updated_at: row.updated_at as Date,
  };
}

export async function fetchProjectMemory(
  projectId: string,
  memoryVersion: number,
): Promise<ProjectMemory | null> {
  try {
    if (!projectId) {
      return null;
    }

    if (memoryVersion > 0) {
      const versioned = await query(
        `SELECT memory
           FROM translation_memory_versions
          WHERE project_id = $1 AND version = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [projectId, memoryVersion],
      );
      const versionedMemory = versioned.rows?.[0]?.memory as
        | ProjectMemory
        | undefined;
      if (versionedMemory) {
        return versionedMemory;
      }
    }

    const current = await query(
      `SELECT memory
         FROM translation_memory
        WHERE project_id = $1
        LIMIT 1`,
      [projectId],
    );
    const latestMemory = current.rows?.[0]?.memory as ProjectMemory | undefined;
    return latestMemory ?? null;
  } catch (error) {
    console.warn("[TRANSLATION] Failed to fetch project memory", {
      projectId,
      memoryVersion,
      error,
    });
    return null;
  }
}

export async function writeProjectMemory(
  projectId: string,
  memory: ProjectMemory,
): Promise<ProjectMemoryRecord> {
  const { rows } = await query(
    `INSERT INTO translation_memory (project_id, memory, version)
       VALUES ($1, $2, 1)
       ON CONFLICT (project_id)
       DO UPDATE SET
         memory = EXCLUDED.memory,
         version = translation_memory.version + 1,
         updated_at = NOW()
       RETURNING project_id, memory, version, updated_at`,
    [projectId, memory],
  );

  const record = rows[0] as ProjectMemoryRecord;

  await query(
    `INSERT INTO translation_memory_versions (project_id, version, memory)
       VALUES ($1, $2, $3)`,
    [record.project_id, record.version, record.memory],
  );

  return record;
}

export async function ensureProjectMemory(
  projectId: string,
  seed?: Partial<ProjectMemory>,
): Promise<ProjectMemoryRecord> {
  const existing = await getCurrentMemoryRecord(projectId);
  if (existing) {
    return existing;
  }
  const base = createBaseMemory(seed);
  return writeProjectMemory(projectId, base);
}

export async function mergeProjectMemory(
  projectId: string,
  patch: Partial<ProjectMemory>,
): Promise<ProjectMemoryRecord> {
  const current = await getCurrentMemoryRecord(projectId);
  const base = current?.memory ?? createBaseMemory();
  const merged = mergeMemory(base, patch);
  return writeProjectMemory(projectId, merged);
}
