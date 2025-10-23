import type { ReactNode } from "react";

type StageKey =
  | "origin"
  | "translation"
  | "proofreading"
  | "quality"
  | "publishing";

interface WorkflowStageItem {
  key: StageKey;
  label: string;
  status?: {
    label: string;
    tone: "info" | "success" | "danger";
  };
  detail?: ReactNode;
}

interface WorkflowTimelineProps {
  stages: WorkflowStageItem[];
  footer?: ReactNode;
  onStageClick?: (stage: StageKey) => void;
}

const toneClass = (tone: "info" | "success" | "danger") => {
  switch (tone) {
    case "success":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "danger":
      return "bg-rose-50 text-rose-700 border-rose-200";
    default:
      return "bg-indigo-50 text-indigo-700 border-indigo-200";
  }
};

const WorkflowTimeline = ({ stages, footer, onStageClick }: WorkflowTimelineProps) => (
  <div className="rounded border border-slate-200 bg-white p-2">
    <ul className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
      {stages.map((stage, index) => {
        const handleClick = onStageClick ? () => onStageClick(stage.key) : undefined;
        const content = (
          <div className="flex flex-col gap-1 text-left">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-800">{stage.label}</span>
              {stage.status && (
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${toneClass(stage.status.tone)}`}
                >
                  {stage.status.label}
                </span>
              )}
            </div>
            {stage.detail ? (
              <div className="text-[11px] text-slate-500">{stage.detail}</div>
            ) : null}
          </div>
        );

        return (
          <li key={stage.key} className="flex items-start gap-2">
            {handleClick ? (
              <button
                type="button"
                onClick={handleClick}
                className="flex items-start gap-2 rounded-lg border border-transparent px-2 py-1 transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                {content}
              </button>
            ) : (
              <span className="flex items-start gap-2">{content}</span>
            )}
            {index < stages.length - 1 && (
              <span className="pt-2 text-slate-300">→</span>
            )}
          </li>
        );
      })}
    </ul>
    {footer ? <div className="mt-2 text-[11px] text-slate-500">{footer}</div> : null}
  </div>
);

export default WorkflowTimeline;
