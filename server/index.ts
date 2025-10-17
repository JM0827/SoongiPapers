import Fastify, {
  FastifyReply,
  FastifyRequest,
  FastifyInstance,
} from "fastify";
import cors from "@fastify/cors";
import fastifyOauth2 from "@fastify/oauth2";
import multipart from "@fastify/multipart";
import type {
  Multipart,
  MultipartFile,
  MultipartValue,
  MultipartFields,
} from "@fastify/multipart";
import * as jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { OpenAI } from "openai";

import { requireAuthAndPlanCheck } from "./middleware/auth";
import TranslationFile from "./models/TranslationFile";
import TranslationDraft from "./models/TranslationDraft";
import TranslationSegment from "./models/TranslationSegment";
import TranslationBatch from "./models/TranslationBatch";
import DocumentProfile, {
  type TranslationNotes,
} from "./models/DocumentProfile";
import Proofreading from "./models/Proofreading";
import EbookFile from "./models/EbookFile";
import { recordTokenUsage } from "./services/usage";
import { getCoverService, parseCoverJobPayload } from "./services/cover";
import { analyzeDocumentProfile } from "./agents/profile/profileAgent";
import {
  getSequentialTranslationConfig,
  getTranslationSegmentationMode,
} from "./config/appControlConfiguration";
import {
  segmentOriginText,
  generateTranslationDraft,
  synthesizeTranslation,
  handleTranslationStageJob,
  type OriginSegment,
  type TranslationSynthesisSegmentResult,
  type ProjectMemory,
  type TranslationStage,
  type SequentialStageJobSegment,
} from "./agents/translation";
import evaluationRoutes from "./routes/evaluation";
import proofreadingRoutes from "./routes/proofreading";
import proofreadEditorRoutes from "./routes/proofreadEditor";
import dictionaryRoutes from "./routes/dictionary";
import chatRoutes from "./routes/chat";
import editingRoutes from "./routes/editing";
import documentProfileRoutes from "./routes/documentProfiles";
import ebooksRoutes from "./routes/ebooks";
import modelsRoutes from "./routes/models";
import workflowRoutes from "./routes/workflow";
import memoryRoutes from "./routes/memory";
import {
  cancelAction as cancelWorkflowRun,
  completeAction as completeWorkflowRun,
  failAction as failWorkflowRun,
  requestAction as requestWorkflowAction,
  WorkflowRunRecord,
} from "./services/workflowManager";
import {
  ensureQueuedDraft,
  markDraftRunning,
  completeDraft,
  failDraft,
  listSuccessfulDrafts,
  loadDraftsByIds,
  cancelDrafts,
} from "./services/translationDrafts";
import {
  registerTranslationDraftProcessor,
  registerTranslationSynthesisProcessor,
  enqueueTranslationSynthesisJob,
  type TranslationDraftJobData,
  type TranslationSynthesisJobData,
  type TranslationDraftJob,
  type TranslationSynthesisJob,
  removeDraftQueueJob,
  removeSynthesisQueueJob,
} from "./services/translationQueue";
import {
  registerTranslationStageProcessor,
  enqueueTranslationStageJob,
  removeStageJobsFor,
} from "./services/translationStageQueue";
import { ensureProjectMemory } from "./services/translation/memory";
import cleanText from "./utils/cleanText";

import { pool, query } from "./db";
import { nanoid } from "nanoid";
import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile, mkdir } from "fs/promises";
import PDFDocument from "pdfkit";
import iconv from "iconv-lite";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "fs";
import {
  extractOriginFromUpload,
  OriginExtraction,
  OriginExtractionResult,
  OriginFileTooLargeError,
  UnsupportedOriginFileError,
} from "./services/origin/extractor";

const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';

let app: FastifyInstance;

const SEQUENTIAL_STAGES = ["literal", "style", "emotion", "qa"] as const;

if (HTTPS_ENABLED) {
  const keyPath = path.join(process.cwd(), 'certs', 'server.key');
  const certPath = path.join(process.cwd(), 'certs', 'server.crt');
  
  try {
    const httpsOptions = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
    
    app = Fastify({ 
      logger: true,
      https: httpsOptions 
    });
  } catch (sslError) {
    console.warn('[STARTUP] SSL certificates not found, falling back to HTTP');
    app = Fastify({ logger: true });
  }
} else {
  app = Fastify({ logger: true });
}
const coverService = getCoverService();
const ebookStorageRoot =
  process.env.EBOOK_STORAGE_DIR ??
  path.resolve(process.cwd(), "storage", "ebooks");

const OAUTH_STATE_TTL_MS = Number(
  process.env.OAUTH_STATE_TTL_MS || 10 * 60 * 1000,
);
const oauthStateStore = new Map<string, number>();

const pruneExpiredOauthStates = () => {
  const now = Date.now();
  for (const [key, expiresAt] of oauthStateStore.entries()) {
    if (expiresAt <= now) {
      oauthStateStore.delete(key);
    }
  }
};

const pruneInterval = setInterval(
  pruneExpiredOauthStates,
  Math.max(30_000, Math.min(OAUTH_STATE_TTL_MS, 5 * 60_000)),
);
if (typeof pruneInterval.unref === "function") {
  pruneInterval.unref();
}

const generateOauthState = async function (
  this: FastifyInstance,
): Promise<string> {
  const state = nanoid();
  oauthStateStore.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  return state;
};

const checkOauthState = async function (
  this: FastifyInstance,
  request: FastifyRequest,
): Promise<boolean> {
  const { state } = request.query as { state?: string };
  if (!state) {
    throw new Error("Missing state");
  }

  const expiresAt = oauthStateStore.get(state);
  if (!expiresAt || expiresAt <= Date.now()) {
    oauthStateStore.delete(state);
    throw new Error("Invalid state");
  }

  oauthStateStore.delete(state);
  return true;
};

type PdfImageSpec = {
  data: Buffer;
  mimeType: string;
};

const createPdfBuffer = async (options: {
  title: string;
  author?: string | null;
  translator?: string | null;
  content: string;
  frontCover?: PdfImageSpec | null;
  backCover?: PdfImageSpec | null;
}) => {
  const { title, author, translator, content, frontCover, backCover } = options;
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on("error", reject);
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    try {
      if (title) {
        doc.info.Title = title;
      }
      if (author) {
        doc.info.Author = author;
      }
      if (translator) {
        doc.info.Subject = `Translated by ${translator}`;
      }

      const drawCover = (image: PdfImageSpec) => {
        const availableWidth =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const availableHeight =
          doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
        doc.image(image.data, doc.page.margins.left, doc.page.margins.top, {
          fit: [availableWidth, availableHeight],
          align: "center",
          valign: "center",
        });
      };

      if (frontCover) {
        drawCover(frontCover);
        doc.addPage();
      }

      const safeTitle = title || "Untitled Manuscript";
      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .text(safeTitle, { align: "left" });
      doc.moveDown();

      if (author) {
        doc.font("Helvetica").fontSize(11).text(`Author: ${author}`);
      }
      if (translator) {
        doc.font("Helvetica").fontSize(11).text(`Translator: ${translator}`);
      }
      if (author || translator) {
        doc.moveDown();
      }

      const body =
        content && content.trim().length ? content : "(empty manuscript)";
      doc.font("Helvetica").fontSize(11).text(body, {
        align: "left",
        lineGap: 4,
      });

      if (backCover) {
        doc.addPage();
        drawCover(backCover);
      }
    } catch (error) {
      reject(error);
      doc.end();
      return;
    }

    doc.end();
  });
};

const maybeDecodeKorean = (value: string | null | undefined): string | null => {
  if (!value) return value ?? null;
  const trimmed = value.startsWith("\ufeff") ? value.slice(1) : value;
  const hasHangul = /[\uAC00-\uD7A3]/.test(trimmed);
  if (hasHangul) {
    return trimmed;
  }
  const hasExtendedLatin = /[\u0080-\u00FF]/.test(trimmed);
  if (!hasExtendedLatin) {
    return trimmed;
  }

  try {
    const buffer = Buffer.from(trimmed, "binary");
    const decoded = iconv.decode(buffer, "euc-kr");
    return decoded.startsWith("\ufeff") ? decoded.slice(1) : decoded;
  } catch (error) {
    app.log.warn({ err: error }, "[ebook] failed to decode euc-kr string");
    return trimmed;
  }
};

const resolveCoverImages = async (
  projectId: string,
): Promise<{ front: PdfImageSpec | null; back: PdfImageSpec | null }> => {
  try {
    const overview = await coverService.getCoverOverview(projectId);
    const coverSet =
      overview.coverSets.find(
        (set) => set.isCurrent && set.status === "ready",
      ) ??
      overview.coverSets.find((set) => set.status === "ready") ??
      null;

    if (!coverSet) {
      return { front: null, back: null };
    }

    const loadAsset = async (
      assetId: string | null | undefined,
    ): Promise<PdfImageSpec | null> => {
      if (!assetId) return null;
      const fileInfo = await coverService.getCoverAssetFile(projectId, assetId);
      if (!fileInfo) return null;
      try {
        const data = await readFile(fileInfo.absolutePath);
        return { data, mimeType: fileInfo.mimeType };
      } catch (error) {
        app.log.warn(
          { err: error, projectId, assetId },
          "[ebook] failed to read cover asset",
        );
        return null;
      }
    };

    const frontAsset = coverSet.assets.find((asset) => asset.role === "front");
    const backAsset = coverSet.assets.find((asset) => asset.role === "back");

    const [front, back] = await Promise.all([
      loadAsset(frontAsset?.assetId),
      loadAsset(backAsset?.assetId),
    ]);

    return { front, back };
  } catch (error) {
    app.log.warn(
      { err: error, projectId },
      "[ebook] failed to load cover overview",
    );
    return { front: null, back: null };
  }
};

app.register(multipart, {
  limits: {
    fileSize: OriginExtraction.FILE_SIZE_LIMIT,
  },
});

// Define Document model ONCE at top-level
const Document =
  mongoose.models.Document ||
  mongoose.model(
    "Document",
    new mongoose.Schema(
      {
        documentId: String,
        user_id: String,
        originalText: String,
        translatedText: String,
        created_at: { type: Date, default: Date.now },
        updated_at: { type: Date, default: Date.now },
        translation_finished_at: Date,
      },
      { collection: "documents" },
    ),
  );

const OriginFile =
  mongoose.models.OriginFile ||
  mongoose.model(
    "OriginFile",
    new mongoose.Schema(
      {
        project_id: String,
        job_id: String, // "0000" for initial file upload
        file_type: String, // extension without leading dot
        file_size: Number,
        original_filename: String,
        original_extension: String,
        mime_type: String,
        extraction_method: String,
        word_count: Number,
        character_count: Number,
        binary_content: { type: Buffer },
        text_content: String,
        created_at: { type: Date, default: Date.now },
        updated_at: { type: Date, default: Date.now },
      },
      { collection: "origin_files" },
    ),
  );

const QualityAssessment =
  mongoose.models.QualityAssessment ||
  mongoose.model(
    "QualityAssessment",
    new mongoose.Schema(
      {
        projectId: String,
        jobId: String,
        assessmentId: String,
        timestamp: { type: Date, default: Date.now },
        sourceText: String,
        translatedText: String,
        qualityResult: {
          overallScore: Number,
          quantitative: mongoose.Schema.Types.Mixed,
          qualitative: {
            emotionalDepth: String,
            vividness: String,
            metaphors: String,
            literaryValue: String,
          },
          meta: {
            model: String,
            chunks: Number,
            chunkSize: Number,
            overlap: Number,
          },
        },
        translationMethod: {
          type: String,
          enum: ["auto", "manual"],
          default: "auto",
        },
        modelUsed: String,
        userId: String,
        created_at: { type: Date, default: Date.now },
        updated_at: { type: Date, default: Date.now },
      },
      { collection: "quality_assessments" },
    ),
  );

// Register Google OAuth2 and routes
app.register(fastifyOauth2, {
  name: "googleOAuth2",
  scope: ["profile", "email"],
  credentials: {
    client: {
      id: process.env.GOOGLE_CLIENT_ID!,
      secret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    auth: (fastifyOauth2 as any).GOOGLE_CONFIGURATION,
  },
  startRedirectPath: "/api/auth/google",
  callbackUri: process.env.GOOGLE_CALLBACK_URL!,
  generateStateFunction: generateOauthState,
  checkStateFunction: checkOauthState,
});

app.register(evaluationRoutes);
app.register(proofreadingRoutes);
app.register(proofreadEditorRoutes);
app.register(dictionaryRoutes);
app.register(chatRoutes);
app.register(editingRoutes);
app.register(modelsRoutes);
app.register(documentProfileRoutes);
app.register(ebooksRoutes);
app.register(workflowRoutes, { prefix: "/api" });
app.register(memoryRoutes);

function mapProjectRow(row: any) {
  let meta: Record<string, any> = {};
  if (row.meta) {
    if (typeof row.meta === "object") {
      meta = row.meta as Record<string, any>;
    } else if (typeof row.meta === "string") {
      try {
        meta = JSON.parse(row.meta) as Record<string, any>;
      } catch (error) {
        app.log?.warn?.(
          { error, meta: row.meta },
          "[PROJECT] Failed to parse project meta field",
        );
      }
    }
  }

  return {
    project_id: row.project_id,
    user_id: row.user_id,
    title: row.title,
    description: row.description,
    intention: row.intention,
    memo: row.memo,
    meta,
    status: row.status,
    origin_lang: row.origin_lang,
    target_lang: row.target_lang,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// OAuth callback
app.get("/api/auth/google/callback", async (req, reply) => {
  try {
    const { token } = await (
      app as any
    ).googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);
    const userInfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    );
    const userInfo = (await userInfoRes.json()) as any;

    const upsert = await query(
      `INSERT INTO users (user_id, first_name, last_name, email, photo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         photo = EXCLUDED.photo
       RETURNING user_id, first_name, last_name, email, photo`,
      [
        userInfo.id,
        userInfo.given_name,
        userInfo.family_name,
        userInfo.email,
        userInfo.picture,
      ],
    );
    const user = upsert.rows[0];

    const jwtSecret = process.env.JWT_SECRET || "dev_secret";
    const tokenPayload = { user_id: user.user_id, email: user.email };
    const jwtToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: "7d" });

    const redirectTarget =
      process.env.OAUTH_SUCCESS_REDIRECT ||
      "http://localhost:5174/oauth/callback";
    try {
      const redirectUrl = new URL(redirectTarget);
      redirectUrl.searchParams.set("jwt", jwtToken);
      reply.redirect(redirectUrl.toString());
    } catch (err) {
      app.log.error({ err, redirectTarget }, "[AUTH] Invalid redirect target");
      reply.redirect("/oauth-error?reason=bad_redirect");
    }
  } catch (e: any) {
    reply.status(500).send({ error: "OAuth callback failed: " + e.message });
  }
});

// Get current user info from JWT
app.get("/api/auth/me", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer "))
      return reply.status(401).send({ error: "No token provided" });

    const token = authHeader.substring(7);
    // The JWT is signed with a `user_id` property (see OAuth callback above).
    // Use the same field name here to avoid user lookup failures.
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      user_id?: string;
      userId?: string;
    };

    const userIdToLookup = decoded.user_id || decoded.userId;

    const { rows } = await query(
      "SELECT user_id, first_name, last_name, nick_name, email, photo FROM users WHERE user_id = $1",
      [userIdToLookup],
    );
    if (!rows.length)
      return reply.status(404).send({ error: "User not found" });

    const user = rows[0];
    reply.send({
      id: user.user_id,
      email: user.email,
      name:
        user.nick_name ||
        `${user.first_name} ${user.last_name}`.trim() ||
        user.first_name,
      picture: user.photo,
    });
  } catch (error) {
    app.log.error(error, "Error fetching user info");
    reply.status(401).send({ error: "Invalid token" });
  }
});

// Projects CRUD
app.get("/api/projects", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const userId = (req as any).user_id;

  try {
    const { rows } = await query(
      `SELECT project_id, user_id, title, description, intention, memo, meta, status, origin_lang, target_lang, created_at, updated_at
       FROM translationprojects
       WHERE user_id = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
      [userId],
    );

    reply.send({ projects: rows.map(mapProjectRow) });
  } catch (error) {
    app.log.error(error, "[PROJECTS] Failed to load projects");
    reply.status(500).send({ error: "Failed to load projects" });
  }
});

app.get("/api/projects/latest", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const userId = (req as any).user_id;

  try {
    const { rows } = await query(
      `SELECT project_id, user_id, title, description, intention, memo, meta, status, origin_lang, target_lang, created_at, updated_at
       FROM translationprojects
       WHERE user_id = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [userId],
    );

    reply.send({ project: rows[0] ? mapProjectRow(rows[0]) : null });
  } catch (error) {
    app.log.error(error, "[PROJECTS] Failed to load latest project");
    reply.status(500).send({ error: "Failed to load latest project" });
  }
});

app.get("/api/projects/:projectId", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId } = req.params as { projectId: string };
  const userId = (req as any).user_id;

  try {
    const { rows } = await query(
      `SELECT project_id, user_id, title, description, intention, memo, meta, status, origin_lang, target_lang, created_at, updated_at
       FROM translationprojects
       WHERE project_id = $1 AND user_id = $2
       LIMIT 1`,
      [projectId, userId],
    );

    if (!rows.length) {
      return reply.status(404).send({ error: "Project not found" });
    }

    reply.send({ project: mapProjectRow(rows[0]) });
  } catch (error) {
    app.log.error(error, "[PROJECTS] Failed to load project");
    reply.status(500).send({ error: "Failed to load project" });
  }
});

app.post("/api/projects", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const userId = (req as any).user_id;
  const body = req.body as Partial<{
    title: string;
    description: string;
    intention: string;
    memo: string;
    meta: any;
    status: string;
    origin_lang: string;
    target_lang: string;
  }>;

  if (!body?.title) {
    return reply.status(400).send({ error: "title is required" });
  }

  try {
    const { rows } = await query(
      `INSERT INTO translationprojects (user_id, title, description, intention, memo, meta, status, origin_lang, target_lang)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING project_id, user_id, title, description, intention, memo, meta, status, origin_lang, target_lang, created_at, updated_at`,
      [
        userId,
        body.title,
        body.description ?? "",
        body.intention ?? "",
        body.memo ?? "",
        JSON.stringify(body.meta ?? {}),
        body.status ?? "active",
        body.origin_lang ?? "Korean",
        body.target_lang ?? "English",
      ],
    );

    if (!rows.length) {
      throw new Error("Insert did not return a project row");
    }

    const project = mapProjectRow(rows[0]);
    reply.status(201).send({ project });
  } catch (error) {
    app.log.error(error, "[PROJECTS] Failed to create project");
    reply.status(500).send({ error: "Failed to create project" });
  }
});

app.put("/api/projects/:projectId", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId } = req.params as { projectId: string };
  const userId = (req as any).user_id;
  const body = req.body as Partial<{
    title: string;
    description: string;
    intention: string;
    memo: string;
    meta: any;
    status: string;
    origin_lang: string;
    target_lang: string;
  }>;

  try {
    const existing = await query(
      `SELECT project_id, user_id, title, description, intention, memo, meta, status, origin_lang, target_lang, created_at, updated_at
       FROM translationprojects
       WHERE project_id = $1 AND user_id = $2
       LIMIT 1`,
      [projectId, userId],
    );

    if (!existing.rows.length) {
      return reply.status(404).send({ error: "Project not found" });
    }

    const current = existing.rows[0];
    const currentMeta = (() => {
      if (!current.meta) return {} as Record<string, any>;
      if (typeof current.meta === "object")
        return current.meta as Record<string, any>;
      try {
        return JSON.parse(current.meta as string);
      } catch (err) {
        return {} as Record<string, any>;
      }
    })();

    const { rows } = await query(
      `UPDATE translationprojects
         SET title = $1,
             description = $2,
             intention = $3,
             memo = $4,
             meta = $5::jsonb,
             status = $6,
             origin_lang = $7,
             target_lang = $8,
             updated_at = NOW()
      WHERE project_id = $9 AND user_id = $10
      RETURNING project_id, user_id, title, description, intention, memo, meta, status, origin_lang, target_lang, created_at, updated_at`,
      [
        body.title ?? current.title,
        body.description ?? current.description,
        body.intention ?? current.intention,
        body.memo ?? current.memo,
        JSON.stringify(body.meta ?? currentMeta ?? {}),
        body.status ?? current.status,
        body.origin_lang ?? current.origin_lang,
        body.target_lang ?? current.target_lang,
        projectId,
        userId,
      ],
    );

    if (!rows.length) {
      throw new Error("Update did not return a project row");
    }

    reply.send({ project: mapProjectRow(rows[0]) });
  } catch (error) {
    app.log.error(error, "[PROJECTS] Failed to update project");
    reply.status(500).send({ error: "Failed to update project" });
  }
});

type MultipartPart = Multipart | MultipartFile;

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const isFieldPart = (part: MultipartPart): part is Multipart =>
  (part as MultipartValue | MultipartFile)?.type === "field";

const getFieldValue = (
  fields: MultipartFields | undefined,
  name: string,
): string | undefined => {
  if (!fields) return undefined;
  const field = asArray(fields[name]).find(isFieldPart);
  if (!field) return undefined;
  const rawValue = (field as MultipartValue).value;
  if (typeof rawValue === "string") return rawValue;
  if (Buffer.isBuffer(rawValue)) return rawValue.toString("utf8");
  return undefined;
};

app.put("/api/projects/:projectId/origin", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId } = req.params as { projectId: string };
  const userId = (req as any).user_id as string | undefined;

  const now = new Date();

  const persistOrigin = async ({
    text,
    filename,
    jobId,
    fileSize,
    metadata,
    binary,
  }: {
    text: string;
    filename: string;
    jobId: string;
    fileSize: number;
    metadata?: OriginExtractionResult["metadata"];
    binary?: Buffer | null;
  }) => {
    const normalizedText = (text ?? "").replace(/\r\n?/g, "\n");
    if (!normalizedText.trim().length) {
      throw new Error("content cannot be empty");
    }

    const doc = await OriginFile.findOneAndUpdate(
      { project_id: projectId, job_id: jobId },
      {
        project_id: projectId,
        job_id: jobId,
        file_type: metadata?.extension?.replace(/^\./, "") || "txt",
        file_size: fileSize,
        original_filename: filename,
        original_extension: metadata?.extension ?? null,
        mime_type: metadata?.mimeType ?? null,
        extraction_method: metadata?.extractor ?? null,
        word_count:
          metadata?.wordCount ??
          normalizedText.split(/\s+/).filter(Boolean).length,
        character_count: metadata?.characterCount ?? normalizedText.length,
        binary_content: binary ?? undefined,
        text_content: normalizedText,
        updated_at: now,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    try {
      await TranslationFile.findOneAndUpdate(
        { project_id: projectId },
        {
          $set: {
            origin_filename: filename,
            origin_file_size: fileSize,
            origin_content: normalizedText,
            updated_at: now,
          },
        },
        { sort: { completed_at: -1 } },
      );
    } catch (tfErr) {
      app.log.warn(
        tfErr,
        `[ORIGIN] Could not update translation file for project ${projectId}`,
      );
    }

    try {
      await query(
        "UPDATE translationprojects SET origin_file = $1, updated_at = NOW() WHERE project_id = $2",
        [String(doc._id), projectId],
      );
    } catch (pgErr) {
      app.log.warn(
        pgErr,
        `[ORIGIN] Failed to update translationprojects.origin_file for ${projectId}`,
      );
    }

    if (userId) {
      enqueueProfileAnalysisJob({
        projectId,
        userId,
        payload: {
          variant: "origin",
          originFileId: doc?._id ? String(doc._id) : null,
          triggeredBy: "origin-update",
        },
      }).catch((err) => {
        app.log.error(
          { err, projectId },
          "[PROFILE] Failed to enqueue origin profile job",
        );
      });
    }

    return doc;
  };

  if (req.isMultipart()) {
    try {
      const filePart = (await req.file()) as
        | (MultipartFile & { fields: MultipartFields })
        | undefined;
      if (!filePart) {
        return reply.status(400).send({ error: "No file provided" });
      }

      const buffer = await filePart.toBuffer();
      const filename = filePart.filename || `origin_${projectId}`;
      const jobId = getFieldValue(filePart.fields, "jobId") || "0000";

      let extraction: OriginExtractionResult;
      try {
        extraction = await extractOriginFromUpload({
          buffer,
          filename,
          mimeType: filePart.mimetype,
        });
      } catch (err: any) {
        if (err instanceof OriginFileTooLargeError) {
          return reply.status(413).send({ error: err.message });
        }
        if (err instanceof UnsupportedOriginFileError) {
          return reply.status(400).send({ error: err.message });
        }
        app.log.error({ err, projectId }, "[ORIGIN] File extraction failed");
        return reply.status(500).send({
          error:
            err instanceof Error
              ? err.message
              : "Failed to extract text from uploaded file",
        });
      }

      try {
        const originDoc = await persistOrigin({
          text: extraction.text,
          filename: extraction.metadata.originalName || filename,
          jobId,
          fileSize: extraction.metadata.fileSize,
          metadata: extraction.metadata,
          binary: extraction.binary,
        });

        return reply.send({
          success: true,
          origin: {
            id: originDoc._id,
            updated_at: originDoc.updated_at,
            file_size: originDoc.file_size,
            filename: originDoc.original_filename,
            content: originDoc.text_content,
            metadata: {
              extractor: originDoc.extraction_method,
              wordCount: originDoc.word_count,
              characterCount: originDoc.character_count,
              mimeType: originDoc.mime_type,
              extension: originDoc.original_extension,
            },
          },
        });
      } catch (error: any) {
        if (error.message === "content cannot be empty") {
          return reply
            .status(400)
            .send({ error: "No textual content was extracted from the file" });
        }
        app.log.error(
          error,
          `[ORIGIN] Failed to upsert origin for project ${projectId}`,
        );
        return reply
          .status(500)
          .send({ error: "Failed to save origin content" });
      }
    } catch (err) {
      app.log.error(err, "[ORIGIN] Multipart handling failed");
      return reply
        .status(500)
        .send({ error: "Failed to process uploaded file" });
    }
  }

  const body = req.body as {
    content?: string;
    filename?: string;
    jobId?: string;
  };
  const content = body?.content ?? "";
  if (typeof content !== "string") {
    return reply.status(400).send({ error: "content must be a string" });
  }

  const cleanedContent = cleanText(content, { source: "auto" });
  const filename = body?.filename || `origin_${projectId}.txt`;
  const jobId = body?.jobId || "0000";
  const fileSize = Buffer.byteLength(cleanedContent, "utf8");

  try {
    const originDoc = await persistOrigin({
      text: cleanedContent,
      filename,
      jobId,
      fileSize,
      metadata: {
        originalName: filename,
        mimeType: "text/plain",
        extension: ".txt",
        fileSize,
        extractor: "direct",
        wordCount: cleanedContent.trim().split(/\s+/).filter(Boolean).length,
        characterCount: cleanedContent.trim().length,
      },
      binary: null,
    });

    reply.send({
      success: true,
      origin: {
        id: originDoc._id,
        updated_at: originDoc.updated_at,
        file_size: originDoc.file_size,
        filename: originDoc.original_filename,
        content: originDoc.text_content,
        metadata: {
          extractor: originDoc.extraction_method,
          wordCount: originDoc.word_count,
          characterCount: originDoc.character_count,
          mimeType: originDoc.mime_type,
          extension: originDoc.original_extension,
        },
      },
    });
  } catch (error: any) {
    if (error.message === "content cannot be empty") {
      return reply.status(400).send({ error: "content cannot be empty" });
    }
    app.log.error(
      error,
      `[ORIGIN] Failed to upsert origin for project ${projectId}`,
    );
    reply.status(500).send({
      error:
        error instanceof Error
          ? error.message
          : "Failed to save origin content",
    });
  }
});

app.put("/api/projects/:projectId/translation", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId } = req.params as { projectId: string };
  const body = req.body as { content?: string; jobId?: string };
  const userId = (req as any).user_id as string | undefined;

  if (typeof body?.content !== "string") {
    return reply
      .status(400)
      .send({ error: "content must be provided as a string" });
  }

  const now = new Date();
  const content = body.content as string;
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  try {
    const filter: any = { project_id: projectId };
    if (body?.jobId) {
      filter.job_id = body.jobId;
    }

    let translationDoc = await TranslationFile.findOne(
      filter,
      null,
      body?.jobId ? undefined : { sort: { completed_at: -1, updated_at: -1 } },
    );

    if (!translationDoc) {
      let originFilename = `origin_${projectId}.txt`;
      let originContent = "";
      let originFileSize = 0;

      try {
        const originDoc = await OriginFile.findOne(
          { project_id: projectId },
          null,
          { sort: { updated_at: -1 } },
        );
        if (originDoc) {
          originFilename = originDoc.original_filename || originFilename;
          originContent = originDoc.text_content || "";
          originFileSize = originDoc.file_size || 0;
        }
      } catch (originLookupError) {
        app.log.warn(
          { err: originLookupError, projectId },
          "[TRANSLATION] Failed to load origin metadata while saving translation",
        );
      }

      if (!originContent.trim().length) {
        originContent = "[origin unavailable]";
        originFileSize = Buffer.byteLength(originContent, "utf8");
      }

      const jobIdToUse = body?.jobId ?? `manual-${Date.now()}`;

      const upserted = await TranslationFile.findOneAndUpdate(
        { project_id: projectId, job_id: jobIdToUse },
        {
          $set: {
            translated_content: normalizedContent,
            updated_at: now,
            variant: "final",
            is_final: true,
            synthesis_draft_ids: [],
          },
          $setOnInsert: {
            project_id: projectId,
            job_id: jobIdToUse,
            origin_filename: originFilename,
            origin_file_size: originFileSize,
            origin_content: originContent,
            batch_count: 0,
            completed_batches: 0,
            created_at: now,
            completed_at: now,
            variant: "final",
            is_final: true,
            synthesis_draft_ids: [],
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        },
      );

      if (!upserted) {
        throw new Error("Failed to upsert translation document");
      }

      translationDoc = upserted;
    } else {
      translationDoc.translated_content = normalizedContent;
      translationDoc.updated_at = now;
      if (!translationDoc.completed_at) {
        translationDoc.completed_at = now;
      }
      translationDoc.variant = "final";
      translationDoc.is_final = true;
      translationDoc.synthesis_draft_ids = [];
      await translationDoc.save();
    }

    const updatedTranslation =
      typeof translationDoc.translated_content === "string"
        ? translationDoc.translated_content
        : normalizedContent;

    try {
      await query(
        "UPDATE translationprojects SET updated_at = NOW() WHERE project_id = $1",
        [projectId],
      );
    } catch (err) {
      app.log.warn(
        err,
        `[TRANSLATION] Failed to update translationprojects.updated_at for ${projectId}`,
      );
    }

    try {
      const proofCollection =
        mongoose.connection?.db?.collection("proofreading_files");
      if (proofCollection) {
        const lookupFilters: Array<Record<string, unknown>> = [];
        if (translationDoc.job_id) {
          lookupFilters.push({
            project_id: projectId,
            job_id: translationDoc.job_id,
          });
        }
        lookupFilters.push({ project_id: projectId });

        let targetProof: Record<string, any> | null = null;
        for (const filter of lookupFilters) {
          const doc = await proofCollection.findOne(filter, {
            sort: { updated_at: -1 },
          });
          if (doc) {
            targetProof = doc as Record<string, any>;
            break;
          }
        }

        if (targetProof) {
          const updatePayload: Record<string, unknown> = {
            applied_translated_content: updatedTranslation,
            updated_at: now,
          };
          if (targetProof.report) {
            updatePayload["report.appliedTranslation"] = updatedTranslation;
          }
          if (targetProof.quick_report) {
            updatePayload["quick_report.appliedTranslation"] =
              updatedTranslation;
          }
          if (targetProof.deep_report) {
            updatePayload["deep_report.appliedTranslation"] =
              updatedTranslation;
          }

          await proofCollection.updateOne(
            { _id: targetProof._id },
            { $set: updatePayload },
          );
        }
      }
    } catch (err) {
      app.log.warn(
        { err, projectId },
        "[TRANSLATION] Failed to sync proofreading content after manual save",
      );
    }

    if (userId && updatedTranslation.trim().length) {
      enqueueProfileAnalysisJob({
        projectId,
        userId,
        payload: {
          variant: "translation",
          translationFileId: translationDoc?._id
            ? String(translationDoc._id)
            : null,
          triggeredBy: "translation-update",
        },
      }).catch((err) => {
        app.log.error(
          { err, projectId },
          "[PROFILE] Failed to enqueue translation profile job",
        );
      });
    }

    reply.send({
      success: true,
      translation: {
        id: translationDoc._id,
        project_id: translationDoc.project_id,
        job_id: translationDoc.job_id,
        updated_at: translationDoc.updated_at,
        translated_content: updatedTranslation,
      },
    });
  } catch (error: any) {
    app.log.error(
      error,
      `[TRANSLATION] Failed to update translation for project ${projectId}`,
    );
    reply.status(500).send({ error: "Failed to save translation content" });
  }
});

app.get(
  "/api/projects/:projectId/translation/:translationFileId/segments",
  async (req, reply) => {
    await requireAuthAndPlanCheck(req, reply);
    if ((reply as any).sent) return;

    const { projectId, translationFileId } = req.params as {
      projectId: string;
      translationFileId: string;
    };
    const userId = (req as any).user_id as string | undefined;

    try {
      if (userId) {
        const { rows } = await query(
          `SELECT 1 FROM translationprojects WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
          [projectId, userId],
        );
        if (!rows.length) {
          return reply.status(404).send({ error: "Project not found" });
        }
      }

      const segments = await TranslationSegment.find({
        project_id: projectId,
        translation_file_id: translationFileId,
        variant: "final",
      })
        .sort({ segment_index: 1 })
        .lean()
        .exec();

      return reply.send({
        segments: segments.map((segment) => ({
          id: segment.segment_id,
          index: segment.segment_index,
          origin: segment.origin_segment,
          translation: segment.translation_segment,
          synthesisNotes: segment.synthesis_notes ?? null,
        })),
      });
    } catch (error) {
      app.log.error(
        { err: error, projectId, translationFileId },
        "[TRANSLATION] Failed to load segments",
      );
      return reply
        .status(500)
        .send({ error: "Failed to load aligned translation segments" });
    }
  },
);


app.get("/api/jobs", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const userId = (req as any).user_id;
  const { projectId, status, limit } = (req.query ?? {}) as {
    projectId?: string;
    status?: string;
    limit?: string;
  };

  try {
    const filters: string[] = ["j.user_id = $1"];
    const params: any[] = [userId];

    if (projectId) {
      params.push(projectId);
      filters.push(`j.project_id = $${params.length}`);
    }

    if (status) {
      params.push(status);
      filters.push(`j.status = $${params.length}`);
    }

    const parsedLimit = Number.parseInt(limit ?? "", 10);
    const effectiveLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 50;

    params.push(effectiveLimit);

    const { rows: jobRows } = await query(
      `SELECT j.id, j.document_id, j.type, j.status, j.created_at, j.updated_at, j.finished_at, j.project_id,
              tp.origin_lang, tp.target_lang
         FROM jobs j
         LEFT JOIN translationprojects tp ON tp.project_id = j.project_id
        WHERE ${filters.join(" AND ")}
        ORDER BY j.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    const jobs = await buildJobsPayload(jobRows);

    reply.send({ jobs });
  } catch (error) {
    app.log.error({ err: error }, "[JOBS] Failed to list jobs");
    reply.status(500).send({ error: "Failed to load jobs" });
  }
});

app.get("/api/jobs/:jobId", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const userId = (req as any).user_id;
  const { jobId } = req.params as { jobId: string };

  try {
    const { rows: jobRows } = await query(
      `SELECT j.id, j.document_id, j.type, j.status, j.created_at, j.updated_at, j.finished_at, j.project_id,
              tp.origin_lang, tp.target_lang
         FROM jobs j
         LEFT JOIN translationprojects tp ON tp.project_id = j.project_id
        WHERE j.user_id = $1 AND j.id = $2
        LIMIT 1`,
      [userId, jobId],
    );

    if (!jobRows.length) {
      return reply.status(404).send({ error: "Job not found" });
    }

    const jobs = await buildJobsPayload(jobRows);
    reply.send({ job: jobs[0] ?? null });
  } catch (error) {
    app.log.error({ err: error, jobId }, "[JOBS] Failed to load job details");
    reply.status(500).send({ error: "Failed to load job" });
  }
});


// List all translation batches for a job (progress/status)
app.get("/api/jobs/:jobId/batches", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;
  const { jobId } = req.params as any;
  // Get all batches for this job from PostgreSQL
  const { rows } = await query(
    "SELECT id, batch_index, status, started_at, finished_at, error FROM translation_batches WHERE job_id = $1 ORDER BY batch_index",
    [jobId],
  );
  reply.send({ batches: rows });
});

// Fetch a single batch's details and result (from MongoDB)
app.get("/api/batches/:batchId", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;
  const { batchId } = req.params as any;
  // Find batch metadata in PostgreSQL
  const { rows } = await query(
    "SELECT * FROM translation_batches WHERE id = $1",
    [batchId],
  );
  if (!rows.length) return reply.status(404).send({ error: "Batch not found" });
  const batch = rows[0];
  // Fetch text and translation from MongoDB
  const batchDoc = await TranslationBatch.findById(batch.mongo_batch_id);
  if (!batchDoc)
    return reply
      .status(404)
      .send({ error: "Batch document not found in MongoDB" });
  reply.send({
    batch_index: batch.batch_index,
    status: batch.status,
    started_at: batch.started_at,
    finished_at: batch.finished_at,
    error: batch.error,
    original_text: batchDoc.original_text,
    translated_text: batchDoc.translated_text,
  });
});

// Retry failed batch
app.post("/api/batches/:batchId/retry", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;
  const { batchId } = req.params as any;

  try {
    // Reset batch status to queued for retry
    const { rows } = await query(
      "UPDATE translation_batches SET status = $1, error = NULL, started_at = NULL, finished_at = NULL WHERE id = $2 AND status = $3 RETURNING *",
      ["queued", batchId, "failed"],
    );

    if (!rows.length) {
      return reply.status(404).send({ error: "Failed batch not found" });
    }

    const batch = rows[0];

    // Also reset MongoDB batch
    await TranslationBatch.findByIdAndUpdate(batch.mongo_batch_id, {
      status: "queued",
      error: undefined,
      finished_at: undefined,
    });

    console.log(`[RETRY] Reset batch ${batchId} for retry`);
    reply.send({ message: "Batch reset for retry", batch });
  } catch (error: any) {
    console.error("[RETRY] Error resetting batch:", error);
    reply.status(500).send({ error: "Failed to reset batch for retry" });
  }
});

// Health check endpoint for PostgreSQL connectivity
app.get("/api/health/postgres", async (req, reply) => {
  try {
    const result = await query("SELECT 1 as ok");
    reply.send({ postgres: result.rows[0].ok === 1 ? "ok" : "fail" });
  } catch (e: any) {
    reply.status(500).send({ error: e.message });
  }
});

// Instantiate OpenAI client BEFORE worker loop with timeout configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
  timeout: 60000, // 60 second timeout
  maxRetries: 2,
});

// Enqueue helper
async function enqueue({
  documentId,
  type,
  user_id,
  project_id,
  created_by,
  updated_at,
  updated_by,
  workflow_run_id,
}: {
  documentId: string;
  type: "analyze" | "translate" | "profile";
  user_id: string;
  project_id?: string;
  created_by?: string;
  updated_at?: string;
  updated_by?: string;
  workflow_run_id?: string | null;
}) {
  const id = nanoid();
  await query(
    `INSERT INTO jobs (id, user_id, document_id, type, status, created_at, attempts, project_id, created_by, updated_at, updated_by, workflow_run_id)
     VALUES ($1, $2, $3, $4, $5, now(), 0, $6, $7, $8, $9, $10)`,
    [
      id,
      user_id,
      documentId,
      type,
      "queued",
      project_id || null,
      created_by || null,
      updated_at || null,
      updated_by || null,
      workflow_run_id || null,
    ],
  );
  return id;
}

async function markJobRunning(jobId: string): Promise<boolean> {
  const result = await query(
    `UPDATE jobs
        SET status = 'running',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND status = 'queued'`,
    [jobId],
  );
  const rowCount = result.rowCount ?? 0;
  return rowCount > 0;
}

async function markJobSucceeded(jobId: string) {
  await query(
    `UPDATE jobs
        SET status = 'done',
            finished_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status != 'cancelled'`,
    [jobId],
  );
}

async function markJobFailed(jobId: string, errorMessage: string) {
  await query(
    `UPDATE jobs
        SET status = 'failed',
            finished_at = NOW(),
            updated_at = NOW(),
            last_error = $2
      WHERE id = $1 AND status != 'cancelled'`,
    [jobId, errorMessage],
  );
}

async function markJobCancelled(jobId: string, reason?: string) {
  await query(
    `UPDATE jobs
        SET status = 'cancelled',
            finished_at = NOW(),
            updated_at = NOW(),
            last_error = COALESCE($2, last_error)
      WHERE id = $1`,
    [jobId, reason ?? null],
  );
}

async function getJobStatus(jobId: string): Promise<string | null> {
  const { rows } = await query(
    `SELECT status FROM jobs WHERE id = $1 LIMIT 1`,
    [jobId],
  );
  return rows[0]?.status ?? null;
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  const status = await getJobStatus(jobId);
  return status === "cancelled";
}

interface ProfileJobPayload {
  variant: "origin" | "translation";
  originFileId?: string | null;
  translationFileId?: string | null;
  triggeredBy?: string;
  requestedAt?: string;
}

function parseProfileJobPayload(raw: string | null): ProfileJobPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProfileJobPayload;
    if (!parsed || typeof parsed !== "object" || !parsed.variant) return null;
    if (parsed.variant !== "origin" && parsed.variant !== "translation")
      return null;
    return parsed;
  } catch (err) {
    app.log.error({ err, raw }, "[PROFILE] Failed to parse job payload");
    return null;
  }
}

async function enqueueProfileAnalysisJob({
  projectId,
  userId,
  payload,
}: {
  projectId: string;
  userId: string;
  payload: ProfileJobPayload;
}) {
  const documentId = JSON.stringify({
    ...payload,
    requestedAt: payload.requestedAt ?? new Date().toISOString(),
  });
  return enqueue({
    documentId,
    type: "profile",
    user_id: userId,
    project_id: projectId,
  });
}

app.post("/api/pipeline/analyze", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;
  const { documentId } = req.body as any;
  const user_id = (req as any).user_id;
  const jobId = await enqueue({
    documentId,
    type: "analyze",
    user_id,
  });
  reply.send({ jobId });
});

// Accepts: { documentId, originalText, targetLang }
app.post("/api/pipeline/translate", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;
  const {
    documentId,
    originalText,
    targetLang = "English",
    project_id,
    created_by,
    updated_at,
    updated_by,
    workflowLabel,
    workflowAllowParallel,
  } = req.body as any;
  const user_id = (req as any).user_id;

  if (!originalText || !documentId) {
    return reply
      .status(400)
      .send({ error: "documentId and originalText are required" });
  }

  const segmentationMode = getTranslationSegmentationMode();
  const projectKey = project_id || documentId;

  let segmentation;
  try {
    segmentation = segmentOriginText({
      text: originalText,
      projectId: projectKey,
      modeOverride: segmentationMode,
    });
  } catch (error) {
    app.log.error(
      { err: error, projectId: project_id },
      "[TRANSLATE] Segmentation failed",
    );
    return reply
      .status(422)
      .send({ error: "원문을 분할하지 못했습니다. 내용을 확인해 주세요." });
  }

  let projectMetadata: any = null;
  if (project_id) {
    try {
      const { rows } = await query(
        `SELECT origin_lang, target_lang, origin_file FROM translationprojects WHERE project_id = $1 LIMIT 1`,
        [project_id],
      );
      projectMetadata = rows[0] ?? null;
    } catch (err) {
      app.log.warn(
        { err },
        `[TRANSLATE] Failed to load project metadata for ${project_id}`,
      );
    }
  }

  let translationNotes: TranslationNotes | null = null;
  if (project_id) {
    try {
      const originProfile = await DocumentProfile.findOne({
        project_id,
        type: "origin",
      })
        .sort({ version: -1 })
        .lean();
      translationNotes = (originProfile as any)?.translation_notes ?? null;
    } catch (err) {
      app.log.warn(
        { err, projectId: project_id },
        "[TRANSLATE] Failed to load translation notes",
      );
    }
  }

  let workflowRun: WorkflowRunRecord | null = null;
  if (project_id) {
    try {
      const workflowResult = await requestWorkflowAction({
        projectId: project_id,
        type: "translation",
        requestedBy: user_id,
        label: workflowLabel ?? null,
        metadata: {
          source: "pipeline.translate",
        },
        allowParallel: Boolean(workflowAllowParallel),
      });
      if (!workflowResult.accepted) {
        return reply.status(409).send({
          error: "해당 프로젝트에서는 새 번역 작업을 시작할 수 없습니다.",
          reason: workflowResult.reason,
        });
      }
      workflowRun = workflowResult.run ?? null;
    } catch (error) {
      app.log.error(
        { err: error, projectId: project_id },
        "[TRANSLATE] Failed to register workflow run",
      );
      return reply
        .status(500)
        .send({ error: "번역 작업을 준비하지 못했습니다." });
    }
  }

  let jobId: string;
  let originDocId: string | null = null;
  const originFileSize = Buffer.byteLength(originalText, "utf8");

  try {
    jobId = await enqueue({
      documentId,
      type: "translate",
      user_id,
      project_id,
      created_by,
      updated_at,
      updated_by,
      workflow_run_id: workflowRun?.runId ?? null,
    });

    const originFile = await OriginFile.create({
      project_id: projectKey,
      job_id: jobId,
      file_type: "text",
      file_size: originFileSize,
      original_filename: `origin-${jobId}.txt`,
      text_content: originalText,
      created_at: new Date(),
      updated_at: new Date(),
    });
    originDocId = originFile._id.toString();

    if (project_id) {
      await query(
        "UPDATE translationprojects SET origin_file = $1, updated_at = NOW() WHERE project_id = $2",
        [originDocId, project_id],
      );
    }
  } catch (error) {
    if (workflowRun) {
      try {
        await failWorkflowRun(workflowRun.runId, {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (workflowError) {
        app.log.warn(
          { err: workflowError, runId: workflowRun.runId },
          "[TRANSLATE] Failed to mark workflow run failure",
        );
      }
    }
    app.log.error(
      { err: error },
      "[TRANSLATE] Failed to initialize translation job",
    );
    return reply
      .status(500)
      .send({ error: "번역 작업을 시작하지 못했습니다." });
  }

  const originLanguage = projectMetadata?.origin_lang || "Korean";
  const targetLanguage =
    projectMetadata?.target_lang || targetLang || "English";

  try {
    await query(
      `UPDATE jobs
         SET created_by = $1,
             updated_at = NOW(),
             updated_by = $1,
             origin_lang = $2,
             target_lang = $3,
             origin_file = COALESCE($4, origin_file)
       WHERE id = $5`,
      [user_id, originLanguage, targetLanguage, originDocId, jobId],
    );
  } catch (err) {
    app.log.warn(
      { err },
      `[TRANSLATE] Failed to update job metadata for ${jobId}`,
    );
  }

  const sequentialConfig = getSequentialTranslationConfig();
  await ensureProjectMemory(
    projectKey,
    buildMemorySeed(translationNotes ?? null, segmentation.segments),
  );
  const stageOrder: TranslationStage[] = [
    "literal",
    "style",
    "emotion",
    "qa",
  ];
  const batchSize = Math.max(1, sequentialConfig.batching.batchSize);
  const batches: SequentialStageJobSegment[][] = [];

  for (let i = 0; i < segmentation.segments.length; i += batchSize) {
    const windowSegments = segmentation.segments.slice(i, i + batchSize);
    const mapped = windowSegments.map((segment, offset) => {
      const globalIndex = i + offset;
      const prev = segmentation.segments[globalIndex - 1];
      const next = segmentation.segments[globalIndex + 1];
      return {
        segmentId: segment.id,
        segmentIndex: globalIndex,
        textSource: segment.text,
        prevCtx: prev?.text,
        nextCtx: next?.text,
        stageOutputs: {},
      } satisfies SequentialStageJobSegment;
    });
    batches.push(mapped);
  }

  const batchCount = batches.length;

  await Promise.all(
    batches.map((segmentBatch, batchIndex) =>
      enqueueTranslationStageJob(
        {
          jobId,
          projectId: projectKey,
          workflowRunId: workflowRun?.runId ?? undefined,
          sourceHash: segmentation.sourceHash,
          stage: "literal",
          memoryVersion: 1,
          config: sequentialConfig,
          segmentBatch,
          batchNumber: batchIndex + 1,
          batchCount,
          translationNotes,
        },
        {
          jobId: `stage-${jobId}-literal-${batchIndex + 1}`,
          removeOnComplete: true,
          removeOnFail: false,
        },
      ),
    ),
  );

  const totalStages = stageOrder.length;
  app.log.info(
    `[TRANSLATE] Queued sequential job ${jobId} with ${segmentation.segments.length} segments across ${batchCount} batches`,
  );

  reply.send({
    jobId,
    workflowRunId: workflowRun?.runId ?? null,
    totalPasses: totalStages,
    segmentCount: segmentation.segments.length,
    segmentationMode,
    sourceHash: segmentation.sourceHash,
    stages: stageOrder,
    batches: batchCount,
  });
});

app.post("/api/projects/:projectId/translation/cancel", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId } = req.params as { projectId: string };
  const body = req.body as {
    jobId?: string | null;
    workflowRunId?: string | null;
    reason?: string | null;
  };
  const userId = (req as any).user_id as string | undefined;

  if (!projectId || !userId) {
    return reply.status(400).send({ error: "Invalid cancellation request" });
  }

  const reason = body?.reason?.trim() || "Cancelled by user";

  try {
    const { rows } = await query(
      `SELECT 1 FROM translationprojects WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
      [projectId, userId],
    );
    if (!rows.length) {
      return reply.status(404).send({ error: "Project not found" });
    }
  } catch (error) {
    req.log.error({ err: error, projectId }, "[TRANSLATION] Failed to validate project ownership");
    return reply.status(500).send({ error: "Failed to validate project" });
  }

  let jobRow: {
    id: string;
    project_id: string;
    status: string;
    workflow_run_id: string | null;
  } | null = null;

  try {
    if (body?.jobId) {
      const { rows } = await query(
        `SELECT id, project_id, status, workflow_run_id
           FROM jobs
          WHERE id = $1 AND project_id = $2 AND type = 'translate'
          LIMIT 1`,
        [body.jobId, projectId],
      );
      jobRow = rows[0] ?? null;
    } else {
      const { rows } = await query(
        `SELECT id, project_id, status, workflow_run_id
           FROM jobs
          WHERE project_id = $1 AND type = 'translate' AND status IN ('queued', 'running')
          ORDER BY created_at DESC
          LIMIT 1`,
        [projectId],
      );
      jobRow = rows[0] ?? null;
    }
  } catch (error) {
    req.log.error(
      { err: error, projectId },
      "[TRANSLATION] Failed to load job for cancellation",
    );
    return reply.status(500).send({ error: "Failed to load translation job" });
  }

  if (!jobRow) {
    return reply
      .status(404)
      .send({ error: "No active translation job found" });
  }

  try {
    await markJobCancelled(jobRow.id, reason);
  } catch (error) {
    req.log.warn(
      { err: error, jobId: jobRow.id },
      "[TRANSLATION] Failed to mark job cancelled",
    );
  }

  try {
    await cancelTranslationDeletes(jobRow.id, reason);
  } catch (error) {
    req.log.warn(
      { err: error, jobId: jobRow.id },
      "[TRANSLATION] Failed to mark drafts cancelled",
    );
  }

  const workflowRunId = body?.workflowRunId ?? jobRow.workflow_run_id;
  if (workflowRunId) {
    try {
      await cancelWorkflowRun(workflowRunId, {
        jobId: jobRow.id,
        reason,
      });
    } catch (error) {
      req.log.warn(
        { err: error, runId: workflowRunId },
        "[TRANSLATION] Failed to mark workflow run cancelled",
      );
    }
  }

  return reply.send({ ok: true, jobId: jobRow.id });
});

app.post("/api/ebook/generate", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId, translationFileId, format, jobId } = req.body as any;
  const userId = (req as any).user_id;

  if (!projectId) {
    return reply.status(400).send({ error: "projectId is required" });
  }

  const { rows: projectRows } = await query(
    `SELECT project_id, title, origin_lang, target_lang, meta
       FROM translationprojects
      WHERE project_id = $1 AND user_id = $2
      LIMIT 1`,
    [projectId, userId],
  );
  const projectRow = projectRows[0];
  if (!projectRow) {
    return reply.status(404).send({ error: "Project not found" });
  }

  let projectMeta: Record<string, any> = {};
  if (projectRow.meta) {
    if (typeof projectRow.meta === "string") {
      try {
        projectMeta = JSON.parse(projectRow.meta);
      } catch (error) {
        projectMeta = {};
      }
    } else if (typeof projectRow.meta === "object") {
      projectMeta = projectRow.meta as Record<string, any>;
    }
  }

  if (!translationFileId) {
    const recommendation = await findBestTranslationForProject(projectId);
    if (!recommendation) {
      return reply.status(409).send({
        error: "no_translation_available",
        message: "No translation files exist for this project yet.",
      });
    }

    return reply.send({
      requiresConfirmation: true,
      recommendation: {
        translationFileId: String(
          recommendation.translation._id ?? recommendation.translation.id,
        ),
        jobId:
          recommendation.translation.job_id ??
          recommendation.translation.jobId ??
          null,
        completedAt:
          recommendation.translation.completed_at ??
          recommendation.translation.updated_at ??
          null,
        qualityScore: recommendation.score,
        qualityAssessmentId:
          recommendation.qualityAssessment?.assessmentId ??
          recommendation.qualityAssessment?._id ??
          null,
      },
    });
  }

  const translationDoc = await TranslationFile.findOne({
    _id: translationFileId,
    project_id: projectId,
  })
    .lean()
    .exec();

  if (!translationDoc) {
    return reply
      .status(404)
      .send({ error: "Translation file not found for project" });
  }

  const translatedContent: string = translationDoc.translated_content || "";
  if (!translatedContent) {
    return reply
      .status(422)
      .send({ error: "Selected translation file has no translated content" });
  }

  const normalizedTitle =
    maybeDecodeKorean(projectRow.title ?? null) ??
    projectRow.title ??
    "Untitled Manuscript";
  const normalizedAuthor =
    maybeDecodeKorean(projectMeta.author ?? projectMeta.writer ?? null) ?? null;
  const normalizedTranslator =
    maybeDecodeKorean(projectMeta.translator ?? null) ?? null;
  const normalizedContentRaw =
    maybeDecodeKorean(translatedContent) ?? translatedContent;
  const normalizedContent = normalizedContentRaw.replace(/\r\n/g, "\n");

  const qaDoc: any =
    (translationDoc.job_id
      ? await QualityAssessment.findOne({
          projectId,
          jobId: translationDoc.job_id,
        })
          .sort({ timestamp: -1 })
          .lean()
          .exec()
      : null) ||
    (await QualityAssessment.findOne({ projectId })
      .sort({ timestamp: -1 })
      .lean()
      .exec());

  const ebookId = uuidv4();
  const requestedFormat = Array.isArray(format) ? format[0] : format;
  const normalizedFormat =
    typeof requestedFormat === "string" ? requestedFormat.toLowerCase() : "txt";
  const allowedFormats = new Set(["txt", "pdf", "epub"]);
  const finalFormat = allowedFormats.has(normalizedFormat)
    ? normalizedFormat
    : "txt";

  const filename = `ebook_${projectId}_${ebookId}.${finalFormat}`;
  const mimeType =
    finalFormat === "pdf"
      ? "application/pdf"
      : finalFormat === "epub"
        ? "application/epub+zip"
        : "text/plain";

  const existingEbookRes = await query(
    `SELECT ebook_id FROM ebooks WHERE project_id = $1 LIMIT 1`,
    [projectId],
  );
  const canonicalEbookId = existingEbookRes.rows[0]?.ebook_id ?? ebookId;

  let buffer: Buffer;
  if (finalFormat === "pdf") {
    const { front: frontCover, back: backCover } =
      await resolveCoverImages(projectId);
    buffer = await createPdfBuffer({
      title: normalizedTitle,
      author: normalizedAuthor,
      translator: normalizedTranslator,
      content: normalizedContent,
      frontCover,
      backCover,
    });
  } else {
    buffer = Buffer.from(normalizedContent, "utf8");
  }
  await mkdir(ebookStorageRoot, { recursive: true });
  const projectStorageDir = path.join(ebookStorageRoot, String(projectId));
  await mkdir(projectStorageDir, { recursive: true });
  const diskPath = path.join(projectStorageDir, filename);
  await writeFile(diskPath, buffer);
  const relativeDiskPath = path.relative(ebookStorageRoot, diskPath);
  const fileChecksum = createHash("sha256").update(buffer).digest("hex");

  const translationProfile = await DocumentProfile.findOne({
    project_id: projectId,
    type: "translation",
  })
    .sort({ version: -1 })
    .lean()
    .exec();
  const translationSummary = translationProfile?.summary?.story ?? null;

  const cleanedWords = normalizedContent.trim();
  const wordCount = cleanedWords
    ? cleanedWords.split(/\s+/).filter(Boolean).length
    : 0;
  const characterCount = normalizedContent.length;

  const now = new Date();
  const ebookDoc = await EbookFile.findOneAndUpdate(
    { ebook_id: canonicalEbookId },
    {
      $set: {
        project_id: projectId,
        translation_file_id: String(translationDoc._id ?? translationFileId),
        format: finalFormat,
        filename,
        size: buffer.length,
        mime_type: mimeType,
        content: buffer,
        recommended_quality_assessment_id:
          qaDoc?.assessmentId ?? qaDoc?._id?.toString() ?? null,
        updated_at: now,
      },
      $setOnInsert: {
        ebook_id: canonicalEbookId,
        created_at: now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const upsertEbookRes = await query(
    `INSERT INTO ebooks (
        ebook_id, project_id, title, author, translator, source_language, target_language, synopsis, status, created_at, updated_at
     ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,'ready', now(), now()
     )
     ON CONFLICT (project_id) DO UPDATE SET
        title = COALESCE(EXCLUDED.title, ebooks.title),
        author = COALESCE(EXCLUDED.author, ebooks.author),
        translator = COALESCE(EXCLUDED.translator, ebooks.translator),
        source_language = COALESCE(EXCLUDED.source_language, ebooks.source_language),
        target_language = COALESCE(EXCLUDED.target_language, ebooks.target_language),
        synopsis = COALESCE(EXCLUDED.synopsis, ebooks.synopsis),
        status = 'ready',
        updated_at = now()
     RETURNING ebook_id;`,
    [
      canonicalEbookId,
      projectId,
      projectRow.title ?? "Untitled Manuscript",
      projectMeta.author ?? projectMeta.writer ?? null,
      projectMeta.translator ?? null,
      projectRow.origin_lang ?? null,
      projectRow.target_lang ?? null,
      translationSummary ?? null,
    ],
  );
  const ebookRowId = upsertEbookRes.rows[0].ebook_id as string;

  await query(
    `INSERT INTO ebook_metadata (ebook_id, writer_note, translator_note, isbn, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (ebook_id) DO UPDATE SET
        writer_note = COALESCE(EXCLUDED.writer_note, ebook_metadata.writer_note),
        translator_note = COALESCE(EXCLUDED.translator_note, ebook_metadata.translator_note),
        isbn = COALESCE(EXCLUDED.isbn, ebook_metadata.isbn),
        updated_at = now();`,
    [
      ebookRowId,
      projectMeta.writerNote ?? projectMeta.writer_note ?? null,
      projectMeta.translatorNote ?? projectMeta.translator_note ?? null,
      projectMeta.isbn ?? null,
    ],
  );

  const versionNumberRes = await query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
       FROM ebook_versions
      WHERE ebook_id = $1`,
    [ebookRowId],
  );
  const versionNumber = Number(versionNumberRes.rows[0]?.next_version ?? 1);
  const ebookVersionId = uuidv4();

  await query(
    `INSERT INTO ebook_versions (
        ebook_version_id, ebook_id, version_number, translation_file_id, quality_assessment_id, export_format,
        word_count, character_count, change_notes, created_by, created_at, updated_at
     ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now()
     )`,
    [
      ebookVersionId,
      ebookRowId,
      versionNumber,
      String(translationDoc._id ?? translationFileId),
      qaDoc?.assessmentId ?? null,
      finalFormat,
      wordCount,
      characterCount,
      null,
      userId ?? null,
    ],
  );

  await query(
    `UPDATE ebook_assets
        SET is_current = FALSE, updated_at = now()
      WHERE project_id = $1
        AND asset_type = 'manuscript'
        AND is_current = TRUE;`,
    [projectId],
  );

  const manuscriptAssetId = uuidv4();
  const manuscriptPublicUrl = `/api/projects/${projectId}/ebook/download/${manuscriptAssetId}`;

  await query(
    `INSERT INTO ebook_assets (
        ebook_asset_id, ebook_version_id, project_id, asset_type, mime_type, file_name, file_path, public_url,
        width, height, size_bytes, checksum, source, metadata, created_at, updated_at
     ) VALUES (
        $1,$2,$3,'manuscript',$4,$5,$6,$7,NULL,NULL,$8,$9,'manuscript:auto-export',$10, now(), now()
     )`,
    [
      manuscriptAssetId,
      ebookVersionId,
      projectId,
      mimeType,
      filename,
      relativeDiskPath,
      manuscriptPublicUrl,
      buffer.length,
      fileChecksum,
      JSON.stringify({
        translationFileId: String(translationDoc._id ?? translationFileId),
        qualityAssessmentId: qaDoc?.assessmentId ?? null,
        storage: {
          mongoId: ebookDoc._id.toString(),
          diskPath: relativeDiskPath,
        },
        format: finalFormat,
      }),
    ],
  );

  await query(
    `UPDATE ebook_versions
        SET file_asset_id = $1, updated_at = now()
      WHERE ebook_version_id = $2`,
    [manuscriptAssetId, ebookVersionId],
  );

  await query(
    `UPDATE ebooks
        SET current_version_id = $1,
            status = 'ready',
            synopsis = COALESCE($2, synopsis),
            updated_at = now()
      WHERE ebook_id = $3`,
    [ebookVersionId, translationSummary ?? null, ebookRowId],
  );

  await query(
    `INSERT INTO ebook_audit_log (log_id, ebook_id, ebook_version_id, event_type, actor, payload, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'ebook_generated', $3, $4, now())`,
    [
      ebookRowId,
      ebookVersionId,
      userId ?? null,
      JSON.stringify({
        assetId: manuscriptAssetId,
        format: finalFormat,
        translationFileId: String(translationDoc._id ?? translationFileId),
        qualityAssessmentId: qaDoc?.assessmentId ?? null,
      }),
    ],
  );

  await query(
    `INSERT INTO ebook_artifacts (ebook_id, project_id, translation_file_id, quality_assessment_id, format, status, storage_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (ebook_id) DO UPDATE SET
       translation_file_id = EXCLUDED.translation_file_id,
       quality_assessment_id = EXCLUDED.quality_assessment_id,
       format = EXCLUDED.format,
       status = EXCLUDED.status,
       storage_ref = EXCLUDED.storage_ref,
       updated_at = now();`,
    [
      ebookRowId,
      projectId,
      String(translationDoc._id ?? translationFileId),
      qaDoc?.assessmentId ?? null,
      finalFormat,
      "ready",
      manuscriptPublicUrl,
    ],
  );

  await recordTokenUsage(app.log, {
    project_id: projectId,
    job_id: translationDoc.job_id ?? jobId ?? null,
    event_type: "ebook",
  });

  reply.status(201).send({
    success: true,
    ebook: {
      ebookId: ebookRowId,
      format: finalFormat,
      status: "ready",
      filename,
      storageRef: manuscriptPublicUrl,
      qualityAssessmentId: qaDoc?.assessmentId ?? null,
      qualityScore: qaDoc?.qualityResult?.overallScore ?? null,
      versionId: ebookVersionId,
      assetId: manuscriptAssetId,
    },
  });
});

app.get("/api/usage/:projectId", async (req, reply) => {
  await requireAuthAndPlanCheck(req, reply);
  if ((reply as any).sent) return;

  const { projectId } = req.params as { projectId: string };
  const userId = (req as any).user_id;

  const { rows: projectRows } = await query(
    `SELECT project_id FROM translationprojects WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
    [projectId, userId],
  );

  if (!projectRows.length) {
    return reply.status(404).send({ error: "Project not found" });
  }

  const totalsRes = await query(
    `SELECT total_input_tokens, total_output_tokens, total_cost, updated_at
     FROM project_usage_totals
     WHERE project_id = $1`,
    [projectId],
  );

  const totalsRow = totalsRes.rows[0] ?? null;

  const jobsRes = await query(
    `SELECT job_id,
            SUM(input_tokens)::bigint AS input_tokens,
            SUM(output_tokens)::bigint AS output_tokens,
            SUM(total_cost)::numeric AS total_cost,
            MIN(created_at) AS first_event,
            MAX(created_at) AS last_event
       FROM token_usage_events
      WHERE project_id = $1 AND job_id IS NOT NULL
   GROUP BY job_id
   ORDER BY last_event DESC NULLS LAST`,
    [projectId],
  );

  const typeRes = await query(
    `SELECT event_type,
            SUM(input_tokens)::bigint AS input_tokens,
            SUM(output_tokens)::bigint AS output_tokens,
            SUM(total_cost)::numeric AS total_cost
       FROM token_usage_events
      WHERE project_id = $1
   GROUP BY event_type`,
    [projectId],
  );

  reply.send({
    projectTotals: {
      inputTokens: Number(totalsRow?.total_input_tokens ?? 0),
      outputTokens: Number(totalsRow?.total_output_tokens ?? 0),
      totalCost: Number(totalsRow?.total_cost ?? 0),
      updatedAt: totalsRow?.updated_at ?? null,
    },
    jobs: jobsRes.rows.map((row: any) => ({
      jobId: row.job_id,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      totalCost: Number(row.total_cost ?? 0),
      firstEventAt: row.first_event,
      lastEventAt: row.last_event,
    })),
    eventsByType: typeRes.rows.map((row: any) => ({
      eventType: row.event_type,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      totalCost: Number(row.total_cost ?? 0),
    })),
  });
});

function startProfileWorker() {
  setInterval(async () => {
    const client = await pool.connect();
    let job: any = null;
    try {
      const { rows } = await client.query(
        "SELECT id, user_id, project_id, document_id FROM jobs WHERE type = $1 AND status = $2 ORDER BY created_at LIMIT 1",
        ["profile", "queued"],
      );
      job = rows[0] ?? null;
      if (!job) {
        return;
      }

      await client.query(
        "UPDATE jobs SET status = $1, attempts = attempts + 1, started_at = now(), updated_at = now() WHERE id = $2",
        ["running", job.id],
      );

      const payload = parseProfileJobPayload(job.document_id);
      if (!payload) {
        await client.query(
          "UPDATE jobs SET status = $1, finished_at = now(), updated_at = now(), last_error = $3 WHERE id = $2",
          ["failed", job.id, "Invalid profile payload"],
        );
        return;
      }

      let projectRow: any = null;
      let projectMeta: Record<string, any> = {};
      try {
        const { rows: projectRows } = await client.query(
          "SELECT title, origin_lang, target_lang, meta FROM translationprojects WHERE project_id = $1",
          [job.project_id],
        );
        projectRow = projectRows[0] ?? null;
        if (projectRow?.meta) {
          if (typeof projectRow.meta === "string") {
            try {
              projectMeta = JSON.parse(projectRow.meta);
            } catch (error) {
              projectMeta = {};
            }
          } else if (typeof projectRow.meta === "object") {
            projectMeta = projectRow.meta as Record<string, any>;
          }
        }
      } catch (err) {
        app.log.warn(
          { err, jobId: job.id },
          "[PROFILE] Failed to load project metadata",
        );
      }

      let originDoc: any = null;
      let translationDoc: any = null;
      let textToAnalyze = "";

      if (payload.variant === "origin") {
        if (payload.originFileId) {
          originDoc = await OriginFile.findById(payload.originFileId).lean();
        }
        if (!originDoc) {
          originDoc = await OriginFile.findOne({ project_id: job.project_id })
            .sort({ updated_at: -1 })
            .lean();
        }
        if (!originDoc?.text_content) {
          throw new Error("Origin text not found for profile job");
        }
        textToAnalyze = originDoc.text_content as string;
      } else {
        if (payload.translationFileId) {
          translationDoc = await TranslationFile.findById(
            payload.translationFileId,
          ).lean();
        }
        if (!translationDoc) {
          translationDoc = await TranslationFile.findOne({
            project_id: job.project_id,
          })
            .sort({ updated_at: -1, completed_at: -1 })
            .lean();
        }
        if (!translationDoc?.translated_content) {
          throw new Error("Translation text not found for profile job");
        }
        textToAnalyze = translationDoc.translated_content as string;
      }

      const language =
        payload.variant === "origin"
          ? (projectRow?.origin_lang ?? null)
          : (projectRow?.target_lang ?? null);
      const analysis = await analyzeDocumentProfile({
        projectId: job.project_id,
        text: textToAnalyze,
        variant: payload.variant,
        language,
      });

      const latestProfile = await DocumentProfile.findOne({
        project_id: job.project_id,
        type: payload.variant,
      })
        .sort({ version: -1 })
        .lean();
      const nextVersion = (latestProfile?.version ?? 0) + 1;

      let qualityDoc: any = null;
      let proofreadingDoc: any = null;
      try {
        qualityDoc = await QualityAssessment.findOne({
          projectId: job.project_id,
        })
          .sort({ timestamp: -1 })
          .lean();
      } catch (err) {
        app.log.warn(
          { err, jobId: job.id },
          "[PROFILE] Failed to load quality assessment reference",
        );
      }
      try {
        proofreadingDoc = await Proofreading.findOne({
          project_id: job.project_id,
        })
          .sort({ updated_at: -1, created_at: -1 })
          .lean();
      } catch (err) {
        app.log.warn(
          { err, jobId: job.id },
          "[PROFILE] Failed to load proofreading reference",
        );
      }

      const createdProfile = await DocumentProfile.create({
        project_id: job.project_id,
        type: payload.variant,
        version: nextVersion,
        language: language ?? null,
        job_id: job.id,
        origin_file_id: originDoc?._id ?? null,
        translation_file_id: translationDoc?._id ?? null,
      quality_assessment_id: qualityDoc?._id ?? null,
      proofreading_id: proofreadingDoc?._id ?? null,
      metrics: analysis.metrics,
      summary: analysis.summary,
      translation_notes: analysis.translationNotes ?? null,
      source_hash: analysis.sourceHash,
      source_characters: analysis.metrics.charCount,
      source_preview: analysis.sourcePreview,
    });

      if (payload.variant === "translation") {
        const storySummary = analysis.summary.story?.trim();
        if (storySummary) {
          try {
            const { rows: existingSets } = await client.query(
              "SELECT 1 FROM ebook_cover_sets WHERE project_id = $1 LIMIT 1",
              [job.project_id],
            );

            if (!existingSets.length) {
              await coverService.queueCoverRegeneration({
                projectId: job.project_id,
                title: projectRow?.title ?? "Untitled Manuscript",
                author: projectMeta?.author ?? projectMeta?.writer ?? null,
                translator: projectMeta?.translator ?? null,
                targetLanguage: projectRow?.target_lang ?? null,
                summary: storySummary,
                writerNote:
                  projectMeta?.writerNote ?? projectMeta?.writer_note ?? null,
                translatorNote:
                  projectMeta?.translatorNote ??
                  projectMeta?.translator_note ??
                  null,
                isbn: projectMeta?.isbn ?? null,
                createdBy: job.user_id ?? null,
                translationProfileId: createdProfile?._id
                  ? String(createdProfile._id)
                  : null,
              });
            }
          } catch (err) {
            app.log.warn(
              { err, projectId: job.project_id },
              "[COVER] Automatic cover queue failed",
            );
          }
        }
      }

      await recordTokenUsage(app.log, {
        project_id: job.project_id,
        job_id: job.id,
        event_type: "profile",
        model: analysis.model,
        input_tokens: analysis.usage.inputTokens,
        output_tokens: analysis.usage.outputTokens,
      });

      await client.query(
        "UPDATE jobs SET status = $1, finished_at = now(), updated_at = now(), last_error = NULL WHERE id = $2",
        ["done", job.id],
      );
    } catch (error: any) {
      const message =
        typeof error?.message === "string" ? error.message : String(error);
      if (job?.id) {
        try {
          await client.query(
            "UPDATE jobs SET status = $1, finished_at = now(), updated_at = now(), last_error = $3 WHERE id = $2",
            ["failed", job.id, message],
          );
        } catch (updateErr) {
          app.log.error(
            { err: updateErr, jobId: job?.id },
            "[PROFILE] Failed to update job status after error",
          );
        }
      }
      app.log.error({ err: error, jobId: job?.id }, "[PROFILE] Job failed");
    } finally {
      client.release();
    }
  }, 2500);

  app.log.info("[STARTUP] Document profile worker loop started");
}

function startCoverWorker() {
  const interval = setInterval(async () => {
    const client = await pool.connect();
    let job: any = null;
    try {
      const { rows } = await client.query(
        "SELECT id, user_id, project_id, document_id FROM jobs WHERE type = $1 AND status = $2 ORDER BY created_at LIMIT 1",
        ["cover", "queued"],
      );
      job = rows[0] ?? null;
      if (!job) {
        return;
      }

      await client.query(
        "UPDATE jobs SET status = $1, attempts = attempts + 1, started_at = now(), updated_at = now() WHERE id = $2",
        ["running", job.id],
      );

      const payload = parseCoverJobPayload(job.document_id);
      if (!payload) {
        await client.query(
          "UPDATE jobs SET status = $1, finished_at = now(), updated_at = now(), last_error = $3 WHERE id = $2",
          ["failed", job.id, "Invalid cover payload"],
        );
        return;
      }

      await coverService.processCoverJob(job.id, payload, job.user_id ?? null);
    } catch (error: any) {
      const message =
        typeof error?.message === "string" ? error.message : String(error);
      app.log.error({ err: error, jobId: job?.id }, "[COVER] Job failed");
      if (job?.id) {
        try {
          await query(
            "UPDATE jobs SET status = $1, finished_at = now(), updated_at = now(), last_error = $3 WHERE id = $2",
            ["failed", job.id, message],
          );
        } catch (updateErr) {
          app.log.error(
            { err: updateErr, jobId: job?.id },
            "[COVER] Failed to update job status after error",
          );
        }
      }
    } finally {
      client.release();
    }
  }, 4000);

  if (typeof interval.unref === "function") {
    interval.unref();
  }

  app.log.info("[STARTUP] Cover generation worker loop started");
}

type LeanDraftDocument =
  Awaited<ReturnType<typeof listSuccessfulDrafts>>[number];

async function handleTranslationDraftJob(job: TranslationDraftJob) {
  const { data } = job;
  if (await isJobCancelled(data.jobId)) {
    await TranslationDraft.findByIdAndUpdate(data.draftId, {
      $set: {
        status: "cancelled",
        error: "Cancelled before start",
        finished_at: new Date(),
      },
    });
    return;
  }

  await markJobRunning(data.jobId);

  const draft = await TranslationDraft.findById(data.draftId);
  if (!draft) {
    throw new Error(
      `Draft ${data.draftId} not found for job ${data.jobId}`,
    );
  }

  if (draft.status === "cancelled") {
    return;
  }

  const runningDraft = await markDraftRunning(
    draft._id,
    data.draftConfig?.model ?? null,
  );

  if (!runningDraft || runningDraft.status === "cancelled") {
    return;
  }

  if (await isJobCancelled(data.jobId)) {
    await TranslationDraft.findByIdAndUpdate(draft._id, {
      $set: {
        status: "cancelled",
        error: "Cancelled before execution",
        finished_at: new Date(),
      },
    });
    return;
  }

  let failureReason: string | null = null;
  const startedAt = Date.now();

  try {
    const draftResult = await generateTranslationDraft({
      projectId: data.projectId,
      jobId: data.jobId,
      runOrder: data.runOrder,
      sourceHash: data.sourceHash,
      originLanguage: data.originLanguage ?? null,
      targetLanguage: data.targetLanguage ?? null,
      originSegments: data.originSegments,
      translationNotes: data.translationNotes ?? null,
      model: data.draftConfig?.model,
      temperature: data.draftConfig?.temperature,
      topP: data.draftConfig?.topP,
    });

    if (await isJobCancelled(data.jobId)) {
      await TranslationDraft.findByIdAndUpdate(draft._id, {
        $set: {
          status: "cancelled",
          error: "Cancelled during execution",
          finished_at: new Date(),
        },
      });
      return;
    }

    await completeDraft(draft._id, {
      segments: draftResult.segments,
      mergedText: draftResult.mergedText,
      model: draftResult.model,
      temperature: draftResult.temperature,
      topP: draftResult.topP,
      usage: draftResult.usage,
    });

    await recordTokenUsage(app.log, {
      project_id: data.projectId,
      job_id: data.jobId,
      event_type: "translate",
      model: draftResult.model,
      input_tokens: draftResult.usage.inputTokens,
      output_tokens: draftResult.usage.outputTokens,
      duration_ms: Date.now() - startedAt,
    });

    app.log.info(
      `[TRANSLATION] Draft pass ${data.runOrder}/${data.totalPasses} succeeded for job ${data.jobId}`,
    );
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    await failDraft(draft._id, failureReason);
    app.log.error(
      { err: error, jobId: data.jobId, draftId: data.draftId },
      "[TRANSLATION] Draft pass failed",
    );
    throw error;
  } finally {
    await maybeQueueSynthesis(job, failureReason);
  }
}

async function maybeQueueSynthesis(
  job: TranslationDraftJob,
  failureReason: string | null,
) {
  const { data } = job;

  if (await isJobCancelled(data.jobId)) {
    app.log.info(
      `[TRANSLATION] Skipping synthesis queue for job ${data.jobId} because it was cancelled`,
    );
    return;
  }

  const outstanding = await TranslationDraft.countDocuments({
    project_id: data.projectId,
    job_id: data.jobId,
    status: { $in: ["queued", "running"] },
  });
  if (outstanding > 0) {
    return;
  }

  const successfulDrafts = await listSuccessfulDrafts(
    data.projectId,
    data.jobId,
  );

  if (await isJobCancelled(data.jobId)) {
    app.log.info(
      `[TRANSLATION] Job ${data.jobId} cancelled after draft completion; skipping synthesis`,
    );
    return;
  }

  if (!successfulDrafts.length) {
    const errorMessage =
      failureReason ??
      "All translation passes failed; no drafts available for synthesis.";
    await markJobFailed(data.jobId, errorMessage);
    if (data.workflowRunId) {
      try {
        await failWorkflowRun(data.workflowRunId, {
          jobId: data.jobId,
          error: errorMessage,
        });
      } catch (err) {
        app.log.warn(
          { err, runId: data.workflowRunId },
          "[TRANSLATION] Failed to mark workflow run failure after drafts",
        );
      }
    }
    return;
  }

  const flag = await TranslationDraft.findOneAndUpdate(
    {
      project_id: data.projectId,
      job_id: data.jobId,
      "metadata.synthesisQueued": { $ne: true },
    },
    {
      $set: {
        "metadata.synthesisQueued": true,
        "metadata.synthesisQueuedAt": new Date().toISOString(),
      },
    },
    { sort: { run_order: 1 }, returnDocument: "before" },
  ).lean();

  if (!flag) {
    return;
  }

  const candidateDraftIds = successfulDrafts.map((draft) =>
    draft._id.toString(),
  );

  await enqueueTranslationSynthesisJob(
    {
      projectId: data.projectId,
      jobId: data.jobId,
      workflowRunId: data.workflowRunId ?? null,
      sourceHash: data.sourceHash,
      segmentationMode: data.segmentationMode,
      originLanguage: data.originLanguage ?? null,
      targetLanguage: data.targetLanguage ?? null,
      originSegments: data.originSegments,
      translationNotes: data.translationNotes ?? null,
      candidateDraftIds,
    },
    {
      jobId: `synthesis-${data.jobId}`,
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 1,
    },
  );

  app.log.info(
    `[TRANSLATION] Queued synthesis job for ${data.jobId} with ${candidateDraftIds.length} drafts`,
  );
}

async function handleTranslationSynthesisJob(job: TranslationSynthesisJob) {
  const { data } = job;
  if (await isJobCancelled(data.jobId)) {
    app.log.info(
      `[TRANSLATION] Skipping synthesis for job ${data.jobId} because it was cancelled`,
    );
    return;
  }
  await markJobRunning(data.jobId);

  try {
    const drafts = await loadDraftsByIds(data.candidateDraftIds);
    if (!drafts.length) {
      throw new Error("No translation drafts available for synthesis");
    }

    const synthesisResult = await synthesizeTranslation({
      projectId: data.projectId,
      jobId: data.jobId,
      sourceHash: data.sourceHash,
      originLanguage: data.originLanguage ?? null,
      targetLanguage: data.targetLanguage ?? null,
      originSegments: data.originSegments,
      translationNotes: data.translationNotes ?? null,
      candidates: drafts.map((draft) => ({
        draftId: draft._id.toString(),
        runOrder: draft.run_order,
        model: draft.model ?? null,
        temperature: draft.temperature ?? null,
        topP: draft.top_p ?? null,
        segments: draft.segments,
      })),
    });

    if (await isJobCancelled(data.jobId)) {
      app.log.info(
        `[TRANSLATION] Discarding synthesis result for job ${data.jobId} because it was cancelled`,
      );
      return;
    }

    await recordTokenUsage(app.log, {
      project_id: data.projectId,
      job_id: data.jobId,
      event_type: "translate",
      model: synthesisResult.model,
      input_tokens: synthesisResult.usage.inputTokens,
      output_tokens: synthesisResult.usage.outputTokens,
    });

    const translationFile = await persistFinalTranslation({
      projectId: data.projectId,
      jobId: data.jobId,
      originSegments: data.originSegments,
      resultSegments: synthesisResult.segments,
      mergedText: synthesisResult.mergedText,
      candidateDrafts: drafts,
      sourceHash: data.sourceHash,
    });

    await markJobSucceeded(data.jobId);

    if (data.workflowRunId) {
      try {
        await completeWorkflowRun(data.workflowRunId, {
          jobId: data.jobId,
          translationFileId: translationFile._id.toString(),
        });
      } catch (err) {
        app.log.warn(
          { err, runId: data.workflowRunId },
          "[TRANSLATION] Failed to mark workflow run complete after synthesis",
        );
      }
    }

    app.log.info(
      `[TRANSLATION] Final translation synthesized for job ${data.jobId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.jobId, message);
    if (data.workflowRunId) {
      try {
        await failWorkflowRun(data.workflowRunId, {
          jobId: data.jobId,
          error: message,
        });
      } catch (err) {
        app.log.warn(
          { err, runId: data.workflowRunId },
          "[TRANSLATION] Failed to mark workflow run failure during synthesis",
        );
      }
    }
    throw error;
  }
}

interface FinalizationPayload {
  projectId: string;
  jobId: string;
  originSegments: OriginSegment[];
  resultSegments: TranslationSynthesisSegmentResult[];
  mergedText: string;
  candidateDrafts: LeanDraftDocument[];
  sourceHash: string;
}

async function persistFinalTranslation(
  options: FinalizationPayload,
) {
  const {
    projectId,
    jobId,
    originSegments,
    resultSegments,
    mergedText,
    candidateDrafts,
    sourceHash,
  } = options;

  const originMap = new Map(
    originSegments.map((segment) => [segment.id, segment.text]),
  );

  const metadataSource = candidateDrafts.find(
    (draft) => draft?.metadata,
  ) as any;

  const originText =
    metadataSource?.metadata?.originText ?? reconstructOriginText(originSegments);
  const originFilename =
    metadataSource?.metadata?.originFilename ?? `origin-${jobId}.txt`;
  const originFileSize =
    metadataSource?.metadata?.originFileSize ??
    Buffer.byteLength(originText, "utf8");

  const candidateObjectIds = candidateDrafts.map((draft) => draft._id);
  const now = new Date();

  const translationFile = await TranslationFile.findOneAndUpdate(
    { project_id: projectId, job_id: jobId },
    {
      project_id: projectId,
      job_id: jobId,
      variant: "final",
      is_final: true,
      source_hash: sourceHash,
      synthesis_draft_ids: candidateObjectIds,
      origin_filename: originFilename,
      origin_file_size: originFileSize,
      origin_content: originText,
      translated_content: mergedText,
      batch_count: resultSegments.length,
      completed_batches: resultSegments.length,
      segments_version: 1,
      completed_at: now,
      updated_at: now,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  await TranslationSegment.deleteMany({
    translation_file_id: translationFile._id,
    variant: "final",
  });

  await TranslationSegment.insertMany(
    resultSegments.map((segment, index) => ({
      project_id: projectId,
      translation_file_id: translationFile._id,
      job_id: jobId,
      variant: "final",
      segment_id: segment.segment_id,
      segment_index: index,
      origin_segment: originMap.get(segment.segment_id) ?? "",
      translation_segment: segment.translation_segment,
      source_draft_ids: candidateObjectIds,
      synthesis_notes: {
        selectedRunOrder: segment.selected_run_order,
        rationale: segment.rationale,
      },
    })),
  );

  await TranslationDraft.updateMany(
    { _id: { $in: candidateObjectIds } },
    {
      $set: {
        "metadata.finalTranslationFileId": translationFile._id.toString(),
        finished_at: now,
      },
    },
  );

  await query(
    "UPDATE translationprojects SET updated_at = NOW() WHERE project_id = $1",
    [projectId],
  );

  let jobOwner: string | null = null;
  try {
    const { rows } = await query(
      "SELECT user_id FROM jobs WHERE id = $1 LIMIT 1",
      [jobId],
    );
    jobOwner = rows[0]?.user_id ?? null;
  } catch (err) {
    app.log.warn(
      { err, jobId },
      "[TRANSLATION] Failed to load job owner for profile enqueue",
    );
  }

  if (jobOwner && mergedText.trim().length) {
    enqueueProfileAnalysisJob({
      projectId,
      userId: jobOwner,
      payload: {
        variant: "translation",
        translationFileId: translationFile._id.toString(),
        triggeredBy: "translation-synthesis",
      },
    }).catch((err) => {
      app.log.error(
        { err, jobId, projectId },
        "[TRANSLATION] Failed to enqueue translation profile job",
      );
    });
  }

  return translationFile;
}

function reconstructOriginText(segments: OriginSegment[]): string {
  return segments
    .filter((segment) => segment.text && segment.text.trim().length)
    .map((segment) => ({
      text: segment.text.trim(),
      paragraphIndex: segment.paragraphIndex ?? 0,
    }))
    .reduce((accumulator, current, index, array) => {
      const previous = index > 0 ? array[index - 1] : null;
      const separator = previous
        ? previous.paragraphIndex !== current.paragraphIndex
          ? "\n\n"
          : "\n"
        : "";
      return accumulator + separator + current.text;
    }, "");
}

function initializeTranslationWorkers() {
  registerTranslationDraftProcessor(handleTranslationDraftJob);
  registerTranslationSynthesisProcessor(handleTranslationSynthesisJob);
  registerTranslationStageProcessor(handleTranslationStageJob);
  app.log.info("[STARTUP] Translation queue workers registered");
}

async function cancelTranslationDeletes(jobId: string, reason: string) {
  await cancelDrafts(jobId, reason);

  const drafts = await TranslationDraft.find({ job_id: jobId })
    .select({ run_order: 1 })
    .lean();
  for (const draft of drafts) {
    if (typeof draft.run_order === "number") {
      await removeDraftQueueJob(`draft-${jobId}-${draft.run_order}`);
    }
  }

  await removeSynthesisQueueJob(`synthesis-${jobId}`);
  await removeStageJobsFor(jobId);

  await query(
    `UPDATE translation_drafts
        SET status = 'cancelled',
            needs_review = false,
            updated_at = NOW()
      WHERE job_id = $1 AND status NOT IN ('succeeded','failed')`,
    [jobId],
  );
}


async function buildJobsPayload(jobRows: any[]) {
  if (!jobRows.length) {
    return [];
  }

  const jobIds = jobRows.map((row: any) => row.id);
  const batchMap: Record<string, any[]> = {};
  const draftMap: Record<string, any[]> = {};
  const translationMap = new Map<string, any>();

  const stageSummaryMap = new Map<
    string,
    {
      stageCounts: Record<string, number>;
      totalSegments: number;
      needsReviewCount: number;
      guardFailures: Record<string, number>;
      flaggedSegments: Array<{
        segmentIndex: number;
        segmentId: string;
        guards: Record<string, unknown> | null;
        guardFindings: unknown;
      }>;
    }
  >();

  const { rows: batchRows } = await query(
    `SELECT id, job_id, batch_index, status, started_at, finished_at, error
         FROM translation_batches
        WHERE job_id = ANY($1::text[])
        ORDER BY batch_index`,
    [jobIds],
  );

  for (const batch of batchRows) {
    if (!batchMap[batch.job_id]) batchMap[batch.job_id] = [];
    batchMap[batch.job_id].push({
      id: batch.id,
      batch_index: batch.batch_index,
      status: batch.status,
      started_at: batch.started_at,
      finished_at: batch.finished_at,
      error: batch.error,
    });
  }

  const draftDocs = await TranslationDraft.find({
    job_id: { $in: jobIds },
  })
    .sort({ run_order: 1 })
    .lean();

  for (const draft of draftDocs) {
    const key = draft.job_id;
    if (!draftMap[key]) draftMap[key] = [];
    draftMap[key].push({
      id: String(draft._id),
      runOrder: draft.run_order,
      status: draft.status,
      started_at: draft.started_at,
      finished_at: draft.finished_at,
      error: draft.error ?? null,
      model: draft.model ?? null,
      temperature: draft.temperature ?? null,
      top_p: draft.top_p ?? null,
      usage: draft.usage ?? null,
    });
  }

  const { rows: stageRows } = await query(
    `SELECT job_id, stage, COUNT(*)::INTEGER AS segment_count,
                SUM(CASE WHEN needs_review THEN 1 ELSE 0 END)::INTEGER AS needs_review_count
           FROM translation_drafts
          WHERE job_id = ANY($1::text[])
          GROUP BY job_id, stage`,
    [jobIds],
  );

  for (const row of stageRows) {
    const jobId = row.job_id as string;
    const stage = row.stage as string;
    const segmentCount = Number(row.segment_count ?? 0);
    const needsReviewCount = Number(row.needs_review_count ?? 0);

    let entry = stageSummaryMap.get(jobId);
    if (!entry) {
      entry = {
        stageCounts: {},
        totalSegments: 0,
        needsReviewCount: 0,
        guardFailures: {},
        flaggedSegments: [],
      };
      stageSummaryMap.set(jobId, entry);
    }

    entry.stageCounts[stage] = segmentCount;
    if (stage === "literal") {
      entry.totalSegments = segmentCount;
    }
    if (stage === "qa") {
      entry.needsReviewCount = needsReviewCount;
    }
  }

  const { rows: guardRows } = await query(
    `SELECT job_id,
                (kv).key AS guard_key,
                SUM(CASE WHEN lower((kv).value) = 'false' THEN 1 ELSE 0 END)::INTEGER AS failed_count
           FROM (
             SELECT job_id, jsonb_each_text(guards) AS kv
               FROM translation_drafts
              WHERE job_id = ANY($1::text[]) AND stage = 'qa'
           ) guard_values
          GROUP BY job_id, guard_key`,
    [jobIds],
  );

  for (const row of guardRows) {
    const jobId = row.job_id as string;
    const guardKey = row.guard_key as string;
    const failedCount = Number(row.failed_count ?? 0);
    if (!guardKey) continue;
    let entry = stageSummaryMap.get(jobId);
    if (!entry) {
      entry = {
        stageCounts: {},
        totalSegments: 0,
        needsReviewCount: 0,
        guardFailures: {},
        flaggedSegments: [],
      };
      stageSummaryMap.set(jobId, entry);
    }
    entry.guardFailures[guardKey] = failedCount;
  }

  const { rows: guardDetailRows } = await query(
    `SELECT job_id,
                segment_index,
                COALESCE(segment_id, notes->>'segmentId') AS segment_identifier,
                guards,
                notes,
                needs_review
           FROM translation_drafts
          WHERE job_id = ANY($1::text[]) AND stage = 'qa' AND needs_review = true
          ORDER BY segment_index ASC`,
    [jobIds],
  );

  for (const row of guardDetailRows) {
    const jobId = row.job_id as string;
    const entry = stageSummaryMap.get(jobId);
    if (!entry) continue;
    const notes = row.notes as Record<string, unknown> | null;
    const guardFindingsRaw = Array.isArray(notes?.guardFindings)
      ? (notes!.guardFindings as unknown[])
      : [];
    const guardFindings = guardFindingsRaw
      .map((finding) => {
        if (!finding || typeof finding !== "object") {
          return null;
        }
        const record = finding as Record<string, unknown>;
        const summary = typeof record.summary === "string" ? record.summary : null;
        if (!summary) return null;
        const mapped: Record<string, unknown> = {
          summary,
          type: typeof record.type === "string" ? record.type : "unknown",
          ok: record.ok !== false,
        };
        if (typeof record.segmentId === "string") {
          mapped.segmentId = record.segmentId;
        }
        if (typeof record.severity === "string") {
          mapped.severity = record.severity;
        }
        if (typeof record.details === "object" && record.details) {
          mapped.details = record.details;
        }
        return mapped;
      })
      .filter((value): value is Record<string, unknown> => Boolean(value));
    const segmentId =
      typeof row.segment_identifier === "string"
        ? row.segment_identifier
        : `segment-${row.segment_index ?? 0}`;
    entry.flaggedSegments.push({
      segmentIndex: Number(row.segment_index ?? 0),
      segmentId,
      guards: (row.guards as Record<string, unknown> | null) ?? null,
      guardFindings,
    });
  }

  const translationFiles = await TranslationFile.find({
    job_id: { $in: jobIds },
    is_final: true,
  })
    .sort({ completed_at: -1 })
    .lean();

  for (const tf of translationFiles) {
    const summary = {
      id: String(tf._id),
      project_id: tf.project_id,
      job_id: tf.job_id,
      completed_at: tf.completed_at ?? tf.updated_at ?? null,
      segments: tf.batch_count ?? null,
      source_hash: tf.source_hash ?? null,
    };
    translationMap.set(tf.job_id, summary);
  }

  return jobRows.map((row: any) => ({
    id: row.id,
    document_id: row.document_id,
    type: row.type,
    status: row.status,
    origin_lang: row.origin_lang,
    target_lang: row.target_lang,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    project_id: row.project_id,
    batches: batchMap[row.id] || [],
    drafts: draftMap[row.id] || [],
    finalTranslation: translationMap.get(row.id) ?? null,
    sequential: buildSequentialSummary(stageSummaryMap.get(row.id)),
  }));
}

function buildSequentialSummary(
  entry?: {
    stageCounts: Record<string, number>;
    totalSegments: number;
    needsReviewCount: number;
    guardFailures: Record<string, number>;
    flaggedSegments: Array<{
      segmentIndex: number;
      segmentId: string;
      guards: Record<string, unknown> | null;
      guardFindings: unknown;
    }>;
  },
) {
  if (!entry) {
    return null;
  }

  const stageCounts: Record<string, number> = { ...entry.stageCounts };
  const totalSegments = entry.totalSegments ?? 0;
  const needsReviewCount = entry.needsReviewCount ?? 0;
  const guardFailures = { ...(entry.guardFailures ?? {}) };
  const flaggedSegments = Array.isArray(entry.flaggedSegments)
    ? entry.flaggedSegments
    : [];

  const completedStages = SEQUENTIAL_STAGES.filter((stage) => {
    if (!totalSegments) return false;
    return (stageCounts[stage] ?? 0) >= totalSegments;
  });

  let currentStage: string | null = null;
  if (totalSegments > 0) {
    currentStage =
      SEQUENTIAL_STAGES.find((stage) => (stageCounts[stage] ?? 0) < totalSegments) ??
      SEQUENTIAL_STAGES[SEQUENTIAL_STAGES.length - 1];
  }

  return {
    stageCounts,
    totalSegments,
    needsReviewCount,
    completedStages,
    currentStage,
    guardFailures,
    flaggedSegments,
  };
}

function buildMemorySeed(
  notes: TranslationNotes | null,
  segments: OriginSegment[],
): Partial<ProjectMemory> {
  const sceneSummaries: Record<string, string> = {};
  for (const segment of segments.slice(0, 5)) {
    sceneSummaries[segment.id] = segment.text;
  }

  const seed: Partial<ProjectMemory> = {
    scene_summaries: sceneSummaries,
  };

  if (notes?.timePeriod) {
    seed.time_period = {
      source: notes.timePeriod,
      target_notes: notes.timePeriod,
    };
  }

  if (notes?.characters?.length) {
    seed.character_sheet = notes.characters.map((character) => ({
      name: { source: character.name, target: character.name },
      role: character.traits?.join(", ") ?? "character",
    }));
  }

  const namedEntities: Array<{ name: string; type: string }> = [];
  notes?.namedEntities?.forEach((entity) => {
    namedEntities.push({ name: entity.name, type: "person" });
  });
  notes?.locations?.forEach((location) => {
    namedEntities.push({ name: location.name, type: "place" });
  });
  if (namedEntities.length) {
    seed.named_entities = namedEntities.map((entity) => ({
      label: { source: entity.name, target: entity.name },
      type: entity.type as "place" | "person" | "org" | "object",
    }));
  }

  if (notes?.measurementUnits?.length) {
    seed.term_map = {
      source_to_target: {},
      target_to_source: {},
      units: notes.measurementUnits.reduce<Record<string, string>>((acc, unit) => {
        acc[unit] = unit;
        return acc;
      }, {}),
    };
  }

  if (notes?.linguisticFeatures?.length) {
    seed.linguistic_features = {
      target: notes.linguisticFeatures.reduce<Record<string, string>>(
        (acc, feature, index) => {
          acc[`feature_${index + 1}`] = feature;
          return acc;
        },
      {}),
    };
  }

  return seed;
}

// --- No-op SSE broadcasters (removed SSE support but keep function stubs) ---
function broadcastJobProgress(_user_id: string, _jobData: any) {
  // SSE removed: keep as no-op to avoid changing worker logic
  app.log.debug("broadcastJobProgress called (SSE disabled)");
}

function broadcastBatchUpdate(_user_id: string, _batchData: any) {
  app.log.debug("broadcastBatchUpdate called (SSE disabled)");
}

interface TranslationRecommendation {
  translation: any;
  score: number;
  qualityAssessment?: any;
}

async function findBestTranslationForProject(
  projectId: string,
): Promise<TranslationRecommendation | null> {
  const translations = await TranslationFile.find({
    project_id: projectId,
    is_final: true,
  })
    .sort({ completed_at: -1 })
    .lean()
    .exec();

  if (!translations?.length) return null;

  const qualityDocs = await QualityAssessment.find({ projectId })
    .sort({ timestamp: -1 })
    .lean()
    .exec();

  const qualityByJob = new Map<string, any>();
  for (const qa of qualityDocs as any[]) {
    const jobId = qa.jobId || qa.job_id;
    if (jobId && !qualityByJob.has(jobId)) {
      qualityByJob.set(jobId, qa);
    }
  }

  let best: TranslationRecommendation | null = null;

  for (const tf of translations as any[]) {
    const jobId = tf.job_id || tf.jobId || null;
    const qa = (jobId && qualityByJob.get(jobId)) || qualityDocs[0] || null;
    const score = qa?.qualityResult?.overallScore ?? 0;

    if (!best) {
      best = { translation: tf, score, qualityAssessment: qa };
      continue;
    }

    const isHigherScore = score > best.score;
    const isEqualButNewer =
      score === best.score &&
      new Date(tf.completed_at ?? tf.updated_at ?? 0).getTime() >
        new Date(
          best.translation.completed_at ?? best.translation.updated_at ?? 0,
        ).getTime();

    if (isHigherScore || isEqualButNewer) {
      best = { translation: tf, score, qualityAssessment: qa };
    }
  }

  return best;
}

//----------
// CORS
//----------

// -----------------------------
// Bootstrap
// -----------------------------
async function registerPluginsAndRoutes() {
  //await app.register(cors, { origin: true });
  await app.register(cors, {
    origin: process.env.CLIENT_ORIGIN, // e.g. http://project-t1.com:5174
    credentials: true,
  });
  // plugins and routes already registered above where appropriate
}

async function bootstrap() {
  try {
    app.log.info("[STARTUP] Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI!);
    app.log.info("[STARTUP] MongoDB connected");

    await registerPluginsAndRoutes();
    initializeTranslationWorkers();
    startProfileWorker();
    startCoverWorker();

    const PORT = Number(process.env.PORT || 8080);
    await app.listen({ port: PORT, host: "0.0.0.0" });
    
    const protocol = HTTPS_ENABLED ? "HTTPS" : "HTTP";
    app.log.info(`[STARTUP] ${protocol} Server started on port ${PORT}`);
  } catch (err) {
    app.log.error(err, "[FATAL] Failed to start server");
    process.exit(1);
  }
}

bootstrap();
