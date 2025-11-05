import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getMongoDoc, saveProofreadingDoc } from "../../db/mongo";
import { query } from "../../db";
import {
  insertHistory,
  updateHistory,
  markInProgressHistoryAsError,
  findProofreadRun,
  upsertProofreadRun,
  updateProofreadRunStatus,
} from "../../db/pg";
import { getProofreadingSpec } from "./proofreadingHelper";
import {
  runGenericWorker,
  buildProofreadingMemoryContext,
} from "./genericWorker";
import {
  splitSentencesByLang,
  alignBySpecAsync,
  makeBucketsFromSpec,
  pushItems,
  buildReportMeta,
  type AlignedPair,
} from "./utils";
import { filterBuckets, recomputeCounts } from "./postProcess";
import { SHARED_TRANSLATION_GUIDELINES } from "../prompts/sharedGuidelines";
import { getCurrentMemoryRecord } from "../../services/translation/memory";
import type { GuardFindingDetail } from "@bookko/translation-types";
import { normalizeTranslationNotes } from "../../models/DocumentProfile";
import type {
  IssueItem,
  ProofreadingLLMRunMeta,
  ProofreadingReport,
} from "./config";
import { insertProofreadingLog } from "../../db/proofreadingLog";
import type { AgentItemsResponseV2 } from "../../services/responsesSchemas";
import {
  emitProofreadComplete,
  emitProofreadError,
  emitProofreadPage,
  emitProofreadStage,
  emitProofreadTierSummary,
} from "../../services/proofreadEvents";
import { recordProofreadEvent } from "../../services/proofreadStreamMeta";

type Tier = "quick" | "deep";

type SubfeatureSpec = {
  key: string;
  label: string;
  enabled: boolean;
  tier?: Tier;
  model?: string;
  prompt: { system: string };
};

type GroupSpec = {
  name: string;
  subfeatures: SubfeatureSpec[];
};

type SegmentGuardEnvelope = {
  segmentId: string;
  segmentIndex: number;
  textSource: string;
  textTarget: string;
  normalizedTarget: string;
  guardFindings: GuardFindingDetail[];
  guards: Record<string, unknown> | null;
  needsReview: boolean;
};

const GUARD_MATCH_THRESHOLD = 0.35;

const normalizeForMatch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[“”‘’]/g, '"')
    .trim();

const computeHangulRatio = (value: string): number => {
  if (!value) return 0;
  const hangulMatches = value.match(/[가-힣]/g);
  const hangulCount = hangulMatches ? hangulMatches.length : 0;
  const letters = value.match(/[a-z가-힣]/gi);
  const letterCount = letters ? letters.length : 0;
  if (!letterCount) return 0;
  return hangulCount / letterCount;
};

export const sanitizeTargetExcerpt = (
  source: string,
  target: string,
): string | null => {
  if (!target) return null;
  const normalizedSource = normalizeForMatch(source);
  const normalizedTarget = normalizeForMatch(target);
  if (!normalizedTarget) return null;
  if (normalizedTarget === normalizedSource) return null;
  const hangulRatio = computeHangulRatio(normalizedTarget);
  if (hangulRatio >= 0.3) {
    const latinMatches = normalizedTarget.match(/[a-z]/g);
    const latinCount = latinMatches ? latinMatches.length : 0;
    if (latinCount < 5) return null;
  }
  return target;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeSeverity = (value: unknown): GuardFindingDetail["severity"] => {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return undefined;
};

const parseGuardFindings = (value: unknown): GuardFindingDetail[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const summary = typeof entry.summary === "string" ? entry.summary : null;
      if (!summary) return null;
      const mapped: GuardFindingDetail = {
        type: typeof entry.type === "string" ? entry.type : "unknown",
        summary,
        ok: entry.ok !== false,
        severity: "info",
        details: {},
      };
      const severity = normalizeSeverity(entry.severity);
      if (severity) {
        mapped.severity = severity;
      }
      if (typeof entry.segmentId === "string") {
        mapped.segmentId = entry.segmentId;
      }
      if (isRecord(entry.details)) {
        mapped.details = entry.details;
      }
      return mapped;
    })
    .filter((finding): finding is GuardFindingDetail => Boolean(finding));
};

const hasGuardIssues = (segment: SegmentGuardEnvelope): boolean => {
  if (segment.needsReview) return true;
  if (segment.guardFindings.length > 0) return true;
  if (segment.guards) {
    for (const value of Object.values(segment.guards)) {
      if (typeof value === "boolean" && value === false) {
        return true;
      }
    }
  }
  return false;
};

const computeMatchScore = (target: string, candidate: string): number => {
  if (!target || !candidate) return 0;
  if (target === candidate) return 1;
  if (candidate.includes(target) || target.includes(candidate)) {
    return 0.95;
  }

  const targetTokens = new Set(target.split(" ").filter(Boolean));
  const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
  if (!targetTokens.size || !candidateTokens.size) return 0;

  let matches = 0;
  targetTokens.forEach((token) => {
    if (candidateTokens.has(token)) matches += 1;
  });

  return matches / Math.max(targetTokens.size, candidateTokens.size, 1);
};

const collectGuardSegmentsForTarget = (
  targetText: string,
  segments: SegmentGuardEnvelope[],
): SegmentGuardEnvelope[] => {
  const normalized = normalizeForMatch(targetText);
  if (!normalized) return [];

  return segments
    .map((segment) => ({
      segment,
      score: hasGuardIssues(segment)
        ? computeMatchScore(normalized, segment.normalizedTarget)
        : 0,
    }))
    .filter(({ score }) => score >= GUARD_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ segment }) => segment);
};

async function loadSegmentGuards(
  jobId: string,
): Promise<SegmentGuardEnvelope[]> {
  const { rows } = await query(
    `SELECT segment_index,
            segment_id,
            text_source,
            text_target,
            guards,
            notes,
            needs_review
       FROM translation_drafts
      WHERE job_id = $1 AND stage = 'qa'
      ORDER BY segment_index ASC`,
    [jobId],
  );

  return rows
    .map((row) => {
      const segmentId =
        typeof row.segment_id === "string" ? row.segment_id : "";
      if (!segmentId) return null;
      const notes = isRecord(row.notes)
        ? (row.notes as Record<string, unknown>)
        : null;
      const guardFindingsSource = notes?.guardFindings ?? notes?.guard_findings;
      const guardFindings = parseGuardFindings(guardFindingsSource);
      const textSource =
        typeof row.text_source === "string" ? row.text_source : "";
      const rawTarget =
        typeof row.text_target === "string" ? row.text_target : "";
      const textTarget = sanitizeTargetExcerpt(textSource, rawTarget);
      if (!textTarget) return null;
      return {
        segmentId,
        segmentIndex: Number(row.segment_index ?? 0),
        textSource,
        textTarget,
        normalizedTarget: normalizeForMatch(textTarget),
        guardFindings,
        guards: isRecord(row.guards)
          ? (row.guards as Record<string, unknown>)
          : null,
        needsReview: row.needs_review === true,
      } satisfies SegmentGuardEnvelope;
    })
    .filter((segment): segment is SegmentGuardEnvelope => Boolean(segment));
}

function chunkAlignedPairs(pairs: AlignedPair[], maxSentences = 4) {
  if (maxSentences <= 1) return pairs;
  const chunks: AlignedPair[] = [];
  let working: AlignedPair[] = [];

  const flush = () => {
    if (!working.length) return;
    const krParts = working.map((p) => p.kr).filter(Boolean) as string[];
    const enParts = working.map((p) => p.en).filter(Boolean) as string[];
    if (!krParts.length || !enParts.length) {
      working = [];
      return;
    }
    chunks.push({
      kr: krParts.join("\n\n"),
      en: enParts.join("\n\n"),
      kr_id: working[0].kr_id,
      en_id: working[0].en_id,
    });
    working = [];
  };

  for (const pair of pairs) {
    working.push(pair);
    if (working.length >= maxSentences) {
      flush();
    }
  }

  flush();
  return chunks.length ? chunks : pairs;
}

type ProofreadingStageData = {
  proofreading_id: string;
  run_id: string;
  tier: Tier;
  key: string;
  label: string;
  status: "queued" | "in_progress" | "done" | "error";
  itemCount?: number;
  message?: string;
};

type ProofreadingItemsData = {
  proofreading_id: string;
  run_id: string;
  tier: Tier;
  key: string;
  chunkIndex: number;
  page: AgentItemsResponseV2;
};

type ProofreadingTierSummaryData = {
  proofreading_id: string;
  run_id: string;
  tier: Tier;
  summary: Record<string, unknown> | null;
  itemCount?: number;
};

type ProofreadingCompleteData = {
  proofreading_id: string;
  run_id: string;
  summary: ProofreadingReport | null;
  scope?: string;
};

type ProofreadingErrorData = {
  proofreading_id: string;
  run_id: string;
  stage?: string | null;
  message: string;
  retryable?: boolean;
  reason?: string | null;
};

type ProofreadingDuplicateData = {
  status: string;
  run_id: string;
};

export type ProofreadingProgressEvent =
  | { type: "stage"; data: ProofreadingStageData }
  | { type: "items"; data: ProofreadingItemsData }
  | { type: "tier_complete"; data: ProofreadingTierSummaryData }
  | { type: "complete"; data: ProofreadingCompleteData }
  | { type: "error"; data: ProofreadingErrorData }
  | { type: "duplicate"; data: ProofreadingDuplicateData };

export async function runProofreading(
  project_id: string,
  job_id: string,
  onProgress?: (event: ProofreadingProgressEvent) => void,
  options?: { includeDeep?: boolean },
) {
  const doc = await getMongoDoc(project_id, job_id);
  const { origin_content, translated_content } = doc;
  const translationFileId = doc?.raw?._id ? String(doc.raw._id) : null;
  if (!translationFileId) {
    throw new Error("Translation file identifier missing for proofreading.");
  }

  const finalTextHash = createHash("sha256")
    .update(translated_content)
    .digest("hex");

  const memoryRecord = await getCurrentMemoryRecord(project_id);
  const memoryVersion = memoryRecord?.version ?? null;
  const translationNotes = normalizeTranslationNotes(
    (doc.raw as { translation_notes?: unknown })?.translation_notes ?? null,
  );
  const memoryContext = buildProofreadingMemoryContext({
    memory: memoryRecord?.memory ?? null,
    translationNotes,
    version: memoryVersion,
  });

  const existingRun = await findProofreadRun({
    projectId: project_id,
    translationFileId,
    memoryVersion,
    finalTextHash,
  });

  if (
    existingRun &&
    (existingRun.status === "running" || existingRun.status === "completed")
  ) {
    onProgress?.({
      type: "duplicate",
      data: {
        status: existingRun.status,
        run_id: String(existingRun.id),
      },
    });
    return {
      proofreading_id: String(existingRun.id),
      report: null,
    };
  }

  const proofreadRunRecord = await upsertProofreadRun({
    projectId: project_id,
    translationFileId,
    memoryVersion,
    finalTextHash,
    status: "running",
  });
  const proofreadRunId = String(proofreadRunRecord.id);

  const guardSegments = await loadSegmentGuards(job_id);

  const llmRuns: ProofreadingLLMRunMeta[] = [];
  const tierRunMeta: Partial<Record<Tier, ProofreadingLLMRunMeta[]>> = {};
  const ensureTierRuns = (tier: Tier): ProofreadingLLMRunMeta[] => {
    if (!tierRunMeta[tier]) {
      tierRunMeta[tier] = [];
    }
    return tierRunMeta[tier]!;
  };

  const proofreading_id = uuidv4();
  await markInProgressHistoryAsError(project_id, job_id);
  await insertHistory({
    project_id,
    job_id,
    proofreading_id,
    status: "requested",
  });
  await updateHistory({ proofreading_id, status: "inprogress" });

  const proofreadStreamId = proofreadRunId;
  const emit = (event: ProofreadingProgressEvent) => {
    onProgress?.(event);

    switch (event.type) {
      case "stage": {
        const data = event.data;
        emitProofreadStage({
          projectId: project_id,
          runId: proofreadStreamId,
          proofreadingId: data.proofreading_id,
          stage: data.key ?? data.label ?? data.tier ?? "stage",
          status: data.status,
          label: data.label,
          itemCount: data.itemCount ?? null,
          tier: data.tier ?? null,
          key: data.key ?? null,
          message: data.message ?? null,
        });
        recordProofreadEvent({
          projectId: project_id,
          runId: proofreadStreamId,
          type: "stage",
        });
        break;
      }
      case "items": {
        const data = event.data;
        emitProofreadPage({
          projectId: project_id,
          runId: proofreadStreamId,
          proofreadingId: data.proofreading_id,
          tier: data.tier ?? null,
          key: data.key ?? null,
          chunkIndex: data.chunkIndex ?? null,
          envelope: data.page,
        });
        recordProofreadEvent({
          projectId: project_id,
          runId: proofreadStreamId,
          type: "items",
        });
        break;
      }
      case "tier_complete": {
        const data = event.data;
        emitProofreadTierSummary({
          projectId: project_id,
          runId: proofreadStreamId,
          proofreadingId: data.proofreading_id,
          tier: data.tier,
          summary: data.summary,
          itemCount: data.itemCount ?? null,
          completedAt: new Date().toISOString(),
        });
        recordProofreadEvent({
          projectId: project_id,
          runId: proofreadStreamId,
          type: "tier",
        });
        break;
      }
      case "complete": {
        const data = event.data;
        emitProofreadComplete({
          projectId: project_id,
          runId: proofreadStreamId,
          proofreadingId: data.proofreading_id,
          completedAt: new Date().toISOString(),
          summary:
            data.summary && typeof data.summary === "object"
              ? (data.summary as Record<string, unknown>)
              : null,
          scope: data.scope ?? "run",
        });
        recordProofreadEvent({
          projectId: project_id,
          runId: proofreadStreamId,
          type: "complete",
        });
        break;
      }
      case "error": {
        const data = event.data;
        emitProofreadError({
          projectId: project_id,
          runId: proofreadStreamId,
          proofreadingId: data.proofreading_id,
          stage: data.stage ?? null,
          message: data.message,
          retryable: data.retryable ?? false,
          reason: data.reason ?? null,
        });
        recordProofreadEvent({
          projectId: project_id,
          runId: proofreadStreamId,
          type: "error",
        });
        break;
      }
      case "duplicate":
      default:
        break;
    }
  };

  try {
    const spec = await getProofreadingSpec(project_id, job_id);
    const includeDeep = options?.includeDeep ?? false;

    const koSent = splitSentencesByLang(origin_content, spec.language.source);
    const enSent = splitSentencesByLang(
      translated_content,
      spec.language.target,
    );
    const aligned = await alignBySpecAsync(spec, koSent, enSent);

    const buckets = makeBucketsFromSpec(spec);

    const groups = spec.groups as GroupSpec[];
    const enabledSubfeatures = groups
      .flatMap((group) =>
        group.subfeatures.map((sf) => ({ ...sf, group: group.name })),
      )
      .filter(
        (sf) =>
          sf.enabled ||
          (includeDeep && (sf.tier as Tier | undefined) === "deep"),
      );

  const tierReports: Partial<Record<Tier, ProofreadingReport>> = {};
  const tierMetrics: Partial<
    Record<
      Tier,
      {
        downshift: number;
        forcedPagination: number;
        cursorRetry: number;
      }
    >
  > = {};

    const quickSubfeatures = enabledSubfeatures.filter(
      (sf) => (sf.tier as Tier | undefined) === "quick",
    );
    const deepSubfeatures = includeDeep
      ? enabledSubfeatures.filter(
          (sf) => (sf.tier as Tier | undefined) !== "quick",
        )
      : [];

    const quickKeys = new Set(quickSubfeatures.map((sf) => sf.key));
    const deepKeys = new Set(deepSubfeatures.map((sf) => sf.key));

    const quickPairs = chunkAlignedPairs(
      aligned,
      Math.max(1, spec.runtime.quickChunkSize ?? 4),
    );
    const deepPairs = chunkAlignedPairs(
      aligned,
      Math.max(1, spec.runtime.deepChunkSize ?? 2),
    );

    const handshakeSubfeature =
      quickSubfeatures[0] ?? enabledSubfeatures[0] ?? null;
    const startedStageKeys = new Set<string>();
    if (handshakeSubfeature) {
      const tierLabel =
        (handshakeSubfeature.tier as Tier | undefined) === "deep"
          ? "deep"
          : "quick";
      const stageKey = handshakeSubfeature.key ?? "proofreading_handshake";
      emit({
        type: "stage",
        data: {
          proofreading_id,
          run_id: proofreadStreamId,
          tier: tierLabel,
          key: stageKey,
          label:
            handshakeSubfeature.label ??
            handshakeSubfeature.key ??
            "Proofreading",
          status: "in_progress",
        },
      });
      startedStageKeys.add(`${tierLabel}:${stageKey}`);
    }

    const processSubfeatures = async (
      tier: Tier,
      subfeatures: typeof quickSubfeatures,
      pairs: AlignedPair[],
    ) => {
      tierMetrics[tier] = tierMetrics[tier] ?? {
        downshift: 0,
        forcedPagination: 0,
        cursorRetry: 0,
      };

      await Promise.all(
        subfeatures.map(async (sf) => {
          const stageKey = `${tier}:${sf.key ?? sf.label ?? "stage"}`;
          if (!startedStageKeys.has(stageKey)) {
            emit({
              type: "stage",
              data: {
                proofreading_id,
                run_id: proofreadStreamId,
                tier,
                key: sf.key,
                label: sf.label,
                status: "in_progress",
              },
            });
            startedStageKeys.add(stageKey);
          }

          const subItems: IssueItem[] = [];
          const tierRuns = ensureTierRuns(tier);
          const tierMetric = tierMetrics[tier]!;
          let pagesEmitted = 0;
          let itemsEmitted = 0;

          try {
            await Promise.all(
              pairs.map(async (pair, chunkIndex) => {
                if (!pair.kr || !pair.en) return;
                const matchedSegments = collectGuardSegmentsForTarget(
                  pair.en ?? "",
                  guardSegments,
                );
                const requiresReview = matchedSegments.some((segment) =>
                  hasGuardIssues(segment),
                );
                if (
                  tier === "quick" &&
                  guardSegments.length > 0 &&
                  matchedSegments.length > 0 &&
                  !requiresReview
                ) {
                  return;
                }
                const guardContext = matchedSegments.length
                  ? {
                      segments: matchedSegments.map((segment) => ({
                        segment_id: segment.segmentId,
                        segment_index: segment.segmentIndex,
                        needs_review: segment.needsReview,
                        guard_findings: segment.guardFindings,
                        guards: segment.guards,
                        source_excerpt: segment.textSource,
                        target_excerpt: segment.textTarget,
                      })),
                    }
                  : undefined;

                let cursor: string | null = null;
                let iteration = 0;

                while (true) {
                  const { items, meta, pages } = await runGenericWorker({
                    model: sf.model ?? undefined,
                    systemPrompt: `${sf.prompt.system}\n\n${SHARED_TRANSLATION_GUIDELINES}`,
                    subKey: sf.key,
                    tier,
                    kr: pair.kr!,
                    en: pair.en!,
                    kr_id: pair.kr_id ?? null,
                    en_id: pair.en_id ?? null,
                    guardContext,
                    memoryContext,
                    cursor,
                  });

                  if (items.length) {
                    subItems.push(...items);
                  }

                  const downshiftAttempts = meta.attemptHistory.filter((attempt) =>
                    attempt.stage === "downshift" || attempt.stage === "minimal",
                  ).length;

                  if (downshiftAttempts > 0) {
                    tierMetric.downshift += downshiftAttempts;
                  }
                  if (meta.hasMore) {
                    tierMetric.forcedPagination += 1;
                  }
                  if (iteration > 0) {
                    tierMetric.cursorRetry += 1;
                  }

                  pages.forEach((page) => {
                    const normalizedPage = {
                      ...page,
                      metrics: {
                        downshift_count: page.metrics?.downshift_count ?? 0,
                        forced_pagination:
                          page.metrics?.forced_pagination ?? Boolean(page.has_more),
                        cursor_retry_count: iteration,
                      },
                      next_cursor: page.has_more
                        ? page.next_cursor ??
                          `continue:${sf.key}:${chunkIndex}:${iteration}`
                        : "",
                    };
                    emit({
                      type: "items",
                      data: {
                        proofreading_id,
                        run_id: proofreadStreamId,
                        tier,
                        key: sf.key,
                        chunkIndex,
                        page: normalizedPage,
                      },
                    });
                    pagesEmitted += 1;
                    itemsEmitted += normalizedPage.items.length;
                    console.info(
                      `[ProofSSE] EMIT items tier=${tier} key=${sf.key ?? ""} chunk=${chunkIndex} page=${pagesEmitted} items=${normalizedPage.items.length}`,
                    );
                  });

                  const runMeta: ProofreadingLLMRunMeta = {
                    tier,
                    subfeatureKey: sf.key,
                    subfeatureLabel: sf.label,
                    chunkIndex,
                    model: meta.model,
                    maxOutputTokens: meta.maxOutputTokens,
                    attempts: meta.attempts,
                    truncated: meta.truncated,
                    requestId: meta.requestId,
                    usage: meta.usage,
                    verbosity: meta.verbosity,
                    reasoningEffort: meta.reasoningEffort,
                    guardSegments: meta.guardSegments,
                    memoryContextVersion: meta.memoryContextVersion,
                    downshiftCount: downshiftAttempts,
                    forcedPaginationCount: meta.hasMore ? 1 : 0,
                    cursorRetryCount: iteration,
                  };
                  tierRuns.push(runMeta);
                  llmRuns.push(runMeta);

                  if (spec.runtime?.debugLogging) {
                    const summary = {
                      tier,
                      subfeatureKey: sf.key,
                      chunkIndex,
                      model: meta.model,
                      maxOutputTokens: meta.maxOutputTokens,
                      attempts: meta.attempts,
                      truncated: meta.truncated,
                      guardSegments: meta.guardSegments,
                      memoryVersion,
                      requestId: meta.requestId,
                      usage: meta.usage,
                      schemaVersion: meta.schemaVersion,
                      runId: meta.runId,
                      hasMore: meta.hasMore,
                      nextCursor: meta.nextCursor,
                      latencyMs: meta.latencyMs,
                      pageCount: meta.pageCount,
                      downshiftAttempts,
                      forcedPagination: meta.hasMore ? 1 : 0,
                      cursorIteration: iteration,
                    };
                    console.info(
                      "[proofreading] llm run",
                      JSON.stringify({
                        projectId: project_id,
                        jobId: job_id,
                        proofreadingId: proofreading_id,
                        run: summary,
                      }),
                    );
                  }

                  try {
                    await insertProofreadingLog({
                      projectId: project_id,
                      jobId: job_id,
                      proofreadingId: proofreading_id,
                      runId: proofreadRunId,
                      tier,
                      subfeatureKey: sf.key,
                      subfeatureLabel: sf.label,
                      chunkIndex,
                      meta: {
                        model: meta.model,
                        maxOutputTokens: meta.maxOutputTokens,
                        attempts: meta.attempts,
                        truncated: meta.truncated,
                        requestId: meta.requestId,
                        guardSegments: meta.guardSegments,
                        memoryContextVersion: meta.memoryContextVersion,
                        usage: meta.usage,
                        verbosity: meta.verbosity,
                        reasoningEffort: meta.reasoningEffort,
                        downshiftAttempts,
                        forcedPagination: meta.hasMore ? 1 : 0,
                        cursorRetry: iteration,
                      },
                    });
                  } catch (error) {
                    console.error(
                      "[proofreading] failed to record llm run",
                      JSON.stringify({
                        projectId: project_id,
                        jobId: job_id,
                        proofreadingId: proofreading_id,
                        tier,
                        subfeatureKey: sf.key,
                        chunkIndex,
                        error:
                          error instanceof Error ? error.message : String(error),
                      }),
                    );
                  }

                  if (meta.hasMore && meta.nextCursor) {
                    cursor = meta.nextCursor;
                    iteration += 1;
                    continue;
                  }

                  break;
                }
              }),
            );

            const decoratedItems = subItems.map((item) => ({
              ...item,
              status: item.status ?? "pending",
              appliedAt: item.appliedAt ?? null,
            }));

            if (decoratedItems.length) {
              pushItems(buckets, sf.group, sf.key, sf.label, decoratedItems);
            }

            emit({
              type: "stage",
              data: {
                proofreading_id,
                run_id: proofreadStreamId,
                tier,
                key: sf.key,
                label: sf.label,
                status: "done",
                itemCount: decoratedItems.length,
              },
            });
            console.info(
              `[ProofSSE] EMIT complete stage tier=${tier} key=${sf.key ?? ""} pages=${pagesEmitted} itemsTotal=${itemsEmitted}`,
            );
          } catch (error) {
            emit({
              type: "stage",
              data: {
                proofreading_id,
                run_id: proofreadStreamId,
                tier,
                key: sf.key,
                label: sf.label,
                status: "error",
              },
            });
            throw error;
          }
        }),
      );

      if (tier === "deep" && !includeDeep) {
        return;
      }

      const tierKeys = tier === "quick" ? quickKeys : deepKeys;
      const tierResultsRaw = buckets.filter((bucket) =>
        tierKeys.has(bucket.subfeatureKey),
      );
      const tierResults = filterBuckets(tierResultsRaw, {
        maxPerSubfeature: tier === "quick" ? 3 : 5,
        minConfidence: tier === "quick" ? 0.6 : 0.5,
        minSeverity: tier === "quick" ? "medium" : "low",
      });

      const baseMeta = buildReportMeta({
        sourcePath: "mongo.translation_files",
        targetPath: "mongo.translation_files",
        sourceLang: spec.language.source,
        targetLang: spec.language.target,
        alignment: tier === "quick" ? "paragraph" : "paragraph",
      });
      const tierReportRuns = ensureTierRuns(tier);
      const reportMeta = tierReportRuns.length
        ? { ...baseMeta, llm: { runs: tierReportRuns } }
        : baseMeta;

      const summaryMetrics = tierMetrics[tier] ?? {
        downshift: 0,
        forcedPagination: 0,
        cursorRetry: 0,
      };

      const tierIssueTotal = tierResults.reduce(
        (sum, bucket) => sum + (bucket.items?.length ?? 0),
        0,
      );

      const report: ProofreadingReport = {
        meta: reportMeta,
        results: tierResults,
        summary: {
          countsBySubfeature: recomputeCounts(tierResults),
          tier_issue_counts: { [tier]: tierIssueTotal },
          item_count: tierIssueTotal,
          downshift_count: summaryMetrics.downshift,
          forced_pagination_count: summaryMetrics.forcedPagination,
          cursor_retry_count: summaryMetrics.cursorRetry,
          notes_ko: tier === "quick" ? "신속 검사 완료" : "심층 검사 진행 중",
          notes_en:
            tier === "quick" ? "Quick scan complete" : "Deep scan update",
        },
      };

      const tierReport: ProofreadingReport = {
        ...report,
        results: report.results.map((bucket) => ({
          ...bucket,
          items: bucket.items?.map((item) => ({ ...item })) ?? [],
        })),
      };

      tierReports[tier] = tierReport;
      const summaryPayload =
        tierReport.summary && typeof tierReport.summary === "object"
          ? (tierReport.summary as Record<string, unknown>)
          : null;
      emit({
        type: "tier_complete",
        data: {
          proofreading_id,
          run_id: proofreadStreamId,
          tier,
          summary: summaryPayload,
          itemCount: tierIssueTotal,
        },
      });
    };

    await processSubfeatures("quick", quickSubfeatures, quickPairs);
    if (includeDeep && deepSubfeatures.length) {
      await processSubfeatures("deep", deepSubfeatures, deepPairs);
    }

    const filteredBuckets = filterBuckets(buckets, {
      maxPerSubfeature: 5,
      minConfidence: 0.5,
      minSeverity: "low",
    });

    const baseMeta = buildReportMeta({
      sourcePath: "mongo.translation_files",
      targetPath: "mongo.translation_files",
      sourceLang: spec.language.source,
      targetLang: spec.language.target,
      alignment: "paragraph",
    });
    const finalMeta = llmRuns.length
      ? { ...baseMeta, llm: { runs: llmRuns } }
      : baseMeta;

    const aggregateMetrics = Object.values(tierMetrics).reduce(
      (acc, metrics) => {
        if (!metrics) return acc;
        acc.downshift += metrics.downshift;
        acc.forcedPagination += metrics.forcedPagination;
        acc.cursorRetry += metrics.cursorRetry;
        return acc;
      },
      { downshift: 0, forcedPagination: 0, cursorRetry: 0 },
    );

    const tierIssueCountsSummary = Object.entries(tierReports).reduce(
      (acc, [tierName, tierReport]) => {
        if (!tierReport) {
          acc[tierName] = 0;
          return acc;
        }
        const total = tierReport.results.reduce(
          (sum, bucket) => sum + (bucket.items?.length ?? 0),
          0,
        );
        acc[tierName] = total;
        return acc;
      },
      {} as Record<string, number>,
    );

    const report: ProofreadingReport = {
      meta: finalMeta,
      results: filteredBuckets,
      summary: {
        countsBySubfeature: recomputeCounts(filteredBuckets),
        tier_issue_counts: tierIssueCountsSummary,
        downshift_count: aggregateMetrics.downshift,
        forced_pagination_count: aggregateMetrics.forcedPagination,
        cursor_retry_count: aggregateMetrics.cursorRetry,
        notes_ko: "교정 완료",
        notes_en: "Proofreading complete",
      },
    };

    await saveProofreadingDoc({
      project_id,
      job_id,
      proofreading_id,
      spec,
      report,
      tierReports,
    });
    await updateHistory({ proofreading_id, status: "completed" });
    await updateProofreadRunStatus(proofreadRunId, "completed");

    emit({
      type: "complete",
      data: {
        proofreading_id,
        run_id: proofreadStreamId,
        summary: report,
        scope: "run",
      },
    });
    console.info(
      `[ProofSSE] EMIT complete tier=all key=* pages=${Object.values(tierReports).reduce((acc, report) => acc + (report?.results.length ?? 0), 0)} itemsTotal=${Object.values(tierReports).reduce(
        (acc, report) =>
          acc +
          (report?.results.reduce(
            (sum, bucket) => sum + (bucket.items?.length ?? 0),
            0,
          ) ?? 0),
        0,
      )}`,
    );

    return { proofreading_id, report };
  } catch (error) {
    await updateProofreadRunStatus(proofreadRunId, "failed");
    await updateHistory({ proofreading_id, status: "error" });
    const message =
      error instanceof Error ? error.message : "Proofreading failed";
    console.error(
      "[proofread] agent error",
      JSON.stringify(
        {
          projectId: project_id,
          jobId: job_id,
          proofreadingId: proofreading_id,
          message,
        },
        null,
        2,
      ),
    );
    emit({
      type: "error",
      data: {
        proofreading_id,
        run_id: proofreadStreamId,
        message,
      },
    });
    throw error;
  }
}
