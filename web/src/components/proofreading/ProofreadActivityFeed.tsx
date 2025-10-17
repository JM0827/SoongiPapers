import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  useWorkflowStore,
  type ProofreadingAgentState,
} from '../../store/workflow.store';

const formatTimestamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatRelativeTime = (value: string | null) => {
  if (!value) return '기록 없음';
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return '알 수 없음';
  const diff = Date.now() - ts;
  if (diff < 0) return '방금 전';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 전`;
};

const statusLabel = (status: string) => {
  switch (status) {
    case 'queued':
      return '대기 중';
    case 'running':
      return '진행 중';
    case 'done':
      return '완료';
    case 'failed':
      return '실패';
    default:
      return '대기';
  }
};

const stageTone = (status?: string) => {
  switch (status) {
    case 'done':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'in_progress':
    default:
      return 'border-slate-200 bg-slate-50 text-slate-500';
  }
};

const EVENT_TYPE_TONE: Record<string, string> = {
  queued: 'bg-slate-200 text-slate-600',
  workflow: 'bg-slate-200 text-slate-600',
  progress: 'bg-indigo-100 text-indigo-700',
  stage: 'bg-indigo-50 text-indigo-600',
  heartbeat: 'bg-slate-100 text-slate-600',
  duplicate: 'bg-amber-100 text-amber-700',
  tier_complete: 'bg-emerald-100 text-emerald-700',
  complete: 'bg-emerald-200 text-emerald-800',
  error: 'bg-rose-100 text-rose-700',
  stalled: 'bg-rose-100 text-rose-700',
  resumed: 'bg-emerald-100 text-emerald-700',
};

const formatEventLabel = (value: string) =>
  value
    .replace(/_/g, ' ')
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const resolveEventTone = (type: string) =>
  EVENT_TYPE_TONE[type] ?? 'bg-slate-100 text-slate-600';

const formatMetaValue = (value: unknown) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  return String(value);
};

type ActivityEntry = ProofreadingAgentState['activityLog'][number];

export const ProofreadActivityFeed = () => {
  const proofreading = useWorkflowStore((state) => state.proofreading);
  const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const entries = useMemo(() => {
    const list = proofreading.activityLog ?? [];
    return [...list].reverse();
  }, [proofreading.activityLog]);

  const stageStatuses = useMemo(() => proofreading.stageStatuses ?? [], [proofreading.stageStatuses]);
  const tierSummaries = useMemo(() => proofreading.tierSummaries ?? {}, [proofreading.tierSummaries]);
  const completionSummary = proofreading.completionSummary;
  const completionNotes =
    completionSummary?.notesKo ?? completionSummary?.notesEn ?? null;

  const lastUpdatedLabel = formatRelativeTime(proofreading.lastHeartbeatAt);

  const handleCopy = useCallback(async (entry: ActivityEntry) => {
    const payload = {
      id: entry.id,
      type: entry.type,
      message: entry.message,
      timestamp: entry.timestamp,
      meta: entry.meta ?? null,
    };
    const serialized = JSON.stringify(payload, null, 2);
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(serialized);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = serialized;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      } else {
        throw new Error('Clipboard API not available');
      }
      setCopyError(null);
      setCopiedEntryId(entry.id);
    } catch (err) {
      setCopiedEntryId(null);
      setCopyError(
        err instanceof Error ? err.message : '복사에 실패했습니다.',
      );
    }
  }, []);

  useEffect(() => {
    if (!copiedEntryId) return;
    const timer = window.setTimeout(() => {
      setCopiedEntryId(null);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [copiedEntryId]);

  useEffect(() => {
    if (!copyError) return;
    const timer = window.setTimeout(() => {
      setCopyError(null);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [copyError]);

  return (
    <div className="rounded border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Activity Feed</h3>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span className="rounded-full border border-slate-200 px-2 py-0.5">
              {statusLabel(proofreading.status)}
            </span>
            <span>최근 업데이트 {lastUpdatedLabel}</span>
            {proofreading.isStalled && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-600">
                ⚠️ 진행 지연 감지
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-3 px-4 py-3 text-xs text-slate-600">
        {copyError && (
          <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            {copyError}
          </p>
        )}
        {stageStatuses.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {stageStatuses.map((stage) => (
              <span
                key={`${stage.tier ?? 'tier'}:${stage.key ?? stage.label ?? 'stage'}`}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${stageTone(stage.status)}`}
              >
                {stage.label ?? stage.key ?? stage.tier ?? '단계'}
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {stage.status === 'done'
                    ? 'done'
                    : stage.status === 'error'
                    ? 'error'
                    : 'running'}
                </span>
              </span>
            ))}
          </div>
        )}

        {Object.keys(tierSummaries).length > 0 && (
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            <p className="font-medium text-slate-700">티어 요약</p>
            <ul className="mt-1 flex flex-wrap gap-3">
              {Object.entries(tierSummaries).map(([tier, info]) => (
                <li key={tier} className="flex items-center gap-2">
                  <span className="rounded bg-white px-2 py-0.5 font-semibold uppercase text-slate-500">
                    {tier}
                  </span>
                  <span className="text-slate-500">
                    {info.itemCount}건 · {formatRelativeTime(info.completedAt)} 완료
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {completionSummary && (
          <div className="rounded border border-slate-200 bg-emerald-50 px-3 py-3 text-[11px] text-emerald-700">
            <p className="text-sm font-semibold text-emerald-800">교정 요약</p>
            <p className="mt-1">총 이슈 {completionSummary.totalIssues}건</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(completionSummary.tierIssueCounts)
                .filter(([, count]) => count > 0)
                .map(([tier, count]) => (
                  <span key={tier} className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">
                    {tier}: {count}건
                  </span>
                ))}
            </div>
            {Object.keys(completionSummary.countsBySubfeature).length > 0 && (
              <div className="mt-2 grid gap-1 text-slate-600">
                {Object.entries(completionSummary.countsBySubfeature)
                  .slice(0, 4)
                  .map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-700">{key}</span>
                      <span>{value}건</span>
                    </div>
                  ))}
              </div>
            )}
            {completionNotes && (
              <p className="mt-2 text-slate-500">{completionNotes}</p>
            )}
          </div>
        )}

        <div className="max-h-48 overflow-y-auto">
          {entries.length === 0 ? (
            <p className="text-slate-500">아직 기록된 이벤트가 없습니다.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry) => {
                const metaEntries = entry.meta
                  ? Object.entries(entry.meta).filter(([, value]) => value !== undefined)
                  : [];
                const toneClass = resolveEventTone(entry.type);
                return (
                  <li
                    key={entry.id}
                    className="space-y-2 rounded border border-slate-100 bg-slate-50 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-700">
                        {entry.message}
                      </span>
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${toneClass}`}
                        >
                          {formatEventLabel(entry.type)}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                      </div>
                    </div>
                    {metaEntries.length > 0 && (
                      <div className="flex flex-wrap gap-2 text-[10px] text-slate-500">
                        {metaEntries.map(([key, value]) => (
                          <span
                            key={`${entry.id}-${key}`}
                            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5"
                          >
                            <span className="font-semibold text-slate-600">
                              {key}
                            </span>
                            <span>{formatMetaValue(value)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-[10px]">
                      <button
                        type="button"
                        onClick={() => {
                          void handleCopy(entry);
                        }}
                        className="rounded border border-slate-300 bg-white px-2 py-1 font-medium text-slate-600 transition hover:bg-slate-100"
                      >
                        Diagnostics 복사
                      </button>
                      {copiedEntryId === entry.id && (
                        <span className="text-emerald-600">복사 완료</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
