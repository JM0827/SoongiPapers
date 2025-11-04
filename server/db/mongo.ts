import { MongoClient, Db } from "mongodb";

import type {
  ProofreadingReport,
  ResultBucket,
  Spec,
} from "../agents/proofreading/config";

let client: MongoClient | null = null;
let db: Db | null = null;
let testDbOverride: Db | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringField = (
  record: Record<string, unknown>,
  ...keys: string[]
): string | null => {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
};

export function __setTestMongoDb(dbOverride: Db | null): void {
  testDbOverride = dbOverride;
  if (dbOverride) {
    db = dbOverride;
    client = null;
  }
}

export async function getMongo(): Promise<Db> {
  if (testDbOverride) return testDbOverride;
  if (db) return db;
  client = await MongoClient.connect(process.env.MONGO_URI!, {});
  db = client.db(process.env.MONGO_DB || "novel");
  return db!;
}
export async function getMongoDoc(project_id: string, job_id: string) {
  const m = await getMongo();
  const col = m.collection("translation_files");

  const match = { project_id, job_id } as const;
  let doc = await col.findOne(match);

  if (!doc) {
    const byJob = await col.findOne({ job_id });
    if (byJob) {
      if (byJob.project_id !== project_id) {
        await col.updateOne({ _id: byJob._id }, { $set: { project_id } });
        byJob.project_id = project_id;
      }
      doc = byJob;
    }
  }

  if (!doc) {
    const byProject = await col
      .find({ project_id })
      .sort({ updated_at: -1, completed_at: -1, created_at: -1 })
      .limit(1)
      .next();

    if (byProject) {
      const needsJobBackfill = !byProject.job_id;
      if (needsJobBackfill) {
        await col.updateOne({ _id: byProject._id }, { $set: { job_id } });
        byProject.job_id = job_id;
        console.warn(
          "[proofreading] Backfilled translation_files.job_id for project",
          {
            project_id,
            job_id,
            translation_file_id: byProject._id,
          },
        );
      }
      doc = byProject;
    }
  }

  if (!doc) {
    throw new Error(`translation_files not found: ${project_id}/${job_id}`);
  }

  if (!isRecord(doc)) {
    throw new Error("translation_files document has unexpected shape");
  }

  const origin_content = readStringField(doc, "origin_content", "originContent");
  const translated_content = readStringField(
    doc,
    "translated_content",
    "translatedContent",
  );

  if (!origin_content || !translated_content) {
    throw new Error("origin_content or translated_content missing.");
  }

  return { origin_content, translated_content, raw: doc };
}
export async function saveProofreadingDoc(payload: {
  project_id: string;
  job_id: string;
  proofreading_id: string;
  spec: Spec;
  report: ProofreadingReport;
  tierReports?: Partial<Record<"quick" | "deep", ProofreadingReport>>;
}) {
  const m = await getMongo();
  const col = m.collection("proofreading_files");
  const { project_id, job_id, proofreading_id, spec, report, tierReports } =
    payload;
  const now = new Date();
  await col.insertOne({
    project_id,
    job_id,
    proofreading_id,
    spec,
    report,
    quick_report: tierReports?.quick ?? null,
    deep_report: tierReports?.deep ?? null,
    applied_translated_content: null,
    applied_issue_ids: [],
    created_at: now,
    updated_at: now,
  });
}

type ApplyProofreadingParams = {
  proofreading_id: string;
  appliedIssueIds: string[];
  translatedContent: string;
};

type ProofreadingMongoDoc = {
  proofreading_id: string;
  project_id: string;
  job_id: string;
  report: ProofreadingReport;
  quick_report: ProofreadingReport | null;
  deep_report: ProofreadingReport | null;
  applied_issue_ids?: string[];
};

export async function applyProofreadingChanges({
  proofreading_id,
  appliedIssueIds,
  translatedContent,
}: ApplyProofreadingParams) {
  const m = await getMongo();
  const proofreadingCol = m.collection("proofreading_files");
  const translationCol = m.collection("translation_files");

  const doc = (await proofreadingCol.findOne({
    proofreading_id,
  })) as ProofreadingMongoDoc | null;
  if (!doc)
    throw new Error(`Proofreading document not found: ${proofreading_id}`);

  const appliedSet = new Set(appliedIssueIds);
  const now = new Date();

  const updateReportResults = (results?: ResultBucket[]): ResultBucket[] =>
    (results ?? []).map((bucket) => ({
      ...bucket,
      items: bucket.items.map((item) => {
        if (item.id && appliedSet.has(item.id)) {
          if (item.status !== "applied") {
            return {
              ...item,
              status: "applied",
              appliedAt: item.appliedAt ?? now.toISOString(),
            };
          }
          return item;
        }
        return item;
      }),
    }));

  const updatedReport = {
    ...doc.report,
    results: updateReportResults(doc.report?.results),
    appliedTranslation: translatedContent,
  };

  const updatedQuick = doc.quick_report
    ? {
        ...doc.quick_report,
        results: updateReportResults(doc.quick_report?.results),
        appliedTranslation: translatedContent,
      }
    : null;
  const updatedDeep = doc.deep_report
    ? {
        ...doc.deep_report,
        results: updateReportResults(doc.deep_report?.results),
        appliedTranslation: translatedContent,
      }
    : null;

  await proofreadingCol.updateOne(
    { proofreading_id },
    {
      $set: {
        report: updatedReport,
        quick_report: updatedQuick,
        deep_report: updatedDeep,
        applied_issue_ids: Array.from(
          new Set([...(doc.applied_issue_ids ?? []), ...appliedIssueIds]),
        ),
        applied_translated_content: translatedContent,
        updated_at: now,
      },
    },
  );

  await translationCol.updateOne(
    { project_id: doc.project_id, job_id: doc.job_id },
    {
      $set: {
        translated_content: translatedContent,
        updated_at: now,
      },
    },
  );

  return {
    report: updatedReport,
    quick_report: updatedQuick,
    deep_report: updatedDeep,
    applied_translated_content: translatedContent,
    updated_at: now,
  };
}
