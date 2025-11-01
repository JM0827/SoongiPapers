import {
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  handleKeyboardToggle,
  isEventFromInteractive,
} from "./collapsibleUtils";

export interface CollapsibleProps {
  title: string;
  titleAdornment?: ReactNode;
  caption?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  action?: ReactNode;
  showDivider?: boolean;
  keepMounted?: boolean;
}

export const Collapsible = ({
  title,
  titleAdornment,
  caption,
  isOpen,
  onToggle,
  children,
  action,
  showDivider = true,
  keepMounted = false,
}: CollapsibleProps) => {
  const handleHeaderClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isEventFromInteractive(event.target)) {
      return;
    }
    onToggle();
  };

  const handleHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEventFromInteractive(event.target)) {
      return;
    }
    handleKeyboardToggle(event, onToggle);
  };

  const bodyClassName = showDivider
    ? "mt-4 border-t border-slate-200 pt-4"
    : "mt-0 pt-0";

  return (
    <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div
          className="flex flex-1 cursor-pointer flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKeyDown}
        >
          <div className="flex items-center gap-2">
            {titleAdornment ? (
              <span className="flex items-center" aria-hidden="true">
                {titleAdornment}
              </span>
            ) : null}
            <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
            {action ? <span data-collapsible-ignore>{action}</span> : null}
          </div>
          {caption ? <p className="text-xs text-slate-500">{caption}</p> : null}
        </div>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-xs text-slate-500 transition hover:bg-slate-100"
          onClick={onToggle}
          aria-label={isOpen ? `${title} 접기` : `${title} 펼치기`}
          data-collapsible-ignore
        >
          {isOpen ? "˄" : "˅"}
        </button>
      </header>
      {keepMounted ? (
        <div className={isOpen ? bodyClassName : "hidden"}>{children}</div>
      ) : (
        isOpen && <div className={bodyClassName}>{children}</div>
      )}
    </section>
  );
};
