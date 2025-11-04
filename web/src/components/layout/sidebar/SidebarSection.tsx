import { ChevronDown, ChevronUp } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

interface SidebarSectionProps {
  title: string;
  subtitle?: string;
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
  action?: ReactNode;
}

export const SidebarSection = ({
  title,
  subtitle,
  isOpen,
  onToggle,
  children,
  action,
}: SidebarSectionProps) => {
  const rawId = useId().replace(/:/g, "");
  const headerId = `sidebar-section-${rawId}-header`;
  const contentId = `sidebar-section-${rawId}-content`;

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white shadow-sm"
      aria-labelledby={headerId}
    >
      <header
        className="flex items-start justify-between gap-3 px-3 py-2"
        id={headerId}
      >
        <div className="flex flex-1 flex-col">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md text-left text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 focus-visible:outline-offset-2"
            onClick={() => onToggle(!isOpen)}
            aria-expanded={isOpen}
            aria-controls={contentId}
          >
            <span className="text-sm font-semibold">{title}</span>
            {isOpen ? (
              <ChevronUp className="h-4 w-4 text-slate-500" aria-hidden />
            ) : (
              <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden />
            )}
          </button>
          {subtitle ? (
            <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {action ? (
          <div className="pt-0.5" data-sidebar-action>
            {action}
          </div>
        ) : null}
      </header>
      {isOpen ? (
        <div
          id={contentId}
          role="region"
          aria-labelledby={headerId}
          className="border-t border-slate-100 px-3 py-2 text-sm text-slate-700"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
};
