import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { ChatInput } from "./ChatInput";
import { ChatMessage } from "./ChatMessage";
import { QuickReplies, type QuickReplyItem } from "./QuickReplies";
import { useProjectStore } from "../../store/project.store";
import { useAuthStore } from "../../store/auth.store";
import { useUIStore } from "../../store/ui.store";
import { api } from "../../services/api";
import type {
  ChatAction,
  ChatMessagePayload,
  ProjectContent,
} from "../../types/domain";
import { useChatHistory } from "../../hooks/useChatHistory";
import { useCreateProject } from "../../hooks/useCreateProject";
import type { ProjectContextSnapshot } from "../../hooks/useProjectContext";
import { useTranslationAgent } from "../../hooks/useTranslationAgent";
import { useProofreadAgent } from "../../hooks/useProofreadAgent";
import { useQualityAgent } from "../../hooks/useQualityAgent";
import WorkflowTimeline from "./WorkflowTimeline";
import {
  useWorkflowGuideAgent,
  type WorkflowTask,
} from "../../agents/useWorkflowGuideAgent";
import { useModelSelection } from "../../hooks/useModelSelection";
import { useWorkflowSummary } from "../../hooks/useProjectData";
import {
  useEditingCommandStore,
  type EditingActionType,
  type EditingSuggestion,
  type EditorSelectionContext,
} from "../../store/editingCommand.store";
import {
  useChatInsightStore,
  type ProofIssueSummaryInsight,
} from "../../store/chatInsight.store";
import { useChatActionStore } from "../../store/chatAction.store";
import type { EditingSelectionPayload } from "../../types/domain";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";
import { Upload, Compass } from "lucide-react";

type MessageTone = "default" | "success" | "error";

type MessageRole = "assistant" | "user" | "system";

type StageKey = "origin" | "translation" | "proofreading" | "quality";

interface StageNote {
  message: string;
  badge?: Message["badge"];
  actions?: ChatAction[];
}

interface StageCardContent {
  text: string;
  badge?: Message["badge"] | null;
  actions?: ChatAction[] | null;
}

interface Message {
  id: string;
  role: MessageRole;
  text: string;
  badge?: {
    label: string;
    description?: string;
    tone?: MessageTone;
  };
  actions?: ChatAction[];
  anchorStage?: StageKey;
}

const SUPPORTED_ORIGIN_EXTENSIONS = [
  ".txt",
  ".doc",
  ".docx",
  ".pdf",
  ".epub",
  ".hwp",
  ".hwpx",
] as const;
const SUPPORTED_ORIGIN_LABEL = SUPPORTED_ORIGIN_EXTENSIONS.map((ext) =>
  ext.replace(".", "").toUpperCase(),
).join(", ");
const SUPPORTED_ORIGIN_HINT = SUPPORTED_ORIGIN_EXTENSIONS.join(", ");
const SUPPORTED_ORIGIN_ACCEPT = SUPPORTED_ORIGIN_EXTENSIONS.join(",");

const isSupportedOriginFile = (file: File | { name?: string }): boolean => {
  const name = file?.name?.toLowerCase() ?? "";
  return SUPPORTED_ORIGIN_EXTENSIONS.some((ext) => name.endsWith(ext));
};

const TRANSLATION_STAGE_ORDER = [
  "literal",
  "style",
  "emotion",
  "qa",
] as const;

const TRANSLATION_STAGE_FALLBACKS: Record<(typeof TRANSLATION_STAGE_ORDER)[number], string> = {
  literal: "직역",
  style: "스타일",
  emotion: "감정",
  qa: "QA",
};

const previewText = (value: string, limit = 160) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

const generateGuideTaskId = () =>
  `guide-task-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

const generateMessageId = () => {
  const cryptoObj =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    const segments = [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ];
    return segments.join("-");
  }
  return `msg-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
};

const getActionKey = (action: ChatAction) => {
  switch (action.type) {
    case "cancelTranslation":
      return `${action.type}:${action.jobId ?? ""}:${action.workflowRunId ?? ""}`;
    case "applyEditingSuggestion":
    case "undoEditingSuggestion":
    case "dismissEditingSuggestion":
      return `${action.type}:${action.suggestionId}`;
    default:
      return action.type;
  }
};

const mergeStageActions = (
  baseActions: ChatAction[],
  extraActions?: ChatAction[] | null,
): ChatAction[] | undefined => {
  const combined = [...baseActions, ...(extraActions ?? [])];
  const seen = new Set<string>();
  const deduped: ChatAction[] = [];
  combined.forEach((action) => {
    const key = getActionKey(action);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(action);
  });
  return deduped.length ? deduped : undefined;
};

const MAX_ASSISTANT_MESSAGE_CHARS = 200;
const MAX_ASSISTANT_MESSAGE_SENTENCES = 3;

const validateAssistantMessage = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  const length = trimmed.length;
  const sentenceCount = trimmed
    .split(/(?:[.!?]+|\n+)/)
    .map((segment) => segment.trim())
    .filter(Boolean).length;
  if (
    length > MAX_ASSISTANT_MESSAGE_CHARS ||
    sentenceCount > MAX_ASSISTANT_MESSAGE_SENTENCES
  ) {
    const preview = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    console.warn(
      `[chat] assistant message exceeds UX guard (length=${length}, sentences=${sentenceCount})`,
      preview,
    );
  }
};

interface ChatOrchestratorProps {
  content?: ProjectContent | null;
  snapshot: ProjectContextSnapshot;
  refreshProjectContext: (
    scope?: "content" | "jobs" | "all",
  ) => Promise<void> | void;
  onOriginSaved?: () => void;
  onTranslationCompleted?: () => void;
  onProofreadCompleted?: () => void;
  onQualityCompleted?: () => void;
  onProfileUpdated?: () => void;
}

export const ChatOrchestrator = ({
  content,
  snapshot,
  refreshProjectContext,
  onOriginSaved,
  onTranslationCompleted,
  onProofreadCompleted,
  onQualityCompleted,
  onProfileUpdated,
}: ChatOrchestratorProps) => {
  const { locale } = useUILocale();
  const localize = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const resolved = translate(key, locale, params);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
  const buildIntroMessage = useCallback(
    (): Message => ({
      id: "intro",
      role: "assistant",
      text: localize(
        "chat_intro_default",
        `안녕하세요, AI 번역·교정 파트너입니다. 원문(${SUPPORTED_ORIGIN_LABEL})을 올려 주시면 프로젝트를 준비하고 번역, 교정, 품질 평가까지 도와드릴게요. 파일을 드래그앤드롭하거나 궁금한 점을 자유롭게 물어봐 주세요.`,
        { formats: SUPPORTED_ORIGIN_LABEL },
      ),
    }),
    [localize],
  );
  const [messages, setMessages] = useState<Message[]>(() => [
    buildIntroMessage(),
  ]);
  const [quickReplies, setQuickReplies] = useState<QuickReplyItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [inputDraft, setInputDraft] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [insightCooldown, setInsightCooldown] = useState(false);
  const insightCooldownTimerRef = useRef<number | null>(null);
  const firstRunScriptShownRef = useRef(false);
  const stageAnchorRefs = useRef<Record<StageKey, HTMLElement | null>>({
    origin: null,
    translation: null,
    proofreading: null,
    quality: null,
  });
  const stageMessageRefs = useRef<Record<StageKey, string | null>>({
    origin: null,
    translation: null,
    proofreading: null,
    quality: null,
  });
  const proofSummaryMessageRef = useRef<string | null>(null);
  const [proofSummary, setProofSummary] =
    useState<ProofIssueSummaryInsight | null>(null);
  const lastProofSummaryRef = useRef<ProofIssueSummaryInsight | null>(null);
  const upsertStageMessage = useCallback(
    (stage: StageKey, content: StageCardContent) => {
      setMessages((prev) => {
        const existingId = stageMessageRefs.current[stage];
        const composeMessage = (id: string): Message => ({
          id,
          role: "assistant",
          text: content.text,
          badge: content.badge ?? undefined,
          actions:
            content.actions && content.actions.length
              ? content.actions
              : undefined,
          anchorStage: stage,
        });

        if (existingId) {
          const index = prev.findIndex((message) => message.id === existingId);
          if (index !== -1) {
            const next = [...prev];
            next[index] = composeMessage(existingId);
            return next;
          }
        }

        const nextId = generateMessageId();
        stageMessageRefs.current[stage] = nextId;
        return [...prev, composeMessage(nextId)];
      });
    },
    [setMessages],
  );
  const upsertProofSummaryMessage = useCallback(
    (content: StageCardContent) => {
      setMessages((prev) => {
        const existingId = proofSummaryMessageRef.current;
        const composeMessage = (id: string): Message => ({
          id,
          role: "assistant",
          text: content.text,
          badge: content.badge ?? undefined,
          actions:
            content.actions && content.actions.length
              ? content.actions
              : undefined,
        });

        if (existingId) {
          const currentIndex = prev.findIndex(
            (message) => message.id === existingId,
          );
          if (currentIndex !== -1) {
            const next = [...prev];
            next[currentIndex] = composeMessage(existingId);
            return next;
          }
        }

        const nextId = generateMessageId();
        proofSummaryMessageRef.current = nextId;
        const nextMessages = [...prev];
        const stageId = stageMessageRefs.current.proofreading;
        if (stageId) {
          const stageIndex = nextMessages.findIndex(
            (message) => message.id === stageId,
          );
          if (stageIndex !== -1) {
            nextMessages.splice(stageIndex, 0, composeMessage(nextId));
            return nextMessages;
          }
        }
        nextMessages.push(composeMessage(nextId));
        return nextMessages;
      });
    },
    [setMessages],
  );
  const resetProofSummaryState = useCallback(() => {
    proofSummaryMessageRef.current = null;
    lastProofSummaryRef.current = null;
    setProofSummary(null);
  }, []);
  const stageNotesRef = useRef<Record<StageKey, StageNote | null>>({
    origin: null,
    translation: null,
    proofreading: null,
    quality: null,
  });

  const token = useAuthStore((state) => state.token);
  const projectId = useProjectStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const { data: history, isLoading: isHistoryLoading } =
    useChatHistory(projectId);
  const historyLength = history?.length ?? 0;
  const { data: workflowSummary, refetch: refetchWorkflowSummary } =
    useWorkflowSummary(projectId);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const setTab = useUIStore((state) => state.setRightPanelTab);
  const triggerQualityDialog = useUIStore((state) => state.openQualityDialog);
  const setPreviewExpanded = useUIStore((state) => state.setPreviewExpanded);
  const { createProject, isCreating } = useCreateProject();
  const { currentModel: selectedModel } = useModelSelection();

  const pendingEditingAction = useEditingCommandStore(
    (state) => state.pendingAction,
  );
  const activeEditingAction = useEditingCommandStore(
    (state) => state.activeAction,
  );
  const clearPendingEditingAction = useEditingCommandStore(
    (state) => state.clearPendingAction,
  );
  const setActiveEditingAction = useEditingCommandStore(
    (state) => state.setActiveAction,
  );
  const addEditingSuggestion = useEditingCommandStore(
    (state) => state.addSuggestion,
  );
  const updateEditingSuggestion = useEditingCommandStore(
    (state) => state.updateSuggestion,
  );
  const removeEditingSuggestion = useEditingCommandStore(
    (state) => state.removeSuggestion,
  );
  const editorAdapter = useEditingCommandStore((state) => state.editorAdapter);
  const setEditingSelectionStore = useEditingCommandStore(
    (state) => state.setSelection,
  );
  const setChatActionExecutor = useChatActionStore((state) => state.setExecutor);
  const lastHandledEditingRef = useRef<string | null>(null);
  const insightQueueLength = useChatInsightStore((state) => state.queue.length);
  const dequeueInsight = useChatInsightStore((state) => state.dequeue);

  const currentProject = useMemo(
    () => projects.find((project) => project.project_id === projectId) ?? null,
    [projects, projectId],
  );

  const originText = content?.content?.origin?.content ?? "";
  const hasOrigin = Boolean(originText.trim());
  const translationText = content?.content?.translation?.content ?? "";
  const hasTranslation = Boolean(translationText.trim());
  const targetLang = currentProject?.target_lang;
  const translationJobId: string | null =
    content?.content?.translation?.jobId ?? content?.latestJob?.jobId ?? null;

  const [showUploader, setShowUploader] = useState(!hasOrigin);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setShowUploader(!hasOrigin);
  }, [hasOrigin]);

  const openFileDialog = useCallback(() => {
    setShowUploader(true);
    fileInputRef.current?.click();
  }, [setShowUploader]);

  const refreshWorkflowView = useCallback(() => {
    if (!projectId) return;
    void refetchWorkflowSummary();
  }, [projectId, refetchWorkflowSummary]);

  useEffect(() => {
    let mounted = true;
    api
      .chatPrompt()
      .then(({ prompt }) => {
        if (mounted) {
          setSystemPrompt(prompt);
        }
      })
      .catch((err) => {
        console.warn("[chat] failed to load system prompt", err);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (systemPrompt) {
      console.info("[chat] system prompt loaded");
    }
  }, [systemPrompt]);

  const pushMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const pushAssistant = useCallback(
    (
      text: string,
      badge?: Message["badge"],
      actions?: ChatAction[],
      persist = false,
      anchorStage?: StageKey,
    ) => {
      validateAssistantMessage(text);
      let appended = false;
      const message: Message = {
        id: generateMessageId(),
        role: "assistant",
        text,
        badge,
        actions,
        anchorStage,
      };

      setMessages((previous) => {
        if (!previous.length) {
          appended = true;
          return [message];
        }

        const next = [...previous];
        const lastIndex = next.length - 1;
        const last = next[lastIndex];
        if (
          last &&
          last.role === "assistant" &&
          last.text.trim() === text.trim()
        ) {
          next[lastIndex] = {
            ...last,
            badge: badge ?? last.badge,
            actions: actions ?? last.actions,
            anchorStage: anchorStage ?? last.anchorStage,
          };
          return next;
        }

        appended = true;
        next.push(message);
        return next;
      });

      if (appended && persist && token && projectId) {
        void api
          .chatLog(token, {
            projectId,
            role: "assistant",
            content: text,
            actions,
          })
          .catch((err) => {
            console.warn("[chat] failed to persist assistant message", err);
          });
      }
    },
    [projectId, token],
  );

  const handleQuickUpload = useCallback(() => {
    setShowUploader(true);
    openFileDialog();
    setQuickReplies([]);
  }, [openFileDialog, setShowUploader]);

  const handleQuickTour = useCallback(() => {
    pushAssistant(
      localize(
        "chat_tour_message",
        "번역 스튜디오 기능을 둘러보려면 우측 패널의 미리보기, 교정, 품질 탭을 차례로 살펴보세요. 필요하면 제가 각 단계를 안내해 드릴게요.",
      ),
      {
        label: localize("chat_tour_badge", "Studio tour"),
        tone: "default",
      },
    );
    setQuickReplies([]);
  }, [localize, pushAssistant]);

  const buildQuickReplies = useCallback((): QuickReplyItem[] => {
    const replies: QuickReplyItem[] = [];
    if (!hasOrigin) {
      replies.push({
        id: "quick-upload",
        label: localize("chat_quick_upload", "Upload origin"),
        icon: <Upload className="h-3 w-3" aria-hidden="true" />,
        onSelect: handleQuickUpload,
      });
    }
    replies.push({
      id: "quick-tour",
      label: localize("chat_quick_tour", "Take a tour"),
      icon: <Compass className="h-3 w-3" aria-hidden="true" />,
      onSelect: handleQuickTour,
    });
    return replies;
  }, [handleQuickTour, handleQuickUpload, hasOrigin, localize]);

  useEffect(() => {
    const shouldShow = historyLength === 0 && !isHistoryLoading;
    if (shouldShow) {
      setQuickReplies(buildQuickReplies());
    } else {
      setQuickReplies([]);
    }
  }, [buildQuickReplies, historyLength, isHistoryLoading]);

  useEffect(() => {
    if (!historyLoaded || isHistoryLoading) return;
    if (historyLength > 0) return;
    if (firstRunScriptShownRef.current) return;
    firstRunScriptShownRef.current = true;

    const lines = [
      localize(
        "chat_welcome_line_intro",
        "안녕하세요! 원문을 올리면 번역, 교정, QA와 전자책 제작까지 함께 도와드릴게요.",
      ),
      localize(
        "chat_welcome_line_actions",
        "지금 바로 원문을 업로드하거나, 둘러보기·샘플 프로젝트로 사용법을 살펴볼 수 있어요.",
      ),
      localize(
        "chat_welcome_line_tip",
        "궁금한 점은 언제든지 채팅으로 물어봐 주세요. 단계별 진행 상황은 상단 타임라인과 배지에서 확인할 수 있습니다.",
      ),
    ];

    lines.forEach((line, index) => {
      pushAssistant(
        line,
        index === 0
          ? {
              label: localize("chat_welcome_badge", "Welcome"),
              tone: "default",
            }
          : undefined,
      );
    });
    setQuickReplies(buildQuickReplies());
  }, [
    historyLoaded,
    isHistoryLoading,
    historyLength,
    localize,
    pushAssistant,
    buildQuickReplies,
  ]);

  const registerStageAnchor = useCallback((stage: StageKey, element: HTMLElement | null) => {
    const anchors = stageAnchorRefs.current;
    if (element) {
      anchors[stage] = element;
    } else if (anchors[stage]) {
      anchors[stage] = null;
    }
  }, []);

  const scrollToStage = useCallback(
    (stage: StageKey) => {
      const target = stageAnchorRefs.current[stage];
      if (!target) return;
      setShowScrollToLatest(false);
      setIsAtBottom(false);
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    [],
  );

  const refreshContentOnly = useCallback(
    () => refreshProjectContext("content"),
    [refreshProjectContext],
  );

  const {
    state: translationState,
    startTranslation,
    cancelTranslation,
  } = useTranslationAgent({
    token,
    projectId,
    originText,
    targetLang,
    pushAssistant,
    onCompleted: onTranslationCompleted,
    refreshContent: refreshContentOnly,
    isTranslationReady: () =>
      Boolean(
        content?.content?.translation?.content?.trim().length &&
          content?.documentProfiles?.translation,
      ),
    lifecycle: snapshot.lifecycle.translation,
  });

  const { state: proofreadingState, startProofread } = useProofreadAgent({
    token,
    projectId,
    translationJobId,
    hasTranslation,
    pushAssistant,
    onCompleted: onProofreadCompleted,
    refreshContent: refreshContentOnly,
    openProofreadTab: () => setTab("proofread:findings"),
    lifecycle: snapshot.lifecycle.proofreading,
  });

  const { state: qualityState, runQuality } = useQualityAgent({
    token,
    projectId,
    originText,
    translationText,
    translationJobId,
    pushAssistant,
    onCompleted: onQualityCompleted,
    refreshContent: refreshContentOnly,
    openQualityDialog: () => triggerQualityDialog(),
    lifecycle: snapshot.lifecycle.quality,
  });

  const processedTaskIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    processedTaskIdsRef.current.clear();
  }, [projectId]);

  const adaptActionsForOrigin = useCallback(
    (actions?: ChatAction[] | null): ChatAction[] | undefined => {
      if (!actions || actions.length === 0) {
        return undefined;
      }

      const adapted: ChatAction[] = [];

      actions.forEach((action) => {
        if (action.type === "startUploadFile") {
          if (hasOrigin) {
            return;
          }
          adapted.push(action);
          return;
        }

        if (action.type === "startTranslation") {
          if (!hasOrigin) {
            adapted.push({
              type: "startUploadFile",
              reason: action.reason,
              label: action.label ?? null,
              allowParallel: action.allowParallel,
              autoStart: false,
            });
            return;
          }

          if (
            translationState.status === "running" ||
            translationState.status === "queued" ||
            translationState.status === "done"
          ) {
            return;
          }
        }

        adapted.push(action);
      });

      return adapted.length ? adapted : undefined;
    },
    [hasOrigin, translationState.status],
  );

  const toSelectionPayload = useCallback(
    (selection: EditorSelectionContext): EditingSelectionPayload => ({
      source: selection.source,
      text: selection.text,
      rawText: selection.rawText ?? selection.text,
      range: selection.range,
      meta: selection.meta ?? null,
    }),
    [],
  );

  const guessEditingIntent = useCallback(
    (message: string): EditingActionType | null => {
      const normalized = message.toLowerCase();
      if (
        /(대명사|pronoun|she|he|they|그녀|그를|그녀로|그로|남성형|여성형)/.test(
          normalized,
        )
      ) {
        return "adjustPronoun";
      }
      if (
        /(이름|name|명칭|호칭)/.test(normalized) &&
        /(통일|맞춰|같게|consistent|統一|統合|unify|統一해)/.test(normalized)
      ) {
        return "normalizeName";
      }
      if (
        /(rewrite|다듬|수정|고쳐|다시 써|polish|improve|tone|정돈)/.test(
          normalized,
        )
      ) {
        return "rewrite";
      }
      return null;
    },
    [],
  );

  const buildSuggestionMessage = useCallback(
    (
      selection: EditorSelectionContext,
      suggestion: EditingSuggestion,
      warnings?: string[] | null,
    ) => {
      const beforePreview = previewText(selection.rawText ?? selection.text);
      const afterPreview = previewText(suggestion.resultText);
      const lines = [
        localize("chat_editing_suggestion_heading", "✏️ 수정 제안이 도착했어요."),
        localize("chat_editing_suggestion_original", `원문: ${beforePreview}`, {
          text: beforePreview,
        }),
        localize("chat_editing_suggestion_candidate", `제안: ${afterPreview}`, {
          text: afterPreview,
        }),
        suggestion.explanation
          ? localize(
              "chat_editing_suggestion_note",
              `메모: ${suggestion.explanation}`,
              { text: suggestion.explanation },
            )
          : null,
        warnings?.length
          ? localize(
              "chat_editing_suggestion_warning",
              `참고: ${warnings.join(" / ")}`,
              { text: warnings.join(" / ") },
            )
          : null,
      ];
      return lines.filter(Boolean).join("\n");
    },
    [localize],
  );

  const requestEditingSuggestion = useCallback(
    async (
      mode: EditingActionType,
      selection: EditorSelectionContext,
      instructions: string,
    ) => {
      if (!token || !projectId) {
        pushAssistant(
          localize(
            "chat_editing_project_required",
            "프로젝트가 선택되어야 수정 요청을 처리할 수 있어요.",
          ),
          {
            label: "Editing unavailable",
            tone: "error",
          },
        );
        return null;
      }

      const payload = {
        selection: toSelectionPayload(selection),
        prompt: instructions,
        locale: snapshot.targetLang ?? null,
        context: {
          projectId,
          selectionId: selection.id,
        },
      };

      try {
        if (mode === "rewrite") {
          return await api.rewriteSelection(token, projectId, payload);
        }
        if (mode === "normalizeName") {
          return await api.normalizeNameSelection(token, projectId, payload);
        }
        return await api.adjustPronounSelection(token, projectId, payload);
      } catch (error) {
        const fallbackReason = localize(
          "chat_error_generic",
          "요청을 처리하지 못했습니다.",
        );
        const reason = error instanceof Error ? error.message : fallbackReason;
        pushAssistant(
          localize(
            "chat_editing_request_failed",
            `수정 도우미 호출에 실패했습니다. (${reason})`,
            { reason },
          ),
          {
            label: "Editing error",
            tone: "error",
          },
        );
        return null;
      }
    },
    [
      projectId,
      pushAssistant,
      snapshot.targetLang,
      toSelectionPayload,
      token,
      localize,
    ],
  );

  const processEditingCommand = useCallback(
    async (
      mode: EditingActionType,
      instructions: string,
      selection: EditorSelectionContext,
    ) => {
      const trimmed = instructions.trim();
      if (!trimmed) {
        pushAssistant(
          localize(
            "chat_editing_instruction_missing",
            "원하는 수정 내용을 한두 문장으로 알려 주세요.",
          ),
          {
            label: "Editing",
            tone: "default",
          },
        );
        return;
      }

      const response = await requestEditingSuggestion(
        mode,
        selection,
        trimmed,
      );
      if (!response) {
        return;
      }

      const suggestionId =
        response.suggestionId?.trim() ||
        `editing-${Date.now().toString(16)}-${Math.random()
          .toString(16)
          .slice(2, 6)}`;

      const resolvedText =
        typeof response.resultText === "string" &&
        response.resultText.trim().length
          ? response.resultText
          : selection.text;
      const combinedWarnings = response.warnings ?? [];
      const noChangeWarning = localize(
        "chat_editing_warning_nochange",
        "새로운 제안을 만들지 못했습니다.",
      );
      const effectiveWarnings =
        resolvedText === selection.text
          ? [...combinedWarnings, noChangeWarning]
          : combinedWarnings;

      const suggestion: EditingSuggestion = {
        id: suggestionId,
        type: mode,
        selection,
        prompt: trimmed,
        resultText: resolvedText,
        explanation: response.explanation ?? null,
        createdAt: Date.now(),
        status: "pending",
        appliedAt: null,
        appliedRange: null,
        previousText: null,
        metadata: {
          warnings: effectiveWarnings,
          tokens: response.tokens ?? null,
        },
      };

      addEditingSuggestion(suggestion);
      pushAssistant(
        buildSuggestionMessage(
          selection,
          suggestion,
          effectiveWarnings,
        ),
        {
          label: localize(
            "chat_editing_label_suggestion",
            "Editing suggestion",
          ),
          tone: effectiveWarnings.length ? "default" : "success",
        },
        [
          { type: "applyEditingSuggestion", suggestionId },
          { type: "dismissEditingSuggestion", suggestionId },
        ],
      );
      setActiveEditingAction(null);
      setEditingSelectionStore(null);
      setQuickReplies([]);
      setInputDraft(null);
    },
    [
      addEditingSuggestion,
      buildSuggestionMessage,
      pushAssistant,
      requestEditingSuggestion,
      setActiveEditingAction,
      setEditingSelectionStore,
      setQuickReplies,
      setInputDraft,
      localize,
    ],
  );

  const buildEditingQuickReplies = useCallback(
    (mode: EditingActionType, selection: EditorSelectionContext): QuickReplyItem[] => {
      const items: QuickReplyItem[] = [];
      const run = (instruction: string) => {
        setQuickReplies([]);
        void processEditingCommand(mode, instruction, selection);
      };

      if (mode === "rewrite") {
        items.push({
          id: `${selection.id}-rewrite-soft`,
          label: localize(
            "chat_editing_quickrewrite_soft_label",
            "부드러운 톤",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickrewrite_soft_instruction",
                "문장을 더 부드럽고 자연스럽게 다듬어 주세요.",
              ),
            ),
        });
        items.push({
          id: `${selection.id}-rewrite-concise`,
          label: localize(
            "chat_editing_quickrewrite_concise_label",
            "간결하게",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickrewrite_concise_instruction",
                "불필요한 표현을 줄이고 간결하게 정리해 주세요.",
              ),
            ),
        });
        items.push({
          id: `${selection.id}-rewrite-formal`,
          label: localize(
            "chat_editing_quickrewrite_formal_label",
            "격식 있게",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickrewrite_formal_instruction",
                "격식 있고 전문적인 어조로 고쳐 주세요.",
              ),
            ),
        });
      } else if (mode === "normalizeName") {
        items.push({
          id: `${selection.id}-name-romanize`,
          label: localize(
            "chat_editing_quickname_romanize_label",
            "영문 표기로",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickname_romanize_instruction",
                "문장에 등장하는 이름을 일관된 영문 표기로 통일해 주세요.",
              ),
            ),
        });
        items.push({
          id: `${selection.id}-name-original`,
          label: localize(
            "chat_editing_quickname_original_label",
            "원문 표기 유지",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickname_original_instruction",
                "이름을 원문 표기대로 유지하도록 정리해 주세요.",
              ),
            ),
        });
        items.push({
          id: `${selection.id}-name-titlecase`,
          label: localize(
            "chat_editing_quickname_titlecase_label",
            "첫 글자 대문자",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickname_titlecase_instruction",
                "이름의 첫 글자를 대문자로 통일해 주세요.",
              ),
            ),
        });
      } else if (mode === "adjustPronoun") {
        items.push({
          id: `${selection.id}-pronoun-feminine`,
          label: localize(
            "chat_editing_quickpronoun_feminine_label",
            "그녀로 바꾸기",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickpronoun_feminine_instruction",
                "대상을 모두 '그녀'로 통일해 주세요.",
              ),
            ),
        });
        items.push({
          id: `${selection.id}-pronoun-neutral`,
          label: localize(
            "chat_editing_quickpronoun_neutral_label",
            "they 사용",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickpronoun_neutral_instruction",
                "성중립 대명사 they/them으로 바꿔 주세요.",
              ),
            ),
        });
        items.push({
          id: `${selection.id}-pronoun-formal`,
          label: localize(
            "chat_editing_quickpronoun_formal_label",
            "존댓말 유지",
          ),
          onSelect: () =>
            run(
              localize(
                "chat_editing_quickpronoun_formal_instruction",
                "문장의 대명사를 존댓말 어조에 맞게 다듬어 주세요.",
              ),
            ),
        });
      }

      if (items.length) {
        items.push({
          id: `${selection.id}-editing-cancel`,
          label: localize("chat_editing_quick_cancel", "취소"),
          onSelect: () => {
            setQuickReplies([]);
            setActiveEditingAction(null);
            setEditingSelectionStore(null);
            setInputDraft(null);
          },
        });
      }

      return items;
    },
    [
      localize,
      processEditingCommand,
      setQuickReplies,
      setActiveEditingAction,
      setEditingSelectionStore,
      setInputDraft,
    ],
  );

  const applyEditingSuggestion = useCallback(
    async (suggestionId: string) => {
      const { suggestions } = useEditingCommandStore.getState();
      const suggestion = suggestions[suggestionId];
      if (!suggestion) {
        pushAssistant(
          localize(
            "chat_editing_not_found",
            "해당 수정 제안을 찾지 못했습니다.",
          ),
          {
            label: "Editing",
            tone: "default",
          },
        );
        return;
      }
      if (suggestion.status === "applied") {
        pushAssistant(
          localize(
            "chat_editing_already_applied",
            "이미 적용된 제안입니다.",
          ),
          {
            label: "Editing",
            tone: "default",
          },
        );
        return;
      }
      if (!editorAdapter) {
        pushAssistant(
          localize(
            "chat_editing_editor_unavailable",
            "교정 편집기가 준비되지 않았습니다. 우측 편집기를 연 뒤 다시 시도해 주세요.",
          ),
          {
            label: "Editing",
            tone: "error",
          },
        );
        return;
      }

      const range = suggestion.selection.range;
      const expectedText = suggestion.selection.rawText ?? suggestion.selection.text;
      const result = editorAdapter.replaceText({
        range,
        expectedText,
        nextText: suggestion.resultText,
      });

      if (!result.ok) {
        const fallback = localize(
          "chat_editing_apply_failed",
          "선택한 문장이 변경되어 적용하지 못했습니다.",
        );
        pushAssistant(
          result.message ?? fallback,
          {
            label: "Editing",
            tone: "error",
          },
        );
        return;
      }

      updateEditingSuggestion(suggestionId, (current) => ({
        ...current,
        status: "applied",
        appliedAt: Date.now(),
        appliedRange: result.appliedRange ?? current.selection.range,
        previousText:
          result.previousText ?? current.previousText ?? expectedText,
      }));

      pushAssistant(
        localize("chat_editing_applied", "제안을 적용했습니다."),
        {
          label: localize("chat_editing_label_applied", "Editing applied"),
          tone: "success",
        },
        [
        { type: "undoEditingSuggestion", suggestionId },
      ]);
    },
    [editorAdapter, pushAssistant, updateEditingSuggestion, localize],
  );

  const undoEditingSuggestion = useCallback(
    async (suggestionId: string) => {
      const { suggestions } = useEditingCommandStore.getState();
      const suggestion = suggestions[suggestionId];
      if (!suggestion) {
        pushAssistant(
          localize(
            "chat_editing_not_found",
            "해당 수정 제안을 찾지 못했습니다.",
          ),
          {
            label: "Editing",
            tone: "default",
          },
        );
        return;
      }
      if (suggestion.status !== "applied") {
        pushAssistant(
          localize(
            "chat_editing_not_applied",
            "아직 적용되지 않은 제안입니다.",
          ),
          {
            label: "Editing",
            tone: "default",
          },
        );
        return;
      }
      if (!editorAdapter) {
        pushAssistant(
          localize(
            "chat_editing_editor_unavailable",
            "교정 편집기가 준비되지 않았습니다. 우측 편집기를 연 뒤 다시 시도해 주세요.",
          ),
          {
            label: "Editing",
            tone: "error",
          },
        );
        return;
      }

      const range = suggestion.appliedRange ?? suggestion.selection.range;
      const expectedText = suggestion.resultText;
      const fallbackOriginal =
        suggestion.previousText ??
        suggestion.selection.rawText ??
        suggestion.selection.text;

      const result = editorAdapter.replaceText({
        range,
        expectedText,
        nextText: fallbackOriginal,
      });

      if (!result.ok) {
        const fallback = localize(
          "chat_editing_undo_failed",
          "변경 내용을 되돌리지 못했습니다.",
        );
        pushAssistant(
          result.message ?? fallback,
          {
            label: "Editing",
            tone: "error",
          },
        );
        return;
      }

      updateEditingSuggestion(suggestionId, (current) => ({
        ...current,
        status: "pending",
        appliedAt: null,
        appliedRange: null,
        previousText: current.previousText ?? fallbackOriginal,
      }));

      pushAssistant(
        localize("chat_editing_undo_success", "변경을 되돌렸습니다."),
        {
          label: localize("chat_editing_label_undo", "Editing undo"),
          tone: "default",
        },
        [
          { type: "applyEditingSuggestion", suggestionId },
          { type: "dismissEditingSuggestion", suggestionId },
        ],
      );
    },
    [editorAdapter, pushAssistant, updateEditingSuggestion, localize],
  );

  const dismissEditingSuggestion = useCallback(
    (suggestionId: string) => {
      const { suggestions } = useEditingCommandStore.getState();
      if (!suggestions[suggestionId]) {
        pushAssistant(
          localize(
            "chat_editing_not_found",
            "해당 수정 제안을 찾지 못했습니다.",
          ),
          {
            label: "Editing",
            tone: "default",
          },
        );
        return;
      }
      removeEditingSuggestion(suggestionId);
      pushAssistant(
        localize("chat_editing_dismissed", "이 제안을 무시했습니다."),
        {
          label: "Editing",
          tone: "default",
        },
      );
    },
    [pushAssistant, removeEditingSuggestion, localize],
  );

  useEffect(() => {
    if (!pendingEditingAction) return;
    const { selection, type } = pendingEditingAction;
    if (lastHandledEditingRef.current === selection.id) {
      clearPendingEditingAction();
      return;
    }

    setActiveEditingAction(type);

    const snippet = previewText(selection.text);

    if (type === "rewrite") {
      pushAssistant(
        localize(
          "chat_editing_prompt_rewrite",
          `선택한 문장을 다듬어 볼까요?\n> ${snippet}`,
          { snippet },
        ),
        {
          label: "Editing",
          tone: "default",
        },
      );
      setInputDraft({
        id: selection.id,
        text: `${selection.text}\n\n${localize(
          "chat_editing_input_rewrite",
          "이 문장을 어떻게 수정하고 싶으신가요?",
        )}`,
      });
    } else if (type === "normalizeName") {
      pushAssistant(
        localize(
          "chat_editing_prompt_name",
          `이 문장에서 어떤 이름을 통일하고 싶으신가요?\n> ${snippet}`,
          { snippet },
        ),
        {
          label: "Name consistency",
          tone: "default",
        },
      );
      setInputDraft({
        id: selection.id,
        text: localize(
          "chat_editing_input_name",
          `예) "민서"를 "Minseo"로 통일해 주세요`,
        ),
      });
    } else if (type === "adjustPronoun") {
      pushAssistant(
        localize(
          "chat_editing_prompt_pronoun",
          `대명사를 어떻게 바꾸고 싶으신가요?\n> ${snippet}`,
          { snippet },
        ),
        {
          label: "Pronoun",
          tone: "default",
        },
      );
      setInputDraft({
        id: selection.id,
        text: localize(
          "chat_editing_input_pronoun",
          `예) "그" 대신 "그녀"를 사용해 주세요`,
        ),
      });
    }

    const replies = buildEditingQuickReplies(type, selection);
    setQuickReplies(replies);

    lastHandledEditingRef.current = selection.id;
    clearPendingEditingAction();
  }, [
    pendingEditingAction,
    clearPendingEditingAction,
    pushAssistant,
    setInputDraft,
    setActiveEditingAction,
    localize,
    buildEditingQuickReplies,
    setQuickReplies,
  ]);

  useEffect(() => () => {
    if (insightCooldownTimerRef.current !== null) {
      window.clearTimeout(insightCooldownTimerRef.current);
    }
  }, []);
  const translationStage =
    snapshot.lifecycle.translation?.stage?.toLowerCase() ?? "none";
  const proofreadingStage =
    snapshot.lifecycle.proofreading?.stage?.toLowerCase() ?? "none";
  const qualityStage =
    snapshot.lifecycle.quality?.stage?.toLowerCase() ?? "none";

  const translationWorkflow = useMemo(
    () =>
      workflowSummary?.state.find((item) => item.type === "translation") ??
      null,
    [workflowSummary],
  );

  const proofreadingWorkflow = useMemo(
    () =>
      workflowSummary?.state.find((item) => item.type === "proofread") ?? null,
    [workflowSummary],
  );

  const qualityWorkflow = useMemo(
    () =>
      workflowSummary?.state.find((item) => item.type === "quality") ?? null,
    [workflowSummary],
  );

  const nextTranslationLabel = useMemo(() => {
    const translationRuns = (workflowSummary?.recentRuns ?? []).filter(
      (run) => run.type === "translation",
    );
    const highestSequence = translationRuns.reduce(
      (max, run) => Math.max(max, run.sequence ?? 0),
      0,
    );
    if (!projectId) return null;
    const sequence = highestSequence + 1;
    return localize(
      "chat_translation_run_label",
      `번역 ${sequence}차`,
      { sequence },
    );
  }, [localize, workflowSummary, projectId]);

  const translationVisual = useMemo(() => {
    const summaryStatus = translationWorkflow?.status ?? "idle";
    const summaryRunning =
      summaryStatus === "running" || summaryStatus === "pending";
    const summaryDone = summaryStatus === "succeeded";
    const summaryFailed =
      summaryStatus === "failed" || summaryStatus === "cancelled";

    const overall = {
      running:
        summaryRunning ||
        translationState.status === "running" ||
        translationState.status === "queued" ||
        translationStage === "translating",
      done:
        summaryDone ||
        translationState.status === "done" ||
        hasTranslation ||
        translationStage === "translated",
      failed:
        summaryFailed ||
        translationState.status === "failed" ||
        translationStage === "failed",
    };

    const totalSegments = translationState.totalSegments ?? 0;
    const needsReviewCount = translationState.needsReviewCount ?? 0;
    const stageCounts = translationState.stageCounts ?? {};
    const completedStages = translationState.completedStages ?? [];
    const currentStage = translationState.currentStage ?? null;
    const guardFailures = translationState.guardFailures ?? {};
    const flaggedSegments = translationState.flaggedSegments ?? [];

    const sequential = totalSegments
      ? {
          stages: TRANSLATION_STAGE_ORDER.map((stage) => {
            const isCompleted = completedStages.includes(stage);
            const isCurrent = currentStage === stage;
            let state: "pending" | "running" | "done" | "failed" = "pending";
            if (overall.failed) {
              state = "failed";
            } else if (isCompleted) {
              state = "done";
            } else if (isCurrent) {
              state = "running";
            }
            return {
              key: stage,
              label: localize(
                `chat_stage_${stage}`,
                TRANSLATION_STAGE_FALLBACKS[stage] ?? stage,
              ),
              state,
              count: stageCounts[stage] ?? 0,
            };
          }),
          totalSegments,
          needsReviewCount,
          guardFailures,
          flaggedSegments,
        }
      : null;

    return {
      overall,
      sequential,
    };
  }, [
    translationWorkflow,
    translationState.status,
    translationState.stageCounts,
    translationState.completedStages,
    translationState.currentStage,
    translationState.totalSegments,
    translationState.needsReviewCount,
    translationState.guardFailures,
    translationState.flaggedSegments,
    translationStage,
    hasTranslation,
    localize,
  ]);

  const proofreadingVisual = useMemo(() => {
    const summaryStatus = proofreadingWorkflow?.status ?? "idle";
    const summaryRunning =
      summaryStatus === "running" || summaryStatus === "pending";
    const summaryDone = summaryStatus === "succeeded";
    const summaryFailed =
      summaryStatus === "failed" || summaryStatus === "cancelled";
    const failed =
      summaryFailed ||
      proofreadingState.status === "failed" ||
      proofreadingStage === "failed";
    const running =
      !failed &&
      (summaryRunning ||
        proofreadingState.status === "running" ||
        proofreadingState.status === "queued" ||
        proofreadingStage === "running" ||
        proofreadingStage === "queued");
    const done =
      !failed &&
      !running &&
      (summaryDone ||
        proofreadingState.status === "done" ||
        proofreadingStage === "done");

    return { running, done, failed };
  }, [proofreadingWorkflow, proofreadingState.status, proofreadingStage]);

  const qualityVisual = useMemo(() => {
    const summaryStatus = qualityWorkflow?.status ?? "idle";
    const summaryRunning =
      summaryStatus === "running" || summaryStatus === "pending";
    const summaryDone = summaryStatus === "succeeded";
    const summaryFailed =
      summaryStatus === "failed" || summaryStatus === "cancelled";

    return {
      running:
        summaryRunning ||
        qualityState.status === "running" ||
        qualityStage === "running",
      done:
        summaryDone ||
        qualityState.status === "done" ||
        qualityStage === "done",
      failed:
      summaryFailed ||
      qualityState.status === "failed" ||
      qualityStage === "failed",
    };
  }, [qualityWorkflow, qualityState.status, qualityStage]);

  const translationDone = translationVisual.overall.done;

  interface ProofSummaryView {
    text: string;
    actions: ChatAction[] | null;
    tone: MessageTone;
  }

  const composeProofSummaryView = useCallback(
    (summary: ProofIssueSummaryInsight | null): ProofSummaryView | null => {
      if (!summary) return null;

      if (summary.totalCount === 0) {
        const lines = [
          localize(
            "chat_proof_summary_empty_headline",
            "지금은 교정할 문제가 없어요.",
          ),
          localize(
            "chat_proof_summary_empty_detail",
            "새 교정 결과가 준비되면 바로 알려드릴게요.",
          ),
        ];
        return {
          text: lines.join("\n"),
          actions: translationDone ? [{ type: "startProofread" }] : null,
          tone: "default",
        };
      }

      const progress = localize(
        "chat_proof_summary_progress",
        `해결됨 ${summary.resolvedCount}/${summary.totalCount}`,
        {
          resolved: summary.resolvedCount,
          total: summary.totalCount,
        },
      );

      if (summary.readyForQuality) {
        const lines = [
          localize(
            "chat_proof_summary_done_headline",
            "교정이 모두 끝났어요!",
          ),
          localize(
            "chat_proof_summary_done_detail",
            `${progress}. 품질 평가로 넘어가 볼까요?`,
            { progress },
          ),
        ];
        return {
          text: lines.join("\n"),
          actions: [{ type: "startQuality" }],
          tone: "success",
        };
      }

      const lines: string[] = [
        localize(
          "chat_proof_summary_pending_headline",
          `${progress}. 아직 ${summary.pendingCount}건 남아 있어요.`,
          {
            progress,
            pending: summary.pendingCount,
          },
        ),
      ];

      const highlight = summary.exampleIssues[0];
      if (highlight) {
        lines.push(
          localize(
            "chat_proof_summary_pending_detail_highlight",
            `${highlight.title}부터 Proofread 탭에서 같이 정리해요.`,
            { title: highlight.title },
          ),
        );
      } else {
        lines.push(
          localize(
            "chat_proof_summary_pending_detail",
            "Proofread 탭에서 남은 항목을 함께 정리해요.",
          ),
        );
      }

      return {
        text: lines.join("\n"),
        actions: [{ type: "openProofreadTab" }],
        tone: "default",
      };
    },
    [localize, translationDone],
  );

  useEffect(() => {
    if (!insightQueueLength || insightCooldown) return;
    const insight = dequeueInsight();
    if (!insight) return;

    if (insight.type === "proofIssueSummary") {
      lastProofSummaryRef.current = insight;
      setProofSummary(insight);
      const summaryView = composeProofSummaryView(insight);
      if (summaryView) {
        upsertProofSummaryMessage({
          text: summaryView.text,
          badge: {
            label: localize("chat_proof_summary_badge", "Proofread 요약"),
            tone: summaryView.tone,
          },
          actions: summaryView.actions,
        });
      }
    }

    insightCooldownTimerRef.current = window.setTimeout(() => {
      insightCooldownTimerRef.current = null;
      setInsightCooldown(false);
    }, 900);
    setInsightCooldown(true);
  }, [
    insightQueueLength,
    insightCooldown,
    dequeueInsight,
    composeProofSummaryView,
    setProofSummary,
    upsertProofSummaryMessage,
    localize,
  ]);

  const buildOriginStageContent = useCallback((): StageCardContent => {
    const note = stageNotesRef.current.origin;
    const hasOriginFile = Boolean(snapshot.origin?.hasContent);
    const filename = snapshot.origin?.filename ?? null;
    const lines: string[] = [];

    if (hasOriginFile) {
      lines.push(
        localize("chat_stage_origin_ready", "원문이 준비되었습니다."),
      );
    } else {
      lines.push(
        localize(
          "chat_stage_origin_missing_short",
          "원문을 업로드하면 바로 시작할 수 있어요.",
        ),
      );
    }

    if (hasOriginFile && filename) {
      lines.push(
        localize(
          "chat_stage_origin_filename",
          `파일: ${filename}`,
          { filename },
        ),
      );
    }
    if (note?.message) {
      lines.push(note.message);
    }

    const baseActions: ChatAction[] = [];
    if (!hasOriginFile) {
      baseActions.push({
        type: "startUploadFile",
        reason: "origin-stage-card",
      });
    } else {
      if (!translationVisual.overall.running && !translationVisual.overall.done) {
        baseActions.push({
          type: "startTranslation",
          label: nextTranslationLabel ?? translationWorkflow?.label ?? null,
        });
      }
      if (translationVisual.overall.done || snapshot.translation?.hasContent) {
        baseActions.push({ type: "viewTranslatedText" });
      }
    }

    const actions = mergeStageActions(baseActions, note?.actions);

    return {
      text: lines.join("\n"),
      badge:
        note?.badge ??
        {
          label: localize("chat_stage_origin_badge", "Origin stage"),
          tone: hasOriginFile ? "success" : "default",
        },
      actions: actions ?? null,
    };
  }, [
    localize,
    nextTranslationLabel,
    snapshot.origin?.filename,
    snapshot.origin?.hasContent,
    snapshot.translation?.hasContent,
    translationVisual.overall.done,
    translationVisual.overall.running,
    translationWorkflow?.label,
  ]);

  const buildTranslationStageContent = useCallback((): StageCardContent => {
    const note = stageNotesRef.current.translation;
    const { overall, sequential } = translationVisual;
    const completedCount = sequential
      ? sequential.stages.filter((stage) => stage.state === "done").length
      : 0;
    const totalStages = sequential?.stages.length ?? TRANSLATION_STAGE_ORDER.length;
    const runningStage = sequential?.stages.find(
      (stage) => stage.state === "running",
    );
    const guardAlertCount = sequential
      ? Object.entries(sequential.guardFailures ?? {})
          .filter(([key]) => key !== "allOk")
          .reduce((acc, [, value]) => acc + Number(value ?? 0), 0)
      : 0;
    const flaggedCount = sequential?.flaggedSegments?.length ?? 0;

    let headline: string;
    let tone: MessageTone = "default";

    if (translationState.status === "queued") {
      headline = localize(
        "chat_stage_translation_queued",
        "번역이 대기열에 있습니다.",
      );
    } else if (overall.failed) {
      headline = localize(
        "chat_stage_translation_failed",
        "번역 작업이 실패했습니다.",
      );
      tone = "error";
    } else if (overall.running) {
      if (runningStage) {
        headline = localize(
          "chat_stage_translation_running_stage",
          `${runningStage.label} 단계 진행 중`,
          { stage: runningStage.label },
        );
      } else {
        headline = localize(
          "chat_stage_translation_running",
          "번역이 진행 중입니다.",
        );
      }
    } else if (overall.done) {
      headline = localize(
        "chat_stage_translation_done",
        "번역이 완료되었습니다.",
      );
      tone = "success";
    } else if (hasOrigin) {
      headline = localize(
        "chat_stage_translation_ready",
        "번역을 시작할 준비가 완료되었습니다.",
      );
    } else {
      headline = localize(
        "chat_stage_translation_waiting_origin",
        "원문을 업로드하면 번역을 시작할 수 있어요.",
      );
    }

    const lines: string[] = [headline];

    if (
      overall.running &&
      translationState.progressTotal > 0 &&
      translationState.progressCompleted >= 0
    ) {
      const currentPass = Math.min(
        translationState.progressTotal,
        translationState.progressCompleted < translationState.progressTotal
          ? translationState.progressCompleted + 1
          : translationState.progressTotal,
      );
      lines.push(
        localize(
          "chat_stage_translation_pass_progress",
          `진행 중인 패스: ${currentPass}/${translationState.progressTotal}`,
          {
            current: currentPass,
            total: translationState.progressTotal,
          },
        ),
      );
    }

    if (sequential) {
      lines.push(
        localize(
          "chat_stage_translation_stage_progress",
          `단계 진행률: ${completedCount}/${totalStages}`,
          { completed: completedCount, total: totalStages },
        ),
      );
      if (sequential.totalSegments > 0) {
        lines.push(
          localize(
            "chat_stage_translation_segments",
            `총 문장 수: ${sequential.totalSegments}`,
            { count: sequential.totalSegments },
          ),
        );
      }
      if (sequential.needsReviewCount > 0) {
        lines.push(
          localize(
            "chat_stage_translation_needs_review",
            `검토 필요 문장: ${sequential.needsReviewCount}`,
            { count: sequential.needsReviewCount },
          ),
        );
      }
    }

    if (guardAlertCount > 0) {
      lines.push(
        localize(
          "chat_stage_translation_guards",
          `가드 경고: ${guardAlertCount}건`,
          { count: guardAlertCount },
        ),
      );
    }

    if (flaggedCount > 0) {
      lines.push(
        localize(
          "chat_stage_translation_flagged",
          `플래그된 문장: ${flaggedCount}개`,
          { count: flaggedCount },
        ),
      );
    }

    if (translationState.lastMessage && overall.running) {
      lines.push(translationState.lastMessage);
    }

    if (translationState.lastError && overall.failed) {
      lines.push(translationState.lastError);
    }

    if (note?.message) {
      lines.push(note.message);
    }

    const baseActions: ChatAction[] = [{ type: "viewTranslationStatus" }];
    if (overall.running && translationState.jobId) {
      baseActions.push({
        type: "cancelTranslation",
        jobId: translationState.jobId,
      });
    }
    if (!overall.running && hasOrigin && !overall.done) {
      baseActions.push({
        type: "startTranslation",
        label: nextTranslationLabel ?? translationWorkflow?.label ?? null,
      });
    }
    if (overall.done) {
      baseActions.push({ type: "viewTranslatedText" });
      baseActions.push({ type: "startProofread" });
    }
    if (overall.failed) {
      baseActions.push({
        type: "startTranslation",
        label: nextTranslationLabel ?? translationWorkflow?.label ?? null,
      });
    }

    const actions = mergeStageActions(baseActions, note?.actions);

    return {
      text: lines.join("\n"),
      badge:
        note?.badge ??
        {
          label: localize("chat_stage_translation_badge", "Translation stage"),
          tone,
        },
      actions: actions ?? null,
    };
  }, [
    hasOrigin,
    localize,
    nextTranslationLabel,
    translationState.jobId,
    translationState.lastError,
    translationState.lastMessage,
    translationState.progressCompleted,
    translationState.progressTotal,
    translationState.status,
    translationVisual,
    translationWorkflow?.label,
  ]);

  const buildProofreadingStageContent = useCallback((): StageCardContent => {
    const note = stageNotesRef.current.proofreading;
    const badgeLabel = localize("chat_stage_proof_badge", "Proofread stage");

    if (proofreadingVisual.failed || proofreadingState.status === "failed") {
      const lines = [
        localize(
          "chat_stage_proof_failed",
          "교정 작업이 실패했습니다.",
        ),
      ];
      if (proofreadingState.lastError) {
        lines.push(proofreadingState.lastError);
      }
      if (note?.message) {
        lines.push(note.message);
      }
      const actions = mergeStageActions([], note?.actions);
      return {
        text: lines.join("\n"),
        badge:
          note?.badge ?? {
            label: badgeLabel,
            tone: "error",
          },
        actions: actions ?? null,
      };
    }

    if (
      proofreadingVisual.running ||
      proofreadingState.status === "running" ||
      proofreadingState.status === "queued"
    ) {
      const lines = [
        localize(
          "chat_stage_proof_running",
          "교정이 진행 중입니다.",
        ),
      ];
      if (proofreadingState.lastMessage) {
        lines.push(proofreadingState.lastMessage);
      }
      if (proofreadingState.isStalled) {
        lines.push(
          localize(
            "chat_stage_proof_stalled",
            "최근 하트비트가 없어 작업이 지연된 것 같아요.",
          ),
        );
      }
      if (note?.message) {
        lines.push(note.message);
      }
      const actions = mergeStageActions([], note?.actions);
      return {
        text: lines.join("\n"),
        badge:
          note?.badge ?? {
            label: badgeLabel,
            tone: "default",
          },
        actions: actions ?? null,
      };
    }

    const summaryView = composeProofSummaryView(proofSummary);
    if (summaryView) {
      const lines = [summaryView.text];
      if (note?.message) {
        lines.push(note.message);
      }
      const baseActions = summaryView.actions ? [...summaryView.actions] : [];
      const actions = mergeStageActions(baseActions, note?.actions);
      return {
        text: lines.join("\n"),
        badge:
          note?.badge ?? {
            label: badgeLabel,
            tone: summaryView.tone,
          },
        actions: actions ?? null,
      };
    }

    const lines = [
      localize(
        "chat_stage_proof_ready",
        "교정을 시작해 보세요.",
      ),
    ];
    if (note?.message) {
      lines.push(note.message);
    }
    const baseActions: ChatAction[] = [];
    if (translationVisual.overall.done) {
      baseActions.push({ type: "startProofread" });
    }
    const actions = mergeStageActions(baseActions, note?.actions);

    return {
      text: lines.join("\n"),
      badge:
        note?.badge ?? {
          label: badgeLabel,
          tone: "default",
        },
      actions: actions ?? null,
    };
  }, [
    composeProofSummaryView,
    localize,
    proofSummary,
    proofreadingState.isStalled,
    proofreadingState.lastError,
    proofreadingState.lastMessage,
    proofreadingState.status,
    proofreadingVisual.failed,
    proofreadingVisual.running,
    translationVisual.overall.done,
  ]);

  const buildQualityStageContent = useCallback((): StageCardContent => {
    const note = stageNotesRef.current.quality;
    const { running, done, failed } = qualityVisual;
    let headline: string;
    let tone: MessageTone = "default";

    if (failed || qualityState.status === "failed") {
      headline = localize(
        "chat_stage_quality_failed",
        "품질 평가가 실패했습니다.",
      );
      tone = "error";
    } else if (running || qualityState.status === "running") {
      headline = localize(
        "chat_stage_quality_running",
        "품질 평가 중입니다.",
      );
    } else if (done || qualityState.status === "done") {
      headline = localize(
        "chat_stage_quality_done",
        "품질 평가가 완료되었습니다.",
      );
      tone = "success";
    } else {
      headline = localize(
        "chat_stage_quality_ready",
        "품질 평가를 실행해 보세요.",
      );
    }

    const lines: string[] = [headline];

    if (qualityState.score != null && (done || qualityState.status === "done")) {
      const roundedScore = Math.round(Number(qualityState.score) * 10) / 10;
      lines.push(
        localize(
          "chat_stage_quality_score",
          `품질 점수: ${roundedScore}`,
          { score: roundedScore },
        ),
      );
    }

    if (qualityState.lastError && (failed || qualityState.status === "failed")) {
      lines.push(qualityState.lastError);
    }

    if (note?.message) {
      lines.push(note.message);
    }

    const baseActions: ChatAction[] = [];
    if (!running && !done && (proofreadingVisual.done || translationVisual.overall.done)) {
      baseActions.push({ type: "startQuality" });
    }
    if (done) {
      baseActions.push({ type: "viewQualityReport" });
    }

    const actions = mergeStageActions(baseActions, note?.actions);

    return {
      text: lines.join("\n"),
      badge:
        note?.badge ??
        {
          label: localize("chat_stage_quality_badge", "Quality stage"),
          tone,
        },
      actions: actions ?? null,
    };
  }, [
    localize,
    proofreadingVisual.done,
    qualityState.lastError,
    qualityState.score,
    qualityState.status,
    qualityVisual,
      translationVisual.overall.done,
  ]);

  const applyOriginStageCard = useCallback(() => {
    upsertStageMessage("origin", buildOriginStageContent());
  }, [buildOriginStageContent, upsertStageMessage]);

  const applyTranslationStageCard = useCallback(() => {
    upsertStageMessage("translation", buildTranslationStageContent());
  }, [buildTranslationStageContent, upsertStageMessage]);

  const applyProofreadingStageCard = useCallback(() => {
    upsertStageMessage("proofreading", buildProofreadingStageContent());
  }, [buildProofreadingStageContent, upsertStageMessage]);

  const applyQualityStageCard = useCallback(() => {
    upsertStageMessage("quality", buildQualityStageContent());
  }, [buildQualityStageContent, upsertStageMessage]);

  useEffect(() => {
    applyOriginStageCard();
  }, [applyOriginStageCard]);

  useEffect(() => {
    applyTranslationStageCard();
  }, [applyTranslationStageCard]);

  useEffect(() => {
    applyProofreadingStageCard();
  }, [applyProofreadingStageCard]);

  useEffect(() => {
    applyQualityStageCard();
  }, [applyQualityStageCard]);

  const enqueueTask = useCallback(
    (task: WorkflowTask) => {
      const normalized: WorkflowTask = {
        ...task,
        id: task.id ?? generateGuideTaskId(),
      };

      if (processedTaskIdsRef.current.has(normalized.id!)) {
        return;
      }
      processedTaskIdsRef.current.add(normalized.id!);

      const actions = adaptActionsForOrigin(
        normalized.actions as ChatAction[] | undefined,
      );

      if (normalized.stage) {
        stageNotesRef.current[normalized.stage] = {
          message: normalized.message,
          badge: normalized.badge,
          actions: actions,
        };

        switch (normalized.stage) {
          case "origin":
            applyOriginStageCard();
            break;
          case "translation":
            applyTranslationStageCard();
            break;
          case "proofreading":
            applyProofreadingStageCard();
            break;
          case "quality":
            applyQualityStageCard();
            break;
          default:
            break;
        }
        return;
      }

      pushAssistant(
        normalized.message,
        normalized.badge,
        actions,
        true,
        normalized.stage,
      );
    },
    [
      adaptActionsForOrigin,
      applyOriginStageCard,
      applyProofreadingStageCard,
      applyQualityStageCard,
      applyTranslationStageCard,
      pushAssistant,
    ],
  );

  useWorkflowGuideAgent({
    projectId,
    snapshot,
    content,
    queueTask: enqueueTask,
  });

  const toPayload = useCallback(
    (msgs: Message[]): ChatMessagePayload[] =>
      msgs.slice(-20).map((msg) => ({ role: msg.role, content: msg.text })),
    [],
  );

  const buildContextSummary = useCallback(() => {
    if (!snapshot.projectId) {
      return [
        "You are the project concierge for a translation workflow. No project is active yet.",
        `When the user uploads an origin file (${SUPPORTED_ORIGIN_LABEL}) you should create a warm onboarding response and explain how you will manage translation, proofreading, and publishing.`,
      ].join(" ");
    }

    const stageLabel = (stage: string) => stage.replace(/-/g, " ");

    const originDetails = snapshot.origin.hasContent
      ? `Origin text is saved${snapshot.origin.filename ? ` as ${snapshot.origin.filename}` : ""} and last updated ${snapshot.origin.lastUpdatedAt ?? "at an unknown time"}; it is ${snapshot.ui.originExpanded ? "already open" : "available"} in the preview panel.`
      : "Origin text has not been provided yet; invite the user to upload or paste it.";

    const translationLifecycle = snapshot.lifecycle.translation;
    const translationDetails = (() => {
      if (snapshot.translation.hasContent) {
        return `Translation output exists (stage: ${stageLabel(translationLifecycle.stage)}) and was last updated ${snapshot.translation.lastUpdatedAt ?? translationLifecycle.lastUpdatedAt ?? "at an unknown time"}; it is ${snapshot.ui.translationExpanded ? "expanded" : "collapsed"} in the preview.`;
      }
      if (translationLifecycle.stage === "translating") {
        const progress =
          snapshot.jobs.batchesCompleted !== null &&
          snapshot.jobs.batchesTotal !== null
            ? ` (${snapshot.jobs.batchesCompleted}/${snapshot.jobs.batchesTotal})`
            : "";
        return `A translation job (${translationLifecycle.jobId ?? "unknown id"}) is currently running${progress}. Keep the user updated and surface the status panel when asked.`;
      }
      if (translationLifecycle.stage === "failed") {
        return "The last translation attempt failed. Encourage the user to retry after addressing any issues.";
      }
      if (translationLifecycle.stage === "origin-only") {
        return "Origin is ready but translation has not started. Offer to kick off translation when the user is ready.";
      }
      return "Translation has not been generated yet. Offer to start it when the user is ready.";
    })();

    const proofreadingDetails = (() => {
      const meta = snapshot.lifecycle.proofreading;
      if (meta.stage === "none") {
        return "Proofreading has not been run yet.";
      }
      if (meta.stage === "running" || meta.stage === "queued") {
        return `Proofreading job ${meta.jobId ?? "pending"} is ${stageLabel(meta.stage)}; keep the user posted.`;
      }
      if (meta.stage === "failed") {
        return "Proofreading encountered an error. Offer guidance to retry or review logs.";
      }
      if (meta.stage === "done") {
        return `Proofreading completed ${meta.lastUpdatedAt ?? "(time unknown)"}; offer to review edits or export summaries.`;
      }
      return "Proofreading status is unknown; verify before responding.";
    })();

    const qualityDetails = (() => {
      const meta = snapshot.lifecycle.quality;
      if (meta.stage === "none")
        return "Quality evaluation has not been performed yet.";
      if (meta.stage === "running")
        return "Quality evaluation is running; let the user know results will appear shortly.";
      if (meta.stage === "failed")
        return "Quality evaluation failed. Suggest retrying or checking configuration.";
      const scoreText =
        typeof meta.score === "number" ? ` (score ${meta.score})` : "";
      return `Quality evaluation completed${scoreText}. Offer to open the report if needed.`;
    })();

    const publishingDetails = (() => {
      const meta = snapshot.lifecycle.publishing;
      if (meta.stage === "exported") {
        return `An ebook export (${meta.ebookId ?? "no id"}) is ready ${meta.lastUpdatedAt ?? ""}. Provide links or next steps for distribution.`;
      }
      if (meta.stage === "exporting") {
        return "Ebook export is in progress; keep the user informed.";
      }
      return "Ebook export has not started; suggest exporting once translation and proofreading are complete.";
    })();

    const jobLine = snapshot.jobs.status
      ? `Current background job: ${snapshot.jobs.status}${snapshot.jobs.batchesCompleted !== null && snapshot.jobs.batchesTotal !== null ? ` (${snapshot.jobs.batchesCompleted}/${snapshot.jobs.batchesTotal})` : ""}.`
      : "No jobs are currently running.";

    const timelineLines = snapshot.timeline.map((entry) => {
      const updated = entry.updatedAt ?? "unknown time";
      const note = entry.note ? ` – ${entry.note}` : "";
      return `${entry.phase}: ${entry.status} (${updated}${note})`;
    });

    const excerpts = [
      snapshot.excerpts.originPreview
        ? `Origin preview: "${snapshot.excerpts.originPreview}"`
        : null,
      snapshot.excerpts.translationPreview
        ? `Translation preview: "${snapshot.excerpts.translationPreview}"`
        : null,
    ].filter(Boolean);

    return [
      `You are a friendly teammate guiding the project "${snapshot.projectTitle ?? "Untitled Project"}" (ID ${snapshot.projectId}) targeting ${snapshot.targetLang ?? "an unspecified language"}.`,
      originDetails,
      translationDetails,
      proofreadingDetails,
      qualityDetails,
      publishingDetails,
      jobLine,
      timelineLines.length ? `Timeline: ${timelineLines.join(" | ")}` : null,
      excerpts.length ? excerpts.join(" ") : null,
      "Always give a brief status recap (translation → proofreading → publishing), mention what is ready, and proactively offer next steps or panel links (e.g., suggest viewing translation, proofread results, or export options). Maintain a warm, collaborative tone.",
    ].join(" ");
  }, [snapshot]);

  const contextSystemMessage = useMemo<ChatMessagePayload | null>(() => {
    const summary = buildContextSummary();
    return { role: "system", content: summary };
  }, [buildContextSummary]);

  const describeLocation = useCallback(
    (section: "origin" | "translation") => {
      const tabLabel =
        snapshot.ui.rightPanelTab === "preview"
          ? localize("chat_preview_tab_ready", "우측 미리보기 탭에서")
          : localize(
              "chat_preview_tab_switch",
              `현재 ${snapshot.ui.rightPanelTab} 탭이 열려 있어 미리보기로 전환하면`,
              { tab: snapshot.ui.rightPanelTab },
            );
      if (section === "origin") {
        return snapshot.ui.originExpanded
          ? localize(
              "chat_origin_view_open",
              "우측 미리보기 탭에서 원문 섹션을 이미 펼쳐두었습니다.",
            )
          : localize(
              "chat_origin_view_hint",
              `${tabLabel} 원문 섹션을 확인할 수 있습니다.`,
              { tabLabel },
            );
      }
      return snapshot.ui.translationExpanded
        ? localize(
            "chat_translation_view_open",
            "우측 미리보기 탭에서 번역본 섹션을 펼쳐두었습니다.",
          )
        : localize(
            "chat_translation_view_hint",
            `${tabLabel} 번역본 섹션을 확인할 수 있습니다.`,
            { tabLabel },
          );
    },
    [snapshot, localize],
  );

  const handleLocalQuestion = useCallback(
    async (question: string) => {
      const normalized = question.toLowerCase();
      const hasProject = Boolean(snapshot.projectId);
      if (!hasProject) {
        pushAssistant(
          localize(
            "chat_no_project_ready",
            `아직 프로젝트가 준비되지 않았습니다. 지원 형식(${SUPPORTED_ORIGIN_LABEL}) 원문을 올리면 바로 새 프로젝트를 만들고 내용을 저장해 드릴게요.`,
            { formats: SUPPORTED_ORIGIN_LABEL },
          ),
          {
            label: "No project",
            tone: "default",
          },
        );
        return true;
      }

      const containsOpenVerb = (keywords: string[]) =>
        [
          "열어",
          "열어줘",
          "열어줘요",
          "열어라",
          "펼쳐",
          "펼쳐줘",
          "펼쳐 줘",
          "보여줘",
          "보여 줘",
          "open",
          "show",
          "display",
        ].some(
          (verb) =>
            normalized.includes(verb) &&
            keywords.some((keyword) => normalized.includes(keyword)),
        );

      const directOriginCommand =
        containsOpenVerb(["원문", "origin"]) ||
        /open\s+origin|show\s+origin/.test(normalized);
      if (directOriginCommand) {
        setTab("preview");
        setPreviewExpanded("origin", true);
        if (snapshot.origin.hasContent) {
          const timestamp = snapshot.origin.lastUpdatedAt
            ? new Date(snapshot.origin.lastUpdatedAt).toLocaleString()
            : localize("chat_timestamp_unknown", "시간 정보 없음");
          pushAssistant(
            localize(
              "chat_origin_ready_message",
              `${describeLocation("origin")} (최근 업데이트: ${timestamp})`,
              { description: describeLocation("origin"), timestamp },
            ),
            {
              label: "Origin ready",
              tone: "success",
            },
            undefined,
            false,
            "origin",
          );
        } else {
          pushAssistant(
            localize(
              "chat_origin_missing",
              `아직 저장된 원문이 없습니다. ${SUPPORTED_ORIGIN_LABEL} 파일을 업로드하거나 원문을 입력해 주세요.`,
              { formats: SUPPORTED_ORIGIN_LABEL },
            ),
            {
              label: "Origin missing",
              tone: "default",
            },
            undefined,
            false,
            "origin",
          );
        }
        return true;
      }

      const directTranslationCommand =
        containsOpenVerb(["번역", "translation"]) ||
        /open\s+translation|show\s+translation/.test(normalized);
      if (directTranslationCommand) {
        setTab("preview");
        setPreviewExpanded("translation", true);
        if (snapshot.translation.hasContent) {
          const timestamp = snapshot.translation.lastUpdatedAt
            ? new Date(snapshot.translation.lastUpdatedAt).toLocaleString()
            : localize("chat_timestamp_unknown", "시간 정보 없음");
          pushAssistant(
            localize(
              "chat_translation_ready_message",
              `${describeLocation("translation")} (최근 업데이트: ${timestamp})`,
              { description: describeLocation("translation"), timestamp },
            ),
            {
              label: "Translation ready",
              tone: "success",
            },
            undefined,
            false,
            "translation",
          );
        } else if (
          snapshot.jobs.status === "running" ||
          snapshot.jobs.status === "queued"
        ) {
          pushAssistant(
            localize(
              "chat_translation_running",
              "번역 작업이 진행 중입니다. 완료되면 번역본을 우측 미리보기 탭에서 열어 드릴게요.",
            ),
            {
              label: "Translation running",
              tone: "default",
            },
            undefined,
            false,
            "translation",
          );
        } else {
          pushAssistant(
            localize(
              "chat_translation_missing",
              "아직 번역본이 없습니다. 번역을 시작하려면 번역을 요청하거나 번역 작업 버튼을 눌러 주세요.",
            ),
            {
              label: "Translation missing",
              tone: "default",
            },
            undefined,
            false,
            "translation",
          );
        }
        return true;
      }

      return false;
    },
    [
      snapshot,
      pushAssistant,
      setTab,
      setPreviewExpanded,
      describeLocation,
      localize,
    ],
  );

  useEffect(() => {
    setHistoryLoaded(false);
    setMessages([buildIntroMessage()]);
    setInputDraft(null);
    firstRunScriptShownRef.current = false;
    resetProofSummaryState();
    stageAnchorRefs.current = {
      origin: null,
      translation: null,
      proofreading: null,
      quality: null,
    };
    stageMessageRefs.current = {
      origin: null,
      translation: null,
      proofreading: null,
      quality: null,
    };
    stageNotesRef.current = {
      origin: null,
      translation: null,
      proofreading: null,
      quality: null,
    };
  }, [projectId, buildIntroMessage, resetProofSummaryState]);

  useEffect(() => {
    setMessages((prev) => {
      if (!prev.length) {
        return [buildIntroMessage()];
      }
      const intro = buildIntroMessage();
      return prev.map((message) =>
        message.id === "intro"
          ? {
              ...message,
              text: intro.text,
            }
          : message,
      );
    });
  }, [buildIntroMessage]);

  useEffect(() => {
    if (!projectId) {
      setMessages([buildIntroMessage()]);
      setHistoryLoaded(false);
      resetProofSummaryState();
      return;
    }

    if (history && !historyLoaded && !isHistoryLoading) {
      if (!history.length) {
        setMessages([buildIntroMessage()]);
        resetProofSummaryState();
      } else {
        setMessages(
          history.map((item) => ({
            id: item.id,
            role: item.role,
            text: item.content,
            actions:
              adaptActionsForOrigin(item.actions as ChatAction[] | undefined) ??
              [],
            badge:
              item.actions && item.actions.length
                ? {
                    label: item.actions.map((action) => action.type).join(", "),
                    tone: item.actions.some((action) =>
                      action.type.toLowerCase().includes("translation"),
                    )
                      ? "success"
                      : "default",
                  }
                : undefined,
          })),
        );
      }
      stageMessageRefs.current = {
        origin: null,
        translation: null,
        proofreading: null,
        quality: null,
      };
      stageNotesRef.current = {
        origin: null,
        translation: null,
        proofreading: null,
        quality: null,
      };
      if (history && history.length) {
        resetProofSummaryState();
      }
      applyOriginStageCard();
      applyTranslationStageCard();
      applyProofreadingStageCard();
      applyQualityStageCard();
      setHistoryLoaded(true);
    }
  }, [
    history,
    projectId,
    historyLoaded,
    isHistoryLoading,
    adaptActionsForOrigin,
    applyOriginStageCard,
    applyProofreadingStageCard,
    applyQualityStageCard,
    applyTranslationStageCard,
    resetProofSummaryState,
    buildIntroMessage,
  ]);

  const handleCreateProject = useCallback(async () => {
    if (isCreating) {
      pushAssistant("이미 새 프로젝트를 생성 중입니다. 잠시만 기다려 주세요.", {
        label: "Creating project",
        tone: "default",
      });
      return;
    }

    try {
      const project = await createProject();
      pushAssistant(
        `새 프로젝트를 생성했습니다. 제목은 "${project.title || "번역"}"입니다. 원문을 업로드해 주세요.`,
        { label: "Project created", tone: "success" },
        adaptActionsForOrigin([
          { type: "startUploadFile", reason: "원문 업로드" },
        ]) ?? [{ type: "startUploadFile" as const, reason: "원문 업로드" }],
        true,
      );
      setShowUploader(true);
    } catch (err) {
      pushAssistant(
        "새 프로젝트를 생성하지 못했습니다. 다시 시도해 주세요.",
        {
          label: "Creation failed",
          description: err instanceof Error ? err.message : "Unknown error",
          tone: "error",
        },
        undefined,
        true,
      );
    }
  }, [
    createProject,
    isCreating,
    pushAssistant,
    setShowUploader,
    adaptActionsForOrigin,
  ]);

  const handleMessageAction = useCallback(
    async (action: ChatAction) => {
      switch (action.type) {
        case "startTranslation":
          if (!hasOrigin) {
            pushAssistant("먼저 지원 형식의 원문 파일을 업로드해 주세요.", {
              label: "원문 필요",
              tone: "default",
            });
            openFileDialog();
            return;
          }
          await startTranslation({
            label: action.label ?? nextTranslationLabel ?? null,
            allowParallel: action.allowParallel ?? false,
          });
          refreshWorkflowView();
          return;
        case "startUploadFile":
          openFileDialog();
          return;
        case "cancelTranslation":
          await cancelTranslation({
            jobId: action.jobId ?? undefined,
            workflowRunId: action.workflowRunId ?? undefined,
            reason: action.reason ?? undefined,
          });
          refreshWorkflowView();
          return;
        case "startProofread":
          await startProofread({
            label: action.label ?? null,
            allowParallel: action.allowParallel ?? false,
          });
          refreshWorkflowView();
          return;
        case "startQuality":
          await runQuality({
            label: action.label ?? null,
            allowParallel: action.allowParallel ?? false,
          });
          refreshWorkflowView();
          return;
        case "openExportPanel":
          setTab("export");
          pushAssistant(
            localize(
              "chat_context_ebook_no_status",
              "전자책 내보내기 패널을 열어두었습니다.",
            ),
            {
              label: localize("chat_action_open_export", "전자책 패널 열기"),
              tone: "default",
            },
          );
          return;
        case "createProject":
          await handleCreateProject();
          return;
        case "viewTranslatedText":
          setTab("preview");
          setPreviewExpanded("translation", true);
          pushAssistant(
            proofreadingState.status === "running"
              ? "번역본을 우측 패널에서 열어두었습니다. 교정 결과가 적용되면 바로 반영됩니다."
              : "번역본을 우측 패널에서 확인할 수 있도록 열어두었습니다.",
            {
              label: "Translation preview",
              tone: "success",
            },
          );
          return;
        case "viewTranslationStatus": {
          if (translationState.status === "running") {
            const { progressCompleted, progressTotal, lastMessage } =
              translationState;
            const currentPass =
              progressTotal && progressTotal > 0
                ? Math.min(
                    progressTotal,
                    progressCompleted < progressTotal
                      ? progressCompleted + 1
                      : progressTotal,
                  )
                : null;
            const progressLabel =
              lastMessage ??
              (progressTotal && currentPass
                ? "번역 진행 중입니다."
                : "번역이 진행 중입니다. 조금만 기다려 주세요.");
            pushAssistant(progressLabel, {
              label: "Translation running",
              tone: "default",
            });
          } else if (translationState.status === "queued") {
            pushAssistant(
              translationState.lastMessage ??
                "번역이 대기열에 있습니다. 곧 시작될 예정입니다.",
              {
                label: "Translation queued",
                tone: "default",
              },
            );
          } else if (translationState.status === "done") {
            pushAssistant(
              "최근 번역 작업이 완료되었습니다. 번역본을 우측 패널에서 확인하세요.",
              {
                label: "Translation done",
                tone: "success",
              },
            );
          } else if (translationState.status === "failed") {
            pushAssistant(
              "마지막 번역 작업이 실패했습니다. 로그를 확인하고 다시 시도해 주세요.",
              {
                label: "Translation failed",
                tone: "error",
              },
            );
          } else if (translationState.status === "cancelled") {
            pushAssistant(
              "최근 번역 작업이 중지되었습니다. 필요하다면 새 번역을 시작할 수 있습니다.",
              {
                label: "Translation cancelled",
                tone: "default",
              },
            );
          } else {
            pushAssistant("지금은 진행 중인 번역 작업이 없습니다.", {
              label: "No active translation",
              tone: "default",
            });
          }
          return;
        }
        case "viewQualityReport":
          triggerQualityDialog();
          if (qualityState.status === "running") {
            pushAssistant(
              "품질 평가가 진행 중입니다. 평가가 완료되면 결과를 알려드릴게요.",
              {
                label: "Quality running",
                tone: "default",
              },
            );
          } else if (qualityState.status === "failed") {
            pushAssistant(
              "최근 품질 평가가 실패했습니다. 로그를 확인하고 다시 시도해 주세요.",
              {
                label: "Quality failed",
                tone: "error",
              },
            );
          } else if (qualityState.status === "done") {
            pushAssistant(
              "품질 평가 결과가 최신 팝업에 표시되었습니다.",
              {
                label: "Quality report",
                tone: "default",
              },
            );
          } else {
            pushAssistant(
              "아직 품질 평가를 실행하지 않았습니다. 필요하다면 품질 평가를 요청해 보세요.",
              {
                label: "Quality pending",
                tone: "default",
              },
            );
          }
          return;
        case "openProofreadTab": {
          setTab("proofread:findings");
          pushAssistant(
            localize(
              "chat_proof_open_tab_message",
              "Proofread 탭에서 카드와 Monaco 편집기로 이슈를 검토할 수 있습니다.",
            ),
            {
              label: localize("chat_proof_open_tab_label", "Proofread 이동"),
              tone: "default",
            },
          );
          return;
        }
        case "describeProofSummary": {
          const summary = lastProofSummaryRef.current;
          const severityLabels: Record<
            "critical" | "high" | "medium" | "low",
            string
          > = {
            critical: localize("chat_proof_severity_critical", "심각"),
            high: localize("chat_proof_severity_high", "높음"),
            medium: localize("chat_proof_severity_medium", "중간"),
            low: localize("chat_proof_severity_low", "낮음"),
          };
          const priorityParts = summary
            ? (["critical", "high"] as const)
                .filter((key) => summary.counts[key] > 0)
                .map(
                  (key) => `${severityLabels[key]} ${summary.counts[key]}건`,
                )
            : [];
          const secondaryParts = summary
            ? (["medium", "low"] as const)
                .filter((key) => summary.counts[key] > 0)
                .map(
                  (key) => `${severityLabels[key]} ${summary.counts[key]}건`,
                )
            : [];

          const advisoryLines = [
            localize(
              "chat_proof_advice_intro",
              "Critical / High 우선으로 Proofread 탭에서 검토하고 적용 여부를 판단해 주세요.",
            ),
            priorityParts.length
              ? localize(
                  "chat_proof_advice_priority",
                  `우선 검토 대상: ${priorityParts.join(", ")}`,
                  { breakdown: priorityParts.join(", ") },
                )
              : null,
            secondaryParts.length
              ? localize(
                  "chat_proof_advice_secondary",
                  `나머지 항목도 필요 시 확인해 주세요: ${secondaryParts.join(", ")}`,
                  { breakdown: secondaryParts.join(", ") },
                )
              : null,
            localize(
              "chat_proof_advice_process",
              "각 카드에서 추천 수정안을 확인하고, 필요하면 적용 또는 무시를 선택하세요.",
            ),
          ].filter(Boolean);

          pushAssistant(advisoryLines.join("\n"), {
            label: localize("chat_proof_advice_label", "Proofread 가이드"),
            tone: "default",
          });
          return;
        }
        case "applyEditingSuggestion": {
          await applyEditingSuggestion(action.suggestionId);
          return;
        }
        case "undoEditingSuggestion": {
          await undoEditingSuggestion(action.suggestionId);
          return;
        }
        case "dismissEditingSuggestion": {
          dismissEditingSuggestion(action.suggestionId);
          return;
        }
        case "acknowledge":
          return;
        default:
          pushAssistant("해당 작업은 아직 지원되지 않습니다.", {
            label: "Unsupported action",
            tone: "default",
          });
          return;
      }
    },
    [
      startTranslation,
      cancelTranslation,
      startProofread,
      runQuality,
      translationState,
      proofreadingState,
      qualityState,
      pushAssistant,
      setTab,
      triggerQualityDialog,
      setPreviewExpanded,
      handleCreateProject,
      hasOrigin,
      openFileDialog,
      refreshWorkflowView,
      nextTranslationLabel,
      applyEditingSuggestion,
      undoEditingSuggestion,
      dismissEditingSuggestion,
      localize,
    ],
  );

  useEffect(() => {
    setChatActionExecutor((action) => handleMessageAction(action));
    return () => setChatActionExecutor(null);
  }, [handleMessageAction, setChatActionExecutor]);

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !token) return;

      setInputDraft(null);
      setQuickReplies([]);

      const userMessage: Message = {
        id: generateMessageId(),
        role: "user",
        text: trimmed,
      };
      pushMessage(userMessage);

      const normalized = trimmed.toLowerCase();
      const wantsUploader = [
        "renew origin",
        "new origin",
        "upload new origin",
        "replace origin",
        "reset origin",
        "원문 다시",
        "원문 새로",
        "원문 업데이트",
      ].some((phrase) => normalized.includes(phrase));

      if (wantsUploader) {
        setShowUploader(true);
        pushAssistant(
          "새 원문을 업로드할 수 있도록 드래그&드롭 영역을 다시 열어두었습니다.",
          { label: "Origin uploader ready", tone: "default" },
        );
      }

      const handledLocally = await handleLocalQuestion(trimmed);
      if (handledLocally) {
        return;
      }

      const editingState = useEditingCommandStore.getState();
      const selectionForEditing = editingState.selection;
      const inferredEditingMode = selectionForEditing
        ? activeEditingAction ?? guessEditingIntent(trimmed)
        : activeEditingAction ?? guessEditingIntent(trimmed);

      if (inferredEditingMode) {
        if (!selectionForEditing) {
          pushAssistant(
            "먼저 수정할 문장을 선택해 주세요.",
            {
              label: "Editing",
              tone: "default",
            },
          );
          setActiveEditingAction(null);
          return;
        }
        await processEditingCommand(
          inferredEditingMode,
          trimmed,
          selectionForEditing,
        );
        return;
      }

      try {
        const baseMessages = toPayload([...messages, userMessage]);
        const payloadMessages = contextSystemMessage
          ? [contextSystemMessage, ...baseMessages]
          : baseMessages;

        const response = await api.chat(token, {
          projectId,
          messages: payloadMessages,
          contextSnapshot: snapshot,
          model: selectedModel,
        });

        const actions = (response.actions ?? []) as Array<{
          type: string;
          reason?: string;
        }>;
        const filteredActions = actions.filter(
          (action) => action.type !== "acknowledge",
        );

        const adaptedActions = adaptActionsForOrigin(
          filteredActions as ChatAction[],
        );

        pushAssistant(response.reply, undefined, adaptedActions);
        for (const action of adaptedActions ?? []) {
          if (!action.autoStart) {
            continue;
          }
          switch (action.type) {
            case "startTranslation":
              await startTranslation({
                label: action.label ?? nextTranslationLabel ?? null,
                allowParallel: action.allowParallel ?? false,
              });
              refreshWorkflowView();
              break;
            case "cancelTranslation":
              await cancelTranslation({
                jobId: action.jobId ?? undefined,
                workflowRunId: action.workflowRunId ?? undefined,
                reason: action.reason ?? undefined,
              });
              refreshWorkflowView();
              break;
            case "startProofread":
              await startProofread({
                label: action.label ?? null,
                allowParallel: action.allowParallel ?? false,
              });
              refreshWorkflowView();
              break;
            case "startQuality":
              await runQuality({
                label: action.label ?? null,
                allowParallel: action.allowParallel ?? false,
              });
              refreshWorkflowView();
              break;
            case "openExportPanel":
              setTab("export");
              pushAssistant(
                localize(
                  "chat_context_ebook_no_status",
                  "전자책 내보내기 패널을 열어두었습니다.",
                ),
                {
                  label: localize(
                    "chat_action_open_export",
                    "전자책 패널 열기",
                  ),
                  tone: "default",
                },
              );
              break;
            case "createProject":
              await handleCreateProject();
              break;
            case "startUploadFile":
              setShowUploader(true);
              break;
            default:
              break;
          }
        }
        if (response.profileUpdates) {
          onProfileUpdated?.();
        }
        void refreshProjectContext("content");
      } catch (err) {
        pushAssistant(
          "대화를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          {
            label: "Chat error",
            description: err instanceof Error ? err.message : "Unknown error",
            tone: "error",
          },
        );
      }
    },
    [
      token,
      projectId,
      messages,
      pushMessage,
      pushAssistant,
      toPayload,
      startTranslation,
      runQuality,
      startProofread,
      setShowUploader,
      setInputDraft,
      onProfileUpdated,
      handleCreateProject,
      contextSystemMessage,
      refreshProjectContext,
      handleLocalQuestion,
      snapshot,
      selectedModel,
      adaptActionsForOrigin,
      refreshWorkflowView,
      nextTranslationLabel,
      cancelTranslation,
      activeEditingAction,
      guessEditingIntent,
      processEditingCommand,
      setActiveEditingAction,
      setTab,
      localize,
    ],
  );

  const processFile = useCallback(
    async (file: File) => {
      if (!token) {
        pushAssistant("인증이 만료되었습니다. 다시 로그인해 주세요.", {
          label: "Authentication required",
          tone: "error",
        });
        return;
      }

      if (!isSupportedOriginFile(file)) {
        pushAssistant(
          `지원되지 않는 형식입니다. ${SUPPORTED_ORIGIN_LABEL} 파일만 업로드할 수 있어요.`,
          {
            label: "Unsupported file",
            tone: "error",
          },
        );
        return;
      }

      if (!file.size) {
        pushAssistant("업로드한 파일이 비어 있습니다.", {
          label: "Empty file",
          tone: "error",
        });
        return;
      }

      setIsUploading(true);
      let resolvedProjectId = projectId;

      if (!resolvedProjectId) {
        pushAssistant(
          "첫 프로젝트를 준비하고 있습니다. 잠시만 기다려 주세요.",
          {
            label: "Project setup",
            tone: "default",
          },
        );
        try {
          const project = await createProject();
          resolvedProjectId = project.project_id;
          pushAssistant(
            `"${project.title || "새 프로젝트"}" 프로젝트가 준비되었습니다. 원문을 저장할게요.`,
            {
              label: "Project ready",
              tone: "success",
            },
          );
        } catch (err) {
          pushAssistant(
            "새 프로젝트를 생성하지 못했습니다. 다시 시도해 주세요.",
            {
              label: "Creation failed",
              description: err instanceof Error ? err.message : "Unknown error",
              tone: "error",
            },
          );
          setIsUploading(false);
          setIsDragging(false);
          return;
        }
      }

      try {
        const response = await api.uploadOriginFile(
          token,
          resolvedProjectId,
          file,
        );
        const filename = response?.origin?.filename ?? file.name;
        const extractor = response?.origin?.metadata?.extractor;
        const description = extractor ? `${filename} · ${extractor}` : filename;
        pushAssistant(
          "원문을 저장했습니다.",
          {
            label: "Origin saved",
            description,
            tone: "success",
          },
          undefined,
          true,
        );
        onOriginSaved?.();
        setShowUploader(false);
      } catch (err) {
        pushAssistant(
          "원문 저장 중 오류가 발생했습니다.",
          {
            label: "Upload failed",
            description: err instanceof Error ? err.message : "Unknown error",
            tone: "error",
          },
          undefined,
          true,
        );
        setShowUploader(true);
      } finally {
        setIsUploading(false);
        setIsDragging(false);
      }
    },
    [token, projectId, createProject, pushAssistant, onOriginSaved],
  );

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        await processFile(file);
      }
      event.target.value = "";
    },
    [processFile],
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      const file = files[0];
      await processFile(file);
    },
    [processFile],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
    setShowUploader(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const dropzoneClasses = useMemo(
    () =>
      `rounded border border-dashed px-2 py-2 text-xs transition ${
        isDragging
          ? "border-indigo-500 bg-indigo-50 text-indigo-700"
          : "border-slate-300 text-slate-500"
      }`,
    [isDragging],
  );

  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(120);
  const messagePaddingClass = useMemo(
    () => (showUploader || isDragging || !hasOrigin ? "pt-6" : "pt-3"),
    [showUploader, isDragging, hasOrigin],
  );

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = "instant") => {
      requestAnimationFrame(() => {
        bottomAnchorRef.current?.scrollIntoView({ behavior, block: "end" });
      });
    },
    [],
  );

  const SCROLL_THRESHOLD_PX = 40;

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const remaining =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const atBottom = remaining <= SCROLL_THRESHOLD_PX;
      setIsAtBottom(atBottom);
      if (atBottom) {
        setShowScrollToLatest(false);
      } else {
        setShowScrollToLatest(true);
      }
    };

    handleScroll();

    const options: AddEventListenerOptions = { passive: true };
    container.addEventListener("scroll", handleScroll, options);
    return () => container.removeEventListener("scroll", handleScroll, options);
  }, []);

  useLayoutEffect(() => {
    if (!initialScrollDoneRef.current) {
      scrollMessagesToBottom("instant");
      initialScrollDoneRef.current = true;
      return;
    }

    if (isAtBottom) {
      scrollMessagesToBottom("instant");
    } else {
      setShowScrollToLatest(true);
    }
  }, [messages, isAtBottom, scrollMessagesToBottom]);

  useLayoutEffect(() => {
    if (!composerRef.current || typeof ResizeObserver === "undefined") {
      setComposerHeight(composerRef.current?.offsetHeight ?? 0);
      return;
    }

    const node = composerRef.current;
    const observer = new ResizeObserver(([entry]) => {
      setComposerHeight(entry.contentRect.height);
    });

    observer.observe(node);
    setComposerHeight(node.offsetHeight);

    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (isAtBottom) {
      scrollMessagesToBottom("instant");
    }
  }, [composerHeight, isAtBottom, scrollMessagesToBottom]);

  const handleJumpToLatest = useCallback(() => {
    setShowScrollToLatest(false);
    setIsAtBottom(true);
    scrollMessagesToBottom("smooth");
  }, [scrollMessagesToBottom]);

  return (
    <div
      className={`relative flex h-full flex-col ${isDragging ? "bg-indigo-50/50" : ""}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={SUPPORTED_ORIGIN_ACCEPT}
        className="hidden"
        onChange={handleFileSelect}
      />
      <header className="sticky top-0 z-10 bg-white px-2 py-2 text-slate-900 shadow-sm">
        <div className="space-y-2">
          <div className="rounded border border-slate-200 bg-white px-1 py-1">
            <div className="space-y-1 bg-transparent">
              <h2 className="text-lg font-semibold text-slate-800">
                {currentProject?.title ||
                  localize(
                    "chat_header_default_title",
                    "Start translation project",
                  )}
              </h2>
              {currentProject && (
                <p className="text-xs text-slate-500">
                  {currentProject.origin_lang ??
                    localize("chat_lang_unknown", "unknown")}
                  {" "}→{" "}
                  {currentProject.target_lang ??
                    localize("chat_lang_unknown", "unknown")}
                </p>
              )}
            </div>
          </div>
          <WorkflowTimeline
            originReady={hasOrigin}
            translation={translationVisual}
            proofreading={proofreadingVisual}
            quality={qualityVisual}
            onStageClick={scrollToStage}
          />
          {(translationWorkflow?.label ||
            proofreadingWorkflow?.label ||
            qualityWorkflow?.label) && (
            <div className="flex flex-wrap gap-3 text-xs text-slate-500">
              {translationWorkflow?.label && (
                <span>번역 라벨: {translationWorkflow.label}</span>
              )}
              {proofreadingWorkflow?.label && (
                <span>교정 라벨: {proofreadingWorkflow.label}</span>
              )}
              {qualityWorkflow?.label && (
                <span>품질 라벨: {qualityWorkflow.label}</span>
              )}
            </div>
          )}
          {/* Timeline summary moved to sidebar; keeping header compact. */}
          {(showUploader || isDragging || !hasOrigin) && (
            <div>
              <div className={dropzoneClasses}>
                <p className="font-medium text-slate-600">
                  {localize(
                    "chat_dropzone_title",
                    "원문 파일을 드래그해 여기에 놓거나 파일을 선택해 주세요.",
                  )}
                </p>
                <p className="text-slate-600">
                  {localize(
                    "chat_dropzone_formats",
                    `(지원 형식: ${SUPPORTED_ORIGIN_HINT})`,
                    { formats: SUPPORTED_ORIGIN_HINT },
                  )}
                </p>
                <p className="mt-1 text-slate-500">
                  {localize(
                    "chat_dropzone_hint",
                    "파일을 업로드하면 자동으로 분석하고 미리보기 영역에 그 내용을 보여드립니다.",
                  )}
                </p>
                <p className="text-slate-500">
                  {localize(
                    "chat_dropzone_guidance",
                    "번역, 교정, 그리고 번역 품질 평가를 채팅으로 자연스럽게 요청해 주세요. 번역 과정을 도와드리겠습니다.",
                  )}
                </p>
                <button
                  type="button"
                  onClick={openFileDialog}
                  disabled={isUploading}
                  className="mt-3 inline-flex items-center rounded border border-indigo-300 px-3 py-1 text-xs font-medium text-indigo-600 transition hover:border-indigo-400 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {localize("chat_dropzone_select", "파일 선택하기")}
                </button>
                {(isUploading ||
                  translationVisual.overall.running ||
                  isHistoryLoading) && (
                  <p className="mt-2 text-indigo-500">
                    {isHistoryLoading
                      ? localize(
                          "chat_status_loading_history",
                          "이전 대화를 불러오는 중...",
                        )
                      : isUploading
                        ? localize("chat_status_uploading", "업로드 중...")
                        : localize(
                            "chat_status_translation_running",
                            "번역 작업 중...",
                          )}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden bg-blue-50">
        <div className="relative h-full">
          <div
            ref={messagesContainerRef}
            className={`h-full overflow-y-auto px-4 ${messagePaddingClass}`}
            style={{
              paddingBottom: composerHeight + 48,
              scrollPaddingBottom: composerHeight + 48,
            }}
          >
            <div className="space-y-3 pb-28">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  role={message.role}
                  text={message.text}
                  badge={message.badge}
                  actions={message.actions}
                  onAction={handleMessageAction}
                  anchorStage={message.anchorStage}
                  onAnchorMount={registerStageAnchor}
                />
              ))}
              <div style={{ height: composerHeight + 48 }}>
                <div ref={bottomAnchorRef} />
              </div>
            </div>
          </div>
          {showScrollToLatest && (
            <button
              type="button"
              className="pointer-events-auto absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-neutral-800"
              onClick={handleJumpToLatest}
            >
              {localize("chat_jump_to_latest", "Jump to latest")}
            </button>
          )}
        </div>
      </main>
      <footer
        ref={composerRef}
        className="sticky bottom-0 bg-blue-50 px-2 pb-2 pt-2"
      >
        {quickReplies.length > 0 && (
          <div className="mb-2 px-1">
            <QuickReplies items={quickReplies} />
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          disabled={isUploading || isHistoryLoading}
          prefill={inputDraft}
        />
      </footer>
    </div>
  );
};
