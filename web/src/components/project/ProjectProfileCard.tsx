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
        errors.bookTitleKo = "도서 제목(원문)을 입력해 주세요.";
      }

      if (requireAuthor && !sanitized.authorNameKo) {
        errors.authorNameKo = "저자를 입력해 주세요.";
      }

      return { sanitized, errors };
    },
    [requireAuthor],
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
        setError("프로젝트 정보를 저장하려면 다시 로그인해 주세요.");
        return;
      }

      setStatus("saving");
      const { sanitized, errors } = computeValidation(snapshot);

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setStatus("error");
        setError("필수 항목을 입력해 주세요.");
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
          author_name: sanitized.authorNameKo || null,
          translator_name: effectiveTranslator,
          description: sanitized.originalAuthorNotes || null,
          intention: null,
          memo: payloadMemo || null,
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
            : "프로젝트 정보를 저장하지 못했습니다.",
        );
      }
    },
    [computeValidation, onUpdated, projectId, token, userName],
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
          label: "저장 중입니다…",
          tone: "info" as const,
        };
      case "dirty":
        return {
          icon: <Circle className="h-3.5 w-3.5 text-amber-500" />,
          label: "변경 사항이 저장 대기 중입니다.",
          tone: "warn" as const,
        };
      case "saved":
        return {
          icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
          label: lastSavedAt
            ? `마지막 저장 ${new Date(lastSavedAt).toLocaleTimeString()}`
            : "저장되었습니다.",
          tone: "success" as const,
        };
      case "error":
        return {
          icon: <AlertCircle className="h-3.5 w-3.5 text-rose-500" />,
          label: error ?? "프로필 저장 오류",
          tone: "error" as const,
        };
      default:
        return null;
    }
  }, [status, lastSavedAt, error]);

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
          도서 제목 (원문)*
          <input
            value={draft.bookTitleKo}
            onChange={handleFieldChange("bookTitleKo")}
            className={`rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
              fieldErrors.bookTitleKo
                ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
            }`}
            placeholder="예: 한국어 책 제목"
          />
          {fieldErrors.bookTitleKo ? (
            <span className="text-[11px] text-rose-500">
              {fieldErrors.bookTitleKo}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          저자 (원문){requireAuthor ? "*" : ""}
          <input
            value={draft.authorNameKo}
            onChange={handleFieldChange("authorNameKo")}
            className={`rounded border px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 ${
              fieldErrors.authorNameKo
                ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
            }`}
            placeholder="예: 홍길동"
          />
          {fieldErrors.authorNameKo ? (
            <span className="text-[11px] text-rose-500">
              {fieldErrors.authorNameKo}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          Book Title (English)
          <input
            value={draft.bookTitleEn}
            onChange={handleFieldChange("bookTitleEn")}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder="예: English Title"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          번역가
          <input
            value={draft.translatorName}
            onChange={handleFieldChange("translatorName")}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder="예: Translator Name"
          />
        </label>
      </div>
      <div className="grid gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          원작자 메모
          <textarea
            value={draft.originalAuthorNotes}
            onChange={handleFieldChange("originalAuthorNotes")}
            className="min-h-[88px] rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder="원작자의 의도나 배경, 독자에게 전달하고 싶은 메모를 기록해 주세요"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold tracking-wide text-slate-500">
          번역가 메모
          <textarea
            value={draft.translatorNotes}
            onChange={handleFieldChange("translatorNotes")}
            className="min-h-[88px] rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            placeholder="번역 시 주의할 점이나 팀과 공유할 메모를 적어주세요"
          />
        </label>
      </div>
      {status === "error" && !(statusInfo && statusInfo.tone === "error") && (
        <p className="text-xs text-rose-500">
          {error ?? "프로젝트 정보를 저장하지 못했습니다."}
        </p>
      )}
    </section>
  );
};

export default ProjectProfileCard;
