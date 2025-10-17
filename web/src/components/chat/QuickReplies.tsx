import type { ReactNode } from "react";

export interface QuickReplyItem {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  onSelect: () => void;
}

interface QuickRepliesProps {
  items: QuickReplyItem[];
}

export const QuickReplies = ({ items }: QuickRepliesProps) => {
  if (!items.length) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="group inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus-visible:ring"
          onClick={item.onSelect}
        >
          {item.icon && (
            <span className="text-slate-400 transition group-hover:text-indigo-500">
              {item.icon}
            </span>
          )}
          <span>{item.label}</span>
          {item.description && (
            <span className="text-[11px] text-slate-400">
              {item.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};
