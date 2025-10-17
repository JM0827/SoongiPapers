interface ProjectStatusPillProps {
  status?: string | null;
}

const COLORS: Record<string, string> = {
  draft: "bg-amber-100 text-amber-700",
  active: "bg-emerald-100 text-emerald-700",
  completed: "bg-indigo-100 text-indigo-700",
};

export const ProjectStatusPill = ({ status }: ProjectStatusPillProps) => {
  if (!status) return null;
  const normalized = status.toLowerCase();
  const color = COLORS[normalized] ?? "bg-slate-200 text-slate-700";
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
};
