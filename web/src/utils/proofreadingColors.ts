const palette = [
  {
    key: "emerald",
    bg: "bg-emerald-100",
    border: "border-emerald-300",
    text: "text-emerald-700",
    highlight: "bg-emerald-200/80",
    highlightClass: "proof-hl-emerald",
    highlightColor: "rgba(16, 185, 129, 0.35)",
  },
  {
    key: "sky",
    bg: "bg-sky-100",
    border: "border-sky-300",
    text: "text-sky-700",
    highlight: "bg-sky-200/80",
    highlightClass: "proof-hl-sky",
    highlightColor: "rgba(56, 189, 248, 0.35)",
  },
  {
    key: "amber",
    bg: "bg-amber-100",
    border: "border-amber-300",
    text: "text-amber-700",
    highlight: "bg-amber-200/80",
    highlightClass: "proof-hl-amber",
    highlightColor: "rgba(245, 158, 11, 0.35)",
  },
  {
    key: "rose",
    bg: "bg-rose-100",
    border: "border-rose-300",
    text: "text-rose-700",
    highlight: "bg-rose-200/80",
    highlightClass: "proof-hl-rose",
    highlightColor: "rgba(244, 63, 94, 0.30)",
  },
  {
    key: "indigo",
    bg: "bg-indigo-100",
    border: "border-indigo-300",
    text: "text-indigo-700",
    highlight: "bg-indigo-200/80",
    highlightClass: "proof-hl-indigo",
    highlightColor: "rgba(99, 102, 241, 0.30)",
  },
  {
    key: "slate",
    bg: "bg-slate-200",
    border: "border-slate-300",
    text: "text-slate-700",
    highlight: "bg-slate-300/80",
    highlightClass: "proof-hl-slate",
    highlightColor: "rgba(148, 163, 184, 0.35)",
  },
  {
    key: "purple",
    bg: "bg-purple-100",
    border: "border-purple-300",
    text: "text-purple-700",
    highlight: "bg-purple-200/80",
    highlightClass: "proof-hl-purple",
    highlightColor: "rgba(168, 85, 247, 0.30)",
  },
];

const cache = new Map<string, (typeof palette)[number]>();

export const getSubfeatureColor = (key: string) => {
  if (!key) return palette[0];
  if (cache.has(key)) return cache.get(key)!;
  const index =
    Math.abs(key.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)) %
    palette.length;
  const color = palette[index];
  cache.set(key, color);
  return color;
};

export type SubfeatureColor = ReturnType<typeof getSubfeatureColor>;
