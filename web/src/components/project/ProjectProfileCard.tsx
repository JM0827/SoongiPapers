import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import { AlertCircle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { useAuthStore } from "../../store/auth.store";
import { useProjectStore } from "../../store/project.store";
import { api } from "../../services/api";
import type { ProjectContent } from "../../types/domain";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";

interface ProjectProfileCardProps {
  content?: ProjectContent | null;
  onUpdated?: () => void;
  onActionReady?: (
    controls: { isEditing: boolean; startEdit: () => void } | null,
  ) => void;
  requireAuthor?: boolean;
}

interface ProfileDraft {
  bookTitleKo: string;
  authorNameKo: string;
  bookTitleEn: string;
  translatorName: string;
  originalAuthorNotes: string;
  translatorNotes: string;
}

const deriveDraft = (content?: ProjectContent | null): ProfileDraft => {
  const profile = content?.projectProfile;
  const rawMeta = profile?.meta;
  const meta =
    typeof rawMeta === "string"
      ? (() => {
          try {
            return JSON.parse(rawMeta) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })()
      : (rawMeta as Record<string, unknown> | null | undefined) ?? {};
  return {
    bookTitleKo: (profile?.bookTitle ?? profile?.title ?? "").trim(),
    authorNameKo:
      (profile?.authorName as string | null | undefined)?.trim() ??
      (meta.author as string | null | undefined)?.trim() ??
      "",
    bookTitleEn:
      (meta.bookTitleEn as string | null | undefined)?.trim() ??
      (meta.book_title_en as string | null | undefined)?.trim() ??
      "",
    translatorName:
      (profile?.translatorName as string | null | undefined)?.trim() ??
      (meta.translator as string | null | undefined)?.trim() ??
      "",
    originalAuthorNotes:
      (meta.originalAuthorNotes as string | null | undefined)?.trim() ??
      (meta.context as string | null | undefined)?.trim() ??
      profile?.intention ??
      profile?.description ??
      "",
    translatorNotes:
      (meta.translatorNotes as string | null | undefined)?.trim() ??
      (profile?.memo ?? "").trim(),
  };
};

const buildMemoFromDraft = (draft: ProfileDraft) => {
  return draft.translatorNotes.trim();
};

const AUTO_SAVE_DELAY_MS = 1200;

const sanitizeDraft = (draft: ProfileDraft): ProfileDraft => ({
  bookTitleKo: draft.bookTitleKo.trim(),
  authorNameKo: draft.authorNameKo.trim(),
  bookTitleEn: draft.bookTitleEn.trim(),
  translatorName: draft.translatorName.trim(),
  originalAuthorNotes: draft.originalAuthorNotes.trim(),
  translatorNotes: draft.translatorNotes.trim(),
});

const draftsMatch = (left: ProfileDraft, right: ProfileDraft) =>
  JSON.stringify(sanitizeDraft(left)) === JSON.stringify(sanitizeDraft(right));

export const ProjectProfileCard = ({
  content,
  onUpdated,
  onActionReady,
  requireAuthor = false,
}: ProjectProfileCardProps) => {
  const { locale } = useUILocale();
  const localize = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const resolved = translate(key, locale, params);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const userName = (user?.name ?? "").trim();
  const projectId = useProjectStore((state) => state.activeProjectId);
  const [draft, setDraft] = useState<ProfileDraft>(() => {
    const base = deriveDraft(content);
    if (!base.translatorName && userName) {
      return { ...base, translatorName: userName };
    }
    return base;
  });
  const draftRef = useRef<ProfileDraft>(draft);
  const [status, setStatus] = useState<
    "idle" | "dirty" | "saving" | "saved" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    bookTitleKo?: string;
    authorNameKo?: string;
  }>({});

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onActionReady?.(null);
    return () => onActionReady?.(null);
  }, [onActionReady]);

  const computeValidation = useCallback(
    (snapshot: ProfileDraft) => {
      const sanitized = sanitizeDraft(snapshot);
      const errors: { bookTitleKo?: string; authorNameKo?: string } = {};

      if (!sanitized.bookTitleKo) {
        errors.bookTitleKo = localize(
          "project_profile_error_book_title",
          "Please enter the original book title.",
        );
      }

      if (requireAuthor && !sanitized.authorNameKo) {
        errors.authorNameKo = localize(
          "project_profile_error_author",
          "Please enter the author.",
        );
      }

      return { sanitized, errors };
    },
    [localize, requireAuthor],
  );

  const externalDraft = useMemo(() => {
    const base = deriveDraft(content);
    if (!base.translatorName && userName) {
      return { ...base, translatorName: userName };
    }
    return base;
  }, [content, userName]);

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
      const effectiveTranslator = translatorValue.length ? translatorValue : null;
      const payloadMemo = buildMemoFromDraft(sanitized);

      try {
        await api.updateProject(token, projectId, {
          book_title: sanitized.bookTitleKo || undefined,
          author_name: sanitized.authorNameKo || undefined,
          translator_name: effectiveTranslator ?? undefined,
          description: sanitized.originalAuthorNotes || undefined,
          intention: undefined,
          memo: payloadMemo || undefined,
          meta: {
            author: sanitized.authorNameKo || null,
            translator: effectiveTranslator,
            bookTitleEn: sanitized.bookTitleEn || null,
            originalAuthorNotes: sanitized.originalAuthorNotes || null,
            translatorNotes: sanitized.translatorNotes || null,
            context: sanitized.originalAuthorNotes || null,
            notes: sanitized.translatorNotes || null,
            translationDirection: null,
          },
        });

        setLastSavedAt(new Date().toISOString());
        setError(null);
        onUpdated?.();

        const persistedDraft: ProfileDraft = {
          ...sanitized,
          translatorName: effectiveTranslator ?? "",
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
                'project_profile_error_generic',
                'Unable to save the project information.',
              ),
        );
      }
    },
    [computeValidation, localize, onUpdated, projectId, token, userName],
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
    (
      key: keyof ProfileDraft,
    ) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      const next = { ...draftRef.current, [key]: value };
      scheduleSave(next);
    },
    [scheduleSave],
  );

  type StatusTone = "info" | "warn" | "success" | "error";

  const statusInfo = useMemo<
    { icon: JSX.Element; label: string; tone: StatusTone } | null
  >(() => {
    switch (status) {
      case "saving":
        return {
          icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />,
          label: localize('project_profile_status_saving', 'Saving…'),
          tone: "info" as const,
        };
      case "dirty":
        return {
          icon: <Circle className="h-3.5 w-3.5 text-amber-500" />,
          label: localize(
            "project_profile_status_dirty",
            "Changes are waiting to be saved.",
          ),
          tone: "warn" as const,
        };
      case "saved":
        return {
          icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
          label: lastSavedAt
            ? localize(
                "project_profile_status_saved_at",
                "Last saved {{time}}",
                { time: new Date(lastSavedAt).toLocaleTimeString() },
              )
            : localize("project_profile_status_saved", "Saved."),
          tone: "success" as const,
        };
      case "error":
        return {
          icon: <AlertCircle className="h-3.5 w-3.5 text-rose-500" />,
          label: error ?? localize('project_profile_status_error', 'Failed to save profile.'),
          tone: "error" as const,
        };
      default:
        return null;
    }
  }, [error, lastSavedAt, localize, status]);

  return (
    <section className="space-y-3">
      {statusInfo && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {statusInfo.icon}
          <span>{statusInfo.label}</span>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          {localize('project_profile_field_book_title', 'Original title (required)')}
          <input
            value={draft.bookTitleKo}
            onChange={handleFieldChange("bookTitleKo")}
            className={`rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
              fieldErrors.bookTitleKo
                ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
            }`}
            placeholder={localize(
              'project_profile_placeholder_book_title',
              'e.g., Korean title',
            )}
          />
          {fieldErrors.bookTitleKo ? (
            <span className="text-[11px] text-rose-500">
              {fieldErrors.bookTitleKo}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          {localize('project_profile_field_author', 'Author (original)')}
          {requireAuthor ? '*' : ''}
          <input
            value={draft.authorNameKo}
            onChange={handleFieldChange("authorNameKo")}
            className={`rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
              fieldErrors.authorNameKo
                ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
            }`}
            placeholder={localize(
              'project_profile_placeholder_author',
              'e.g., Hong Gildong',
            )}
          />
          {fieldErrors.authorNameKo ? (
            <span className="text-[11px] text-rose-500">
              {fieldErrors.authorNameKo}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          {localize('project_profile_field_book_title_en', 'Book title (English)')}
          <input
            value={draft.bookTitleEn}
            onChange={handleFieldChange("bookTitleEn")}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder={localize(
              'project_profile_placeholder_book_title_en',
              'e.g., English Title',
            )}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          {localize('project_profile_field_translator', 'Translator')}
          <input
            value={draft.translatorName}
            onChange={handleFieldChange("translatorName")}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder={localize(
              'project_profile_placeholder_translator',
              'e.g., Translator Name',
            )}
          />
        </label>
      </div>
      <div className="grid gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          {localize('project_profile_field_author_notes', 'Author notes')}
          <textarea
            value={draft.originalAuthorNotes}
            onChange={handleFieldChange("originalAuthorNotes")}
            className="min-h-[88px] rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder={localize(
              'project_profile_placeholder_author_notes',
              'Capture author intent, background, or notes for readers.',
            )}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          {localize('project_profile_field_translator_notes', 'Translator notes')}
          <textarea
            value={draft.translatorNotes}
            onChange={handleFieldChange("translatorNotes")}
            className="min-h-[88px] rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder={localize(
              'project_profile_placeholder_translator_notes',
              'Share context or reminders for the translation team.',
            )}
          />
        </label>
      </div>
      {status === "error" && !(statusInfo && statusInfo.tone === "error") && (
        <p className="text-xs text-rose-500">
          {error ??
            localize(
              'project_profile_error_generic',
              'Unable to save the project information.',
            )}
        </p>
      )}
    </section>
  );
};

export default ProjectProfileCard;
