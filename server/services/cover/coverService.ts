import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import type { PoolClient } from "pg";
import { AIImageService } from "@bookko/ai-image-gen";
import { pool, query } from "../../db";

export type CoverStatus = "queued" | "generating" | "ready" | "failed";
export type CoverAssetRole = "front" | "back" | "spine" | "wrap";

interface QueueCoverOptions {
  projectId: string;
  title: string;
  author?: string | null;
  translator?: string | null;
  targetLanguage?: string | null;
  summary: string;
  writerNote?: string | null;
  translatorNote?: string | null;
  isbn?: string | null;
  createdBy?: string | null;
  translationProfileId?: string | null;
}

interface CoverSetRow {
  cover_set_id: string;
  project_id: string;
  ebook_id: string | null;
  translation_profile_id: string | null;
  job_id: string | null;
  title: string | null;
  author: string | null;
  translator: string | null;
  target_language: string | null;
  summary_snapshot: string | null;
  prompt: string | null;
  writer_note: string | null;
  translator_note: string | null;
  isbn: string | null;
  status: CoverStatus;
  is_current: boolean;
  created_by: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CoverAssetRow {
  ebook_asset_id: string;
  cover_set_id: string | null;
  asset_type: string;
  mime_type: string;
  file_name: string;
  file_path: string;
  public_url: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  checksum: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface CoverSetOverview {
  coverSetId: string;
  status: CoverStatus;
  isCurrent: boolean;
  generatedAt: string;
  createdBy: string | null;
  prompt: string | null;
  summary: string | null;
  failureReason: string | null;
  assets: Array<{
    assetId: string;
    role: CoverAssetRole;
    publicUrl: string;
    fileName: string;
    filePath: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    sizeBytes: number;
    checksum: string;
  }>;
}

export interface CoverOverviewResponse {
  projectId: string;
  coverSets: CoverSetOverview[];
  currentSetId: string | null;
}

const WRAP_WIDTH = 2100;
const WRAP_HEIGHT = 1400;
const FRONT_WIDTH = 900;
const SPINE_WIDTH = 300;
const BACK_WIDTH = WRAP_WIDTH - FRONT_WIDTH - SPINE_WIDTH;

const DEFAULT_STORAGE_SUBDIR = "covers";
const DEFAULT_SVG_SUBDIR = path.join(DEFAULT_STORAGE_SUBDIR, "svg");

const buildCoverPrompt = (
  title: string,
  summary: string,
  targetLanguage?: string | null,
): string => {
  const cleanTitle = title.trim() || "Untitled Manuscript";
  const trimmedSummary = summary.trim();
  const summarySnippet =
    trimmedSummary.length > 800
      ? `${trimmedSummary.slice(0, 800)}…`
      : trimmedSummary;
  const targetLabel = targetLanguage?.trim();
  const languageName = targetLabel || "the intended reader language";
  const languageDirectives = targetLabel
    ? [
        `Target language: ${targetLabel}.`,
        `Translate any supplied content (title, author name, summary blurb) into ${targetLabel} before placing it on the layout.`,
        `All visible copy on front, back, and spine must appear exclusively in ${targetLabel}.`,
      ]
    : [
        "Ensure any textual elements use a single, appropriate reader language.",
        "Avoid mixing multiple languages or placeholder Latin on the cover.",
      ];

  return [
    `Design a marketing-ready wraparound book cover for "${cleanTitle}".`,
    `Story summary for inspiration: ${summarySnippet}.`,
    "The canvas represents a full wrap: left panel is back cover, middle (~15% width) is the spine, right panel is the front cover.",
    "Front cover must feature an eye-catching focal illustration or photographic treatment that clearly signals the primary genre and tone.",
    "Back cover should reserve space for a compelling synopsis and optional author note derived from the summary; keep typography balanced and legible.",
    "Spine should display a concise title and author/translator combination with strong contrast for shelf visibility.",
    "Ensure color palette, typography, and imagery flow seamlessly across back, spine, and front panels.",
    "Avoid placeholder lorem ipsum; leave areas blank rather than inserting filler text if needed.",
    ...languageDirectives,
    `Typography hierarchy should lead with the front-cover title, followed by author/translator names and any subtitle or tagline in ${languageName}.`,
  ].join(" ");
};

const roleFromAssetType = (assetType: string): CoverAssetRole => {
  if (assetType === "cover-front") return "front";
  if (assetType === "cover-back") return "back";
  if (assetType === "cover-spine") return "spine";
  return "wrap";
};

interface CoverJobPayload {
  coverSetId: string;
}

export class CoverService {
  private readonly storageRoot: string;
  private readonly svgArchiveRoot: string;
  private readonly aiService: AIImageService;
  private initialized = false;

  constructor(options?: { storageRoot?: string; svgArchiveRoot?: string }) {
    const workingRoot = process.cwd();
    this.storageRoot =
      options?.storageRoot ??
      process.env.COVER_STORAGE_DIR ??
      path.resolve(workingRoot, "storage", DEFAULT_STORAGE_SUBDIR);
    this.svgArchiveRoot =
      options?.svgArchiveRoot ??
      process.env.COVER_SVG_ARCHIVE_DIR ??
      path.resolve(workingRoot, "storage", DEFAULT_SVG_SUBDIR);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY must be configured to generate covers");
    }

    this.aiService = new AIImageService({
      ai: {
        geminiApiKey: apiKey,
        model: process.env.GEMINI_MODEL,
      },
    });
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    await Promise.all([
      fs.mkdir(this.storageRoot, { recursive: true }),
      fs.mkdir(this.svgArchiveRoot, { recursive: true }),
    ]);
    await this.aiService.initialize();
    this.initialized = true;
  }

  async queueCoverRegeneration(
    options: QueueCoverOptions,
  ): Promise<{ coverSetId: string; jobId: string; status: CoverStatus }> {
    await this.ensureInitialized();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const ebookId = await this.ensureEbook(client, {
        projectId: options.projectId,
        title: options.title,
        author: options.author,
        translator: options.translator,
        sourceLanguage: null,
        targetLanguage: options.targetLanguage ?? null,
        synopsis: options.summary,
      });

      const pendingRes = await client.query(
        `SELECT 1
           FROM ebook_cover_sets
          WHERE project_id = $1
            AND status IN ('queued','generating')
          LIMIT 1`,
        [options.projectId],
      );

      if (pendingRes.rows.length) {
        await client.query("ROLLBACK");
        throw new Error("cover_job_pending");
      }

      const insertSet = await client.query(
        `INSERT INTO ebook_cover_sets (
           project_id,
           ebook_id,
           translation_profile_id,
           title,
           author,
           translator,
           target_language,
           summary_snapshot,
           writer_note,
           translator_note,
           isbn,
           status,
           is_current,
           created_by,
           created_at,
           updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',FALSE,$12, now(), now()
         )
         RETURNING cover_set_id;`,
        [
          options.projectId,
          ebookId,
          options.translationProfileId ?? null,
          options.title,
          options.author ?? null,
          options.translator ?? null,
          options.targetLanguage ?? null,
          options.summary,
          options.writerNote ?? null,
          options.translatorNote ?? null,
          options.isbn ?? null,
          options.createdBy ?? null,
        ],
      );

      const coverSetId = insertSet.rows[0].cover_set_id as string;
      const jobId = uuidv4();
      const payload: CoverJobPayload = { coverSetId };

      await client.query(
        `INSERT INTO jobs (id, user_id, project_id, document_id, type, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'cover','queued', now(), now())`,
        [
          jobId,
          options.createdBy ?? null,
          options.projectId,
          JSON.stringify(payload),
        ],
      );

      await client.query(
        `UPDATE ebook_cover_sets
           SET job_id = $2
         WHERE cover_set_id = $1`,
        [coverSetId, jobId],
      );

      await client.query(
        `INSERT INTO ebook_audit_log (log_id, ebook_id, cover_set_id, event_type, actor, payload, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'cover_queue', $3, $4, now())`,
        [
          ebookId,
          coverSetId,
          options.createdBy ?? null,
          JSON.stringify({
            translationProfileId: options.translationProfileId ?? null,
          }),
        ],
      );

      await client.query("COMMIT");

      return { coverSetId, jobId, status: "queued" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async processCoverJob(
    jobId: string,
    payload: CoverJobPayload,
    userId: string | null,
  ): Promise<void> {
    await this.ensureInitialized();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const coverSetRes = await client.query<CoverSetRow>(
        `SELECT * FROM ebook_cover_sets WHERE cover_set_id = $1 FOR UPDATE`,
        [payload.coverSetId],
      );
      const coverSet = coverSetRes.rows[0];
      if (!coverSet) {
        await client.query("ROLLBACK");
        throw new Error(`Cover set ${payload.coverSetId} not found`);
      }

      await client.query(
        `UPDATE ebook_cover_sets
            SET status = 'generating', failure_reason = NULL, updated_at = now()
          WHERE cover_set_id = $1`,
        [payload.coverSetId],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      client.release();
      throw error;
    }

    // Re-fetch outside transaction for generation
    const coverSet = await this.getCoverSet(payload.coverSetId);
    if (!coverSet) {
      throw new Error(`Cover set ${payload.coverSetId} not found`);
    }

    try {
      const prompt = buildCoverPrompt(
        coverSet.title ?? "Untitled Manuscript",
        coverSet.summary_snapshot ?? "",
        coverSet.target_language ?? null,
      );

      const svgContent = await this.generateSvg(prompt);
      const { wrapBuffer, frontBuffer, spineBuffer, backBuffer, svgBuffer } =
        await this.createCoverVariants(svgContent);

      await this.storeCoverAssets({
        coverSet,
        prompt,
        svgBuffer,
        wrapBuffer,
        frontBuffer,
        spineBuffer,
        backBuffer,
        generatedBy: userId,
      });

      await this.markJobStatus(jobId, "done");
    } catch (error) {
      await this.handleCoverFailure(payload.coverSetId, error as Error, userId);
      await this.markJobStatus(jobId, "failed", (error as Error).message);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCoverOverview(projectId: string): Promise<CoverOverviewResponse> {
    await this.ensureInitialized();
    const res = await query(
      `SELECT cs.*, ea_json.assets
         FROM ebook_cover_sets cs
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
             'ebook_asset_id', ea.ebook_asset_id,
             'cover_set_id', ea.cover_set_id,
             'asset_type', ea.asset_type,
             'mime_type', ea.mime_type,
             'file_name', ea.file_name,
             'file_path', ea.file_path,
             'public_url', ea.public_url,
             'width', ea.width,
             'height', ea.height,
             'size_bytes', ea.size_bytes,
             'checksum', ea.checksum,
             'metadata', ea.metadata,
             'created_at', ea.created_at
           ) ORDER BY ea.created_at) AS assets
           FROM ebook_assets ea
          WHERE ea.cover_set_id = cs.cover_set_id
            AND ea.asset_type LIKE 'cover-%'
        ) ea_json ON TRUE
        WHERE cs.project_id = $1
        ORDER BY cs.created_at DESC`,
      [projectId],
    );

    const coverSets: CoverSetOverview[] = res.rows.map((row) => {
      const assetsRaw = Array.isArray(row.assets)
        ? (row.assets as unknown[])
        : [];
      const assets = assetsRaw
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null,
        )
        .map((entry) => ({
          assetId: String(entry.ebook_asset_id ?? ""),
          role: roleFromAssetType(String(entry.asset_type ?? "cover-wrap")),
          publicUrl: String(entry.public_url ?? ""),
          fileName: String(entry.file_name ?? "cover.jpg"),
          filePath: String(entry.file_path ?? ""),
          mimeType: String(entry.mime_type ?? "image/jpeg"),
          width: typeof entry.width === "number" ? entry.width : null,
          height: typeof entry.height === "number" ? entry.height : null,
          sizeBytes: Number(entry.size_bytes ?? 0),
          checksum: String(entry.checksum ?? ""),
        }));

      return {
        coverSetId: String(row.cover_set_id),
        status: row.status as CoverStatus,
        isCurrent: Boolean(row.is_current),
        generatedAt: (row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at)
        ).toISOString(),
        createdBy: row.created_by ? String(row.created_by) : null,
        prompt: row.prompt ? String(row.prompt) : null,
        summary: row.summary_snapshot ? String(row.summary_snapshot) : null,
        failureReason: row.failure_reason ? String(row.failure_reason) : null,
        assets,
      };
    });

    const currentSetId =
      coverSets.find((set) => set.isCurrent)?.coverSetId ?? null;

    return {
      projectId,
      coverSets,
      currentSetId,
    };
  }

  async getCoverAssetFile(projectId: string, assetId: string) {
    const res = await query(
      `SELECT file_path, mime_type, file_name
         FROM ebook_assets
        WHERE project_id = $1
          AND ebook_asset_id = $2
        LIMIT 1`,
      [projectId, assetId],
    );
    const row = res.rows[0];
    if (!row) return null;

    const absolutePath = path.join(this.storageRoot, row.file_path as string);
    return {
      absolutePath,
      mimeType: (row.mime_type as string) ?? "image/jpeg",
      fileName: (row.file_name as string) ?? "cover.jpg",
    };
  }

  private async ensureEbook(
    client: PoolClient,
    params: {
      projectId: string;
      title: string;
      author?: string | null;
      translator?: string | null;
      sourceLanguage?: string | null;
      targetLanguage?: string | null;
      synopsis?: string | null;
    },
  ): Promise<string> {
    const result = await client.query(
      `INSERT INTO ebooks (
          ebook_id,
          project_id,
          title,
          author,
          translator,
          source_language,
          target_language,
          synopsis,
          status,
          created_at,
          updated_at
       ) VALUES (
          gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,'cover-queued', now(), now()
       )
       ON CONFLICT (project_id) DO UPDATE SET
          title = COALESCE(EXCLUDED.title, ebooks.title),
          author = COALESCE(EXCLUDED.author, ebooks.author),
          translator = COALESCE(EXCLUDED.translator, ebooks.translator),
          source_language = COALESCE(EXCLUDED.source_language, ebooks.source_language),
          target_language = COALESCE(EXCLUDED.target_language, ebooks.target_language),
          synopsis = COALESCE(EXCLUDED.synopsis, ebooks.synopsis),
          updated_at = now()
       RETURNING ebook_id;`,
      [
        params.projectId,
        params.title,
        params.author ?? null,
        params.translator ?? null,
        params.sourceLanguage ?? null,
        params.targetLanguage ?? null,
        params.synopsis ?? null,
      ],
    );
    return result.rows[0].ebook_id as string;
  }

  private async getCoverSet(coverSetId: string): Promise<CoverSetRow | null> {
    const res = await query(
      `SELECT * FROM ebook_cover_sets WHERE cover_set_id = $1`,
      [coverSetId],
    );
    return res.rows[0] ?? null;
  }

  private async generateSvg(prompt: string): Promise<string> {
    const result = await this.aiService.generateImage(prompt, {
      width: WRAP_WIDTH,
      height: WRAP_HEIGHT,
      style: "book-cover",
      quality: "high",
      storeImage: false,
    });
    return result.svgContent;
  }

  private async createCoverVariants(svgContent: string) {
    const svgBuffer = Buffer.from(svgContent, "utf8");
    const wrapBuffer = await sharp(svgBuffer)
      .resize(WRAP_WIDTH, WRAP_HEIGHT, { fit: "cover" })
      .jpeg({ quality: 90 })
      .toBuffer();

    const backBuffer = await sharp(wrapBuffer)
      .extract({ left: 0, top: 0, width: BACK_WIDTH, height: WRAP_HEIGHT })
      .jpeg({ quality: 90 })
      .toBuffer();

    const spineBuffer = await sharp(wrapBuffer)
      .extract({
        left: BACK_WIDTH,
        top: 0,
        width: SPINE_WIDTH,
        height: WRAP_HEIGHT,
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    const frontBuffer = await sharp(wrapBuffer)
      .extract({
        left: BACK_WIDTH + SPINE_WIDTH,
        top: 0,
        width: FRONT_WIDTH,
        height: WRAP_HEIGHT,
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return { wrapBuffer, frontBuffer, spineBuffer, backBuffer, svgBuffer };
  }

  private async storeCoverAssets(params: {
    coverSet: CoverSetRow;
    prompt: string;
    svgBuffer: Buffer;
    wrapBuffer: Buffer;
    frontBuffer: Buffer;
    spineBuffer: Buffer;
    backBuffer: Buffer;
    generatedBy: string | null;
  }) {
    const {
      coverSet,
      prompt,
      svgBuffer,
      wrapBuffer,
      frontBuffer,
      spineBuffer,
      backBuffer,
      generatedBy,
    } = params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const baseDir = path.join(
        this.storageRoot,
        coverSet.project_id,
        coverSet.cover_set_id,
      );
      const svgDir = path.join(
        this.svgArchiveRoot,
        coverSet.project_id,
        coverSet.cover_set_id,
      );
      await fs.mkdir(baseDir, { recursive: true });
      await fs.mkdir(svgDir, { recursive: true });

      const wrapFile = `cover_${coverSet.cover_set_id}_wrap.jpg`;
      const frontFile = `cover_${coverSet.cover_set_id}_front.jpg`;
      const backFile = `cover_${coverSet.cover_set_id}_back.jpg`;
      const spineFile = `cover_${coverSet.cover_set_id}_spine.jpg`;
      const svgFile = `cover_${coverSet.cover_set_id}.svg`;

      await Promise.all([
        fs.writeFile(path.join(baseDir, wrapFile), wrapBuffer),
        fs.writeFile(path.join(baseDir, frontFile), frontBuffer),
        fs.writeFile(path.join(baseDir, backFile), backBuffer),
        fs.writeFile(path.join(baseDir, spineFile), spineBuffer),
        fs.writeFile(path.join(svgDir, svgFile), svgBuffer, "utf8"),
      ]);

      const wrapChecksum = createHash("sha256")
        .update(wrapBuffer)
        .digest("hex");
      const frontChecksum = createHash("sha256")
        .update(frontBuffer)
        .digest("hex");
      const backChecksum = createHash("sha256")
        .update(backBuffer)
        .digest("hex");
      const spineChecksum = createHash("sha256")
        .update(spineBuffer)
        .digest("hex");

      const now = new Date();

      await client.query(
        `UPDATE ebook_assets
            SET is_current = FALSE, updated_at = now()
          WHERE project_id = $1 AND asset_type LIKE 'cover-%'`,
        [coverSet.project_id],
      );

      await client.query(
        `UPDATE ebook_cover_sets
            SET is_current = FALSE, updated_at = now()
          WHERE project_id = $1`,
        [coverSet.project_id],
      );

      await this.insertCoverAsset(client, coverSet, {
        fileName: wrapFile,
        filePath: path.relative(this.storageRoot, path.join(baseDir, wrapFile)),
        checksum: wrapChecksum,
        role: "wrap",
        width: WRAP_WIDTH,
        height: WRAP_HEIGHT,
        sizeBytes: wrapBuffer.length,
        metadata: {
          prompt,
          svgFile,
          svgChecksum: createHash("sha256").update(svgBuffer).digest("hex"),
        },
      });

      await this.insertCoverAsset(client, coverSet, {
        fileName: frontFile,
        filePath: path.relative(
          this.storageRoot,
          path.join(baseDir, frontFile),
        ),
        checksum: frontChecksum,
        role: "front",
        width: FRONT_WIDTH,
        height: WRAP_HEIGHT,
        sizeBytes: frontBuffer.length,
        metadata: { prompt },
      });

      await this.insertCoverAsset(client, coverSet, {
        fileName: backFile,
        filePath: path.relative(this.storageRoot, path.join(baseDir, backFile)),
        checksum: backChecksum,
        role: "back",
        width: BACK_WIDTH,
        height: WRAP_HEIGHT,
        sizeBytes: backBuffer.length,
        metadata: { prompt },
      });

      await this.insertCoverAsset(client, coverSet, {
        fileName: spineFile,
        filePath: path.relative(
          this.storageRoot,
          path.join(baseDir, spineFile),
        ),
        checksum: spineChecksum,
        role: "spine",
        width: SPINE_WIDTH,
        height: WRAP_HEIGHT,
        sizeBytes: spineBuffer.length,
        metadata: { prompt },
      });

      await client.query(
        `UPDATE ebook_cover_sets
            SET status = 'ready',
                prompt = $2,
                is_current = TRUE,
                failure_reason = NULL,
                updated_at = now()
          WHERE cover_set_id = $1`,
        [coverSet.cover_set_id, prompt],
      );

      await client.query(
        `UPDATE ebooks
            SET status = 'cover-ready', updated_at = now()
          WHERE ebook_id = $1`,
        [coverSet.ebook_id ?? null],
      );

      await client.query(
        `INSERT INTO ebook_audit_log (log_id, ebook_id, cover_set_id, event_type, actor, payload, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'cover_generated', $3, $4, now())`,
        [
          coverSet.ebook_id ?? null,
          coverSet.cover_set_id,
          generatedBy,
          JSON.stringify({ prompt }),
        ],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertCoverAsset(
    client: PoolClient,
    coverSet: CoverSetRow,
    params: {
      fileName: string;
      filePath: string;
      checksum: string;
      role: CoverAssetRole;
      width: number;
      height: number;
      sizeBytes: number;
      metadata?: Record<string, unknown>;
    },
  ) {
    const assetId = uuidv4();
    const assetType = `cover-${params.role}`;
    const publicUrl = `/api/projects/${coverSet.project_id}/cover/image/${assetId}`;

    await client.query(
      `INSERT INTO ebook_assets (
          ebook_asset_id,
          ebook_version_id,
          cover_set_id,
          project_id,
          asset_type,
          mime_type,
          file_name,
          file_path,
          public_url,
          width,
          height,
          size_bytes,
          checksum,
          source,
          metadata,
          is_current,
          created_at,
          updated_at
       ) VALUES (
          $1,$2,$3,$4,$5,'image/jpeg',$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE, now(), now()
       )`,
      [
        assetId,
        null,
        coverSet.cover_set_id,
        coverSet.project_id,
        assetType,
        params.fileName,
        params.filePath,
        publicUrl,
        params.width,
        params.height,
        params.sizeBytes,
        params.checksum,
        "ai:gemini-2.5-flash",
        JSON.stringify({ role: params.role, ...(params.metadata ?? {}) }),
      ],
    );
  }

  private async handleCoverFailure(
    coverSetId: string,
    error: Error,
    userId: string | null,
  ) {
    await query(
      `UPDATE ebook_cover_sets
          SET status = 'failed', failure_reason = $2, updated_at = now()
        WHERE cover_set_id = $1`,
      [coverSetId, error.message],
    );

    await query(
      `INSERT INTO ebook_audit_log (log_id, ebook_id, cover_set_id, event_type, actor, payload, created_at)
       VALUES (
         gen_random_uuid(),
         (SELECT ebook_id FROM ebook_cover_sets WHERE cover_set_id = $1),
         $1,
         'cover_failed',
         $2,
         $3,
         now()
       )`,
      [coverSetId, userId ?? null, JSON.stringify({ reason: error.message })],
    );
  }

  private async markJobStatus(jobId: string, status: string, message?: string) {
    await query(
      `UPDATE jobs
          SET status = $2,
              finished_at = now(),
              updated_at = now(),
              last_error = $3
        WHERE id = $1`,
      [jobId, status, message ?? null],
    );
  }
}

let singleton: CoverService | null = null;

export function getCoverService(): CoverService {
  if (!singleton) {
    singleton = new CoverService();
  }
  return singleton;
}

export const parseCoverJobPayload = (
  documentId: string | null,
): CoverJobPayload | null => {
  if (!documentId) return null;
  try {
    const parsed = JSON.parse(documentId) as { coverSetId?: string };
    if (!parsed.coverSetId) return null;
    return { coverSetId: String(parsed.coverSetId) };
  } catch (error) {
    return null;
  }
};
