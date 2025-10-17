import { CheckCircle2, Loader2, Circle } from "lucide-react";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";
interface StageProgress {
  running: boolean;
  done: boolean;
  failed: boolean;
}

interface SequentialStage {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  count: number;
}

interface TranslationSequentialSummary {
  stages: SequentialStage[];
  totalSegments: number;
  needsReviewCount: number;
  guardFailures?: Record<string, number>;
  flaggedSegments?: Array<{
    segmentIndex: number;
    segmentId: string;
    guardFindings?: Array<{
      type: string;
      summary: string;
      severity?: string;
    }>;
  }>;
}

interface TranslationTimelineData {
  overall: StageProgress;
  sequential: TranslationSequentialSummary | null;
}

interface WorkflowTimelineProps {
  originReady: boolean;
  translation: TranslationTimelineData;
  proofreading: StageProgress;
  quality: StageProgress;
  onStageClick?: (stage: "origin" | "translation" | "proofreading" | "quality") => void;
}

const stageIcon = (state: "pending" | "running" | "done" | "failed") => {
  if (state === "done") {
    return (
      <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
    );
  }
  if (state === "failed") {
    return <Circle className="h-4 w-4 text-rose-500" aria-hidden="true" />;
  }
  if (state === "running") {
    return (
      <Loader2
        className="h-4 w-4 animate-spin text-indigo-500"
        aria-hidden="true"
      />
    );
  }
  return <Circle className="h-4 w-4 text-slate-300" aria-hidden="true" />;
};

const resolveStageState = ({
  running,
  done,
  failed,
}: StageProgress): "pending" | "running" | "done" | "failed" => {
  if (failed) return "failed";
  if (done) return "done";
  if (running) return "running";
  return "pending";
};

const WorkflowTimeline = ({
  originReady,
  translation,
  proofreading,
  quality,
  onStageClick,
}: WorkflowTimelineProps) => {
  const { locale } = useUILocale();
  const localize = (
    key: string,
    fallback: string,
    params?: Record<string, string | number>,
  ) => {
    const resolved = translate(key, locale, params);
    return resolved === key ? fallback : resolved;
  };
  const originState: "pending" | "running" | "done" | "failed" = originReady
    ? "done"
    : "pending";
  const translationState = resolveStageState(translation.overall);
  const proofreadingState = resolveStageState(proofreading);
  const qualityState = resolveStageState(quality);
  const sequential = translation.sequential;
  const stageLabelSequence = sequential?.stages?.length
    ? sequential.stages.map((stage) => stage.label).join(" -> ")
    : localize(
        "timeline_stage_sequence",
        "직역 -> 스타일 -> 감정 -> QA",
      );

  const proofreadingDescription = (() => {
    switch (proofreadingState) {
      case "done":
        return localize("timeline_proof_done", "교정 완료");
      case "running":
        return localize("timeline_proof_running", "교정 진행 중");
      case "failed":
        return localize("timeline_proof_failed", "교정 실패");
      default:
        return localize("timeline_proof_pending", "교정 대기 중");
    }
  })();

  const qualityDescription = (() => {
    switch (qualityState) {
      case "done":
        return localize("timeline_quality_done", "품질 평가 완료");
      case "running":
        return localize("timeline_quality_running", "품질 평가 중");
      case "failed":
        return localize("timeline_quality_failed", "품질 평가 실패");
      default:
        return localize("timeline_quality_pending", "품질 평가 대기");
    }
  })();

  const stageCopy: Record<string, { title: string; description: string }> = {
    origin: {
      title: localize("timeline_origin_title", "Origin"),
      description:
        originState === "done"
          ? localize("timeline_origin_complete", "원문 확보 완료")
          : localize("timeline_origin_pending", "원문 확보"),
    },
    translation: {
      title: localize("timeline_translation_title", "Translation"),
      description: (() => {
        if (sequential) {
          const { stages, guardFailures } = sequential;
          const runningStage = stages.find((stage) => stage.state === "running");
          const completedCount = stages.filter((stage) => stage.state === "done").length;
          const totalStages = stages.length;
          const guardAlertCount = Object.entries(guardFailures ?? {})
            .filter(([key, value]) => key !== "allOk" && Number(value ?? 0) > 0)
            .reduce((acc, [, count]) => acc + Number(count ?? 0), 0);

          if (translationState === "failed") {
            return localize("timeline_translation_failed", "번역 실패");
          }
          if (translationState === "done") {
            return guardAlertCount > 0
              ? localize(
                  "timeline_translation_done_with_guard",
                  `번역 완료 · 가드 경고 ${guardAlertCount}건`,
                  { count: guardAlertCount },
                )
              : localize("timeline_translation_done", "번역 완료");
          }
          if (runningStage) {
            const base = `${runningStage.label} 단계 진행 중`;
            return guardAlertCount > 0
              ? localize(
                  "timeline_translation_running_with_guard",
                  `${base} · 가드 경고 ${guardAlertCount}건`,
                  { label: runningStage.label, count: guardAlertCount },
                )
              : localize(
                  "timeline_translation_running_stage",
                  base,
                  { label: runningStage.label },
                );
          }
          if (completedCount > 0) {
            const base = `번역 진행 중 (${completedCount}/${totalStages})`;
            return guardAlertCount > 0
              ? localize(
                  "timeline_translation_progress_with_guard",
                  `${base} · 가드 경고 ${guardAlertCount}건`,
                  { completed: completedCount, total: totalStages, count: guardAlertCount },
                )
              : localize(
                  "timeline_translation_progress",
                  base,
                  { completed: completedCount, total: totalStages },
                );
          }
          return localize(
            "timeline_translation_ready",
            `번역을 준비 중입니다. ${stageLabelSequence} 순서로 진행됩니다.`,
            { sequence: stageLabelSequence },
          );
        }

        if (translationState === "done")
          return localize("timeline_translation_done", "번역 완료");
        if (translationState === "running")
          return localize("timeline_translation_running", "번역 진행 중");
        if (translationState === "failed")
          return localize("timeline_translation_failed", "번역 실패");
        return localize("timeline_translation_pending", "번역 대기 중");
      })(),
    },
    proofreading: {
      title: localize("timeline_proof_title", "Proofread"),
      description: proofreadingDescription,
    },
    quality: {
      title: localize("timeline_quality_title", "Quality"),
      description: qualityDescription,
    },
  };

  const stages: Array<{
    key: "origin" | "translation" | "proofreading" | "quality";
    state: "pending" | "running" | "done" | "failed";
  }> = [
    {
      key: "origin",
      state: originState,
    },
    {
      key: "translation",
      state: translationState,
    },
    {
      key: "proofreading",
      state: proofreadingState,
    },
    {
      key: "quality",
      state: qualityState,
    },
  ];

  return (
    <div className="rounded border border-slate-200 bg-white p-2">
      <ul className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
        {stages.map((stage, index) => {
          const handleClick = onStageClick
            ? () => onStageClick(stage.key)
            : undefined;
          const content = (
            <>
              <span className="flex items-center gap-1">
                {stageIcon(stage.state)}
                <span className="font-medium text-slate-700">
                  {stageCopy[stage.key].title}
                </span>
              </span>
              <span className="hidden sm:inline text-slate-400">
                {stageCopy[stage.key].description}
              </span>
            </>
          );
          return (
            <li key={stage.key} className="flex items-center gap-2">
              {handleClick ? (
                <button
                  type="button"
                  onClick={handleClick}
                  className="flex items-center gap-2 rounded-full border border-transparent px-2 py-1 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
                >
                  {content}
                </button>
              ) : (
                <span className="flex items-center gap-2">{content}</span>
              )}
              {index < stages.length - 1 && (
                <span className="text-slate-300">→</span>
              )}
            </li>
          );
        })}
      </ul>
      {sequential && (
        <div className="mt-2 space-y-1 text-[11px] text-slate-500">
          <div className="flex flex-wrap gap-2">
            {sequential.stages.map((stage) => (
              <span
                key={stage.key}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                  stage.state === "done"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : stage.state === "running"
                      ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                      : stage.state === "failed"
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : "border-slate-200 bg-slate-50 text-slate-500"
                }`}
              >
                {stageIcon(stage.state)}
                <span>{stage.label}</span>
                {sequential.totalSegments > 0 && (
                  <span className="text-[10px] text-slate-400">
                    {stage.count}/{sequential.totalSegments}
                  </span>
                )}
              </span>
            ))}
          </div>
          {renderGuardSummary(sequential.guardFailures ?? {}, localize)}
        </div>
      )}
    </div>
  );
};

const guardTypeLabel = (
  key: string,
  localize: (k: string, fallback: string) => string,
) => {
  const normalized = key.toLowerCase();
  switch (normalized) {
    case "named-entity":
      return localize("timeline_guard_named_entity", "Entity");
    case "term-map":
      return localize("timeline_guard_term_map", "Term Map");
    case "back-translation":
      return localize("timeline_guard_back_translation", "Back Translation");
    case "length-parity":
      return localize("timeline_guard_length_parity", "Length");
    case "register":
      return localize("timeline_guard_register", "Register");
    default:
      return key;
  }
};

const renderGuardSummary = (
  guardFailures: Record<string, number>,
  localize: (k: string, fallback: string, params?: Record<string, string | number>) => string,
) => {
  const entries = Object.entries(guardFailures)
    .filter(([key, value]) => key !== "allOk" && Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  if (!entries.length) return null;

  return (
    <div className="flex flex-wrap gap-2 text-amber-600">
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5"
        >
          <span className="font-semibold">{guardTypeLabel(key, localize)}</span>
          <span>
            {localize(
              "timeline_guard_count",
              String(value),
              { count: value },
            )}
          </span>
        </span>
      ))}
    </div>
  );
};

export default WorkflowTimeline;
