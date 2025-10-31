import { useRef } from "react";
import { Image, RefreshCw, Upload } from "lucide-react";

export interface CoverPreviewProps {
  t: (key: string, params?: Record<string, string | number>) => string;
  coverUrl: string | null;
  isGenerating?: boolean;
  isRegenerating?: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
  onGenerate: () => void;
  onRegenerate: () => void;
}

export function CoverPreview({
  t,
  coverUrl,
  isGenerating = false,
  isRegenerating = false,
  onUpload,
  onRemove,
  onGenerate,
  onRegenerate,
}: CoverPreviewProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onUpload(file);
    }
    event.target.value = "";
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          <span>{t("export.cover.preview.title")}</span>
          <span>
            {coverUrl
              ? t("export.cover.preview.status.custom")
              : t("export.cover.preview.status.empty")}
          </span>
        </div>
        <div className="aspect-[5/7] overflow-hidden rounded-b-xl bg-slate-100">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={t("export.cover.preview.alt")}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-400">
              <Image className="h-10 w-10" aria-hidden />
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
          aria-label={t("export.cover.actions.upload.aria")}
        />
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 shadow-sm hover:border-indigo-300 hover:text-indigo-600"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-4 w-4" aria-hidden />
          <span>{t("export.cover.actions.upload.label")}</span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 shadow-sm hover:border-indigo-300 hover:text-indigo-600"
          onClick={onGenerate}
          disabled={isGenerating}
          aria-label={t("export.cover.actions.generate.aria")}
        >
          <Image className="h-4 w-4" aria-hidden />
          <span>
            {isGenerating
              ? t("export.cover.actions.generate.loading")
              : t("export.cover.actions.generate.label")}
          </span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 shadow-sm hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onRegenerate}
          disabled={isRegenerating}
          aria-label={t("export.cover.actions.regenerate.aria")}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          <span>
            {isRegenerating
              ? t("export.cover.actions.regenerate.loading")
              : t("export.cover.actions.regenerate.label")}
          </span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 shadow-sm hover:border-rose-300 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onRemove}
          disabled={!coverUrl}
          aria-label={t("export.cover.actions.remove.aria")}
        >
          <span>{t("export.cover.actions.remove.label")}</span>
        </button>
      </div>
    </div>
  );
}
