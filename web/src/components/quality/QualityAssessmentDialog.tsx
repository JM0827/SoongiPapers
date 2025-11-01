import { useCallback, useEffect, useState } from "react";
import { X, Loader2, ShieldCheck } from "lucide-react";
import type { ProjectContent } from "../../types/domain";
import { QualityPanel } from "./QualityPanel";
import { useWorkflowStore } from "../../store/workflow.store";
import { useChatActionStore } from "../../store/chatAction.store";
import { useUILocale } from "../../hooks/useUILocale";
import { translate } from "../../lib/locale";

interface QualityAssessmentDialogProps {
  open: boolean;
  onClose: () => void;
  stage?: string;
  latest?: ProjectContent["qualityAssessment"] | null;
}

export const QualityAssessmentDialog = ({
  open,
  onClose,
  stage,
  latest,
}: QualityAssessmentDialogProps) => {
  const qualityState = useWorkflowStore((state) => state.quality);
  const chatActionExecute = useChatActionStore((state) => state.execute);
  const chatExecutorReady = useChatActionStore((state) =>
    Boolean(state.executor),
  );
  const [localError, setLocalError] = useState<string | null>(null);
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

  const isRunning = qualityState.status === "running";
  const hasAssessment = Boolean(latest);
  const errorMessage = localError ?? qualityState.lastError ?? null;
  const dialogTitle = localize("quality_dialog_title", "Quality Assessment");
  const runInitialLabel = localize(
    "quality_dialog_run_initial",
    "Run Quality Assessment",
  );
  const runRerunLabel = localize(
    "quality_dialog_run_rerun",
    "Re-run Quality Assessment",
  );
  const runRunningLabel = localize(
    "quality_dialog_run_running",
    "Running assessment…",
  );
  const closeLabel = localize(
    "quality_dialog_close_label",
    "Close quality assessment",
  );
  const pendingMessage = localize(
    "quality_dialog_run_pending",
    "Quality assessment is still initializing. Please try again shortly.",
  );
  const unavailableTooltip = localize(
    "quality_dialog_run_unavailable",
    "The quality assessment engine is preparing. Please try again shortly.",
  );
  const genericErrorMessage = localize(
    "quality_dialog_run_error",
    "Unable to start quality assessment. Please try again shortly.",
  );

  const handleRunQuality = useCallback(async () => {
    if (isRunning) return;
    setLocalError(null);
    if (!chatExecutorReady) {
      setLocalError(pendingMessage);
      return;
    }
    try {
      await chatActionExecute({
        type: "startQuality",
        allowParallel: false,
        reason: "Run quality assessment from dialog",
      });
    } catch (error) {
      console.error(
        "[quality-dialog] Failed to trigger quality assessment",
        error,
      );
      setLocalError(genericErrorMessage);
    }
  }, [
    chatActionExecute,
    chatExecutorReady,
    genericErrorMessage,
    isRunning,
    pendingMessage,
  ]);

  const buttonLabel = isRunning
    ? runRunningLabel
    : hasAssessment
      ? runRerunLabel
      : runInitialLabel;

  useEffect(() => {
    if (qualityState.status === "running") {
      setLocalError(null);
    }
  }, [qualityState.status]);

  const buttonDisabled = isRunning || !chatExecutorReady;
  const runButtonTitle =
    buttonDisabled && !isRunning ? unavailableTooltip : undefined;
  const progressPercent = qualityState.chunksTotal
    ? Math.min(
        100,
        Math.round(
          (qualityState.chunksCompleted /
            Math.max(qualityState.chunksTotal, 1)) *
            100,
        ),
      )
    : isRunning
      ? 5
      : 0;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-900/50 px-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-col gap-4 border-b border-slate-200 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <span>{dialogTitle}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRunQuality}
              disabled={buttonDisabled}
              title={runButtonTitle}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                buttonDisabled
                  ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100"
              }`}
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              <span>{buttonLabel}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
              aria-label={closeLabel}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        {isRunning && (
          <div className="px-6 pb-3 text-xs text-slate-600">
            <div className="mb-2 flex items-center justify-between">
              <span>
                {qualityState.chunksTotal
                  ? `청크 ${Math.min(
                      qualityState.chunksCompleted + 1,
                      qualityState.chunksTotal,
                    )}/${qualityState.chunksTotal} 평가 중…`
                  : "청크 준비 중…"}
              </span>
              {qualityState.chunksTotal ? (
                <span className="text-[11px] text-slate-400">
                  {qualityState.chunksCompleted}/{qualityState.chunksTotal}
                </span>
              ) : null}
            </div>
            <div className="h-2 rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {qualityState.lastMessage && (
              <p className="mt-2 text-[11px] text-slate-500">
                {qualityState.lastMessage}
              </p>
            )}
          </div>
        )}
        {errorMessage && (
          <p className="px-6 pt-3 text-xs text-rose-600">{errorMessage}</p>
        )}
        <div className="max-h-[calc(90vh-6rem)] overflow-y-auto">
          <QualityPanel stage={stage} latest={latest ?? null} />
        </div>
      </div>
    </div>
  );
};
