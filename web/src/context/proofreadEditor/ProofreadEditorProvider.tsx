import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type PropsWithChildren,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import {
  proofreadEditorKeys,
  useProofreadEditorDataset,
} from '../../hooks/useProofreadEditorDataset';
import type {
  ProofreadEditorDatasetSummary,
  ProofreadEditorIssueEntry,
  ProofreadEditorPatchPayload,
  ProofreadEditorPatchResponse,
  ProofreadEditorResponse,
  ProofreadEditorSegmentPayload,
  ProofreadEditorConflictResponse,
  ProofreadEditorStreamEvent,
  ProofreadEditorVersions,
} from '../../types/domain';

interface SegmentState {
  segmentId: string;
  segmentIndex: number;
  originText: string;
  originLastSavedAt: string | null;
  translationText: string;
  translationLastSavedAt: string | null;
  issues: string[];
  spans: Array<{ issueId: string; start: number; end: number }>;
}

interface ProofreadEditorConflictState {
  message: string;
  documentVersion: string | null;
  updates: ProofreadEditorPatchPayload['segments'];
  serverSegments?: ProofreadEditorSegmentPayload[];
}

interface ProofreadEditorState {
  dataset: ProofreadEditorDatasetSummary | null;
  versions: ProofreadEditorVersions | null;
  segmentsById: Record<string, SegmentState>;
  orderedSegmentIds: string[];
  collapsedSegmentIds: Record<string, boolean>;
  selectedSegmentId: string | null;
  editorRatio: number;
  dirtySegments: Record<string, { origin?: string; translation?: string }>;
  issues: ProofreadEditorIssueEntry[];
  issueAssignments: Record<string, string[]>;
  activeIssueId: string | null;
  conflict: ProofreadEditorConflictState | null;
  isSaving: boolean;
  lastError: string | null;
  featureToggles: Record<string, boolean>;
  lastSavedAt: string | null;
}

const initialState: ProofreadEditorState = {
  dataset: null,
  versions: null,
  segmentsById: {},
  orderedSegmentIds: [],
  collapsedSegmentIds: {},
  selectedSegmentId: null,
  editorRatio: 0.5,
  dirtySegments: {},
  issues: [],
  issueAssignments: {},
  activeIssueId: null,
  conflict: null,
  isSaving: false,
  lastError: null,
  featureToggles: {},
  lastSavedAt: null,
};

const mapSegments = (segments: ProofreadEditorSegmentPayload[]) => {
  const segmentsById: Record<string, SegmentState> = {};
  const orderedIds: string[] = [];
  segments
    .slice()
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
    .forEach((segment) => {
      const segmentId = segment.segmentId;
      segmentsById[segmentId] = {
        segmentId,
        segmentIndex: segment.segmentIndex,
        originText: segment.origin.text,
        originLastSavedAt: segment.origin.lastSavedAt ?? null,
        translationText: segment.translation.text,
        translationLastSavedAt: segment.translation.lastSavedAt ?? null,
        issues: segment.issues ?? [],
        spans: segment.spans ?? [],
      };
      orderedIds.push(segmentId);
    });
  return { segmentsById, orderedIds };
};

const clampRatio = (value: number) => Math.min(0.9, Math.max(0.1, value));

type Action =
  | { type: 'LOAD_SUCCESS'; payload: ProofreadEditorResponse }
  | { type: 'SELECT_SEGMENT'; segmentId: string | null }
  | { type: 'TOGGLE_COLLAPSE'; segmentId: string }
  | { type: 'SET_EDITOR_RATIO'; ratio: number }
  | {
      type: 'EDIT_SEGMENT';
      segmentId: string;
      column: 'origin' | 'translation';
      text: string;
    }
  | { type: 'SAVE_START' }
  | { type: 'SAVE_SUCCESS'; payload: ProofreadEditorPatchResponse }
  | {
      type: 'SAVE_CONFLICT';
      conflict: ProofreadEditorConflictResponse;
      updates: ProofreadEditorPatchPayload['segments'];
    }
  | { type: 'SAVE_ERROR'; message: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SELECT_ISSUE'; issueId: string | null }
  | { type: 'CLEAR_CONFLICT' }
  | { type: 'CLEAR_DATASET' };

const reducer = (state: ProofreadEditorState, action: Action): ProofreadEditorState => {
  switch (action.type) {
    case 'LOAD_SUCCESS': {
      const {
        dataset,
        segments,
        versions,
        issues,
        issueAssignments,
        featureToggles,
      } = action.payload;
      const mapped = mapSegments(segments);
      const collapsed: Record<string, boolean> = {};
      mapped.orderedIds.forEach((segmentId) => {
        collapsed[segmentId] = state.collapsedSegmentIds[segmentId] ?? false;
      });
      const selectedSegmentId = mapped.orderedIds.includes(state.selectedSegmentId ?? '')
        ? state.selectedSegmentId
        : mapped.orderedIds[0] ?? null;
      const nextActiveIssueId = selectedSegmentId
        ? issueAssignments[selectedSegmentId]?.[0] ?? null
        : null;
      return {
        ...state,
        dataset,
        versions,
        segmentsById: mapped.segmentsById,
        orderedSegmentIds: mapped.orderedIds,
        collapsedSegmentIds: collapsed,
        selectedSegmentId,
        dirtySegments: {},
        issues,
        issueAssignments,
        activeIssueId: nextActiveIssueId,
        conflict: null,
        isSaving: false,
        lastError: null,
        featureToggles: featureToggles ?? {},
        lastSavedAt: new Date().toISOString(),
      };
    }
    case 'SELECT_SEGMENT': {
      if (!action.segmentId) {
        return { ...state, selectedSegmentId: null, activeIssueId: null };
      }
      if (!state.segmentsById[action.segmentId]) {
        return state;
      }
      const issueIds = state.issueAssignments[action.segmentId] ?? [];
      const nextIssueId = issueIds.includes(state.activeIssueId ?? '')
        ? state.activeIssueId
        : issueIds[0] ?? null;
      return {
        ...state,
        selectedSegmentId: action.segmentId,
        activeIssueId: nextIssueId,
      };
    }
    case 'TOGGLE_COLLAPSE': {
      if (!state.segmentsById[action.segmentId]) {
        return state;
      }
      const next = { ...state.collapsedSegmentIds };
      next[action.segmentId] = !next[action.segmentId];
      return { ...state, collapsedSegmentIds: next };
    }
    case 'SET_EDITOR_RATIO': {
      return { ...state, editorRatio: clampRatio(action.ratio) };
    }
    case 'EDIT_SEGMENT': {
      const target = state.segmentsById[action.segmentId];
      if (!target) return state;
      const updated: SegmentState =
        action.column === 'origin'
          ? { ...target, originText: action.text }
          : { ...target, translationText: action.text };
      return {
        ...state,
        segmentsById: {
          ...state.segmentsById,
          [action.segmentId]: updated,
        },
        dirtySegments: {
          ...state.dirtySegments,
          [action.segmentId]: {
            ...state.dirtySegments[action.segmentId],
            [action.column]: action.text,
          },
        },
      };
    }
    case 'SAVE_START': {
      return { ...state, isSaving: true, lastError: null };
    }
    case 'SAVE_SUCCESS': {
      const { dataset, segments, versions, issues, issueAssignments, featureToggles } =
        action.payload;
      const mapped = mapSegments(segments);
      const collapsed: Record<string, boolean> = {};
      mapped.orderedIds.forEach((segmentId) => {
        collapsed[segmentId] = state.collapsedSegmentIds[segmentId] ?? false;
      });
      const selectedSegmentId = mapped.orderedIds.includes(state.selectedSegmentId ?? '')
        ? state.selectedSegmentId
        : mapped.orderedIds[0] ?? null;
      const nextActiveIssueId = selectedSegmentId
        ? issueAssignments[selectedSegmentId]?.[0] ?? null
        : null;
      return {
        ...state,
        dataset,
        versions,
        segmentsById: mapped.segmentsById,
        orderedSegmentIds: mapped.orderedIds,
        collapsedSegmentIds: collapsed,
        selectedSegmentId,
        dirtySegments: {},
        issues,
        issueAssignments,
        activeIssueId: nextActiveIssueId,
        conflict: null,
        isSaving: false,
        lastError: null,
        featureToggles: featureToggles ?? {},
      };
    }
    case 'SAVE_CONFLICT': {
      const { conflict, updates } = action;
      const conflictState: ProofreadEditorConflictState = {
        message:
          conflict.message ?? '서버와 충돌이 발생했습니다. 다시 시도해 주세요.',
        documentVersion: conflict.documentVersion ?? null,
        updates,
        serverSegments: conflict.serverSegments,
      };
      return {
        ...state,
        isSaving: false,
        conflict: conflictState,
        lastError: conflictState.message,
        lastSavedAt: state.lastSavedAt,
      };
    }
    case 'SAVE_ERROR': {
      return {
        ...state,
        isSaving: false,
        lastError: action.message,
      };
    }
    case 'CLEAR_ERROR': {
      return { ...state, lastError: null };
    }
    case 'SELECT_ISSUE': {
      return { ...state, activeIssueId: action.issueId };
    }
    case 'CLEAR_CONFLICT': {
      return { ...state, conflict: null, lastError: null };
    }
    case 'CLEAR_DATASET': {
      return {
        ...state,
        dataset: null,
        versions: null,
        segmentsById: {},
        orderedSegmentIds: [],
        collapsedSegmentIds: {},
        selectedSegmentId: null,
        dirtySegments: {},
        issues: [],
        issueAssignments: {},
        activeIssueId: null,
        conflict: null,
        isSaving: false,
        lastError: null,
        featureToggles: {},
        lastSavedAt: null,
      };
    }
    default:
      return state;
  }
};

interface ProofreadEditorProviderProps extends PropsWithChildren {
  token: string | null;
  projectId: string | null;
  jobId?: string | null;
  translationFileId?: string | null;
}

interface ProofreadEditorContextValue {
  dataset: ProofreadEditorDatasetSummary | null;
  versions: ProofreadEditorVersions | null;
  segments: SegmentState[];
  collapsedSegmentIds: Record<string, boolean>;
  selectedSegmentId: string | null;
  editorRatio: number;
  dirtySegments: ProofreadEditorState['dirtySegments'];
  issues: ProofreadEditorIssueEntry[];
  issueAssignments: Record<string, string[]>;
  activeIssueId: string | null;
  conflict: ProofreadEditorConflictState | null;
  isSaving: boolean;
  isLoading: boolean;
  error: string | null;
  featureToggles: Record<string, boolean>;
  lastSavedAt: string | null;
  selectSegment: (segmentId: string | null) => void;
  toggleSegmentCollapse: (segmentId: string) => void;
  setEditorRatio: (ratio: number) => void;
  editSegment: (segmentId: string, column: 'origin' | 'translation', text: string) => void;
  savePendingChanges: () => Promise<void>;
  clearError: () => void;
  refetch: () => Promise<ProofreadEditorResponse | undefined>;
  selectIssue: (issueId: string | null) => void;
  resolveConflict: () => Promise<void>;
  retryConflict: () => Promise<void>;
}

const ProofreadEditorContext = createContext<ProofreadEditorContextValue | null>(
  null,
);

export const ProofreadEditorProvider = ({
  token,
  projectId,
  jobId,
  translationFileId,
  children,
}: ProofreadEditorProviderProps) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const queryClient = useQueryClient();

  const datasetQuery = useProofreadEditorDataset({
    token,
    projectId,
    jobId,
    translationFileId,
  });

  const { refetch: rawDatasetRefetch } = datasetQuery;

  const refetchDataset = useCallback(async () => {
    const result = await rawDatasetRefetch();
    return result.data ?? undefined;
  }, [rawDatasetRefetch]);

  useEffect(() => {
    if (datasetQuery.data) {
      dispatch({ type: 'LOAD_SUCCESS', payload: datasetQuery.data });
    }
  }, [datasetQuery.data]);

  useEffect(() => {
    if (datasetQuery.data === null) {
      dispatch({ type: 'CLEAR_DATASET' });
    }
  }, [datasetQuery.data]);

  const segments = useMemo<SegmentState[]>(
    () =>
      state.orderedSegmentIds
        .map((id) => state.segmentsById[id])
        .filter((segment): segment is SegmentState => Boolean(segment)),
    [state.orderedSegmentIds, state.segmentsById],
  );

  const selectSegment = useCallback((segmentId: string | null) => {
    dispatch({ type: 'SELECT_SEGMENT', segmentId });
  }, []);

  const toggleSegmentCollapse = useCallback((segmentId: string) => {
    dispatch({ type: 'TOGGLE_COLLAPSE', segmentId });
  }, []);

  const setEditorRatio = useCallback((ratio: number) => {
    dispatch({ type: 'SET_EDITOR_RATIO', ratio });
  }, []);

  const editSegment = useCallback(
    (segmentId: string, column: 'origin' | 'translation', text: string) => {
      dispatch({ type: 'EDIT_SEGMENT', segmentId, column, text });
    },
    [],
  );

  const savePendingChanges = useCallback(async () => {
    if (!token || !projectId) return;
    if (!state.dataset || !state.versions) return;
    if (state.featureToggles.originOnly || state.featureToggles.readOnly) return;

    const entries = Object.entries(state.dirtySegments);
    if (!entries.length) return;

    const updates: ProofreadEditorPatchPayload['segments'] = [];
    entries.forEach(([segmentId, changes]) => {
      if (!changes) return;
      if (changes.origin !== undefined) {
        updates.push({ segmentId, column: 'origin', text: changes.origin });
      }
      if (changes.translation !== undefined) {
        updates.push({ segmentId, column: 'translation', text: changes.translation });
      }
    });

    if (!updates.length) return;

    dispatch({ type: 'SAVE_START' });

    const payload: ProofreadEditorPatchPayload = {
      translationFileId: state.dataset.translationFileId,
      documentVersion: state.versions.documentVersion,
      segments: updates,
      jobId: state.dataset.jobId,
      clientMutationId: `proofread-editor-${Date.now()}`,
    };

    try {

      const response = await api.patchProofreadEditorSegments({
        token,
        projectId,
        payload,
      });

      dispatch({ type: 'SAVE_SUCCESS', payload: response });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const conflict = error as ProofreadEditorConflictResponse;
        if (conflict.code === 'CONFLICT') {
          let documentVersion = conflict.documentVersion ?? null;
          if (!documentVersion) {
            try {
              const latest = await refetchDataset();
              documentVersion = latest?.versions.documentVersion ?? null;
            } catch (refetchError) {
              console.warn('[ProofreadEditorProvider] refetch after conflict failed', refetchError);
            }
          }

          if (documentVersion) {
            try {
              const retryPayload: ProofreadEditorPatchPayload = {
                ...payload,
                documentVersion,
                clientMutationId: `proofread-editor-conflict-resolve-${Date.now()}`,
              };
              const response = await api.patchProofreadEditorSegments({
                token,
                projectId,
                payload: retryPayload,
              });

              dispatch({ type: 'SAVE_SUCCESS', payload: response });
              return;
            } catch (retryError) {
              console.warn('[ProofreadEditorProvider] auto-retry after conflict failed', retryError);
            }
          }

          dispatch({
            type: 'SAVE_ERROR',
            message:
              conflict.message ??
              '서버와 버전 충돌이 발생했지만 자동 저장을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
          });
          return;
        }
      }
      const message =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : '저장에 실패했습니다.';
      dispatch({ type: 'SAVE_ERROR', message });
    }
  }, [
    token,
    projectId,
    state.dataset,
    state.versions,
    state.dirtySegments,
    state.featureToggles,
    refetchDataset,
  ]);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  const resolveConflict = useCallback(async () => {
    if (!state.conflict) return;
    dispatch({ type: 'CLEAR_CONFLICT' });
    await refetchDataset();
  }, [state.conflict, refetchDataset]);

  const retryConflict = useCallback(async () => {
    if (!state.conflict || !token || !projectId || !state.dataset) return;
    if (state.featureToggles.originOnly || state.featureToggles.readOnly) return;
    const updates = state.conflict.updates;
    if (!updates.length) {
      dispatch({ type: 'CLEAR_CONFLICT' });
      return;
    }
    dispatch({ type: 'SAVE_START' });
    try {
      const payload: ProofreadEditorPatchPayload = {
        translationFileId: state.dataset.translationFileId,
        documentVersion:
          state.conflict.documentVersion ?? state.versions?.documentVersion ?? '',
        segments: updates,
        jobId: state.dataset.jobId,
        clientMutationId: `proofread-editor-conflict-${Date.now()}`,
      };
      const response = await api.patchProofreadEditorSegments({
        token,
        projectId,
        payload,
      });
      dispatch({ type: 'SAVE_SUCCESS', payload: response });
      dispatch({ type: 'CLEAR_CONFLICT' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const conflict = error as ProofreadEditorConflictResponse;
        if (conflict.code === 'CONFLICT') {
          dispatch({
            type: 'SAVE_CONFLICT',
            conflict,
            updates,
          });
          return;
        }
      }
      const message =
        error instanceof Error ? error.message : '저장에 실패했습니다.';
      dispatch({ type: 'SAVE_ERROR', message });
    }
  }, [
    state.conflict,
    token,
    projectId,
    state.dataset,
    state.versions,
    state.featureToggles,
  ]);

  const selectIssue = useCallback(
    (issueId: string | null) => {
      if (!issueId) {
        dispatch({ type: 'SELECT_ISSUE', issueId: null });
        return;
      }
      const segmentId = state.orderedSegmentIds.find((id) =>
        (state.issueAssignments[id] ?? []).includes(issueId),
      );
      if (segmentId) {
        dispatch({ type: 'SELECT_SEGMENT', segmentId });
      }
      dispatch({ type: 'SELECT_ISSUE', issueId });
    },
    [state.issueAssignments, state.orderedSegmentIds],
  );

  useEffect(() => {
    if (!token || !projectId || !state.dataset) return;
    if (state.featureToggles.originOnly || state.featureToggles.readOnly) return;

    const unsubscribe = api.subscribeProofreadEditorStream({
      token,
      projectId,
      jobId: state.dataset.jobId,
      translationFileId: state.dataset.translationFileId,
      onEvent: (event: ProofreadEditorStreamEvent) => {
        if (event.type === 'proofread.update') {
          queryClient.invalidateQueries({
            queryKey: proofreadEditorKeys.dataset(
              projectId,
              state.dataset?.jobId ?? null,
              state.dataset?.translationFileId ?? null,
            ),
          });
        }
      },
      onError: (error) => {
        console.warn('[ProofreadEditorProvider] SSE error', error);
      },
    });

    return unsubscribe;
  }, [token, projectId, state.dataset, state.featureToggles, queryClient]);

  const contextValue = useMemo<ProofreadEditorContextValue>(() => ({
    dataset: state.dataset,
    versions: state.versions,
    segments,
    collapsedSegmentIds: state.collapsedSegmentIds,
    selectedSegmentId: state.selectedSegmentId,
    editorRatio: state.editorRatio,
    dirtySegments: state.dirtySegments,
    issues: state.issues,
    issueAssignments: state.issueAssignments,
    activeIssueId: state.activeIssueId,
    conflict: state.conflict,
    isSaving: state.isSaving,
    isLoading: datasetQuery.isLoading,
    error:
      state.lastError ??
      (datasetQuery.error instanceof Error ? datasetQuery.error.message : null),
    featureToggles: state.featureToggles,
    lastSavedAt: state.lastSavedAt,
    selectSegment,
    toggleSegmentCollapse,
    setEditorRatio,
    editSegment,
    savePendingChanges,
    clearError,
    selectIssue,
    resolveConflict,
    retryConflict,
    refetch: refetchDataset,
  }), [
    state.dataset,
    state.versions,
    segments,
    state.collapsedSegmentIds,
    state.selectedSegmentId,
    state.editorRatio,
    state.dirtySegments,
    state.issues,
    state.issueAssignments,
    state.activeIssueId,
    state.conflict,
    state.isSaving,
    state.lastError,
    state.featureToggles,
    state.lastSavedAt,
    datasetQuery.isLoading,
    datasetQuery.error,
    selectSegment,
    toggleSegmentCollapse,
    setEditorRatio,
    editSegment,
    savePendingChanges,
    clearError,
    selectIssue,
    resolveConflict,
    retryConflict,
    refetchDataset,
  ]);

  return (
    <ProofreadEditorContext.Provider value={contextValue}>
      {children}
    </ProofreadEditorContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useProofreadEditorContext = () => {
  const context = useContext(ProofreadEditorContext);
  if (!context) {
    throw new Error(
      'useProofreadEditorContext must be used within a ProofreadEditorProvider',
    );
  }
  return context;
};

export type { SegmentState as ProofreadEditorSegmentState };
