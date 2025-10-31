import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import clsx from "clsx";
import { MoreVertical } from "lucide-react";
import { FolderIcon, OpenFolderIcon } from "../icons/ProjectIcons";

import { useProjectContent } from "../../hooks/useProjectData";
import type {
  ProjectSummary,
  QualityAssessmentResultPayload,
} from "../../types/domain";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";

interface SidebarProjectButtonProps {
  project: ProjectSummary;
  active: boolean;
  onSelect: (projectId: string, projectName?: string | null) => void;
  onRename: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onComplete: () => Promise<void> | void;
}

const formatLanguageCode = (value: string | null | undefined): string => {
  if (!value) return "--";
  const trimmed = value.trim();
  if (!trimmed) return "--";
  const lower = trimmed.toLowerCase();
  const map: Record<string, string> = {
    korean: "Ko",
    english: "En",
    japanese: "Ja",
    chinese: "Zh",
    spanish: "Es",
    french: "Fr",
    german: "De",
    italian: "It",
    portuguese: "Pt",
  };
  const code = map[lower] ?? trimmed.slice(0, 2).toLowerCase();
  const [first, second] = code;
  if (!first) return "--";
  return `${first.toUpperCase()}${second ? second.toLowerCase() : ""}`;
};

const formatUpdatedLabel = (value?: string): string | null => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  const diffMs = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "Just now";
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours}h ago`;
  }
  const days = Math.floor(diffMs / day);
  return `${days}d ago`;
};

const SidebarProjectButtonComponent = ({
  project,
  active,
  onSelect,
  onRename,
  onDelete,
  onComplete,
}: SidebarProjectButtonProps) => {
  const { data: content, isLoading } = useProjectContent(project.project_id, {
    staleTime: 30_000,
  });

  const normalizedStatus = (project.status ?? "").trim().toLowerCase();
  const { locale } = useUILocale();
  const localize = useCallback(
    (
      key: string,
      fallback: string,
      params?: Record<string, string | number>,
    ) => {
      const resolved = translate(key, locale, params);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
  const originCompleted = Boolean(content?.content?.origin?.content);
  const translationCompleted = Boolean(content?.content?.translation?.content);
  const proofStage =
    content?.proofreadingStage ??
    content?.proofreading?.stage ??
    content?.proofreading?.status ??
    null;
  const proofCompleted = proofStage === "done" || proofStage === "complete";
  const qualityScore = useMemo(() => {
    type EmbeddedQA = {
      qualityAssessment?: {
        qualityResult?: QualityAssessmentResultPayload | null;
        overallScore?: number;
      } | null;
    };

    const embeddedQA =
      (content?.content as EmbeddedQA | undefined)?.qualityAssessment ?? null;
    const qa = content?.qualityAssessment ?? embeddedQA;
    const score = qa?.qualityResult?.overallScore ?? qa?.overallScore;
    return typeof score === "number" ? score : null;
  }, [content]);

  const dotCount = proofCompleted
    ? 3
    : translationCompleted
      ? 2
      : originCompleted
        ? 1
        : 0;

  const updatedLabel = formatUpdatedLabel(
    project.updated_at ?? project.created_at ?? undefined,
  );
  const directionLabel = `${formatLanguageCode(project.origin_lang)}→${formatLanguageCode(project.target_lang)}`;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const handleClickAway = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (event.target instanceof Node && menuRef.current.contains(event.target)) {
        return;
      }
      setMenuOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickAway);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickAway);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  const handleSelect = () => {
    onSelect(project.project_id, project.title ?? null);
  };

  const handleMenuAction = async (action: string) => {
    try {
      if (action === "rename") {
        await onRename();
      } else if (action === "delete") {
        await onDelete();
      } else if (action === "complete") {
        await onComplete();
      } else {
        window.alert(`'${action}' 기능은 아직 준비 중입니다.`);
      }
    } finally {
      setMenuOpen(false);
    }
  };

  const menuItems = useMemo(
    () => {
      const items: Array<
        | { type: "item"; key: string; label: string; action: string; tone?: "danger"; disabled?: boolean }
        | { type: "separator"; key: string }
      > = [
        {
          type: "item",
          key: "properties",
          label: localize(
            'sidebar_project_menu_properties',
            'Properties',
          ),
          action: "rename",
        },
        {
          type: "item",
          key: "share",
          label: localize('sidebar_project_menu_share', 'Share'),
          action: "export",
          disabled: true,
        },
        {
          type: "item",
          key: "complete",
          label:
            normalizedStatus === "completed" || normalizedStatus === "complete"
              ? localize('sidebar_project_menu_reopen', 'Reopen project')
              : localize('sidebar_project_menu_complete', 'Mark complete'),
          action: "complete",
        },
        { type: "separator", key: "separator-delete" },
        {
          type: "item",
          key: "delete",
          label: localize('sidebar_project_menu_delete', 'Delete'),
          action: "delete",
          tone: "danger",
        },
      ];
      return items;
    },
    [localize, normalizedStatus],
  );

  return (
    <div
      className={clsx(
        "group relative flex w-full items-start gap-2.5 rounded-xl pl-3 pr-2 py-0.5 text-left transition",
        active
          ? "border border-emerald-400 bg-emerald-100/90 shadow-sm"
          : "border border-transparent bg-white hover:bg-indigo-50",
      )}
    >
      <button
        type="button"
        onClick={handleSelect}
        className="flex flex-1 flex-col gap-0.5 overflow-hidden text-left"
      >
        <div className="flex w-full items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
            {active ? (
              <OpenFolderIcon size={14} className="shrink-0 text-emerald-500" />
            ) : (
              <FolderIcon size={14} className="shrink-0 text-slate-400" />
            )}
            <span
              className="min-w-0 flex-1 truncate"
              title={project.title ?? undefined}
            >
              <span
                className={clsx(
                  'text-sm font-medium',
                  active ? 'text-emerald-900' : 'text-slate-900',
                )}
              >
                {project.title || "제목 없음"}
              </span>
            </span>
          </div>
          {updatedLabel && (
            <span
              className="hidden text-xs text-slate-400 group-hover:inline"
              aria-hidden="true"
            >
              {updatedLabel}
            </span>
          )}
        </div>
        <div className="ml-5 flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className="font-mono uppercase tracking-tight text-slate-400 text-[10px]">
            {`${directionLabel.replace('→', '->')}${qualityScore !== null ? ` Q${qualityScore.toFixed(0)}` : ''}`}
          </span>
          <span className="flex items-center gap-1">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className={clsx(
                  "h-1.5 w-1.5 rounded-full transition",
                  dotCount > index
                    ? "bg-emerald-500 opacity-100"
                    : "bg-slate-300 opacity-30",
                )}
              />
            ))}
          </span>
        </div>
        {isLoading && (
          <span className="text-[11px] text-slate-400">Syncing…</span>
        )}
      </button>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          className="hidden h-8 w-8 items-center justify-center rounded-md border border-transparent text-slate-400 transition hover:border-slate-300 hover:text-slate-600 group-hover:flex"
          aria-label="프로젝트 메뉴"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-9 z-20 w-40 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {menuItems.map((item) => {
              if (item.type === "separator") {
                return (
                  <div
                    key={item.key}
                    className="my-1 border-t border-slate-200"
                    role="separator"
                  />
                );
              }

              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    void handleMenuAction(item.action);
                  }}
                  className={clsx(
                    "flex w-full items-center justify-start px-3 py-1.5 text-left text-sm transition",
                    item.disabled
                      ? "cursor-not-allowed text-slate-300"
                      : "text-slate-700 hover:bg-slate-100",
                    item.tone === "danger" &&
                      (item.disabled
                        ? "text-red-300"
                        : "text-red-600 hover:bg-red-50 hover:text-red-700"),
                  )}
                  aria-disabled={item.disabled || undefined}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export const SidebarProjectButton = memo(SidebarProjectButtonComponent);
