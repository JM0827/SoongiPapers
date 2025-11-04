import type { IntentClassification } from "./intentClassifier";
import type { IntentSnapshot } from "./workflowEvents";
import type { WorkflowType, RequestActionResult } from "./workflowManager";
import type { UILocale } from "./localeService";
import { translate as defaultTranslate } from "./localeService";

export interface LlmAction {
  type: string;
  reason?: string | null;
  allowParallel?: boolean;
  label?: string | null;
  autoStart?: boolean;
  jobId?: string | null;
  workflowRunId?: string | null;
  suggestionId?: string | null;
}

export interface IntentRoutingPreflight {
  actions: LlmAction[];
  notes: string[];
  effectiveIntent: IntentClassification["intent"] | WorkflowType;
  effectiveLabel: string | null;
}

export interface IntentRoutingParams {
  locale: UILocale;
  classification: IntentClassification;
  preflight: IntentRoutingPreflight;
  latestUserMessage: string;
  userId: string | null;
  projectId: string;
  requestAction: (options: {
    projectId: string;
    type: WorkflowType;
    requestedBy?: string | null;
    intentText?: string | null;
    label?: string | null;
    parentRunId?: string | null;
    metadata?: Record<string, unknown> | null;
    allowParallel?: boolean;
  }) => Promise<RequestActionResult>;
  translateFn?: typeof defaultTranslate;
  currentStatusSummary?: string | null;
}

export interface IntentRoutingOutcome {
  handled: boolean;
  reply?: string;
  actions?: LlmAction[];
  classificationForEvent?: IntentClassification;
  effectiveIntent?: IntentClassification["intent"] | WorkflowType;
  snapshotToPersist?: IntentSnapshot;
  llmContext?: string | null;
}

export const ACTION_INTENT_MAP: Record<string, WorkflowType> = {
  startTranslation: "translation",
  startProofread: "proofread",
  startQuality: "quality",
};

const INTENT_RESPONSE_CONFIG: Record<
  keyof typeof ACTION_INTENT_MAP,
  {
    successKey: string;
    successWithLabelKey: string;
    alreadyRunningKey: string;
    inactiveKey: string;
    failureKey: string;
    followupAction: string;
  }
> = {
  startTranslation: {
    successKey: "chat_intent_translation_started",
    successWithLabelKey: "chat_intent_translation_started_label",
    alreadyRunningKey: "chat_intent_translation_already_running",
    inactiveKey: "chat_intent_translation_inactive",
    failureKey: "chat_intent_translation_failed",
    followupAction: "viewTranslationStatus",
  },
  startProofread: {
    successKey: "chat_intent_proofread_started",
    successWithLabelKey: "chat_intent_proofread_started_label",
    alreadyRunningKey: "chat_intent_proofread_already_running",
    inactiveKey: "chat_intent_proofread_inactive",
    failureKey: "chat_intent_proofread_failed",
    followupAction: "viewTranslationStatus",
  },
  startQuality: {
    successKey: "chat_intent_quality_started",
    successWithLabelKey: "chat_intent_quality_started_label",
    alreadyRunningKey: "chat_intent_quality_already_running",
    inactiveKey: "chat_intent_quality_inactive",
    failureKey: "chat_intent_quality_failed",
    followupAction: "viewQualityReport",
  },
};

const ROUTABLE_TYPES = new Set<keyof typeof ACTION_INTENT_MAP>([
  "startTranslation",
  "startProofread",
  "startQuality",
]);

const dedupeActions = (actions: LlmAction[]): LlmAction[] => {
  const map = new Map<string, LlmAction>();
  for (const action of actions) {
    if (!action?.type) continue;
    if (!map.has(action.type)) {
      map.set(action.type, action);
    }
  }
  return Array.from(map.values());
};

interface RoutingAccumulator {
  messages: string[];
  actions: LlmAction[];
  resolvedLabel: string | null;
}

export const handleIntentRouting = async (
  params: IntentRoutingParams,
): Promise<IntentRoutingOutcome> => {
  const {
    locale,
    classification,
    preflight,
    latestUserMessage,
    userId,
    projectId,
    requestAction,
    translateFn = defaultTranslate,
    currentStatusSummary,
  } = params;

  const routableActions = preflight.actions.filter(
    (action): action is LlmAction & { type: keyof typeof ACTION_INTENT_MAP } =>
      Boolean(action?.autoStart) && ROUTABLE_TYPES.has(action.type as any),
  );

  if (!routableActions.length) {
    return { handled: false };
  }

  const acc: RoutingAccumulator = {
    messages: [],
    actions: [],
    resolvedLabel: classification.label ?? preflight.effectiveLabel ?? null,
  };

  for (const action of routableActions) {
    const config = INTENT_RESPONSE_CONFIG[action.type];
    const workflowType = ACTION_INTENT_MAP[action.type];
    const desiredLabel = action.label ?? classification.label ?? null;

    try {
      const result = await requestAction({
        projectId,
        type: workflowType,
        requestedBy: userId,
        intentText: latestUserMessage,
        label: desiredLabel ?? undefined,
        allowParallel: action.allowParallel === true,
      });

      if (result.accepted && result.run) {
        if (desiredLabel) {
          acc.messages.push(
            translateFn(config.successWithLabelKey, locale, {
              label: desiredLabel,
            }),
          );
        } else {
          acc.messages.push(translateFn(config.successKey, locale));
        }

        acc.actions.push({ type: config.followupAction });
        acc.resolvedLabel =
          result.run.label ?? desiredLabel ?? acc.resolvedLabel;
      } else {
        const failureKey = (() => {
          if (result.reason === "already_running") {
            return config.alreadyRunningKey;
          }
          if (result.reason === "project_inactive") {
            return config.inactiveKey;
          }
          return config.failureKey;
        })();
        acc.messages.push(translateFn(failureKey, locale));

        if (result.reason === "already_running") {
          acc.actions.push({ type: config.followupAction });
        }
      }
    } catch (error) {
      acc.messages.push(translateFn(config.failureKey, locale));
    }
  }

  if (locale === "ko" && preflight.notes.length) {
    acc.messages.push(...preflight.notes);
  }

  if (!acc.messages.length) {
    return { handled: false };
  }

  const llmLines = [...acc.messages];
  if (currentStatusSummary) {
    llmLines.push(`현재 상태: ${currentStatusSummary}`);
  }
  const llmContext = llmLines.join("\n");
  const uniqueActions = dedupeActions(acc.actions);
  if (!uniqueActions.length) {
    const defaultFollowup = routableActions[0]?.type
      ? INTENT_RESPONSE_CONFIG[routableActions[0].type].followupAction
      : "viewTranslationStatus";
    uniqueActions.push({ type: defaultFollowup });
  }

  const classificationForEvent: IntentClassification = {
    ...classification,
    label: acc.resolvedLabel ?? classification.label ?? null,
  };

  const effectiveIntent =
    preflight.effectiveIntent ?? (classification.intent as WorkflowType);

  const snapshotToPersist: IntentSnapshot = {
    ...classificationForEvent,
    label: classificationForEvent.label ?? null,
    effectiveIntent,
    notes: classificationForEvent.notes ?? null,
    updatedAt: new Date().toISOString(),
  };

  return {
    handled: true,
    actions: uniqueActions,
    classificationForEvent,
    effectiveIntent,
    snapshotToPersist,
    llmContext,
  };
};
