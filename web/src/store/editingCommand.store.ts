import { create } from "zustand";
import type { SelectionRange } from "../types/domain";

export type EditorSelectionSource = "origin" | "translation";

export interface EditorSelectionContext {
  id: string;
  source: EditorSelectionSource;
  text: string;
  rawText: string;
  range: SelectionRange;
  meta?: Record<string, unknown> | null;
}

export type EditingActionType = "rewrite" | "normalizeName" | "adjustPronoun";

export interface PendingEditingAction {
  type: EditingActionType;
  selection: EditorSelectionContext;
}

export interface EditingEditorAdapter {
  replaceText: (payload: {
    range: SelectionRange;
    expectedText: string;
    nextText: string;
    reason?: string;
  }) => {
    ok: boolean;
    appliedRange?: SelectionRange;
    previousText?: string;
    message?: string;
  };
}

export interface EditingSuggestion {
  id: string;
  type: EditingActionType;
  selection: EditorSelectionContext;
  prompt: string;
  resultText: string;
  explanation?: string | null;
  createdAt: number;
  status: "pending" | "applied" | "dismissed";
  appliedAt?: number | null;
  appliedRange?: SelectionRange | null;
  previousText?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface EditingCommandState {
  selection: EditorSelectionContext | null;
  pendingAction: PendingEditingAction | null;
  activeAction: EditingActionType | null;
  editorAdapter: EditingEditorAdapter | null;
  suggestions: Record<string, EditingSuggestion>;
  setSelection: (selection: EditorSelectionContext | null) => void;
  triggerAction: (type: EditingActionType) => void;
  clearPendingAction: () => void;
  setActiveAction: (action: EditingActionType | null) => void;
  registerEditorAdapter: (adapter: EditingEditorAdapter | null) => void;
  addSuggestion: (suggestion: EditingSuggestion) => void;
  updateSuggestion: (
    id: string,
    updater: (suggestion: EditingSuggestion) => EditingSuggestion,
  ) => void;
  removeSuggestion: (id: string) => void;
  clearSuggestions: () => void;
}

export const useEditingCommandStore = create<EditingCommandState>((set, get) => ({
  selection: null,
  pendingAction: null,
  activeAction: null,
  editorAdapter: null,
  suggestions: {},
  setSelection: (selection) =>
    set((state) => ({
      selection,
      activeAction: selection ? state.activeAction : null,
    })),
  triggerAction: (type) => {
    const { selection } = get();
    if (!selection) return;
    set({ pendingAction: { type, selection } });
  },
  clearPendingAction: () => set({ pendingAction: null }),
  setActiveAction: (action) => set({ activeAction: action }),
  registerEditorAdapter: (adapter) => set({ editorAdapter: adapter }),
  addSuggestion: (suggestion) =>
    set((state) => ({
      suggestions: { ...state.suggestions, [suggestion.id]: suggestion },
    })),
  updateSuggestion: (id, updater) =>
    set((state) => {
      const current = state.suggestions[id];
      if (!current) return state;
      const next = updater(current);
      return {
        suggestions: { ...state.suggestions, [id]: next },
      };
    }),
  removeSuggestion: (id) =>
    set((state) => {
      if (!state.suggestions[id]) return state;
      const next = { ...state.suggestions };
      delete next[id];
      return { suggestions: next };
    }),
  clearSuggestions: () => set({ suggestions: {} }),
}));
