import { useCallback, useEffect, useMemo, useState } from "react";
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
}

interface ProfileDraft {
  title: string;
  author: string;
  context: string;
  translationDirection: string;
  notes: string;
}

const deriveDraft = (content?: ProjectContent | null): ProfileDraft => {
  const profile = content?.projectProfile;
  const meta = profile?.meta ?? {};
  return {
    title: (profile?.title ?? "").trim(),
    author: (meta.author as string | null | undefined)?.trim() ?? "",
    context:
      (meta.context as string | null | undefined)?.trim() ??
      profile?.description ??
      "",
    translationDirection:
      (meta.translationDirection as string | null | undefined)?.trim() ??
      profile?.intention ??
      "",
    notes:
      (meta.notes as string | null | undefined)?.trim() ?? profile?.memo ?? "",
  };
};

const buildMemoFromDraft = (draft: ProfileDraft) => {
  const lines: string[] = [];
  if (draft.author.trim()) lines.push(`Author: ${draft.author.trim()}`);
  if (draft.context.trim()) lines.push(`Context: ${draft.context.trim()}`);
  if (draft.notes.trim()) lines.push(draft.notes.trim());
  return lines.join("\n");
};

export const ProjectProfileCard = ({
  content,
  onUpdated,
  onActionReady,
}: ProjectProfileCardProps) => {
  const token = useAuthStore((state) => state.token);
  const projectId = useProjectStore((state) => state.activeProjectId);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(() => deriveDraft(content));

  const display = useMemo(() => deriveDraft(content), [content]);

  useEffect(() => {
    if (!isEditing) {
      setDraft(display);
    }
  }, [display, isEditing]);

  const handleEdit = useCallback(() => {
    setDraft(display);
    setIsEditing(true);
    setError(null);
  }, [display]);

  const handleCancel = useCallback(() => {
    setDraft(display);
    setIsEditing(false);
    setError(null);
  }, [display]);

  const handleSave = async () => {
    if (!token || !projectId) {
      setError("프로젝트 정보를 저장하려면 다시 로그인해 주세요.");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const trimmedTitle = draft.title.trim();
      const trimmedContext = draft.context.trim();
      const trimmedDirection = draft.translationDirection.trim();
      const trimmedNotes = draft.notes.trim();
      const trimmedAuthor = draft.author.trim();

      await api.updateProject(token, projectId, {
        title: trimmedTitle || undefined,
        description: trimmedContext,
        intention: trimmedDirection,
        memo: buildMemoFromDraft({
          ...draft,
          author: trimmedAuthor,
          context: trimmedContext,
          translationDirection: trimmedDirection,
          notes: trimmedNotes,
        }),
        meta: {
          author: trimmedAuthor || null,
          context: trimmedContext || null,
          notes: trimmedNotes || null,
          translationDirection: trimmedDirection || null,
        },
      });
      setIsEditing(false);
      onUpdated?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "프로젝트 정보를 저장하지 못했습니다.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const actionPayload = useMemo(
    () => ({ isEditing, startEdit: handleEdit }),
    [isEditing, handleEdit],
  );

  useEffect(() => {
    onActionReady?.(actionPayload);
    return () => onActionReady?.(null);
  }, [onActionReady, actionPayload]);

  const renderViewRow = (
    label: string,
    value?: string,
    multiline = false,
    className?: string,
  ) => (
    <div className={`flex items-start gap-3 ${className ?? ""}`}>
      <dt className="w-24 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`flex-1 text-sm text-slate-700 ${multiline ? "whitespace-pre-wrap" : ""}`}
      >
        {value?.trim() ? value : "—"}
      </dd>
    </div>
  );

  return (
    <section>
      {!isEditing && (
        <dl className="mt-4 grid gap-x-6 gap-y-3 md:grid-cols-2">
          {renderViewRow("Title", display.title)}
          {renderViewRow("Author", display.author)}
          {renderViewRow("Context", display.context)}
          {renderViewRow("Direction", display.translationDirection)}
          {renderViewRow("Notes", display.notes, true, "md:col-span-2")}
        </dl>
      )}

      {isEditing && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Title
            </label>
            <input
              type="text"
              value={draft.title}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, title: event.target.value }))
              }
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="프로젝트 제목"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Author
            </label>
            <input
              type="text"
              value={draft.author}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, author: event.target.value }))
              }
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="예: Jane Doe"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Context
            </label>
            <textarea
              value={draft.context}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, context: event.target.value }))
              }
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              rows={3}
              placeholder="작품 배경이나 장르 정보를 기록하세요."
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Translation Direction
            </label>
            <input
              type="text"
              value={draft.translationDirection}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  translationDirection: event.target.value,
                }))
              }
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="예: Korean → English"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Notes
            </label>
            <textarea
              value={draft.notes}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, notes: event.target.value }))
              }
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              rows={3}
              placeholder="추가 메모를 자유롭게 작성하세요."
            />
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              disabled={isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
              disabled={isSaving}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
};

export default ProjectProfileCard;
