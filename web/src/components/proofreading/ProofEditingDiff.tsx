interface DiffRow {
  index: number;
  origin: string;
  translation: string;
  status: "equal" | "modified" | "missing-origin" | "missing-translation";
}

interface ProofEditingDiffProps {
  rows: DiffRow[];
}

const statusClasses: Record<DiffRow["status"], string> = {
  equal: "bg-transparent text-slate-600",
  modified: "bg-amber-50 text-amber-700",
  "missing-origin": "bg-rose-50 text-rose-700",
  "missing-translation": "bg-sky-50 text-sky-700",
};

export const ProofEditingDiff = ({ rows }: ProofEditingDiffProps) => {
  if (!rows.length) {
    return (
      <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-500">
        비교할 텍스트가 없습니다.
      </div>
    );
  }

  return (
    <div className="rounded border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
        <span>Origin ↔ Translation Diff</span>
        <span>{rows.length} lines</span>
      </header>
      <div className="max-h-64 overflow-auto">
        <table className="w-full table-fixed text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="w-12 px-2 py-1 text-right">#</th>
              <th className="w-[45%] px-3 py-1 text-left">Origin</th>
              <th className="w-[45%] px-3 py-1 text-left">Translation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.index} className={statusClasses[row.status]}>
                <td className="px-2 py-1 text-right text-slate-400">
                  {row.index + 1}
                </td>
                <td className="whitespace-pre-wrap px-3 py-1 font-normal">
                  {row.origin || "⟂"}
                </td>
                <td className="whitespace-pre-wrap px-3 py-1 font-normal">
                  {row.translation || "⟂"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export type { DiffRow };
