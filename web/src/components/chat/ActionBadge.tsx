import type { MouseEvent } from "react";

interface ActionBadgeProps {
  label: string;
  description?: string;
  tone?: "default" | "success" | "error";
  onClick?: () => void;
}

const toneStyles: Record<"default" | "success" | "error", string> = {
  default: "bg-slate-200 text-slate-700 hover:bg-slate-300",
  success: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200",
  error: "bg-rose-100 text-rose-700 hover:bg-rose-200",
};

export const ActionBadge = ({
  label,
  description,
  tone = "default",
  onClick,
}: ActionBadgeProps) => {
  const clickable = typeof onClick === "function";
  const baseClasses = `inline-flex flex-wrap items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition ${toneStyles[tone]}`;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClick?.();
  };

  if (clickable) {
    return (
      <button
        type="button"
        className={`${baseClasses} focus:outline-none focus:ring`}
        onClick={handleClick}
      >
        <span>{label}</span>
        {description && (
          <span className="text-[11px] text-slate-500">{description}</span>
        )}
      </button>
    );
  }

  return (
    <span className={baseClasses}>
      <span>{label}</span>
      {description && (
        <span className="text-[11px] text-slate-500">{description}</span>
      )}
    </span>
  );
};
