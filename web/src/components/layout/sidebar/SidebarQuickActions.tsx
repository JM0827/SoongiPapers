import React, { useCallback, useEffect, useId, useState } from "react";
import clsx from "clsx";
import { SidebarSection } from "./SidebarSection";

export interface QuickAction {
  key: string;
  label: string;
  icon: React.ReactElement<{ className?: string }>;
  tooltip?: string;
  onClick: () => Promise<void> | void;
  disabled?: boolean;
  status?: "default" | "running" | "done";
}

interface SidebarQuickActionsProps {
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  actions: QuickAction[];
}

const describeStatus = (
  label: string,
  status: "default" | "running" | "done",
) => {
  switch (status) {
    case "running":
      return `${label} 실행 상태: 진행 중`;
    case "done":
      return `${label} 실행 상태: 완료됨`;
    default:
      return `${label} 실행 상태: 대기 중`;
  }
};

export const SidebarQuickActions = ({
  isOpen,
  onToggle,
  actions,
}: SidebarQuickActionsProps) => {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(
    null,
  );
  const instanceId = useId().replace(/:/g, "");
  const baseId = `sidebar-quick-action-${instanceId}`;

  const isBusy = useCallback((key: string) => pendingKey === key, [pendingKey]);

  const handleClick = useCallback(
    async (action: QuickAction) => {
      if (action.disabled || isBusy(action.key)) return;
      const id = Date.now();
      setPendingKey(action.key);
      try {
        await action.onClick();
        setToast({ id, message: `${action.label} 요청을 처리 중입니다.` });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `${action.label} 요청을 완료할 수 없습니다.`;
        setToast({ id, message });
      } finally {
        setPendingKey(null);
      }
    },
    [isBusy],
  );

  useEffect(() => {
    if (!toast) return () => undefined;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <SidebarSection
      title="빠른 액션"
      subtitle="주요 워크플로를 바로 실행합니다"
      isOpen={isOpen}
      onToggle={onToggle}
    >
      <div className="grid grid-cols-3 gap-2">
        {actions.map((action) => {
          const busy = isBusy(action.key);
          const effectiveStatus = busy ? "running" : action.status ?? "default";
          const statusDescription = describeStatus(action.label, effectiveStatus);
          const tooltipId = action.tooltip
            ? `${baseId}-${action.key}-tooltip`
            : undefined;
          const statusId = `${baseId}-${action.key}-status`;
          const describedBy = [statusId, tooltipId]
            .filter(Boolean)
            .join(" ")
            .trim() || undefined;

          return (
            <button
              key={action.key}
              type="button"
              onClick={() => void handleClick(action)}
              disabled={action.disabled || busy}
              className={clsx(
                "flex flex-col items-center gap-1 rounded-lg border border-transparent p-2 text-center text-[11px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 focus-visible:outline-offset-2",
                action.disabled
                  ? "cursor-not-allowed text-slate-400"
                  : "text-slate-700 hover:border-indigo-200 hover:bg-indigo-50 focus-visible:border-indigo-300 focus-visible:bg-indigo-50",
              )}
              title={action.tooltip}
              aria-describedby={describedBy}
              aria-busy={busy || undefined}
              data-status={effectiveStatus}
            >
              <span
                id={statusId}
                className="sr-only"
                aria-live="polite"
                aria-atomic="true"
              >
                {statusDescription}
              </span>
              {action.tooltip ? (
                <span id={tooltipId} className="sr-only">
                  {action.tooltip}
                </span>
              ) : null}
              {(() => {
                const iconWrapperClass = clsx(
                  "relative flex h-11 w-11 items-center justify-center rounded-full border text-base transition",
                  action.disabled
                    ? "border-slate-200 bg-slate-100 text-slate-300"
                    : effectiveStatus === "running"
                      ? "border-indigo-300 bg-indigo-50 text-indigo-600"
                      : effectiveStatus === "done"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-600"
                        : "border-slate-300 bg-white text-slate-600 hover:border-indigo-300 hover:bg-indigo-50",
                );
                const iconElement = React.cloneElement(action.icon, {
                  className: clsx(
                    "h-5 w-5",
                    action.icon.props.className,
                    action.disabled
                      ? "text-slate-400"
                      : effectiveStatus === "running"
                        ? "text-indigo-600"
                        : effectiveStatus === "done"
                          ? "text-emerald-600"
                          : "text-slate-600",
                  ),
                });
                return (
                  <div className={iconWrapperClass} aria-hidden="true">
                    {iconElement}
                    {effectiveStatus === "running" ? (
                      <span
                        className="absolute top-1 right-1 h-2 w-2 animate-ping rounded-full bg-indigo-500"
                        aria-hidden="true"
                      />
                    ) : null}
                    {effectiveStatus === "done" && !action.disabled ? (
                      <span
                        className="absolute top-1 right-1 h-2 w-2 rounded-full bg-emerald-500"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                );
              })()}
              <span className="leading-tight">{action.label}</span>
              {busy ? (
                <span className="text-[10px] text-indigo-500" aria-hidden="true">
                  진행 중…
                </span>
              ) : null}
            </button>
          );
        })}
        {toast ? (
          <div
            className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {toast.message}
          </div>
        ) : null}
      </div>
    </SidebarSection>
  );
};
