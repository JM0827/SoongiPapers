import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, ShieldCheck } from 'lucide-react';
import type { ProjectContent } from '../../types/domain';
import { QualityPanel } from './QualityPanel';
import { useWorkflowStore } from '../../store/workflow.store';
import { useChatActionStore } from '../../store/chatAction.store';

interface QualityAssessmentDialogProps {
  open: boolean;
  onClose: () => void;
  stage?: string;
  latest?: ProjectContent['qualityAssessment'] | null;
}

export const QualityAssessmentDialog = ({
  open,
  onClose,
  stage,
  latest,
}: QualityAssessmentDialogProps) => {
  const qualityState = useWorkflowStore((state) => state.quality);
  const chatActionExecute = useChatActionStore((state) => state.execute);
  const chatExecutorReady = useChatActionStore((state) => Boolean(state.executor));
  const [localError, setLocalError] = useState<string | null>(null);

  const isRunning = qualityState.status === 'running';
  const hasAssessment = Boolean(latest);
  const errorMessage = localError ?? qualityState.lastError ?? null;

  const handleRunQuality = useCallback(async () => {
    if (isRunning) return;
    setLocalError(null);
    if (!chatExecutorReady) {
      setLocalError('품질 평가 실행 준비 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    try {
      await chatActionExecute({
        type: 'startQuality',
        allowParallel: false,
        reason: 'Run quality assessment from dialog',
      });
    } catch (error) {
      console.error('[quality-dialog] Failed to trigger quality assessment', error);
      setLocalError('품질 평가를 실행할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }
  }, [chatActionExecute, chatExecutorReady, isRunning]);

  const buttonLabel = isRunning
    ? 'Running assessment…'
    : hasAssessment
      ? 'Re-run Quality Assessment'
      : 'Run Quality Assessment';

  useEffect(() => {
    if (qualityState.status === 'running') {
      setLocalError(null);
    }
  }, [qualityState.status]);

  const buttonDisabled = isRunning || !chatExecutorReady;
  const runButtonTitle = buttonDisabled && !isRunning
    ? '품질 평가 엔진 준비 중입니다. 잠시 후 다시 시도해 주세요.'
    : undefined;

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
            <span>Quality Assessment</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRunQuality}
              disabled={buttonDisabled}
              title={runButtonTitle}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                buttonDisabled
                  ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100'
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
              aria-label="Close quality assessment"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
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
