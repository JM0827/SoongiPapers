import { useState } from 'react';
import { Loader2, ChevronDown, ChevronRight, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { useProofreadEditorContext } from '../../context/proofreadEditor';
import { DualEditorPanel } from './DualEditorPanel';
import { ProofreadIssueTray } from './ProofreadIssueTray';
import { ProofreadActivityFeed } from './ProofreadActivityFeed';

const formatSegmentLabel = (index: number) =>
  `Segment ${String(index + 1).padStart(3, '0')}`;

interface SegmentNavigatorProps {
  isCollapsed: boolean;
  onToggleSidebar: () => void;
}

const SegmentNavigator = ({ isCollapsed, onToggleSidebar }: SegmentNavigatorProps) => {
  const {
    segments,
    collapsedSegmentIds,
    selectedSegmentId,
    dirtySegments,
    toggleSegmentCollapse,
    selectSegment,
  } = useProofreadEditorContext();

  if (isCollapsed) {
    return (
      <div className="flex h-full items-start justify-start p-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-2 text-xs font-medium text-slate-600 shadow-sm transition hover:bg-slate-100"
          aria-expanded={!isCollapsed}
          aria-controls="proofread-editor-sidebar"
          aria-label="Show segments"
          title="Show segments"
        >
          <PanelLeftOpen className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden pt-4 pl-2">
      <div className="flex-1 overflow-hidden rounded border border-slate-200 bg-white">
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Segments</h2>
            <p className="text-xs text-slate-500">{segments.length} items</p>
          </div>
          <button
            type="button"
            onClick={onToggleSidebar}
            className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100"
            aria-expanded={!isCollapsed}
            aria-controls="proofread-editor-sidebar"
            aria-label="Hide segments"
            title="Hide segments"
          >
            <PanelLeftClose className="h-5 w-5" />
          </button>
        </header>
        <ul className="flex flex-1 flex-col divide-y divide-slate-100 overflow-y-auto text-sm text-slate-600">
        {segments.map((segment) => {
          const isSelected = segment.segmentId === selectedSegmentId;
          const isCollapsed = collapsedSegmentIds[segment.segmentId] ?? false;
          const isDirty = Boolean(dirtySegments[segment.segmentId]);
          const handleSelect = () => selectSegment(segment.segmentId);
          const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleSelect();
            }
          };
          return (
            <li key={segment.segmentId}>
              <div
                role="button"
                tabIndex={0}
                onClick={handleSelect}
                onKeyDown={handleKeyDown}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200 ${
                  isSelected ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
                    <span>{formatSegmentLabel(segment.segmentIndex)}</span>
                    {isDirty && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                        Unsaved
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSegmentCollapse(segment.segmentId);
                  }}
                  className="rounded p-1 text-slate-400 transition hover:bg-slate-100"
                  aria-label={isCollapsed ? 'Expand segment' : 'Collapse segment'}
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex-1 min-h-0">
            <ProofreadIssueTray />
          </div>
          <ProofreadActivityFeed />
        </div>
      </div>
    </div>
  );
};

export const ProofreadEditorTab = () => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [showOriginNotice, setShowOriginNotice] = useState(true);
  const {
    dataset,
    isLoading,
    isSaving,
    error,
    clearError,
    conflict,
    resolveConflict,
    retryConflict,
    featureToggles,
  } = useProofreadEditorContext();

  return (
    <div
      className={`grid h-full w-full ${isSidebarCollapsed ? 'gap-2' : 'gap-4'} overflow-hidden`}
      style={{
        gridTemplateColumns: isSidebarCollapsed
          ? 'max-content 1fr'
          : 'minmax(12rem,16rem) 1fr',
      }}
    >
      <div id="proofread-editor-sidebar" className="flex h-full flex-col">
        <SegmentNavigator
          isCollapsed={isSidebarCollapsed}
          onToggleSidebar={() => setIsSidebarCollapsed((current) => !current)}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden">
        {conflict && (
          <div className="flex items-start justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <div className="flex-1">
              <p className="font-semibold">편집 충돌이 발생했습니다.</p>
              <p className="text-xs text-amber-700">{conflict.message}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void resolveConflict();
                }}
                className="rounded border border-amber-400 bg-white px-3 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
              >
                서버 버전 사용
              </button>
              <button
                type="button"
                onClick={() => {
                  void retryConflict();
                }}
                className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-white transition hover:bg-amber-600"
              >
                내 변경 다시 저장
              </button>
            </div>
          </div>
        )}
        {error && !conflict && dataset && (
          <div className="flex items-start justify-between gap-3 rounded border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <p className="flex-1 text-xs">{error}</p>
            <button
              type="button"
              onClick={clearError}
              className="rounded border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-100"
            >
              닫기
            </button>
          </div>
        )}
        {featureToggles.originOnly && showOriginNotice && (
          <div className="flex items-start justify-between gap-3 rounded border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <p className="flex-1">
              번역본이 아직 생성되지 않아 원문만 표시됩니다. 번역이 완료되면 자동으로 편집 기능이 활성화됩니다.
            </p>
            <button
              type="button"
              onClick={() => setShowOriginNotice(false)}
              className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-slate-100"
              aria-label="닫기"
            >
              닫기
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-slate-500">
          {isLoading && (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
            </span>
          )}
          {isSaving && <span className="text-indigo-600">Saving…</span>}
          {error && dataset && (
            <span className="rounded border border-rose-200 bg-rose-50 px-3 py-1 text-rose-600">
              {error}
            </span>
          )}
        </div>
        <div className="flex h-full min-h-[24rem] flex-1 items-stretch overflow-hidden">
          <DualEditorPanel />
        </div>
      </div>
    </div>
  );
};
