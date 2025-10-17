import { EventEmitter } from 'node:events';

export interface ProofreadEditorUpdateEvent {
  projectId: string;
  translationFileId: string;
  jobId: string | null;
  documentVersion: string;
  clientMutationId: string | null;
  emittedAt: string;
}

type Listener = (event: ProofreadEditorUpdateEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const CHANNEL_PREFIX = 'proofread-editor:';

export function emitProofreadEditorUpdate(event: ProofreadEditorUpdateEvent): void {
  const channel = `${CHANNEL_PREFIX}${event.projectId}`;
  emitter.emit(channel, event);
}

export function subscribeProofreadEditorUpdates(
  projectId: string,
  listener: Listener,
): () => void {
  const channel = `${CHANNEL_PREFIX}${projectId}`;
  emitter.on(channel, listener);
  return () => {
    emitter.off(channel, listener);
  };
}
