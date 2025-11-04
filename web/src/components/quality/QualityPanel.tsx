import { useMemo } from "react";
import { useProjectStore } from "../../store/project.store";
import { useQualityHistory } from "../../hooks/useProjectData";
import { useWorkflowStore } from "../../store/workflow.store";
import type { ProjectContent } from "../../types/domain";

interface QualityPanelProps {
  stage?: string;
  latest?: ProjectContent["qualityAssessment"] | null;
}

interface QualityAssessmentMetaShape {
  model?: string;
  chunks?: number;
  chunkSize?: number;
  overlap?: number;
  chunkStats?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
}

interface QualityAssessmentResultShape {
  overallScore?: number | null;
  meta?: QualityAssessmentMetaShape;
  quantitative?: Record<string, unknown> | null;
  qualitative?: Record<string, unknown> | null;
}

interface ParsedAssessment {
  timestamp?: string;
  result: QualityAssessmentResultShape | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseMeta = (value: unknown): QualityAssessmentMetaShape | undefined => {
  if (!isRecord(value)) return undefined;
  const meta: QualityAssessmentMetaShape = {};
  if (typeof value.model === "string") meta.model = value.model;
  if (typeof value.chunks === "number") meta.chunks = value.chunks;
  if (typeof value.chunkSize === "number") meta.chunkSize = value.chunkSize;
  if (typeof value.overlap === "number") meta.overlap = value.overlap;
  if (Array.isArray(value.chunkStats))
    meta.chunkStats = value.chunkStats as Array<Record<string, unknown>>;
  if (isRecord(value.config))
    meta.config = value.config as Record<string, unknown>;
  return Object.keys(meta).length ? meta : undefined;
};

const toQualityResult = (
  input: unknown,
): QualityAssessmentResultShape | null => {
  if (!isRecord(input)) return null;
  const container = isRecord(input.qualityResult)
    ? (input.qualityResult as Record<string, unknown>)
    : (input as Record<string, unknown>);
  if (!isRecord(container)) return null;

  const overallCandidate = container["overallScore"] ?? input["overallScore"];
  const metaCandidate = container["meta"] ?? input["meta"];
  const quantitativeCandidate = container["quantitative"];
  const qualitativeCandidate = container["qualitative"];

  const quantitative = isRecord(quantitativeCandidate)
    ? (quantitativeCandidate as Record<string, unknown>)
    : null;
  const qualitative = isRecord(qualitativeCandidate)
    ? (qualitativeCandidate as Record<string, unknown>)
    : null;

  return {
    overallScore:
      typeof overallCandidate === "number" ? overallCandidate : null,
    meta: parseMeta(metaCandidate),
    quantitative,
    qualitative,
  };
};

const extractAssessments = (source: unknown): ParsedAssessment[] => {
  if (!source) return [];
  if (Array.isArray(source)) {
    const collected: ParsedAssessment[] = [];
    source.forEach((entry) => {
      if (!isRecord(entry)) return;
      collected.push({
        timestamp:
          typeof entry.timestamp === "string" ? entry.timestamp : undefined,
        result: toQualityResult(entry),
      });
    });
    return collected;
  }
  if (isRecord(source)) {
    const dataAssessments = extractAssessments(source["data"]);
    if (dataAssessments.length) return dataAssessments;
    const directAssessments = extractAssessments(source["assessments"]);
    if (directAssessments.length) return directAssessments;
    const result = toQualityResult(source);
    if (!result) return [];
    return [
      {
        timestamp:
          typeof source["timestamp"] === "string"
            ? (source["timestamp"] as string)
            : undefined,
        result,
      },
    ];
  }
  return [];
};

const normalizeCommentValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeCommentValue(item))
      .filter((item): item is string => Boolean(item && item.trim()));
    return normalized.length ? normalized.join(" ") : undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.summary === "string") return obj.summary;
    if (typeof obj.message === "string") return obj.message;
    const nested = Object.values(obj)
      .map((item) => normalizeCommentValue(item))
      .filter((item): item is string => Boolean(item && item.trim()));
    return nested.length ? nested.join(" ") : undefined;
  }
  return String(value);
};

const joinComments = (
  ...values: (string | undefined)[]
): string | undefined => {
  const parts = values.filter((value): value is string =>
    Boolean(value && value.trim()),
  );
  if (!parts.length) return undefined;
  return parts.join(" ");
};

interface CommentaryText {
  ko?: string;
  en?: string;
}

const collectCommentary = (entry: unknown): CommentaryText => {
  if (!entry) return { ko: undefined, en: undefined };
  if (typeof entry === "string") return { ko: entry, en: undefined };
  if (Array.isArray(entry)) {
    return entry
      .map((item) => collectCommentary(item))
      .reduce(
        (acc, current) => ({
          ko: joinComments(acc.ko, current.ko),
          en: joinComments(acc.en, current.en),
        }),
        {
          ko: undefined as string | undefined,
          en: undefined as string | undefined,
        },
      );
  }
  if (isRecord(entry)) {
    const commentaryValue = entry["commentary"];
    const base =
      commentaryValue !== undefined
        ? collectCommentary(commentaryValue)
        : { ko: undefined, en: undefined };
    const koExtras = normalizeCommentValue(
      entry["commentaryKo"] ??
        entry["ko"] ??
        entry["commentary_ko"] ??
        entry["summary"] ??
        entry["text"],
    );
    const enExtras = normalizeCommentValue(
      entry["commentaryEn"] ?? entry["en"] ?? entry["commentary_en"],
    );
    return {
      ko: joinComments(base.ko, koExtras),
      en: joinComments(base.en, enExtras),
    };
  }
  return { ko: normalizeCommentValue(entry), en: undefined };
};

interface MetricRecord {
  score?: unknown;
  Score?: unknown;
  commentary?: unknown;
  [key: string]: unknown;
}

const QuantitativeTable = ({
  data,
}: {
  data: Record<string, unknown> | null | undefined;
}) => {
  if (!data) return null;
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <div className="rounded border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h4 className="text-xs font-semibold uppercase text-slate-500">
        정량 평가 (Quantitative)
      </h4>
      <table className="mt-3 w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase text-slate-500">
            <th className="py-2">항목</th>
            <th className="py-2">점수</th>
            <th className="py-2">한줄평</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {entries.map(([metric, info]) => {
            const metricRecord: MetricRecord = isRecord(info)
              ? (info as MetricRecord)
              : { score: info };
            const rawScore = metricRecord.score ?? metricRecord.Score ?? info;
            const scoreValue =
              typeof rawScore === "number"
                ? rawScore.toFixed(1)
                : typeof rawScore === "string"
                  ? rawScore
                  : "-";
            const commentarySource = metricRecord.commentary ?? metricRecord;
            const { ko: commentaryKo, en: commentaryEn } =
              collectCommentary(commentarySource);
            return (
              <tr key={metric}>
                <th className="py-2 text-xs uppercase text-slate-500">
                  {metric}
                </th>
                <td className="py-2 text-sm font-medium text-slate-700">
                  {scoreValue}
                </td>
                <td className="py-2 text-xs text-slate-500">
                  <ul className="list-disc space-y-1 pl-4">
                    {commentaryKo ? <li>{commentaryKo}</li> : <li>-</li>}
                    {commentaryEn && (
                      <li className="text-[10px] text-slate-400">
                        {commentaryEn}
                      </li>
                    )}
                  </ul>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const QualitativeTable = ({
  data,
}: {
  data: Record<string, unknown> | null | undefined;
}) => {
  if (!data) return null;
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <div className="rounded border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h4 className="text-xs font-semibold uppercase text-slate-500">
        정성 평가 (Qualitative)
      </h4>
      <table className="mt-3 w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase text-slate-500">
            <th className="py-2">항목</th>
            <th className="py-2">한줄평(ko)</th>
            <th className="py-2">한줄평(en)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {entries.map(([metric, detail]) => {
            const { ko, en } = collectCommentary(detail);
            return (
              <tr key={metric}>
                <th className="py-2 text-xs uppercase text-slate-500">
                  {metric}
                </th>
                <td className="py-2 text-sm text-slate-700">{ko || "-"}</td>
                <td className="py-2 text-xs text-slate-500">{en || "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export const QualityPanel = ({ stage, latest }: QualityPanelProps) => {
  const projectId = useProjectStore((state) => state.activeProjectId);
  const { data: qualityHistory } = useQualityHistory(projectId);
  const qualityStatus = useWorkflowStore((state) => state.quality.status);
  const qualityLastMessage = useWorkflowStore(
    (state) => state.quality.lastMessage,
  );
  const assessments = useMemo(
    () => extractAssessments(qualityHistory),
    [qualityHistory],
  );
  const latestFromHistory = assessments.length
    ? assessments[assessments.length - 1]
    : null;
  const latestResult = toQualityResult(latest);
  const activeAssessment = latestResult
    ? { timestamp: latest?.timestamp ?? undefined, result: latestResult }
    : latestFromHistory;
  const qualityResult = activeAssessment?.result ?? null;

  const stageLabel = stage ?? (qualityResult ? "done" : "no-assessment");
  const completedAt = activeAssessment?.timestamp
    ? new Date(activeAssessment.timestamp).toLocaleString()
    : null;
  const stageDescription = (() => {
    if (qualityStatus === "running") {
      return (
        qualityLastMessage ??
        "Quality assessment is running. Results will refresh automatically."
      );
    }
    if (qualityStatus === "failed") {
      return "Quality assessment failed. Retry from the Run Quality Assessment button.";
    }
    if (!qualityResult) {
      return "Run a quality assessment to see scores and analysis.";
    }
    if (!completedAt) {
      return "Quality assessment completed successfully.";
    }
    return `Quality assessment completed at ${completedAt}.`;
  })();

  const stageTone =
    qualityStatus === "running"
      ? "running"
      : qualityStatus === "failed"
        ? "failed"
        : qualityResult && stageLabel !== "no-assessment"
          ? "done"
          : "idle";

  const metaLine = useMemo(() => {
    if (!qualityResult?.meta) return null;
    const { model, chunks, chunkSize, overlap } = qualityResult.meta;
    const parts: string[] = [];
    if (model) parts.push(`최신 평가 모델: ${model}`);
    if (typeof chunks === "number" || typeof chunkSize === "number") {
      const chunkCountLabel = typeof chunks === "number" ? `${chunks}` : "?";
      const chunkSizeLabel =
        typeof chunkSize === "number" ? `${chunkSize}` : "?";
      parts.push(`청크 수: ${chunkCountLabel} / 청크 크기: ${chunkSizeLabel}`);
    }
    if (typeof overlap === "number") {
      parts.push(`청크 겹침: ${overlap}`);
    }
    if (!parts.length) return null;
    return parts.join(" · ");
  }, [qualityResult?.meta]);
  const stageCardClass = (() => {
    switch (stageTone) {
      case "done":
        return "rounded border border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm";
      case "running":
        return "rounded border border-amber-200 bg-amber-50 text-amber-700 shadow-sm";
      case "failed":
        return "rounded border border-rose-200 bg-rose-50 text-rose-700 shadow-sm";
      default:
        return "rounded border border-slate-200 bg-white text-slate-700 shadow-sm";
    }
  })();

  const stageTitleClass = (() => {
    switch (stageTone) {
      case "done":
        return "text-sm font-semibold uppercase text-emerald-600";
      case "running":
        return "text-sm font-semibold uppercase text-amber-600";
      case "failed":
        return "text-sm font-semibold uppercase text-rose-600";
      default:
        return "text-sm font-semibold uppercase text-slate-500";
    }
  })();

  const stageDescriptionClass = (() => {
    switch (stageTone) {
      case "done":
        return "text-sm text-emerald-700";
      case "running":
        return "text-sm text-amber-700";
      case "failed":
        return "text-sm text-rose-700";
      default:
        return "text-sm text-slate-500";
    }
  })();

  if (!projectId) {
    return (
      <p className="p-4 text-sm text-slate-500">
        Select a project to see quality insights.
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4 text-sm">
      <div className={stageCardClass + " p-4"}>
        <h3 className={stageTitleClass}>Quality Assessment</h3>
        <p className={stageDescriptionClass}>{stageDescription}</p>
      </div>

      {stage === "no-assessment" &&
        !qualityResult &&
        qualityStatus !== "running" && (
          <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
            품질 검토가 실행되면 정량/정성 분석 결과가 표시됩니다.
          </div>
        )}

      <QuantitativeTable data={qualityResult?.quantitative} />
      <div className="space-y-3">
        <QualitativeTable data={qualityResult?.qualitative} />
        {metaLine && <p className="text-[11px] text-slate-500">{metaLine}</p>}
      </div>
    </div>
  );
};
