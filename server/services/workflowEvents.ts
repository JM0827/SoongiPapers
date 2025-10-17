import { EventEmitter } from "events";
import type { IntentClassification } from "./intentClassifier";
import type {
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowType,
} from "./workflowManager";

export const WORKFLOW_EVENTS = {
  INTENT_REQUESTED: "workflow.intent.requested",
  RUN_STARTED: "workflow.run.started",
  RUN_COMPLETED: "workflow.run.completed",
  RUN_FAILED: "workflow.run.failed",
  RUN_CANCELLED: "workflow.run.cancelled",
} as const;

export interface IntentRequestedPayload {
  projectId: string;
  userId: string | null;
  classification: IntentClassification;
  effectiveIntent: WorkflowType | IntentClassification["intent"];
  previousIntent?: IntentSnapshot | null;
}

export interface WorkflowRunEventPayload {
  run: WorkflowRunRecord;
}

export type WorkflowEventPayloadMap = {
  [WORKFLOW_EVENTS.INTENT_REQUESTED]: IntentRequestedPayload;
  [WORKFLOW_EVENTS.RUN_STARTED]: WorkflowRunEventPayload;
  [WORKFLOW_EVENTS.RUN_COMPLETED]: WorkflowRunEventPayload;
  [WORKFLOW_EVENTS.RUN_FAILED]: WorkflowRunEventPayload;
  [WORKFLOW_EVENTS.RUN_CANCELLED]: WorkflowRunEventPayload;
};

export type WorkflowEventNames = keyof WorkflowEventPayloadMap;

export interface IntentSnapshot extends IntentClassification {
  effectiveIntent: WorkflowType | IntentClassification["intent"];
  label: string | null;
  updatedAt: string;
  notes?: string | null;
}

class WorkflowEventBus extends EventEmitter {
  emit<TName extends WorkflowEventNames>(
    event: TName,
    payload: WorkflowEventPayloadMap[TName],
  ): boolean {
    return super.emit(event, payload);
  }

  on<TName extends WorkflowEventNames>(
    event: TName,
    listener: (payload: WorkflowEventPayloadMap[TName]) => void,
  ): this {
    return super.on(event, listener);
  }
}

export const workflowEvents = new WorkflowEventBus();

workflowEvents.setMaxListeners(50);
