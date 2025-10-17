import { MongoClient, Db } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;
let testDbOverride: Db | null = null;

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

  let doc = await col.findOne({ project_id, job_id });
  if (!doc) {
    const fallback = await col.findOne({ job_id });
    if (fallback) {
      if (fallback.project_id !== project_id) {
        await col.updateOne({ _id: fallback._id }, { $set: { project_id } });
      }
      doc = await col.findOne({ project_id, job_id });
    }
  }

  if (!doc)
    throw new Error(`translation_files not found: ${project_id}/${job_id}`);
  const { origin_content, translated_content } = doc as any;
  if (!origin_content || !translated_content)
    throw new Error("origin_content or translated_content missing.");
  return { origin_content, translated_content, raw: doc };
}
export async function saveProofreadingDoc(payload: {
  project_id: string;
  job_id: string;
  proofreading_id: string;
  spec: any;
  report: any;
  tierReports?: Partial<Record<"quick" | "deep", any>>;
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

export async function applyProofreadingChanges({
  proofreading_id,
  appliedIssueIds,
  translatedContent,
}: ApplyProofreadingParams) {
  const m = await getMongo();
  const proofreadingCol = m.collection("proofreading_files");
  const translationCol = m.collection("translation_files");

  const doc = await proofreadingCol.findOne({ proofreading_id });
  if (!doc)
    throw new Error(`Proofreading document not found: ${proofreading_id}`);

  const appliedSet = new Set(appliedIssueIds);
  const now = new Date();

  const updateReportResults = (results: any[] | undefined) =>
    (results ?? []).map((bucket) => ({
      ...bucket,
      items: (bucket.items ?? []).map((item: any) => {
        if (item?.id && appliedSet.has(item.id)) {
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
