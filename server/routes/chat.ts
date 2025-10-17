import { FastifyPluginAsync } from "fastify";
import mongoose from "mongoose";
import { OpenAI } from "openai";
import { requireAuthAndPlanCheck } from "../middleware/auth";
import ChatMessageModel from "../models/ChatMessage";
import QualityAssessment from "../models/QualityAssessment";
import Proofreading from "../models/Proofreading";
import { resolveChatModel } from "../services/modelService";
import {
  detectLocaleFromMessage,
  resolveLocale,
  translate,
} from "../services/localeService";
import {
  classifyIntent,
  type IntentClassification,
} from "../services/intentClassifier";
import {
  loadIntentSnapshot,
  saveIntentSnapshot,
} from "../services/intentSnapshotStore";
import { query } from "../db";
import { chatSystemPrompt } from "../prompts/chatSystemPrompt";
import {
  workflowEvents,
  WORKFLOW_EVENTS,
  type IntentSnapshot as StoredIntentSnapshot,
} from "../services/workflowEvents";
import { getWorkflowSummary, requestAction, type WorkflowSummary, type WorkflowType } from "../services/workflowManager";
import {
  ACTION_INTENT_MAP,
  handleIntentRouting,
  type LlmAction,
} from "../services/chatIntentRouter";
import {
  buildStatusSnapshot,
  formatStatusSnapshotForLlm,
} from "../services/statusSummaryBuilder";

interface ChatMessagePayload {
  role: "assistant" | "user" | "system";
  content: string;
}

interface ProjectContextSnapshotPayload {
  projectId: string | null;
  projectTitle: string | null;
  targetLang: string | null;
  lifecycle: {
    translation: {
      stage: "none" | "origin-only" | "translating" | "translated" | "failed";
      lastUpdatedAt: string | null;
      jobId: string | null;
    };
    proofreading: {
      stage: "none" | "running" | "queued" | "done" | "failed" | "unknown";
      lastUpdatedAt: string | null;
      jobId: string | null;
    };
    quality: {
      stage: "none" | "running" | "done" | "failed";
      lastUpdatedAt: string | null;
      score: number | null;
    };
    publishing: {
      stage: "none" | "exporting" | "exported";
      lastUpdatedAt: string | null;
      ebookId: string | null;
    };
  };
  timeline: Array<{
    phase: "origin" | "translation" | "proofreading" | "quality" | "publishing";
    status: string;
    updatedAt: string | null;
    note?: string;
  }>;
  origin: {
    hasContent: boolean;
    lastUpdatedAt: string | null;
    filename: string | null;
  };
  translation: {
    hasContent: boolean;
    lastUpdatedAt: string | null;
  };
  excerpts: {
    originPreview: string | null;
    translationPreview: string | null;
  };
  ui: {
    rightPanelTab: string;
    originExpanded: boolean;
    translationExpanded: boolean;
  };
  jobs: {
    status: string | null;
    activeJobId: string | null;
    lastCheckedAt: number | null;
    batchesCompleted: number | null;
    batchesTotal: number | null;
  };
  refreshedAt: number;
}

const AUTHOR_KEYWORDS = ["작가", "저자", "author", "writer", "글쓴이"];

const cleanKoreanEnding = (input: string) =>
  input
    .replace(
      /(?:이라고|라고|이라고요|라구요|라고요|이야|라네|이라네|랍니다|라네요|라는데요|입니다|이에요|예요|입니다요|라니까요|랍니다요|라던데요|라던가요|라지요|라구|이거든요|라거든요|라나|라네|라니|랍디다|라더군요|라더라|랍디다|나고요|네요|네요\.)$/u,
      "",
    )
    .trim();

const extractAuthorFromMessage = (message: string): string | null => {
  if (!message) return null;
  const normalized = message.replace(/\s+/g, " ").trim();
  const patterns: RegExp[] = [
    /(?:작가|저자|글쓴이)\s*(?:는|은|이|가|:|=)?\s*["'“”]?(?<name>[가-힣A-Za-z·\s'.-]{2,})/u,
    /(?:author|writer)\s*(?:is|:|=)?\s*["'“”]?(?<name>[A-Za-z·\s'.-]{2,})/i,
    /written by\s+(?<name>[A-Za-z·\s'.-]{2,})/i,
    /by\s+(?<name>[A-Za-z·\s'.-]{2,})/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.groups?.name) {
      let candidate = match.groups.name.trim();
      candidate = candidate.replace(/["'“”]/g, "").trim();
      candidate = cleanKoreanEnding(candidate);
      candidate = candidate.replace(/[.,!?。！？]+$/u, "").trim();
      if (candidate.length >= 2 && candidate.length <= 60) {
        return candidate;
      }
    }
  }

  // fallback: check keyword presence and take word before/after
  for (const keyword of AUTHOR_KEYWORDS) {
    const idx = normalized.indexOf(keyword);
    if (idx !== -1) {
      const after = normalized.slice(idx + keyword.length).trim();
      const tokens = after.split(/[\s,]/).filter(Boolean);
      if (tokens.length) {
        let candidate = tokens.slice(0, 2).join(" ");
        candidate = candidate.replace(/["'“”]/g, "").trim();
        candidate = cleanKoreanEnding(candidate);
        if (candidate.length >= 2 && candidate.length <= 60) {
          return candidate;
        }
      }
    }
  }

  return null;
};

const stripQuotes = (text: string) => text.replace(/["'“”]/g, "");
const hasHangul = (text: string) => /[가-힣]/.test(text);

const normalizeAuthorName = (value: string, previous?: string | null) => {
  let cleaned = stripQuotes(value).trim();
  if (!cleaned) return null;
  cleaned = cleaned
    .replace(
      /^(?:작가|저자|author|writer|글쓴이)\s*(?:의|는|은|이|가|:)?\s*/i,
      "",
    )
    .replace(
      /(?:의\s*(?:말|말씀|헌정|이야기|노트|메시지|코멘트|편지|글))$/u,
      "",
    )
    .trim();
  cleaned = cleanKoreanEnding(cleaned);
  cleaned = cleaned
    .replace(/[.,!?。！？]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!/[가-힣A-Za-z]/.test(cleaned)) return null;
  if (cleaned.length < 2) return null;
  if (previous && cleaned === previous) return null;
  return cleaned;
};

const stripTrailingContextSuffix = (text: string) =>
  text.replace(
    /(?:라고|이라며|이라면서|라면서|라더라고|라더라구|라더군요|라네요|라더라고요|라더라|라고요|라구요|이라네요|이라더군요|이라더라고요)\s*(?:합니다|한다|했어요|했죠|했어|했답니다|하더라구|하더라고|하더군요|하더라고요|하더래요|하네|하네요|래요|라고 했다|라고 한다)?$/u,
    "",
  );

const normalizeContext = (value: string, previous?: string | null) => {
  let cleaned = stripQuotes(value).trim();
  cleaned = cleaned
    .replace(/^(?:그\s*)?작가의\s*말(?:씀)?\s*(?:은|는|이|가)?\s*/u, "")
    .trim();
  cleaned = stripTrailingContextSuffix(cleaned);
  cleaned = cleanKoreanEnding(cleaned)
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  if (previous && cleaned === previous) return null;
  const hangul = hasHangul(cleaned);
  if (!/[.!?。！？]$/.test(cleaned)) cleaned += hangul ? "입니다." : ".";
  return cleaned;
};

const IMPORTANT_MEMO_KEYWORDS = [
  "번역",
  "tone",
  "voice",
  "style",
  "register",
  "독자",
  "reader",
  "sensitivity",
  "검열",
  "문화",
  "cultural",
  "감정",
  "emotion",
];

const normalizeMemo = (value: string, existingMemos: string[]) => {
  let cleaned = stripQuotes(value).trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const hasImportantKeyword = IMPORTANT_MEMO_KEYWORDS.some((keyword) =>
    lower.includes(keyword),
  );
  if (!hasImportantKeyword) {
    return null;
  }
  cleaned = cleanKoreanEnding(cleaned)
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  const hangul = hasHangul(cleaned);
  if (!/[.!?。！？]$/.test(cleaned)) cleaned += hangul ? "입니다." : ".";
  const prefix = hangul ? "번역 참고:" : "Translation note:";
  if (!cleaned.startsWith(prefix)) cleaned = `${prefix} ${cleaned}`;
  const duplicate = existingMemos.some((entry) => entry === cleaned);
  if (duplicate) return null;
  return cleaned;
};

const mapLangToken = (token: string) => {
  const lower = token.toLowerCase();
  if (["ko", "kor", "korean", "한국어", "한국말", "한글"].includes(lower))
    return "KO";
  if (["en", "eng", "english", "영어", "잉글리시"].includes(lower)) return "EN";
  if (["ja", "jpn", "japanese", "일본어", "일어"].includes(lower)) return "JA";
  if (["zh", "chi", "chinese", "중국어", "중국말", "中文"].includes(lower))
    return "ZH";
  if (["es", "spa", "spanish", "스페인어"].includes(lower)) return "ES";
  if (["fr", "fra", "french", "프랑스어"].includes(lower)) return "FR";
  if (lower.length === 2) return lower.toUpperCase();
  return token.slice(0, 2).toUpperCase();
};

const mapLangTokenSafe = (token?: string | null) => {
  if (!token) return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  try {
    const mapped = mapLangToken(trimmed);
    return mapped && mapped.length === 2 ? mapped : null;
  } catch (err) {
    return null;
  }
};

const parseDirection = (value?: string | null) => {
  if (!value) return null;
  const match = value.match(/([A-Z]{2})\s*->\s*([A-Z]{2})/);
  if (!match) return null;
  return {
    from: match[1],
    to: match[2],
    formatted: `${match[1]} -> ${match[2]}`,
  };
};

const normalizeDirection = (value: string, previous?: string | null) => {
  if (!value) return null;
  let candidate = stripQuotes(value).trim();
  const match = candidate.match(
    /([A-Za-z가-힣]{2,})\s*(?:->|→|➡|to|에서)\s*([A-Za-z가-힣]{2,})/i,
  );
  if (match) {
    const from = mapLangToken(match[1]);
    const to = mapLangToken(match[2]);
    if (from.length === 2 && to.length === 2) {
      const formatted = `${from} -> ${to}`;
      if (!previous || formatted !== previous) return formatted;
      return null;
    }
  }
  const normalized = candidate.toUpperCase();
  if (/^[A-Z]{2}\s*->\s*[A-Z]{2}$/.test(normalized)) {
    const [fromRaw, toRaw] = normalized.split("->");
    const formatted = `${fromRaw.trim()} -> ${toRaw.trim()}`;
    if (!previous || formatted !== previous) return formatted;
  }
  return null;
};

const normalizeTitle = (value: string, previous?: string | null) => {
  let cleaned = stripQuotes(value).trim();
  if (!cleaned) return null;
  if (previous && cleaned === previous) return null;
  return cleaned;
};

const sanitizeProfileUpdates = (
  updates: Record<string, any> | undefined,
  currentMeta: Record<string, any>,
  project: any,
) => {
  if (!updates) return undefined;
  const sanitized: Record<string, string> = {};
  const prevTitle = project?.title ?? currentMeta.title ?? null;
  const prevAuthor = currentMeta.author ?? null;
  const prevContext = currentMeta.context ?? project?.description ?? null;
  const prevDirection = parseDirection(
    currentMeta.translationDirection ?? project?.intention ?? null,
  );
  const existingMemoEntries =
    typeof project?.memo === "string"
      ? project.memo
          .split(/\n+/)
          .map((entry: string) => entry.trim())
          .filter(Boolean)
      : [];

  if (typeof updates.title === "string") {
    const title = normalizeTitle(updates.title, prevTitle);
    if (title) sanitized.title = title;
  }

  if (typeof updates.author === "string") {
    const author = normalizeAuthorName(updates.author, prevAuthor);
    if (author) sanitized.author = author;
  }

  if (typeof updates.context === "string") {
    const context = normalizeContext(updates.context, prevContext);
    if (context) sanitized.context = context;
  }

  if (typeof updates.translationDirection === "string") {
    const direction = normalizeDirection(
      updates.translationDirection,
      prevDirection?.formatted ?? null,
    );
    if (direction) sanitized.translationDirection = direction;
  }

  if (typeof updates.memo === "string") {
    const memo = normalizeMemo(updates.memo, existingMemoEntries);
    if (memo) sanitized.memo = memo;
  }

  if (!sanitized.translationDirection) {
    const originCandidate =
      prevDirection?.from ?? mapLangTokenSafe(project?.origin_lang);
    const targetCandidate =
      prevDirection?.to ?? mapLangTokenSafe(project?.target_lang);
    if (
      originCandidate &&
      targetCandidate &&
      originCandidate !== targetCandidate
    ) {
      const formatted = `${originCandidate} -> ${targetCandidate}`;
      if (!prevDirection?.formatted || prevDirection.formatted !== formatted) {
        sanitized.translationDirection = formatted;
      }
    }
  }

  return Object.keys(sanitized).length ? sanitized : undefined;
};

const ENTITY_PROMPT = `You are a meticulous metadata extractor for the Project-T1 literary translation studio.
Given the latest user utterance and project context, identify updated entity values and return the strict JSON schema below. Use null for unknown values.

Schema:
{
  "title": string | null,
  "author": string | null,
  "context": string | null,
  "translationDirection": string | null,
  "memo": string | null
}

Rules:
- Never change the title or author unless the user clearly states a different name. Mentions like “작가의 말”, “author’s note”, or dedications do NOT change the author; leave author as null in that case.
- "author" must be only the person’s name without particles or extra words.
- "context" should be a concise, professional sentence describing new background information. For Korean text, end with “입니다.” or “합니다.”; for English, end with a period.
- "translationDirection" must be formatted like "KO -> EN" (two-letter codes, uppercase). If the user does not specify both languages, return null.
- "memo" should be an action-oriented note (e.g., “번역 참고: …” or “Translation note: …”).
- Return Korean text in Korean when the user supplied it; otherwise use the user’s language.
- If there is no new information for a field, return null for that field.
`;

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  const intentConfidenceThreshold = Number(
    process.env.CHAT_INTENT_CONFIDENCE ?? 0.6,
  );

  fastify.post(
    "/api/chat",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      if (!openai) {
        request.log.warn("[CHAT] Missing OPENAI_API_KEY; returning fallback reply");
        return reply.send({
          reply:
            "LLM 구성이 아직 준비되지 않았습니다. 관리자에게 문의해 주세요.",
          actions: [],
        });
      }

      const body = request.body as {
        projectId?: string | null;
        messages?: ChatMessagePayload[];
        contextSnapshot?: ProjectContextSnapshotPayload | null;
        model?: string | null;
      };

      const projectId = body?.projectId ?? null;
      const incomingMessages = body?.messages ?? [];
      const selectedModelId = resolveChatModel(body?.model, request.log);
      request.log.info(
        { projectId, model: selectedModelId },
        "[CHAT] Using LLM model for conversation",
      );
      const frontendSnapshot = body?.contextSnapshot ?? null;

      if (!projectId) {
        return reply.send({
          reply: "먼저 번역할 프로젝트를 선택해 주세요.",
          actions: [],
        });
      }

      const userId = (request as any).user_id ?? null;

      const db = mongoose.connection?.db;
      if (!db) {
        request.log.error("[CHAT] MongoDB connection not ready");
        return reply
          .status(500)
          .send({ reply: "서버 연결 상태가 좋지 않습니다.", actions: [] });
      }

      const userMessages = incomingMessages.filter(
        (msg) => msg.role === "user",
      );
      const latestUserMessage = userMessages[userMessages.length - 1];

      if (!latestUserMessage) {
        return reply.send({
          reply:
            "무엇을 도와드릴까요? 번역, 교정, 품질 평가 등 원하는 작업을 말씀해 주세요.",
          actions: [],
        });
      }

      await ChatMessageModel.create({
        project_id: projectId,
        role: "user",
        content: latestUserMessage.content,
      });

      const projectRes = await query(
        `SELECT project_id, title, description, intention, memo, meta, origin_lang, target_lang
         FROM translationprojects
         WHERE project_id = $1
         LIMIT 1`,
        [projectId],
      );
      const project = projectRes.rows[0];
      const currentMeta = (() => {
        if (!project?.meta) return {} as Record<string, any>;
        if (typeof project.meta === "object")
          return project.meta as Record<string, any>;
        try {
          return JSON.parse(project.meta as string);
        } catch (err) {
          return {} as Record<string, any>;
        }
      })();

      const history = await ChatMessageModel.find({ project_id: projectId })
        .sort({ created_at: 1 })
        .limit(20)
        .lean()
        .exec();

      const originCollection = db.collection("origin_files");
      const originDoc = await originCollection.findOne({
        project_id: projectId,
      });

      type LatestJobSummary = {
        id: string;
        status: string;
        type: string;
        created_at: string | null;
        updated_at: string | null;
        workflow_run_id: string | null;
      };

      let latestJob: LatestJobSummary | null = null;
      let translationStage = originDoc?.text_content
        ? "origin-only"
        : "no-origin";
      let translationProgress: {
        total: number;
        completed: number;
        failed: number;
      } | null = null;

      try {
        const { rows: jobRows } = await query(
          `SELECT id, status, type, created_at, updated_at, workflow_run_id
             FROM jobs
             WHERE project_id = $1 AND type = 'translate'
             ORDER BY created_at DESC
             LIMIT 1`,
          [projectId],
        );
        if (jobRows?.length) {
          const jobRow = jobRows[0] as LatestJobSummary;
          latestJob = jobRow;

          const jobId = jobRow.id;
          const { rows: batchRowsRaw } = await query(
            `SELECT status
               FROM translation_batches
               WHERE job_id = $1`,
            [jobId],
          );
          const batchRows = batchRowsRaw ?? [];
          const total = batchRows.length;
          const completed = batchRows.filter(
            (row: any) => row.status === "done",
          ).length;
          const failed = batchRows.filter(
            (row: any) => row.status === "failed",
          ).length;
          translationProgress = { total, completed, failed };

          if (jobRow.status === "done") translationStage = "translated";
          else if (jobRow.status === "failed")
            translationStage = "translation-error";
          else if (jobRow.status === "cancelled")
            translationStage = originDoc?.text_content ? "origin-only" : "no-origin";
          else translationStage = "translating";
        }
      } catch (err) {
        request.log.warn(
          { err },
          "[CHAT] Failed to load latest translation job",
        );
      }

      let latestProof: any = null;
      let proofreadingStage = "no-proofreading";
      try {
        latestProof = await Proofreading.findOne({ project_id: projectId })
          .sort({ updated_at: -1, created_at: -1 })
          .lean()
          .exec();
        if (latestProof) {
          proofreadingStage = latestProof.status ?? "unknown";
        }
      } catch (err) {
        request.log.warn(
          { err },
          "[CHAT] Failed to load proofreading snapshot",
        );
      }

      let latestQuality: any = null;
      let qualityStage = "no-assessment";
      try {
        latestQuality = await QualityAssessment.findOne({ projectId })
          .sort({ timestamp: -1 })
          .lean()
          .exec();
        if (latestQuality) {
          qualityStage = "done";
        }
      } catch (err) {
        request.log.warn({ err }, "[CHAT] Failed to load quality snapshot");
      }

      const ebookMeta: any = null;

      const translationReady = translationStage === "translated";
      const translationInProgress =
        latestJob?.status === "running" || latestJob?.status === "queued";
      const proofInProgress =
        proofreadingStage === "running" || proofreadingStage === "queued";
      const proofCompleted =
        proofreadingStage === "done" || proofreadingStage === "completed";
      const qualityCompleted = qualityStage === "done";

      const systemPrompt = chatSystemPrompt;

      const previousIntentSnapshot =
        userId && projectId
          ? await loadIntentSnapshot(projectId, userId)
          : null;

      const intentClassification = await classifyIntent(
        openai,
        latestUserMessage.content,
        {
          translationStage,
          proofreadingStage,
          qualityStage,
        },
      );

      request.log.info(
        { intent: intentClassification },
        "[CHAT] Intent classification",
      );

      const snapshotLocaleCandidate = (() => {
        if (!frontendSnapshot) return null;
        if (typeof (frontendSnapshot as any)?.locale === "string")
          return (frontendSnapshot as any).locale as string;
        if (typeof (frontendSnapshot as any)?.ui?.locale === "string")
          return (frontendSnapshot as any).ui.locale as string;
        return null;
      })();

      const metaLocaleCandidate = (() => {
        const candidates = [
          (currentMeta as Record<string, unknown>)?.uiLocale,
          (currentMeta as Record<string, unknown>)?.preferredLocale,
          (currentMeta as Record<string, unknown>)?.locale,
        ];
        for (const candidate of candidates) {
          if (typeof candidate === "string") return candidate;
        }
        return null;
      })();

      const acceptLanguage =
        typeof request.headers["accept-language"] === "string"
          ? request.headers["accept-language"]?.split(",")[0] ?? null
          : null;

      const locale = resolveLocale(
        snapshotLocaleCandidate,
        metaLocaleCandidate,
        acceptLanguage,
        detectLocaleFromMessage(latestUserMessage.content),
      );

      const syntheticActions: LlmAction[] = [];
      switch (intentClassification.intent) {
        case "translate":
          syntheticActions.push({
            type: "startTranslation",
            autoStart: true,
            allowParallel: intentClassification.rerun,
            label: intentClassification.label ?? null,
          });
          break;
        case "proofread":
          syntheticActions.push({
            type: "startProofread",
            autoStart: true,
            allowParallel: intentClassification.rerun,
            label: intentClassification.label ?? null,
          });
          break;
        case "quality":
          syntheticActions.push({
            type: "startQuality",
            autoStart: true,
            allowParallel: intentClassification.rerun,
            label: intentClassification.label ?? null,
          });
          break;
        default:
          break;
      }

      const preflightReconciliation = reconcileActions({
        actions: syntheticActions,
        classification: intentClassification,
        threshold: intentConfidenceThreshold,
        translationReady,
        translationInProgress,
        proofInProgress,
        proofCompleted,
        qualityCompleted,
        activeTranslationJob: latestJob
          ? {
              jobId: latestJob.id,
              workflowRunId: latestJob.workflow_run_id ?? null,
            }
          : null,
        previousIntent: previousIntentSnapshot,
      });

      let workflowSummary: WorkflowSummary | null = null;
      try {
        workflowSummary = await getWorkflowSummary(projectId, 10);
      } catch (err) {
        request.log.warn({ err }, "[CHAT] Failed to load workflow summary");
      }

      const workflowStatusSnapshot = buildStatusSnapshot(workflowSummary ?? null);
      const workflowStatusContext = formatStatusSnapshotForLlm(
        workflowStatusSnapshot,
      );
      const plannedTranslationJob = latestJob
        ? {
            jobId: latestJob.id,
            workflowRunId: latestJob.workflow_run_id ?? null,
          }
        : null;

      let routingGeneratedActions: LlmAction[] | null = null;
      let routingLlmContext: string | null = null;

      if (intentClassification.intent === "status") {
        const statusActions: LlmAction[] = [{ type: "viewTranslationStatus" }];
        if (translationReady) {
          statusActions.push({ type: "viewTranslatedText" });
        }
        if (qualityCompleted) {
          statusActions.push({ type: "viewQualityReport" });
        }
        routingGeneratedActions = statusActions;
        routingLlmContext = workflowStatusContext
          ? translate("chat_context_status_summary", locale, {
              status: workflowStatusContext,
            })
          : translate("chat_context_status_no_data", locale);

        workflowEvents.emit(WORKFLOW_EVENTS.INTENT_REQUESTED, {
          projectId,
          userId,
          classification: intentClassification,
          effectiveIntent: intentClassification.intent,
          previousIntent: previousIntentSnapshot ?? undefined,
        });

        if (userId && projectId) {
          try {
            await saveIntentSnapshot(projectId, userId, {
              ...intentClassification,
              label: intentClassification.label ?? null,
              notes: intentClassification.notes ?? null,
              effectiveIntent: intentClassification.intent,
              updatedAt: new Date().toISOString(),
            });
          } catch (snapshotError) {
            request.log.warn(
              { err: snapshotError },
              "[CHAT] Failed to persist intent snapshot",
            );
          }
        }
      } else if (intentClassification.intent === "cancel") {
        if (translationInProgress && plannedTranslationJob) {
          routingGeneratedActions = [
            {
              type: "cancelTranslation",
              jobId: plannedTranslationJob.jobId,
              workflowRunId: plannedTranslationJob.workflowRunId,
            },
            { type: "viewTranslationStatus" },
          ];
          routingLlmContext = workflowStatusContext
            ? translate("chat_context_cancel_with_status", locale, {
                status: workflowStatusContext,
              })
            : translate("chat_context_cancel_no_status", locale);
        } else {
          routingGeneratedActions = [{ type: "viewTranslationStatus" }];
          routingLlmContext = translate("chat_context_cancel_none", locale);
        }

        workflowEvents.emit(WORKFLOW_EVENTS.INTENT_REQUESTED, {
          projectId,
          userId,
          classification: intentClassification,
          effectiveIntent: intentClassification.intent,
          previousIntent: previousIntentSnapshot ?? undefined,
        });

        if (userId && projectId) {
          try {
            await saveIntentSnapshot(projectId, userId, {
              ...intentClassification,
              label: intentClassification.label ?? null,
              notes: intentClassification.notes ?? null,
              effectiveIntent: intentClassification.intent,
              updatedAt: new Date().toISOString(),
            });
          } catch (snapshotError) {
            request.log.warn(
              { err: snapshotError },
              "[CHAT] Failed to persist intent snapshot",
            );
          }
        }
      } else if (intentClassification.intent === "upload") {
        routingGeneratedActions = [{ type: "startUploadFile" }];
        routingLlmContext = translate("chat_context_upload_origin", locale);

        workflowEvents.emit(WORKFLOW_EVENTS.INTENT_REQUESTED, {
          projectId,
          userId,
          classification: intentClassification,
          effectiveIntent: intentClassification.intent,
          previousIntent: previousIntentSnapshot ?? undefined,
        });

        if (userId && projectId) {
          try {
            await saveIntentSnapshot(projectId, userId, {
              ...intentClassification,
              label: intentClassification.label ?? null,
              notes: intentClassification.notes ?? null,
              effectiveIntent: intentClassification.intent,
              updatedAt: new Date().toISOString(),
            });
          } catch (snapshotError) {
            request.log.warn(
              { err: snapshotError },
              "[CHAT] Failed to persist intent snapshot",
            );
          }
        }
      } else if (intentClassification.intent === "ebook") {
        routingGeneratedActions = [{ type: "openExportPanel" }];
        routingLlmContext = workflowStatusContext
          ? translate("chat_context_ebook_with_status", locale, {
              status: workflowStatusContext,
            })
          : translate("chat_context_ebook_no_status", locale);

        // TODO(mvp-ebook-automation): trigger ebook export automation when the
        // backend workflow is ready, then replace this placeholder with the
        // real job invocation and status tracking.

        workflowEvents.emit(WORKFLOW_EVENTS.INTENT_REQUESTED, {
          projectId,
          userId,
          classification: intentClassification,
          effectiveIntent: intentClassification.intent,
          previousIntent: previousIntentSnapshot ?? undefined,
        });

        if (userId && projectId) {
          try {
            await saveIntentSnapshot(projectId, userId, {
              ...intentClassification,
              label: intentClassification.label ?? null,
              notes: intentClassification.notes ?? null,
              effectiveIntent: intentClassification.intent,
              updatedAt: new Date().toISOString(),
            });
          } catch (snapshotError) {
            request.log.warn(
              { err: snapshotError },
              "[CHAT] Failed to persist intent snapshot",
            );
          }
        }
      } else {
        const routingOutcome = await handleIntentRouting({
          locale,
          classification: intentClassification,
          preflight: preflightReconciliation,
          latestUserMessage: latestUserMessage.content,
          userId,
          projectId,
          requestAction,
          translateFn: translate,
          currentStatusSummary: workflowStatusContext,
        });

        if (routingOutcome.handled && routingOutcome.actions) {
          const classificationForEvent =
            routingOutcome.classificationForEvent ?? intentClassification;
          const effectiveIntent =
            routingOutcome.effectiveIntent ??
            preflightReconciliation.effectiveIntent ??
            intentClassification.intent;

          workflowEvents.emit(WORKFLOW_EVENTS.INTENT_REQUESTED, {
            projectId,
            userId,
            classification: classificationForEvent,
            effectiveIntent,
            previousIntent: previousIntentSnapshot ?? undefined,
          });

          if (userId && projectId && routingOutcome.snapshotToPersist) {
            try {
              await saveIntentSnapshot(
                projectId,
                userId,
                routingOutcome.snapshotToPersist,
              );
            } catch (snapshotError) {
              request.log.warn(
                { err: snapshotError },
                "[CHAT] Failed to persist intent snapshot",
              );
            }
          }

          routingGeneratedActions = routingOutcome.actions ?? null;
          routingLlmContext = routingOutcome.llmContext ?? null;
        }
      }

      const proofTimestamp =
        (latestProof?.updated_at ?? latestProof?.created_at) || null;
      const qualityTimestamp =
        (latestQuality?.timestamp ?? latestQuality?.updated_at) || null;
      const translationProgressText = translationProgress
        ? `${translationProgress.completed}/${translationProgress.total} completed, ${translationProgress.failed} failed`
        : "no batches yet";
      const latestQualityScore = latestQuality?.qualityResult?.overallScore;
      const proofTimestampIso = proofTimestamp
        ? new Date(proofTimestamp).toISOString()
        : "none";
      const qualityTimestampIso = qualityTimestamp
        ? new Date(qualityTimestamp).toISOString()
        : "none";
      const describeTimelineEntry = (
        entry: ProjectContextSnapshotPayload["timeline"][number],
      ) => {
        const phaseLabel = {
          origin: "Origin",
          translation: "Translation",
          proofreading: "Proofreading",
          quality: "Quality",
          publishing: "Publishing",
        }[entry.phase];
        const updated = entry.updatedAt ?? "time unknown";
        const note = entry.note ? ` (${entry.note})` : "";
        return `${phaseLabel}: ${entry.status}${note} — updated ${updated}`;
      };

      const buildProjectBrief = () => {
        const lines: string[] = [];
        lines.push(
          "Role reminder: You are a warm, literary production partner who helps manage translation, proofreading, and publishing while preserving the author's tone. Speak like a trusted teammate.",
        );
        lines.push(
          `Project: "${project?.title ?? "Untitled Project"}" (ID ${project?.project_id ?? projectId}) targeting ${project?.target_lang ?? "Unknown target language"} from ${project?.origin_lang ?? "Unknown source language"}.`,
        );
        lines.push(
          `Narrative context: author=${currentMeta.author ?? "unknown"}, intention=${project?.intention ?? currentMeta.translationDirection ?? "unspecified"}, memo=${project?.memo ?? "none"}.`,
        );

        const originLine = originDoc?.text_content
          ? `Origin text is available (last update ${originDoc?.updated_at ?? originDoc?.created_at ?? "unknown"}).`
          : "Origin text has not been uploaded yet.";
        lines.push(originLine);

        const translationLine = (() => {
          const snapshotStage =
            frontendSnapshot?.lifecycle?.translation?.stage ?? translationStage;
          const stageLabel = snapshotStage?.replace(/-/g, " ") ?? "unknown";
          if (snapshotStage === "translating") {
            const batchesNote =
              frontendSnapshot?.jobs && frontendSnapshot.jobs.batchesTotal
                ? `${frontendSnapshot.jobs.batchesCompleted ?? 0}/${frontendSnapshot.jobs.batchesTotal} batches complete`
                : translationProgressText;
            return `Translation is in progress (${batchesNote}). Keep the user informed and offer to open status panels.`;
          }
          if (snapshotStage === "translated") {
            return `Translation is complete. Latest job: ${latestJob ? `${latestJob.id} (${latestJob.status})` : "unknown status"}.`;
          }
          if (snapshotStage === "failed") {
            return "The last translation attempt failed. Suggest remedial actions before retrying.";
          }
          if (snapshotStage === "origin-only") {
            return "Origin is ready but translation has not started. Offer to initiate translation when the user is ready.";
          }
          return `Translation stage: ${stageLabel}.`;
        })();
        lines.push(translationLine);

        const proofreadingLine = (() => {
          const snapshotStage =
            frontendSnapshot?.lifecycle?.proofreading?.stage ??
            proofreadingStage;
          if (snapshotStage === "none")
            return "Proofreading has not been run yet.";
          if (snapshotStage === "running" || snapshotStage === "queued") {
            return `Proofreading is ${snapshotStage}; keep the user updated and offer to open the proofreading tab.`;
          }
          if (snapshotStage === "failed")
            return "Proofreading failed; diagnose and suggest a retry.";
          if (snapshotStage === "done") {
            const when =
              frontendSnapshot?.lifecycle?.proofreading?.lastUpdatedAt ??
              proofTimestampIso;
            return `Proofreading completed (last update ${when}). Offer a concise recap and link to issues.`;
          }
          return `Proofreading stage: ${snapshotStage}.`;
        })();
        lines.push(proofreadingLine);

        const qualityLine = (() => {
          const snapshotStage =
            frontendSnapshot?.lifecycle?.quality?.stage ?? qualityStage;
          if (snapshotStage === "none")
            return "Quality evaluation has not been executed yet.";
          if (snapshotStage === "running")
            return "Quality evaluation is in progress; tell the user results are forthcoming.";
          if (snapshotStage === "failed")
            return "Quality evaluation failed. Provide guidance to retry.";
          const score =
            frontendSnapshot?.lifecycle?.quality?.score ?? latestQualityScore;
          const scoreText = typeof score === "number" ? ` score=${score}` : "";
          const when =
            frontendSnapshot?.lifecycle?.quality?.lastUpdatedAt ??
            qualityTimestampIso;
          return `Quality evaluation complete${scoreText} (last update ${when}). Offer to open the report.`;
        })();
        lines.push(qualityLine);

        const publishingLine = (() => {
          const snapshotStage =
            frontendSnapshot?.lifecycle?.publishing?.stage ?? "none";
          if (snapshotStage === "exported") {
            const when =
              frontendSnapshot?.lifecycle?.publishing?.lastUpdatedAt ??
              "unknown time";
            const ebookId =
              frontendSnapshot?.lifecycle?.publishing?.ebookId ??
              ebookMeta?.ebookId ??
              "unknown";
            return `Ebook export ready (id=${ebookId}, updated ${when}). Offer follow-up steps for distribution.`;
          }
          if (snapshotStage === "exporting")
            return "Ebook export is running; reassure the user and monitor completion.";
          return "Ebook export not yet triggered; propose it when translation and proofreading are stable.";
        })();
        lines.push(publishingLine);

        if (frontendSnapshot?.timeline?.length) {
          const timelineLine = frontendSnapshot.timeline
            .map(describeTimelineEntry)
            .join(" | ");
          lines.push(`Timeline recap: ${timelineLine}`);
        } else {
          lines.push(
            `Timeline recap: translation=${translationStage}, proofreading=${proofreadingStage}, quality=${qualityStage}.`,
          );
        }

        if (
          frontendSnapshot?.excerpts?.originPreview ||
          frontendSnapshot?.excerpts?.translationPreview
        ) {
          const previews: string[] = [];
          if (frontendSnapshot.excerpts.originPreview) {
            previews.push(
              `Origin preview: "${frontendSnapshot.excerpts.originPreview}"`,
            );
          }
          if (frontendSnapshot.excerpts.translationPreview) {
            previews.push(
              `Translation preview: "${frontendSnapshot.excerpts.translationPreview}"`,
            );
          }
          lines.push(previews.join(" "));
        }

        if (frontendSnapshot) {
          lines.push(
            `UI state: right_panel_tab=${frontendSnapshot.ui.rightPanelTab}, origin_expanded=${frontendSnapshot.ui.originExpanded}, translation_expanded=${frontendSnapshot.ui.translationExpanded}.`,
          );
        }

        if (translationProgress) {
          lines.push(
            `DB translation progress snapshot: ${translationProgressText}.`,
          );
        }

        lines.push(
          'Always respond with empathy and clarity, summarize the current stage (translation → proofreading → publishing), offer helpful suggestions, and cite interactive actions when it makes sense (e.g., "[번역본 열어보기](action:viewTranslation)" or "[품질 리포트 보기](action:viewQualityReport)").',
        );
        return lines.join("\n");
      };

      const projectBrief = buildProjectBrief();

      const contextMeta = `Project meta:
- title: ${project?.title ?? "unknown"}
- author: ${currentMeta.author ?? "unknown"}
- context: ${currentMeta.context ?? project?.description ?? "unknown"}
- translation_direction: ${currentMeta.translationDirection ?? project?.intention ?? "unknown"}`;

      const historyMessages = history.map((msg) => ({
        role: msg.role as "assistant" | "user" | "system",
        content: msg.content,
      }));

      const frontendContextMessage = (() => {
        if (!frontendSnapshot) return null;
        const refreshedAtIso = frontendSnapshot.refreshedAt
          ? new Date(frontendSnapshot.refreshedAt).toISOString()
          : "unknown";
        return {
          role: "system" as const,
          content: `Client UI snapshot metadata: refreshed_at=${refreshedAtIso}; job_status=${frontendSnapshot.jobs.status ?? "none"}; batches=${frontendSnapshot.jobs.batchesCompleted ?? 0}/${frontendSnapshot.jobs.batchesTotal ?? 0}. Use this to stay in sync with the interface state.`,
        };
      })();

      const plannedRoutingActions = routingGeneratedActions;
      const routingSummary = routingLlmContext;

      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "system" as const, content: projectBrief },
        ...(workflowStatusContext
          ? [
              {
                role: "system" as const,
                content: `Workflow status snapshot: ${workflowStatusContext}`,
              },
            ]
          : []),
        ...(routingSummary
          ? [
              {
                role: "system" as const,
                content: `Workflow routing summary:\n${routingSummary}`,
              },
            ]
          : []),
        ...(frontendContextMessage ? [frontendContextMessage] : []),
        ...historyMessages,
        { role: "user" as const, content: latestUserMessage.content },
      ];

      let modelReply = "요청을 처리하지 못했습니다.";
      let actions: LlmAction[] = [];
      let profileUpdates: Record<string, any> | undefined;

      try {
        const completion = await openai.chat.completions.create({
          model: selectedModelId,
          response_format: { type: "json_object" },
          messages,
        });

        const content = completion.choices[0]?.message?.content || "{}";
        const parsed = JSON.parse(content);
        modelReply = parsed.reply ?? modelReply;
        actions = Array.isArray(parsed.actions)
          ? parsed.actions
          : plannedRoutingActions ?? [];
        profileUpdates = parsed.profileUpdates;
        request.log.info(
          { profileUpdates },
          "[CHAT] Model profileUpdates payload",
        );
      } catch (err) {
        request.log.error(
          { err, model: selectedModelId },
          "[CHAT] LLM call failed",
        );
        return reply.send({
          reply: "대화를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          actions: [],
        });
      }

      const {
        actions: reconciledActions,
        notes: actionNotes,
        effectiveIntent,
        effectiveLabel,
      } = reconcileActions({
        actions,
        classification: intentClassification,
        threshold: intentConfidenceThreshold,
        translationReady,
        translationInProgress,
        proofInProgress,
        proofCompleted,
        qualityCompleted,
        activeTranslationJob: latestJob
          ? {
              jobId: latestJob.id,
              workflowRunId: latestJob.workflow_run_id ?? null,
            }
          : null,
        previousIntent: previousIntentSnapshot,
      });

      if (actionNotes.length) {
        modelReply = `${modelReply}\n\n${actionNotes.join("\n")}`;
      }

      if (plannedRoutingActions?.length) {
        actions = [...plannedRoutingActions, ...reconciledActions];
      } else {
        actions = reconciledActions;
      }

      const classificationForEvent: IntentClassification = {
        ...intentClassification,
        label: effectiveLabel ?? intentClassification.label ?? null,
      };

      workflowEvents.emit(WORKFLOW_EVENTS.INTENT_REQUESTED, {
        projectId,
        userId,
        classification: classificationForEvent,
        effectiveIntent,
        previousIntent: previousIntentSnapshot ?? undefined,
      });

      // LLM-based entity extraction for structured metadata
      try {
        const entityMessages = [
          { role: "system" as const, content: ENTITY_PROMPT },
          { role: "system" as const, content: contextMeta },
          { role: "user" as const, content: latestUserMessage.content },
        ];
        const entityCompletion = await openai.chat.completions.create({
          model: selectedModelId,
          response_format: { type: "json_object" },
          messages: entityMessages,
        });
        const entityContent =
          entityCompletion.choices[0]?.message?.content || "{}";
        const entityPayload = JSON.parse(entityContent) as Partial<
          Record<
            "title" | "author" | "context" | "translationDirection" | "memo",
            string | null
          >
        >;
        if (entityPayload && typeof entityPayload === "object") {
          request.log.info(
            { entityPayload },
            "[CHAT] Entity extraction payload",
          );
          profileUpdates = { ...(profileUpdates ?? {}) };
          for (const key of [
            "title",
            "author",
            "context",
            "translationDirection",
            "memo",
          ] as const) {
            const value = entityPayload[key];
            if (typeof value === "string" && value.trim().length > 0) {
              profileUpdates[key] = value.trim();
            }
          }
        }
      } catch (err) {
        request.log.warn(
          { err, model: selectedModelId },
          "[CHAT] Entity extraction failed",
        );
      }

      const inferredAuthor = extractAuthorFromMessage(
        latestUserMessage.content,
      );
      if (inferredAuthor) {
        profileUpdates = { ...profileUpdates, author: inferredAuthor };
        request.log.info(
          { inferredAuthor },
          "[CHAT] Rule-based author inference",
        );
      }

      const sanitizedUpdates = sanitizeProfileUpdates(
        profileUpdates,
        currentMeta,
        project,
      );
      request.log.info(
        { sanitizedUpdates },
        "[CHAT] Sanitized profile updates (final)",
      );
      profileUpdates = sanitizedUpdates;

      if (profileUpdates) {
        const updates: string[] = [];
        const values: any[] = [];
        const memoParts: string[] = [];
        let metaChanged = false;
        const nextMeta: Record<string, any> = { ...currentMeta };
        request.log.info(
          { profileUpdates },
          "[CHAT] Profile updates after merge",
        );

        if (profileUpdates.translationDirection) {
          updates.push(`intention = $${updates.length + 1}`);
          values.push(profileUpdates.translationDirection);
          nextMeta.translationDirection = profileUpdates.translationDirection;
          metaChanged = true;
        }
        if (profileUpdates.context) {
          updates.push(`description = $${updates.length + 1}`);
          values.push(profileUpdates.context);
          memoParts.push(`Context: ${profileUpdates.context}`);
          nextMeta.context = profileUpdates.context;
          metaChanged = true;
        }
        const existingMemoEntries =
          typeof project?.memo === "string"
            ? project.memo
                .split(/\n+/)
                .map((entry: string) => entry.trim())
                .filter(Boolean)
            : [];
        if (profileUpdates.memo) {
          if (
            !existingMemoEntries.includes(profileUpdates.memo) &&
            !memoParts.includes(profileUpdates.memo)
          ) {
            memoParts.push(profileUpdates.memo);
          }
        }
        if (profileUpdates.author) {
          memoParts.push(`Author: ${profileUpdates.author}`);
          nextMeta.author = profileUpdates.author;
          metaChanged = true;
        }
        if (profileUpdates.title) {
          updates.push(`title = $${updates.length + 1}`);
          values.push(profileUpdates.title);
          nextMeta.draftTitle = profileUpdates.title;
          metaChanged = true;
        }

        if (memoParts.length) {
          updates.push(
            `memo = CONCAT_WS(E'\\n', NULLIF(memo, ''), $${updates.length + 1}::text)`,
          );
          values.push(memoParts.join("\n"));
        }

        if (metaChanged) {
          updates.push(`meta = $${updates.length + 1}::jsonb`);
          values.push(JSON.stringify(nextMeta));
        }

        if (updates.length) {
          try {
            values.push(projectId);
            request.log.info(
              { updates, valuesSnapshot: values },
              "[CHAT] Executing project update",
            );
            await query(
              `UPDATE translationprojects
               SET ${updates.join(", ")}, updated_at = now()
               WHERE project_id = $${values.length}`,
              values,
            );
            request.log.info(
              { projectId, profileUpdates },
              "[CHAT] Project profile updated",
            );
          } catch (err) {
            request.log.warn(
              { err },
              "[CHAT] Failed to update project profile",
            );
          }
        }
      }

      if (userId && projectId) {
        const snapshotToPersist = {
          ...classificationForEvent,
          label: classificationForEvent.label ?? null,
          notes: classificationForEvent.notes ?? null,
          effectiveIntent,
          updatedAt: new Date().toISOString(),
        };
        try {
          await saveIntentSnapshot(projectId, userId, snapshotToPersist);
        } catch (snapshotError) {
          request.log.warn(
            { err: snapshotError },
            "[CHAT] Failed to persist intent snapshot",
          );
        }
      }

      await ChatMessageModel.create({
        project_id: projectId,
        role: "assistant",
        content: modelReply,
        actions,
        metadata: { profileUpdates, model: selectedModelId },
      });

      return reply.send({
        reply: modelReply,
        actions,
        profileUpdates,
        model: selectedModelId,
      });
    },
  );

  fastify.get("/api/chat/prompt", async (_request, reply) => {
    return reply.send({ prompt: chatSystemPrompt });
  });

  fastify.get(
    "/api/chat/history/:projectId",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };

      const history = await ChatMessageModel.find({ project_id: projectId })
        .sort({ created_at: 1 })
        .limit(200)
        .lean()
        .exec();

      return reply.send({
        messages: history.map((msg) => ({
          id: String(msg._id),
          projectId: msg.project_id,
          role: msg.role,
          content: msg.content,
          actions: msg.actions,
          created_at: msg.created_at,
        })),
      });
    },
  );

  fastify.post(
    "/api/chat/log",
    {
      preHandler: requireAuthAndPlanCheck,
    },
    async (request, reply) => {
      const body = request.body as {
        projectId?: string;
        role?: string;
        content?: string;
        actions?: any[];
      };

      if (!body?.projectId || !body?.role || !body?.content) {
        return reply.status(400).send({
          success: false,
          error: "projectId, role, content are required",
        });
      }

      if (!["assistant", "system"].includes(body.role)) {
        return reply.status(400).send({
          success: false,
          error: "Only assistant/system roles can be logged.",
        });
      }

      await ChatMessageModel.create({
        project_id: body.projectId,
        role: body.role,
        content: body.content,
        actions: body.actions ?? [],
      });

      return reply.send({ success: true });
    },
  );
};

interface ActiveTranslationJobContext {
  jobId: string;
  workflowRunId: string | null;
}

interface ReconcileOptions {
  actions: LlmAction[];
  classification: IntentClassification;
  threshold: number;
  translationReady: boolean;
  translationInProgress: boolean;
  proofInProgress: boolean;
  proofCompleted: boolean;
  qualityCompleted: boolean;
  activeTranslationJob: ActiveTranslationJobContext | null;
  previousIntent?: StoredIntentSnapshot | null;
}

interface ReconcileResult {
  actions: LlmAction[];
  notes: string[];
  effectiveIntent: IntentClassification["intent"] | WorkflowType;
  effectiveLabel: string | null;
}

const START_ACTIONS = new Set([
  "startTranslation",
  "startProofread",
  "startQuality",
]);

const CANCEL_TRANSLATION_ACTION = "cancelTranslation";

const asWorkflowType = (
  intent: IntentClassification["intent"],
): WorkflowType | null => {
  switch (intent) {
    case "translate":
      return "translation";
    case "proofread":
      return "proofread";
    case "quality":
      return "quality";
    default:
      return null;
  }
};

const snapshotWorkflowIntent = (
  snapshot: StoredIntentSnapshot | null | undefined,
): WorkflowType | null => {
  if (!snapshot) return null;
  const effective = snapshot.effectiveIntent;
  if (
    effective === "translation" ||
    effective === "proofread" ||
    effective === "quality"
  ) {
    return effective;
  }
  const fromEffective =
    typeof effective === "string"
      ? asWorkflowType(effective as IntentClassification["intent"])
      : null;
  if (fromEffective) return fromEffective;
  return asWorkflowType(snapshot.intent as IntentClassification["intent"]);
};

function reconcileActions(options: ReconcileOptions): ReconcileResult {
  const {
    actions,
    classification,
    threshold,
    translationReady,
    translationInProgress,
    proofInProgress,
    proofCompleted: _proofCompleted,
    qualityCompleted,
    activeTranslationJob,
    previousIntent,
  } = options;

  const notes: string[] = [];
  const dedup = new Map<string, LlmAction>();

  const register = (action: LlmAction) => {
    if (!action?.type) return;
    dedup.set(action.type, action);
  };

  const remove = (type: string, note?: string) => {
    if (dedup.has(type)) {
      dedup.delete(type);
      if (note) notes.push(note);
    }
  };

  const ensure = (type: string, extras?: Partial<LlmAction>) => {
    const existing = dedup.get(type) ?? { type };
    dedup.set(type, { ...existing, ...extras });
  };

  actions.forEach(register);

  const previousWorkflowIntent = snapshotWorkflowIntent(previousIntent);
  let desiredWorkflowIntent = asWorkflowType(classification.intent);
  let effectiveLabel = classification.label ?? previousIntent?.label ?? null;
  const highConfidence = classification.confidence >= threshold;
  const rerun = classification.rerun;
  const canCancelTranslation =
    translationInProgress && Boolean(activeTranslationJob?.jobId);

  if (!desiredWorkflowIntent && rerun && previousWorkflowIntent) {
    desiredWorkflowIntent = previousWorkflowIntent;
    notes.push("이전 작업 유형을 다시 실행하려는 요청으로 해석했습니다.");
  }

  if (!effectiveLabel && previousIntent?.label) {
    effectiveLabel = previousIntent.label;
  }

  if (classification.intent === "status" && highConfidence) {
    for (const type of START_ACTIONS) {
      remove(
        type,
        "요청이 진행 상황 확인이라서 새 작업은 시작하지 않았습니다.",
      );
    }
  }

  if (classification.intent === "cancel") {
    if (canCancelTranslation) {
      ensure(CANCEL_TRANSLATION_ACTION, {
        jobId: activeTranslationJob?.jobId ?? null,
        workflowRunId: activeTranslationJob?.workflowRunId ?? null,
        autoStart: true,
      });
      for (const type of START_ACTIONS) {
        remove(
          type,
          "번역 중지 요청이 있어 새 작업을 시작하지 않았습니다.",
        );
      }
    } else {
      remove(
        CANCEL_TRANSLATION_ACTION,
        "현재 진행 중인 번역 작업이 없어 중지 요청을 실행하지 않았습니다.",
      );
    }
  }

  const canAutoExecute = (target: WorkflowType | null) => {
    if (!target) return false;
    if (target === desiredWorkflowIntent && highConfidence) return true;
    if (rerun && previousWorkflowIntent === target) return true;
    return false;
  };

  const allowParallelFlag = rerun === true;

  if (canAutoExecute("translation")) {
    ensure("startTranslation", {
      label: effectiveLabel,
      allowParallel: allowParallelFlag,
      autoStart: true,
    });
  }

  if (canAutoExecute("proofread")) {
    if (!translationReady) {
      remove(
        "startProofread",
        "번역본이 준비되지 않아 교정을 시작하지 않았습니다.",
      );
    } else if (proofInProgress && !rerun) {
      remove(
        "startProofread",
        "이미 교정 작업이 진행 중입니다. 이전 작업이 끝나면 다시 요청해 주세요.",
      );
    } else {
      ensure("startProofread", {
        label: effectiveLabel,
        allowParallel: allowParallelFlag,
        autoStart: true,
      });
      remove("startQuality");
    }
  }

  if (canAutoExecute("quality")) {
    if (!translationReady) {
      remove(
        "startQuality",
        "번역이 완료되지 않아 품질 평가를 시작하지 않았습니다.",
      );
    } else if (qualityCompleted && !rerun) {
      remove(
        "startQuality",
        "최근 품질 평가가 완료된 상태입니다. 다시 실행하려면 '다시'와 함께 명확히 요청해 주세요.",
      );
    } else {
      ensure("startQuality", {
        label: effectiveLabel,
        allowParallel: allowParallelFlag,
        autoStart: true,
      });
      remove("startProofread");
    }
  }

  if (!highConfidence && !rerun) {
    if (proofInProgress) {
      remove(
        "startProofread",
        "교정이 이미 진행 중이어서 추가 작업을 시작하지 않았습니다.",
      );
    }
    if (qualityCompleted) {
      remove(
        "startQuality",
        "최근 품질 평가가 완료된 상태입니다. 다시 실행하려면 구체적으로 요청해 주세요.",
      );
    }
  }

  if (!translationReady) {
    remove("startProofread", "번역본이 준비되면 교정을 도와드릴게요.");
    remove(
      "startQuality",
      "번역본이 준비되지 않아 품질 평가를 진행할 수 없습니다.",
    );
  }

  if (canCancelTranslation) {
    const cancelAction = dedup.get(CANCEL_TRANSLATION_ACTION);
    if (cancelAction) {
      dedup.set(CANCEL_TRANSLATION_ACTION, {
        ...cancelAction,
        jobId: cancelAction.jobId ?? activeTranslationJob?.jobId ?? null,
        workflowRunId:
          cancelAction.workflowRunId ?? activeTranslationJob?.workflowRunId ?? null,
      });
    }
  } else {
    remove(CANCEL_TRANSLATION_ACTION);
  }

  const final: LlmAction[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (!action?.type) continue;
    if (dedup.has(action.type) && !seen.has(action.type)) {
      final.push({ autoStart: false, ...dedup.get(action.type)! });
      seen.add(action.type);
    }
  }
  for (const [type, action] of dedup.entries()) {
    if (!seen.has(type)) {
      final.push({ autoStart: false, ...action });
    }
  }

  let effectiveIntent: IntentClassification["intent"] | WorkflowType =
    classification.intent;
  for (const action of final) {
    const mapped = ACTION_INTENT_MAP[action.type];
    if (mapped) {
      effectiveIntent = mapped;
      if (typeof action.label === "string") {
        effectiveLabel = action.label;
      }
      break;
    }
  }

  return { actions: final, notes, effectiveIntent, effectiveLabel };
}

export default chatRoutes;
