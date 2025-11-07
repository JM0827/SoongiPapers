import { useMemo, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  Play,
} from "lucide-react";
import {
  type GenerationFormat,
  type GenerationProgressChip,
  type TranslationSummary,
  langToCode,
} from "./ebookTypes";
import type { Readiness } from "../../lib/ebook/readiness";
import { mapGenerationError, type BackendErrorCode } from "./errorMap";

interface ExportEssentialsCardProps {
  t: (key: string, params?: Record<string, string | number>) => string;
  readiness: Readiness;
  buildState: "idle" | "running" | "done" | "error";
  buildPercent: number;
  progress: GenerationProgressChip[];
  translation: TranslationSummary;
  wantPDF: boolean;
  wantEPUB: boolean;
  profileSection?: ReactNode;
  onOpenTranslation: () => void;
  onToggleFormat: (format: GenerationFormat, value: boolean) => void;
  onGenerate: () => void;
  generationDisabled: boolean;
  errorCode?: BackendErrorCode;
  errorMessage?: string | null;
  onDownload?: () => void;
  downloadDisabled?: boolean;
  downloadLabel?: string;
  downloadLoading?: boolean;
  downloadError?: string | null;
}

const progressIcon = {
  pending: <Circle className="h-3 w-3 text-slate-300" aria-hidden />,
  running: (
    <Loader2 className="h-3 w-3 animate-spin text-indigo-500" aria-hidden />
  ),
  done: <Check className="h-3 w-3 text-emerald-500" aria-hidden />,
  error: <AlertTriangle className="h-3 w-3 text-rose-500" aria-hidden />,
};

export function ExportEssentialsCard({
  t,
  readiness,
  buildState: _buildState,
  buildPercent: _buildPercent,
  progress,
  translation,
  wantPDF,
  wantEPUB,
  profileSection,
  onOpenTranslation,
  onToggleFormat,
  onGenerate,
  generationDisabled,
  errorCode,
  errorMessage,
  onDownload,
  downloadDisabled,
  downloadLabel,
  downloadLoading,
  downloadError,
}: ExportEssentialsCardProps) {
  const missingSet = useMemo(() => {
    const entries = new Set<string>();
    readiness.epub.missing.forEach((value) => entries.add(value));
    readiness.pdf.missing.forEach((value) => entries.add(value));
    return entries;
  }, [readiness.epub.missing, readiness.pdf.missing]);

  const translationReady = translation.exists;
  const translationBadge = translationReady
    ? t("export.essentials.translation.ready", {
        code: langToCode(translation.targetLang),
      })
    : t("export.essentials.translation.missing", {
        code: langToCode(translation.targetLang),
      });

  const translationStatusBadge = (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        translationReady
          ? "bg-emerald-50 text-emerald-700"
          : "bg-rose-50 text-rose-600"
      }`}
      aria-live="polite"
    >
      {translationBadge}
    </span>
  );

  const displayError = useMemo(() => {
    if (!errorCode && !errorMessage) return null;
    const mapped = mapGenerationError(errorCode);
    return {
      title: errorMessage ?? mapped.title,
      message: mapped.message,
    };
  }, [errorCode, errorMessage]);

  const progressLabel = (chip: GenerationProgressChip) =>
    t(`export.essentials.progress.${chip.status}`, {
      format: chip.format.toUpperCase(),
    });

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-slate-100 p-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-800">
            {t("export.essentials.title")}
          </h2>
          <p className="text-sm text-slate-500">
            {t("export.essentials.description")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
            onClick={onGenerate}
            disabled={generationDisabled}
            aria-label={t("export.essentials.generate.aria")}
          >
            <Play className="h-4 w-4" aria-hidden />
            <span>{t("export.essentials.generate.label")}</span>
          </button>
          <div className="flex flex-wrap justify-end gap-2">
            {progress.map((chip) => (
              <span
                key={chip.format}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 text-[11px] text-slate-600"
              >
                {progressIcon[chip.status]}
                <span>{progressLabel(chip)}</span>
              </span>
            ))}
          </div>
          {onDownload && (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 shadow-sm hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={onDownload}
              disabled={downloadDisabled}
              aria-label={t("export.essentials.download.aria")}
            >
              {downloadLoading && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              )}
              <span>
                {downloadLabel ?? t("export.essentials.download.label")}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="space-y-6 p-4">
        <section className="space-y-3">
          <div
            className={`rounded-xl border p-4 ${
              missingSet.has("translation") && !translationReady
                ? "border-rose-300"
                : "border-slate-200"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-slate-700">
                {t("export.essentials.translation.pick")}
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                onClick={onOpenTranslation}
                aria-label={t("export.essentials.translation.open")}
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                <span>{t("export.essentials.translation.open")}</span>
              </button>
            </div>
            <div className="mt-3 space-y-1 text-xs text-slate-500">
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    {t("export.essentials.translation.detail")}
                  </span>
                  {translation.targetLang && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {translation.targetLang}
                    </span>
                  )}
                  {typeof translation.qaScore === "number" && (
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-600">
                      {t("export.essentials.translation.score", {
                        score: translation.qaScore.toFixed(1),
                      })}
                    </span>
                  )}
                </div>
                {translationStatusBadge}
              </div>
              <div className="text-[11px] text-slate-500">
                {translation.id ? (
                  <span>
                    {t("export.essentials.translation.id", {
                      id: translation.id,
                    })}
                  </span>
                ) : (
                  <span>{t("export.essentials.translation.id.missing")}</span>
                )}
              </div>
            </div>
          </div>
        </section>

        {profileSection ? <div className="space-y-4">{profileSection}</div> : null}

        {missingSet.has("rightsAccepted") && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
            {t("export.essentials.rights.description")}
          </div>
        )}

        <section className="flex flex-col gap-4 md:flex-row">
          <div className="flex-1 rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-700">
              {t("export.essentials.format.title")}
            </p>
            <div className="mt-3 space-y-2">
              <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-indigo-300">
                <span>{t("export.essentials.format.pdf")}</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  checked={wantPDF}
                  onChange={(event) =>
                    onToggleFormat("pdf", event.target.checked)
                  }
                  aria-label={t("export.essentials.format.pdf.aria")}
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-indigo-300">
                <span>{t("export.essentials.format.epub")}</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  checked={wantEPUB}
                  onChange={(event) =>
                    onToggleFormat("epub", event.target.checked)
                  }
                  aria-label={t("export.essentials.format.epub.aria")}
                />
              </label>
            </div>
          </div>
        </section>

        {displayError && (
          <div
            className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
            role="alert"
          >
            <AlertCircle className="h-5 w-5" aria-hidden />
            <div>
              <p className="font-semibold">{displayError.title}</p>
              <p className="text-xs text-rose-600">{displayError.message}</p>
            </div>
          </div>
        )}
        {downloadError && (
          <div
            className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700"
            role="alert"
          >
            {downloadError}
          </div>
        )}
      </div>
    </div>
  );
}
