import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import clsx from "clsx";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useAuthStore } from "../../store/auth.store";
import { useProjectStore } from "../../store/project.store";
import { api } from "../../services/api";
import type { ProjectContent, ProjectSummary } from "../../types/domain";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";

interface UserConsentRecord {
  consented?: boolean;
  status?: string;
  statusKo?: string;
  statusEn?: string;
  consentedAt?: string | null;
  userName?: string | null;
  originTitle?: string | null;
  translatedTitle?: string | null;
  authorName?: string | null;
  translatorName?: string | null;
  version?: number;
  [key: string]: unknown;
}

export interface ProfileStatusSnapshot {
  consent: boolean;
  requiredFilled: boolean;
  complete: boolean;
}

interface ProjectProfileCardProps {
  content?: ProjectContent | null;
  projectSummary?: ProjectSummary | null;
  onUpdated?: () => void;
  onActionReady?: (
    controls: { isEditing: boolean; startEdit: () => void } | null,
  ) => void;
  onStatusChange?: (status: ProfileStatusSnapshot) => void;
  requireAuthor?: boolean;
  onDraftChange?: (draft: ProfileDraft) => void;
}

interface ProfileDraft {
  bookTitleKo: string;
  authorNameKo: string;
  bookTitleEn: string;
  translatorName: string;
  originalAuthorNotes: string;
  translatorNotes: string;
  copyrightConsent: boolean;
  consentRecord: UserConsentRecord;
}

export type ProjectProfileDraft = ProfileDraft;
export type ProjectProfileStatusSnapshot = ProfileStatusSnapshot;

const AUTO_SAVE_DELAY_MS = 1200;

const coerceMetaString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const parseMeta = (meta: unknown): Record<string, unknown> => {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      console.warn("[profile-card] failed to parse meta", error);
      return {};
    }
  }
  if (typeof meta === "object") {
    return { ...(meta as Record<string, unknown>) };
  }
  return {};
};

const parseUserConsent = (value: unknown): UserConsentRecord => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      console.warn("[profile-card] failed to parse user consent", error);
      return {};
    }
  }
  if (typeof value === "object") {
    return { ...(value as Record<string, unknown>) } as UserConsentRecord;
  }
  return {};
};

const deriveConsentFlag = (record: UserConsentRecord): boolean => {
  if (!record) return false;
  if (record.consented === true) return true;
  const statusTokens = new Set([
    "동의",
    "동의함",
    "consented",
    "consent",
    "received",
    "yes",
    "granted",
  ]);
  const statusRaw = coerceMetaString(record.status);
  const statusKoRaw = coerceMetaString(record.statusKo);
  const statusEnRaw = coerceMetaString(record.statusEn);
  const normalized = statusRaw.replace(/\s+/g, "").toLowerCase();
  const normalizedKo = statusKoRaw.replace(/\s+/g, "").toLowerCase();
  const normalizedEn = statusEnRaw.replace(/\s+/g, "").toLowerCase();
  return (
    statusTokens.has(normalized) ||
    statusTokens.has(normalizedKo) ||
    statusTokens.has(normalizedEn)
  );
};

const pickFirstText = (...values: Array<unknown>): string => {
  for (const value of values) {
    const text = coerceMetaString(value);
    if (text.length > 0) {
      return text;
    }
  }
  return "";
};

const deriveDraft = (
  content: ProjectContent | null | undefined,
  summary: ProjectSummary | null | undefined,
  fallbackTranslator: string,
): ProfileDraft => {
  const profile = content?.projectProfile ?? null;
  const profileMeta = parseMeta(profile?.meta);
  const summaryMeta = parseMeta(summary?.meta);
  const consentRecord = parseUserConsent(summary?.user_consent ?? null);

  const bookTitleKo = pickFirstText(
    profile?.bookTitle,
    profile?.title,
    summary?.book_title,
    summary?.title,
  );
  const authorNameKo = pickFirstText(
    profile?.authorName,
    profileMeta.author,
    summary?.author_name,
    summaryMeta.author,
  );
  const bookTitleEn = pickFirstText(
    profileMeta.bookTitleEn,
    summaryMeta.bookTitleEn,
    summaryMeta.book_title_en,
  );
  const translatorName = pickFirstText(
    profile?.translatorName,
    profileMeta.translator,
    summary?.translator_name,
    fallbackTranslator,
  );
  const originalAuthorNotes = pickFirstText(
    profileMeta.originalAuthorNotes,
    profileMeta.context,
    summaryMeta.originalAuthorNotes,
    summaryMeta.context,
    profile?.description,
    profile?.intention,
    summary?.description,
    summary?.intention,
  );
  const translatorNotes = pickFirstText(
    profileMeta.translatorNotes,
    summaryMeta.translatorNotes,
    profile?.memo,
    summaryMeta.notes,
  );

  return {
    bookTitleKo,
    authorNameKo,
    bookTitleEn,
    translatorName,
    originalAuthorNotes,
    translatorNotes,
    copyrightConsent: deriveConsentFlag(consentRecord),
    consentRecord,
  };
};

const buildMemoFromDraft = (draft: ProfileDraft) =>
  draft.translatorNotes.trim();

const sanitizeDraft = (draft: ProfileDraft): ProfileDraft => ({
  bookTitleKo: draft.bookTitleKo.trim(),
  authorNameKo: draft.authorNameKo.trim(),
  bookTitleEn: draft.bookTitleEn.trim(),
  translatorName: draft.translatorName.trim(),
  originalAuthorNotes: draft.originalAuthorNotes.trim(),
  translatorNotes: draft.translatorNotes.trim(),
  copyrightConsent: Boolean(draft.copyrightConsent),
  consentRecord:
    typeof draft.consentRecord === "object" && draft.consentRecord !== null
      ? { ...draft.consentRecord }
      : {},
});

const computeStatusSnapshot = (draft: ProfileDraft): ProfileStatusSnapshot => {
  const sanitized = sanitizeDraft(draft);
  const requiredFilled =
    sanitized.bookTitleKo.length > 0 &&
    sanitized.bookTitleEn.length > 0 &&
    sanitized.authorNameKo.length > 0 &&
    sanitized.translatorName.length > 0;
  return {
    consent: sanitized.copyrightConsent,
    requiredFilled,
    complete: requiredFilled && sanitized.copyrightConsent,
  };
};

const draftsMatch = (left: ProfileDraft, right: ProfileDraft) => {
  const sanitizedLeft = sanitizeDraft(left);
  const sanitizedRight = sanitizeDraft(right);
  const { consentRecord: leftConsent, ...restLeft } = sanitizedLeft;
  const { consentRecord: rightConsent, ...restRight } = sanitizedRight;
  return (
    JSON.stringify(restLeft) === JSON.stringify(restRight) &&
    JSON.stringify(leftConsent ?? {}) === JSON.stringify(rightConsent ?? {})
  );
};

const composeUpdatedMeta = (
  sanitized: ProfileDraft,
  baseMeta: Record<string, unknown>,
  translatorValue: string | null,
): Record<string, unknown> => {
  const next = { ...baseMeta };
  next.author = sanitized.authorNameKo || null;
  next.translator = translatorValue || null;
  next.bookTitleEn = sanitized.bookTitleEn || null;
  next.originalAuthorNotes = sanitized.originalAuthorNotes || null;
  next.translatorNotes = sanitized.translatorNotes || null;
  next.context = sanitized.originalAuthorNotes || null;
  next.notes = sanitized.translatorNotes || null;
  if (!Object.prototype.hasOwnProperty.call(next, "translationDirection")) {
    next.translationDirection = null;
  }
  return next;
};

const buildUserConsentRecord = (params: {
  consented: boolean;
  draft: ProfileDraft;
  userName: string | null;
  previous: UserConsentRecord;
}): UserConsentRecord => {
  const { consented, draft, userName, previous } = params;

  const historical = {
    ...(previous ?? {}),
    ...(draft.consentRecord ?? {}),
  } as UserConsentRecord;

  const version =
    typeof historical.version === "number" &&
    Number.isFinite(historical.version)
      ? historical.version
      : 1;

  const base: UserConsentRecord = {
    version,
    userName:
      userName ??
      (typeof historical.userName === "string" ? historical.userName : null),
    originTitle:
      draft.bookTitleKo ||
      (typeof historical.originTitle === "string"
        ? historical.originTitle
        : null),
    translatedTitle:
      draft.bookTitleEn ||
      (typeof historical.translatedTitle === "string"
        ? historical.translatedTitle
        : null),
    authorName:
      draft.authorNameKo ||
      (typeof historical.authorName === "string"
        ? historical.authorName
        : null),
    translatorName:
      draft.translatorName ||
      (typeof historical.translatorName === "string"
        ? historical.translatorName
        : null),
  };

  if (consented) {
    const existingConsentTimestamp =
      historical.consented === true &&
      typeof historical.consentedAt === "string"
        ? historical.consentedAt
        : null;
    return {
      ...base,
      consented: true,
      status: "동의",
      statusKo: "동의",
      statusEn: "received",
      consentedAt: existingConsentTimestamp ?? new Date().toISOString(),
    };
  }

  return {
    ...base,
    consented: false,
    status: "동의 안함",
    statusKo: "동의 안함",
    statusEn: "not_received",
    consentedAt: null,
  };
};

export const ProjectProfileCard = ({
  content,
  projectSummary,
  onUpdated,
  onActionReady,
  onStatusChange,
  onDraftChange,
  requireAuthor = true,
}: ProjectProfileCardProps) => {
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
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const userName = (user?.name ?? "").trim();
  const projectId = useProjectStore((state) => state.activeProjectId);
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    deriveDraft(content ?? null, projectSummary ?? null, userName),
  );
  const draftRef = useRef<ProfileDraft>(draft);
  const statusSnapshotRef = useRef<{
    projectId: string | null;
    snapshot: ProfileStatusSnapshot | null;
  }>({ projectId: null, snapshot: null });
  const [status, setStatus] = useState<
    "idle" | "dirty" | "saving" | "saved" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    bookTitleKo?: string;
    bookTitleEn?: string;
    authorNameKo?: string;
    translatorName?: string;
  }>({});

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  useEffect(() => {
    onActionReady?.(null);
    return () => onActionReady?.(null);
  }, [onActionReady]);

  const computeValidation = useCallback(
    (snapshot: ProfileDraft) => {
      const sanitized = sanitizeDraft(snapshot);
      const requiredMessage = localize(
        "project_profile_error_required_field",
        "필수 입력 항목입니다.",
      );
      const errors: {
        bookTitleKo?: string;
        bookTitleEn?: string;
        authorNameKo?: string;
        translatorName?: string;
      } = {};

      if (!sanitized.bookTitleKo) {
        errors.bookTitleKo = requiredMessage;
      }

      if (!sanitized.bookTitleEn) {
        errors.bookTitleEn = requiredMessage;
      }

      if (requireAuthor && !sanitized.authorNameKo) {
        errors.authorNameKo = requiredMessage;
      }

      if (!sanitized.translatorName) {
        errors.translatorName = requiredMessage;
      }

      return { sanitized, errors };
    },
    [localize, requireAuthor],
  );

  const externalDraft = useMemo(
    () => deriveDraft(content ?? null, projectSummary ?? null, userName),
    [content, projectSummary, userName],
  );

  const statusSnapshot = useMemo(() => computeStatusSnapshot(draft), [draft]);

  useEffect(() => {
    const previous = statusSnapshotRef.current;
    const currentProjectId = projectId ?? null;
    if (!onStatusChange) {
      statusSnapshotRef.current = {
        projectId: currentProjectId,
        snapshot: statusSnapshot,
      };
      return;
    }

    const previousSnapshot = previous.snapshot;
    const projectChanged = previous.projectId !== currentProjectId;
    const snapshotChanged =
      !previousSnapshot ||
      previousSnapshot.complete !== statusSnapshot.complete ||
      previousSnapshot.consent !== statusSnapshot.consent ||
      previousSnapshot.requiredFilled !== statusSnapshot.requiredFilled;

    if (projectChanged || snapshotChanged) {
      onStatusChange(statusSnapshot);
    }

    statusSnapshotRef.current = {
      projectId: currentProjectId,
      snapshot: statusSnapshot,
    };
  }, [projectId, statusSnapshot, onStatusChange]);

  useEffect(() => {
    setLastSavedAt(null);
    setHasLocalChanges(false);
    setStatus("idle");
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (hasLocalChanges) return;
    setDraft(externalDraft);
    draftRef.current = externalDraft;
    setStatus("idle");
    setError(null);
    setFieldErrors(computeValidation(externalDraft).errors);
  }, [computeValidation, externalDraft, hasLocalChanges]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (status !== "saved") return;
    const timeoutId = window.setTimeout(() => {
      setStatus("idle");
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const persist = useCallback(
    async (snapshot: ProfileDraft) => {
      if (!token || !projectId) {
        setStatus("error");
        setError(
          localize(
            "project_profile_error_auth",
            "Please sign in again to save project information.",
          ),
        );
        return;
      }

      setStatus("saving");
      const { sanitized, errors } = computeValidation(snapshot);

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setStatus("error");
        setError(
          localize(
            "project_profile_error_required",
            "Please fill in the required fields.",
          ),
        );
        return;
      }

      setFieldErrors({});

      const translatorValueRaw = sanitized.translatorName || userName || "";
      const translatorValue = translatorValueRaw.trim();
      const effectiveTranslator = translatorValue.length
        ? translatorValue
        : null;
      const payloadMemo = buildMemoFromDraft(sanitized);
      const profileMeta = parseMeta(content?.projectProfile?.meta ?? null);
      const summaryMeta = parseMeta(projectSummary?.meta ?? null);
      const combinedMeta = { ...summaryMeta, ...profileMeta };
      const nextUserConsent = buildUserConsentRecord({
        consented: sanitized.copyrightConsent,
        draft: sanitized,
        userName: userName.length > 0 ? userName : effectiveTranslator,
        previous: sanitized.consentRecord ?? {},
      });
      const updatedMeta = composeUpdatedMeta(
        sanitized,
        combinedMeta,
        effectiveTranslator,
      );

      try {
        await api.updateProject(token, projectId, {
          book_title: sanitized.bookTitleKo || undefined,
          author_name: sanitized.authorNameKo || undefined,
          translator_name: effectiveTranslator ?? undefined,
          description: sanitized.originalAuthorNotes || undefined,
          intention: undefined,
          memo: payloadMemo || undefined,
          meta: updatedMeta,
          user_consent: nextUserConsent,
        });

        setLastSavedAt(new Date().toISOString());
        setError(null);
        onUpdated?.();

        const persistedDraft: ProfileDraft = {
          ...sanitized,
          translatorName: effectiveTranslator ?? "",
          consentRecord: nextUserConsent,
        };

        const stillDirty = !draftsMatch(draftRef.current, persistedDraft);

        if (!stillDirty) {
          setDraft(persistedDraft);
          draftRef.current = persistedDraft;
        }

        setHasLocalChanges(stillDirty);
        setStatus(stillDirty ? "dirty" : "saved");
      } catch (err) {
        setStatus("error");
        setError(
          err instanceof Error
            ? err.message
            : localize(
                "project_profile_error_generic",
                "Unable to save the project information.",
              ),
        );
      }
    },
    [
      computeValidation,
      content,
      projectSummary,
      localize,
      onUpdated,
      projectId,
      token,
      userName,
    ],
  );

  const scheduleSave = useCallback(
    (nextDraft: ProfileDraft) => {
      setDraft(nextDraft);
      draftRef.current = nextDraft;
      setHasLocalChanges(true);
      setStatus("dirty");
      setError(null);
      setFieldErrors(computeValidation(nextDraft).errors);

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null;
        void persist(draftRef.current);
      }, AUTO_SAVE_DELAY_MS);
    },
    [computeValidation, persist],
  );

  const handleFieldChange = useCallback(
    (key: keyof ProfileDraft) =>
      (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const value = event.target.value;
        const next = { ...draftRef.current, [key]: value };
        scheduleSave(next);
      },
    [scheduleSave],
  );

  const handleConsentToggle = useCallback(() => {
    const next = {
      ...draftRef.current,
      copyrightConsent: !draftRef.current.copyrightConsent,
    };
    scheduleSave(next);
  }, [scheduleSave]);

  type StatusTone = "info" | "warn" | "success" | "error";

  const statusInfo = useMemo<{
    icon: JSX.Element;
    label: string;
    tone: StatusTone;
  } | null>(() => {
    switch (status) {
      case "saving":
        return {
          icon: (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
          ),
          label: localize("project_profile_status_saving", "Saving…"),
          tone: "info" as const,
        };
      case "error":
        return {
          icon: <AlertCircle className="h-3.5 w-3.5 text-rose-500" />,
          label:
            error ??
            localize("project_profile_status_error", "Failed to save profile."),
          tone: "error" as const,
        };
      default:
        return null;
    }
  }, [error, localize, status]);

  const consentLabel = localize(
    "project_consent_label",
    "Original copyright consent",
  );
  const consentStatusEnabled = localize("project_consent_received", "Received");
  const consentStatusDisabled = localize(
    "project_consent_not_received",
    "Not received",
  );
  const consentEnabled = draft.copyrightConsent;
  const consentStatusLabel = consentEnabled
    ? consentStatusEnabled
    : consentStatusDisabled;
  const consentOffClass = consentEnabled ? "text-slate-400" : "text-rose-500";
  const consentOnClass = consentEnabled ? "text-emerald-600" : "text-slate-400";
  const savedBadgeLabel = localize(
    "project_profile_status_saved_badge",
    "Saved",
  );
  const showSavedBadge = !hasLocalChanges && Boolean(lastSavedAt);

  return (
    <section className="space-y-4">
      {statusInfo && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {statusInfo.icon}
          <span>{statusInfo.label}</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1 text-xs font-semibold text-slate-500">
          <span>{consentLabel}</span>
          <div className="flex items-center gap-3">
            <span className={consentOffClass}>{consentStatusDisabled}</span>
            <button
              type="button"
              onClick={handleConsentToggle}
              className={clsx(
                "relative h-5 w-9 rounded-full border transition-colors duration-150",
                consentEnabled
                  ? "border-emerald-500 bg-emerald-500"
                  : "border-slate-300 bg-slate-200",
              )}
              aria-pressed={consentEnabled}
              aria-label={consentLabel}
            >
              <span
                className={clsx(
                  "absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white transition-transform duration-150",
                  consentEnabled ? "translate-x-4" : "translate-x-0",
                )}
              />
            </button>
            <span className={consentOnClass}>{consentStatusEnabled}</span>
          </div>
          <span className="sr-only">{consentStatusLabel}</span>
        </div>
        {showSavedBadge ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600">
            <Check className="h-3 w-3" aria-hidden="true" />
            <span>{savedBadgeLabel}</span>
          </span>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500 md:flex-row md:items-center md:gap-2">
          <span className="md:w-22">
            {localize(
              "project_profile_field_book_title",
              "Book title*",
            )}
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <input
              value={draft.bookTitleKo}
              onChange={handleFieldChange("bookTitleKo")}
              className={`w-full rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
                fieldErrors.bookTitleKo
                  ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                  : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
              }`}
              placeholder={localize(
                "project_profile_placeholder_book_title",
                "e.g., Korean title",
              )}
            />
            {fieldErrors.bookTitleKo ? (
              <span className="text-[11px] text-rose-500">
                {fieldErrors.bookTitleKo}
              </span>
            ) : null}
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500 md:flex-row md:items-center md:gap-2">
          <span className="md:w-22">
            {localize(
              "project_profile_field_book_title_en",
              "Translated title",
            )}
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <input
              value={draft.bookTitleEn}
              onChange={handleFieldChange("bookTitleEn")}
              className={`w-full rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
                fieldErrors.bookTitleEn
                  ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                  : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
              }`}
              placeholder={localize(
                "project_profile_placeholder_book_title_en",
                "e.g., English Title",
              )}
            />
            {fieldErrors.bookTitleEn ? (
              <span className="text-[11px] text-rose-500">
                {fieldErrors.bookTitleEn}
              </span>
            ) : null}
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500 md:flex-row md:items-center md:gap-2">
          <span className="md:w-22">
            {localize("project_profile_field_author", "Author*")}
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <input
              value={draft.authorNameKo}
              onChange={handleFieldChange("authorNameKo")}
              className={`w-full rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
                fieldErrors.authorNameKo
                  ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                  : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
              }`}
              placeholder={localize(
                "project_profile_placeholder_author",
                "e.g., Hong Gildong",
              )}
            />
            {fieldErrors.authorNameKo ? (
              <span className="text-[11px] text-rose-500">
                {fieldErrors.authorNameKo}
              </span>
            ) : null}
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500 md:flex-row md:items-center md:gap-2">
          <span className="md:w-22">
            {localize("project_profile_field_translator", "Translator")}
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <input
              value={draft.translatorName}
              onChange={handleFieldChange("translatorName")}
              className={`w-full rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
                fieldErrors.translatorName
                  ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                  : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
              }`}
              placeholder={localize(
                "project_profile_placeholder_translator",
                "e.g., Translator Name",
              )}
            />
            {fieldErrors.translatorName ? (
              <span className="text-[11px] text-rose-500">
                {fieldErrors.translatorName}
              </span>
            ) : null}
          </div>
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500 md:flex-row md:items-start md:gap-2">
          <span className="md:w-22">
            {localize("project_profile_field_author_notes", "Author notes")}
          </span>
          <textarea
            value={draft.originalAuthorNotes}
            onChange={handleFieldChange("originalAuthorNotes")}
            className="min-h-[88px] w-full rounded border border-slate-300 px-3 py-2 text-[13px] font-normal text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder={localize(
              "project_profile_placeholder_author_notes",
              "Capture author intent, background, or notes for readers.",
            )}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500 md:flex-row md:items-start md:gap-2">
          <span className="md:w-28">
            {localize(
              "project_profile_field_translator_notes",
              "Translator notes",
            )}
          </span>
          <textarea
            value={draft.translatorNotes}
            onChange={handleFieldChange("translatorNotes")}
            className="min-h-[88px] w-full rounded border border-slate-300 px-3 py-2 text-[13px] font-normal text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder={localize(
              "project_profile_placeholder_translator_notes",
              "Share context or reminders for the translation team.",
            )}
          />
        </label>
      </div>
      {status === "error" && !(statusInfo && statusInfo.tone === "error") && (
        <p className="text-xs text-rose-500">
          {error ??
            localize(
              "project_profile_error_generic",
              "Unable to save the project information.",
            )}
        </p>
      )}
    </section>
  );
};

export default ProjectProfileCard;
