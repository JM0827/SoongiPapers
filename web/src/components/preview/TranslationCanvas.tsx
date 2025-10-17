import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { ProjectContent } from "../../types/domain";
import { useWorkflowStore } from "../../store/workflow.store";

interface TranslationCanvasProps {
  content?: ProjectContent | null;
  isLoading?: boolean;
}

type StageState = "completed" | "in-progress" | "pending";

const stageLabel = (stage?: string) => {
  const normalized = (stage ?? "").toLowerCase();
  switch (normalized) {
    case "done":
    case "complete":
    case "translated":
      return "번역 완료";
    case "running":
    case "queued":
    case "progress":
    case "translating":
      return "번역 중";
    case "origin-only":
      return "원문만 등록됨";
    case "translation-error":
    case "failed":
      return "번역 오류";
    default:
      return "대기 중";
  }
};

const proofreadingLabel = (stage?: string) => {
  const normalized = (stage ?? "").toLowerCase();
  if (!normalized || normalized === "none") return "미실행";
  if (normalized.includes("run") || normalized.includes("progress"))
    return "진행 중";
  if (normalized.includes("queue")) return "대기 중";
  if (normalized.includes("done") || normalized.includes("complete"))
    return "완료";
  if (normalized.includes("fail")) return "실패";
  return stage ?? "미확인";
};

const qualityLabel = (stage?: string) => {
  const normalized = (stage ?? "").toLowerCase();
  if (!normalized || normalized === "none" || normalized === "no-assessment")
    return "미실행";
  if (normalized.includes("run") || normalized.includes("progress"))
    return "진행 중";
  if (normalized.includes("fail")) return "실패";
  if (normalized.includes("done")) return "완료";
  return stage ?? "미확인";
};

const publishLabel = (status?: string) => {
  const normalized = (status ?? "").toLowerCase();
  if (!normalized) return "미실행";
  if (
    normalized.includes("export") &&
    !normalized.includes("done") &&
    !normalized.includes("complete")
  ) {
    return "내보내기 진행 중";
  }
  if (
    normalized.includes("done") ||
    normalized.includes("complete") ||
    normalized.includes("ready") ||
    normalized.includes("exported")
  ) {
    return "출판 준비 완료";
  }
  if (normalized.includes("fail")) return "실패";
  return status ?? "미확인";
};

const StageIcon = ({ state }: { state: StageState }) => {
  if (state === "completed") {
    return (
      <CheckCircle2
        className="h-5 w-5 flex-shrink-0 text-emerald-500"
        aria-hidden="true"
      />
    );
  }
  if (state === "in-progress") {
    return (
      <Loader2
        className="h-5 w-5 flex-shrink-0 animate-spin text-indigo-500"
        aria-hidden="true"
      />
    );
  }
  return (
    <Circle
      className="h-5 w-5 flex-shrink-0 text-slate-300"
      aria-hidden="true"
    />
  );
};

export const TranslationCanvas = ({
  content,
  isLoading,
}: TranslationCanvasProps) => {
  const translationAgent = useWorkflowStore((state) => state.translation);
  const proofreadingAgent = useWorkflowStore((state) => state.proofreading);
  const qualityAgent = useWorkflowStore((state) => state.quality);

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center p-4 text-sm text-slate-500">
        최신 상태를 불러오는 중입니다...
      </div>
    );
  }

  if (!content) {
    return (
      <div className="p-4 text-sm text-slate-500">
        프로젝트를 선택해 워크플로우를 시작하세요.
      </div>
    );
  }

  const originStageState: StageState = content.content?.origin?.content?.trim()
    ? "completed"
    : isLoading
      ? "in-progress"
      : "pending";

  const translationStageBase =
    content.translationStage ??
    content.latestJob?.status ??
    content.latestJob?.stage ??
    "";
  const translationComposite = (() => {
    switch (translationAgent.status) {
      case "running":
        return "running";
      case "queued":
        return "queued";
      case "done":
        return "translated";
      case "failed":
        return "failed";
      default:
        return translationStageBase;
    }
  })();
  const translationStageRaw = translationComposite
    ? translationComposite.toString().toLowerCase()
    : "";
  let translationStageState: StageState = "pending";
  if (translationStageRaw === "translated") translationStageState = "completed";
  else if (
    translationStageRaw.includes("translating") ||
    translationStageRaw.includes("progress") ||
    translationStageRaw.includes("queue")
  ) {
    translationStageState = "in-progress";
  } else if (!translationStageRaw || translationStageRaw === "origin-only")
    translationStageState = "pending";
  else if (
    translationStageRaw.includes("fail") ||
    translationStageRaw.includes("error")
  )
    translationStageState = "pending";

  const proofreadingStageBase =
    content.proofreadingStage ??
    content.proofreading?.stage ??
    content.proofreading?.status ??
    "";
  const proofreadingComposite = (() => {
    switch (proofreadingAgent.status) {
      case "running":
        return "running";
      case "queued":
        return "queued";
      case "done":
        return "done";
      case "failed":
        return "failed";
      default:
        return proofreadingStageBase;
    }
  })();
  const proofreadingStageRaw = proofreadingComposite
    ? proofreadingComposite.toString().toLowerCase()
    : "";
  let proofreadingStageState: StageState = "pending";
  if (
    proofreadingStageRaw?.includes("done") ||
    proofreadingStageRaw?.includes("complete")
  ) {
    proofreadingStageState = "completed";
  } else if (
    proofreadingStageRaw?.includes("run") ||
    proofreadingStageRaw?.includes("queue") ||
    proofreadingStageRaw?.includes("progress")
  ) {
    proofreadingStageState = "in-progress";
  } else if (proofreadingStageRaw?.includes("fail")) {
    proofreadingStageState = "pending";
  }

  const qualityStageBase =
    content.qualityAssessmentStage ?? content.qualityAssessment?.status ?? "";
  const qualityComposite = (() => {
    switch (qualityAgent.status) {
      case "running":
        return "running";
      case "done":
        return "done";
      case "failed":
        return "failed";
      default:
        return qualityStageBase;
    }
  })();
  const qualityStageRaw = qualityComposite
    ? qualityComposite.toString().toLowerCase()
    : "";
  let qualityStageState: StageState = "pending";
  if (
    !qualityStageRaw ||
    qualityStageRaw === "no-assessment" ||
    qualityStageRaw === "none"
  ) {
    qualityStageState = "pending";
  } else if (
    qualityStageRaw.includes("done") ||
    qualityStageRaw.includes("complete")
  ) {
    qualityStageState = "completed";
  } else if (qualityStageRaw.includes("run")) {
    qualityStageState = "in-progress";
  } else if (qualityStageRaw.includes("fail")) {
    qualityStageState = "pending";
  }

  const publishStatusRaw = content.ebook?.status?.toLowerCase();
  let publishStageState: StageState = "pending";
  if (!publishStatusRaw) {
    publishStageState = "pending";
  } else if (
    publishStatusRaw.includes("done") ||
    publishStatusRaw.includes("complete") ||
    publishStatusRaw.includes("ready") ||
    publishStatusRaw.includes("exported")
  ) {
    publishStageState = "completed";
  } else if (publishStatusRaw.includes("export")) {
    publishStageState = "in-progress";
  } else if (publishStatusRaw.includes("fail")) {
    publishStageState = "pending";
  }

  const stages: Array<{
    key: string;
    label: string;
    description: string;
    state: StageState;
  }> = [
    {
      key: "origin",
      label: "Origin text upload",
      description: content.content?.origin?.content
        ? "원문 업로드 완료"
        : "원문을 업로드해 주세요.",
      state: originStageState,
    },
    {
      key: "translation",
      label: "Translation",
      description: stageLabel(translationComposite?.toString()),
      state: translationStageState,
    },
    {
      key: "proofread",
      label: "Proofread analysis",
      description: proofreadingLabel(proofreadingComposite?.toString()),
      state: proofreadingStageState,
    },
    {
      key: "quality",
      label: "Translation quality",
      description: qualityLabel(qualityComposite?.toString()),
      state: qualityStageState,
    },
    {
      key: "publish",
      label: "Publish",
      description: publishLabel(content.ebook?.status),
      state: publishStageState,
    },
  ];

  return (
    <div className="space-y-3 text-sm">
      {stages.map((stage) => (
        <div key={stage.key} className="flex items-start gap-3">
          <StageIcon state={stage.state} />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">
              {stage.label}
            </p>
            <p className="text-xs text-slate-500">{stage.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
};
