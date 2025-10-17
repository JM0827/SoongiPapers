import type { ReactNode } from "react";
import { SidebarSection } from "./SidebarSection";

interface WorkflowItem {
  key: string;
  title: string;
  statusLabel: string;
  toneClass: string;
  description?: string | null;
  detail?: ReactNode;
  updatedAtLabel?: string | null;
}

interface RecentRun {
  id: string;
  label: string;
  statusLabel: string;
  timestampLabel: string;
}

interface SidebarWorkflowSectionProps {
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  items: WorkflowItem[];
  recentRuns: RecentRun[];
}

export const SidebarWorkflowSection = ({
  isOpen,
  onToggle,
  items,
  recentRuns,
}: SidebarWorkflowSectionProps) => {
  return (
    <SidebarSection
      title="워크플로 상태"
      subtitle="번역 · 교정 · 품질 단계 진행 현황"
      isOpen={isOpen}
      onToggle={onToggle}
    >
      <div className="space-y-3">
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.key}
              className={`flex flex-col gap-1 rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600 ${item.toneClass}`}
            >
              <div className="flex items-center justify-between text-sm text-slate-700">
                <span className="font-semibold">{item.title}</span>
                <span>{item.statusLabel}</span>
              </div>
              {item.description ? (
                <p className="text-[11px] text-slate-500">{item.description}</p>
              ) : null}
              {item.detail}
              {item.updatedAtLabel ? (
                <p className="text-[10px] text-slate-400">
                  업데이트: {item.updatedAtLabel}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {recentRuns.length > 0 && (
          <div className="rounded border border-slate-100 bg-white p-3">
            <p className="text-xs font-semibold text-slate-600">최근 실행</p>
            <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
              {recentRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between">
                  <span className="truncate pr-2">{run.label}</span>
                  <span className="text-slate-400">{run.statusLabel}</span>
                  <span className="text-slate-400">{run.timestampLabel}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SidebarSection>
  );
};
