import { Fragment, useCallback } from "react";
import type { ReactNode } from "react";
import { ActionBadge } from "./ActionBadge";
import type { ChatAction, ChatMessageRole } from "../../types/domain";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";

type MessageTone = "default" | "success" | "error";

interface ChatMessageProps {
  role: ChatMessageRole;
  text: string;
  badge?: {
    label: string;
    description?: string;
    tone?: MessageTone;
  };
  actions?: ChatAction[];
  onAction?: (action: ChatAction) => void;
}

const renderInlineNodes = (
  input: string,
  options: {
    resolveAction?: (actionType: string) => ChatAction | null;
    onTriggerAction?: (action: ChatAction) => void;
    keyPrefix: string;
  },
) => {
  const { resolveAction, onTriggerAction, keyPrefix } = options;
  const elements: ReactNode[] = [];
  const pattern =
    /\*\*([^*]+)\*\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)]\((action:[^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;
  while ((match = pattern.exec(input))) {
    const [, bold, italic, code, linkLabel, actionTarget] = match;
    if (match.index > lastIndex) {
      const plainText = input.slice(lastIndex, match.index);
      elements.push(
        <Fragment key={`${keyPrefix}-text-${tokenIndex}`}>
          {plainText}
        </Fragment>,
      );
      tokenIndex += 1;
    }
    if (bold) {
      elements.push(
        <strong key={`${keyPrefix}-bold-${tokenIndex}`}>{bold}</strong>,
      );
    } else if (italic) {
      elements.push(
        <em key={`${keyPrefix}-italic-${tokenIndex}`}>{italic}</em>,
      );
    } else if (code) {
      elements.push(
        <code
          key={`${keyPrefix}-code-${tokenIndex}`}
          className="rounded bg-slate-800/80 px-1 py-0.5 text-xs text-amber-200"
        >
          {code}
        </code>,
      );
    } else if (actionTarget) {
      const actionType = actionTarget.replace("action:", "");
      const action = resolveAction?.(actionType) ?? null;
      if (action && onTriggerAction) {
        elements.push(
          <button
            key={`${keyPrefix}-action-${tokenIndex}`}
            type="button"
            className="inline-flex items-center rounded border border-indigo-400 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            onClick={() => onTriggerAction(action)}
          >
            {linkLabel}
          </button>,
        );
      } else {
        elements.push(
          <span key={`${keyPrefix}-action-${tokenIndex}`} className="font-medium">
            {linkLabel}
          </span>,
        );
      }
    }
    lastIndex = pattern.lastIndex;
    tokenIndex += 1;
  }
  if (lastIndex < input.length) {
    elements.push(
      <Fragment key={`${keyPrefix}-tail-${tokenIndex}`}>
        {input.slice(lastIndex)}
      </Fragment>,
    );
  }
  return elements;
};

const renderMarkdown = (
  text: string,
  options: {
    resolveAction?: (actionType: string) => ChatAction | null;
    onTriggerAction?: (action: ChatAction) => void;
  },
) => {
  const { resolveAction, onTriggerAction } = options;
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (!listBuffer.length) return;
    const items = listBuffer.map((item, idx) => (
      <li key={`list-item-${blocks.length}-${idx}`} className="ml-4 list-disc">
        {renderInlineNodes(item, {
          resolveAction,
          onTriggerAction,
          keyPrefix: `list-${blocks.length}-${idx}`,
        })}
      </li>
    ));
    blocks.push(
      <ul key={`list-${blocks.length}`} className="space-y-1">
        {items}
      </ul>,
    );
    listBuffer = [];
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      blocks.push(<div key={`break-${index}`} className="h-2" />);
      return;
    }

    if (/^[-*] /.test(trimmed)) {
      listBuffer.push(trimmed.slice(2).trim());
      return;
    }

    flushList();
    blocks.push(
      <p key={`paragraph-${index}`} className="leading-relaxed">
        {renderInlineNodes(line, {
          resolveAction,
          onTriggerAction,
          keyPrefix: `p-${index}`,
        })}
      </p>,
    );
  });

  flushList();
  return blocks;
};

export const ChatMessage = ({
  role,
  text,
  badge,
  actions = [],
  onAction,
}: ChatMessageProps) => {
  const isUser = role === "user";
  const { locale } = useUILocale();
  const localize = useCallback(
    (key: string, fallback: string) => {
      const resolved = translate(key, locale);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
  const resolveAction = useCallback(
    (actionType: string): ChatAction | null =>
      actions.find(
        (item) => item.type.toLowerCase() === actionType.toLowerCase(),
      ) ?? null,
    [actions],
  );

  const handleInlineAction = useCallback(
    (action: ChatAction) => {
      if (!onAction) return;
      onAction(action);
    },
    [onAction],
  );

  const hasActions = actions.length > 0;
  const showBadge = Boolean(badge && hasActions);
  const resolvedBadge = showBadge ? badge : undefined;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-lg px-4 py-3 text-sm ${
          isUser
            ? "bg-neutral-800 text-white"
            : "bg-white text-slate-800 shadow"
        }`}
      >
        <div className="flex flex-col gap-2">
          {renderMarkdown(text, {
            resolveAction: onAction ? resolveAction : undefined,
            onTriggerAction: onAction ? handleInlineAction : undefined,
          })}
        </div>
        {resolvedBadge && (
          <ActionBadge
            label={resolvedBadge.label}
            description={resolvedBadge.description}
            tone={resolvedBadge.tone}
          />
        )}
        {hasActions && (
          <div className="mt-2 flex flex-wrap gap-2">
            {actions.map((action, idx) => (
              <ActionBadge
                key={`${action.type}-${idx}`}
                label={getActionLabel(action, localize)}
                description={action.reason}
                tone={getActionTone(action)}
                onClick={onAction ? () => onAction(action) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const getActionLabel = (
  action: ChatAction,
  localize: (key: string, fallback: string) => string,
): string => {
  switch (action.type) {
    case "startTranslation":
      return localize("chat_action_start_translation", "번역 시작");
    case "startUploadFile":
      return localize("chat_action_start_upload", "원작 업로드");
    case "startProofread":
      return localize("chat_action_start_proofread", "교정 시작");
    case "startQuality":
      return localize("chat_action_start_quality", "품질 검토");
    case "viewQualityReport":
      return localize("chat_action_view_quality", "품질 리포트 보기");
    case "viewTranslatedText":
      return localize("chat_action_view_translation", "번역본 열기");
    case "viewTranslationStatus":
      return localize("chat_action_view_translation_status", "번역 상태 보기");
    case "openProofreadTab":
      return localize("chat_action_open_proofread", "Proofread 탭 열기");
    case "describeProofSummary":
      return localize("chat_action_describe_proof", "요약 설명 요청");
    case "applyEditingSuggestion":
      return localize("chat_action_apply", "적용");
    case "undoEditingSuggestion":
      return localize("chat_action_undo", "되돌리기");
    case "dismissEditingSuggestion":
      return localize("chat_action_ignore", "무시");
    case "cancelTranslation":
      return localize("chat_action_cancel_translation", "번역 중지");
    case "createProject":
      return localize("chat_action_create_project", "프로젝트 생성");
    case "acknowledge":
    default:
      return localize("chat_action_acknowledge", "확인");
  }
};

const getActionTone = (action: ChatAction): "default" | "success" | "error" => {
  switch (action.type) {
    case "startTranslation":
    case "startUploadFile":
    case "startProofread":
    case "startQuality":
    case "applyEditingSuggestion":
      return "success";
    case "cancelTranslation":
      return "error";
    default:
      return "default";
  }
};
