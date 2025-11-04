import { create } from "zustand";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type UILocale,
} from "../config/i18n";

const LOCALE_STORAGE_KEY = "t1.ui-locale";

const resolveInitialLocale = (): UILocale => {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && isSupportedLocale(stored)) {
      return stored;
    }
  } catch (error) {
    console.warn("[ui.store] Failed to read locale from storage", error);
  }
  const browserLanguage =
    typeof navigator !== "undefined" ? navigator.language?.slice(0, 2) : null;
  if (browserLanguage && isSupportedLocale(browserLanguage)) {
    return browserLanguage;
  }
  return DEFAULT_LOCALE;
};

const DEFAULT_RIGHT_RATIO = 0.5;
const DEFAULT_RIGHT_WIDTH =
  typeof window !== "undefined"
    ? Math.max(400, Math.round(window.innerWidth * DEFAULT_RIGHT_RATIO))
    : 640;

export type RightPanelBaseTab =
  | "preview"
  | "proofread:findings"
  | "proofread:editing"
  | "export";
export type RightPanelExtraTab =
  | "profile"
  | "settings"
  | "activity"
  | "terms"
  | "privacy";
export type RightPanelTab = RightPanelBaseTab | RightPanelExtraTab;

type SidebarSectionKey = "workflow" | "quickActions" | "activity";

export const DEFAULT_SIDEBAR_SECTIONS: Record<SidebarSectionKey, boolean> = {
  workflow: true,
  quickActions: true,
  activity: false,
};

const EXTRA_TAB_KEYS: RightPanelExtraTab[] = [
  "profile",
  "settings",
  "activity",
  "terms",
  "privacy",
];

const isExtraTab = (
  tab: RightPanelTab | null | undefined,
): tab is RightPanelExtraTab =>
  Boolean(tab && EXTRA_TAB_KEYS.includes(tab as RightPanelExtraTab));

interface UIState {
  rightPanelTab: RightPanelTab;
  extraTab: { key: RightPanelExtraTab; label: string } | null;
  isSidebarCollapsed: boolean;
  setRightPanelTab: (tab: UIState["rightPanelTab"]) => void;
  toggleSidebar: () => void;
  leftPanelWidth: number;
  setLeftPanelWidth: (width: number | ((current: number) => number)) => void;
  rightPanelWidth: number;
  setRightPanelWidth: (width: number | ((current: number) => number)) => void;
  openExtraTab: (tab: { key: RightPanelExtraTab; label: string }) => void;
  clearExtraTab: () => void;
  locale: UILocale;
  setLocale: (next: UILocale) => void;
  sidebarSections: Record<string, Record<SidebarSectionKey, boolean>>;
  setSidebarSection: (
    projectId: string | null,
    section: SidebarSectionKey,
    open: boolean,
  ) => void;
  qualityDialogOpen: boolean;
  openQualityDialog: () => void;
  closeQualityDialog: () => void;
  advancedProofreadEnabled: boolean;
  setAdvancedProofreadEnabled: (
    enabled: boolean | ((current: boolean) => boolean),
  ) => void;
  toggleAdvancedProofread: () => void;
}

const ADVANCED_PROOFREAD_KEY = "t1.ui-advanced-proofread";

const loadAdvancedProofreadFlag = () => {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(ADVANCED_PROOFREAD_KEY);
    if (!raw) return false;
    return raw === "1";
  } catch (error) {
    console.warn("[ui.store] Failed to read advanced proofread flag", error);
    return false;
  }
};

const persistAdvancedProofreadFlag = (enabled: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADVANCED_PROOFREAD_KEY, enabled ? "1" : "0");
  } catch (error) {
    console.warn("[ui.store] Failed to persist advanced proofread flag", error);
  }
};

export const useUIStore = create<UIState>((set) => ({
  rightPanelTab: "preview",
  extraTab: null,
  isSidebarCollapsed: false,
  setRightPanelTab: (tab) =>
    set((state) => ({
      rightPanelTab: tab,
      extraTab: isExtraTab(tab) ? state.extraTab : null,
    })),
  toggleSidebar: () =>
    set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
  // Sidebar default width trimmed by ~20% so it feels lighter on initial load
  leftPanelWidth: 228,
  setLeftPanelWidth: (width) =>
    set((state) => ({
      leftPanelWidth:
        typeof width === "function" ? width(state.leftPanelWidth) : width,
    })),
  rightPanelWidth: DEFAULT_RIGHT_WIDTH,
  setRightPanelWidth: (width) =>
    set((state) => ({
      rightPanelWidth:
        typeof width === "function" ? width(state.rightPanelWidth) : width,
    })),
  openExtraTab: ({ key, label }) =>
    set(() => ({
      extraTab: { key, label },
      rightPanelTab: key,
    })),
  clearExtraTab: () =>
    set((state) => ({
      extraTab: null,
      rightPanelTab: isExtraTab(state.rightPanelTab)
        ? "preview"
        : state.rightPanelTab,
    })),
  locale: resolveInitialLocale(),
  setLocale: (next) => {
    set(() => ({ locale: next }));
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch (error) {
        console.warn("[ui.store] Failed to persist locale", error);
      }
    }
  },
  sidebarSections: {},
  setSidebarSection: (projectId, section, open) =>
    set((state) => {
      const key = projectId ?? "global";
      const current = state.sidebarSections[key] ?? DEFAULT_SIDEBAR_SECTIONS;
      return {
        sidebarSections: {
          ...state.sidebarSections,
          [key]: { ...DEFAULT_SIDEBAR_SECTIONS, ...current, [section]: open },
        },
      };
    }),
  qualityDialogOpen: false,
  openQualityDialog: () => set(() => ({ qualityDialogOpen: true })),
  closeQualityDialog: () => set(() => ({ qualityDialogOpen: false })),
  advancedProofreadEnabled: loadAdvancedProofreadFlag(),
  setAdvancedProofreadEnabled: (next) => {
    set((state) => {
      const value =
        typeof next === "function"
          ? next(state.advancedProofreadEnabled)
          : next;
      persistAdvancedProofreadFlag(value);
      return { advancedProofreadEnabled: value };
    });
  },
  toggleAdvancedProofread: () =>
    set((state) => {
      const next = !state.advancedProofreadEnabled;
      persistAdvancedProofreadFlag(next);
      return { advancedProofreadEnabled: next };
    }),
}));
