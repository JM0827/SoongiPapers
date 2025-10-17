import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTranslationStageJob } from '../stageWorker';

type OverrideMap = Record<string, unknown>;

const setOverrides = (overrides: OverrideMap) => {
  (globalThis as { __STAGE_WORKER_MOCKS?: OverrideMap }).__STAGE_WORKER_MOCKS = overrides;
};

const clearOverrides = () => {
  delete (globalThis as { __STAGE_WORKER_MOCKS?: OverrideMap }).__STAGE_WORKER_MOCKS;
};

test('literal stage persists results and enqueues style', async (t) => {
  const ensureBaselineMock = t.mock.fn(async () => ({ text: 'baseline' }));
  const runLiteralMock = t.mock.fn(async () => [
    {
      segmentId: 'seg-1',
      stage: 'literal',
      textTarget: 'literal-output',
    },
  ]);
  const persistMock = t.mock.fn(async () => undefined);
  const enqueueMock = t.mock.fn(async () => undefined);
  const fetchMemoryMock = t.mock.fn(async () => null);

  setOverrides({
    ensureBaseline: ensureBaselineMock,
    runLiteralStage: runLiteralMock,
    persistStageResults: persistMock,
    enqueueTranslationStageJob: enqueueMock,
    fetchProjectMemory: fetchMemoryMock,
  });

  t.after(clearOverrides);

  const job = {
    data: {
      projectId: 'proj-1',
      jobId: 'job-1',
      workflowRunId: null,
      stage: 'literal',
      memoryVersion: 1,
      config: { sourceLang: 'ko', targetLang: 'en', temps: {} },
      segmentBatch: [
        {
          segmentId: 'seg-1',
          segmentIndex: 0,
          textSource: '원문 문장',
          stageOutputs: {},
        },
      ],
      batchNumber: 1,
      batchCount: 1,
    },
  } as const;

  await handleTranslationStageJob(job as any);

  assert.equal(ensureBaselineMock.mock.callCount(), 1);
  assert.equal(runLiteralMock.mock.callCount(), 1);
  assert.equal(persistMock.mock.callCount(), 1);
  assert.equal(enqueueMock.mock.callCount(), 1);

  const enqueued = enqueueMock.mock.calls[0].arguments[0];
  assert.equal(enqueued.stage, 'style');
  assert.equal(enqueued.segmentBatch[0].stageOutputs.literal.textTarget, 'literal-output');

});

test('qa stage without guard failures finalizes and completes workflow', async (t) => {
  const runQaMock = t.mock.fn(async () => [
    { segmentId: 'seg-1', stage: 'qa', textTarget: 'qa-output', guards: null },
  ]);
  const evaluateGuardsMock = t.mock.fn(async (_, results: any[]) => results);
  const persistMock = t.mock.fn(async () => undefined);
  const fetchMemoryMock = t.mock.fn(async () => null);
  const finalizeMock = t.mock.fn(async () => ({
    finalized: true,
    completedNow: true,
    translationFileId: 'tf-1',
    needsReviewCount: 0,
  }));
  const completeActionMock = t.mock.fn(async () => undefined);
  const infoMock = t.mock.method(console, 'info', () => undefined);

  setOverrides({
    runQaStage: runQaMock,
    evaluateGuards: evaluateGuardsMock,
    persistStageResults: persistMock,
    fetchProjectMemory: fetchMemoryMock,
    finalizeSequentialJob: finalizeMock,
    completeAction: completeActionMock,
  });

  t.after(clearOverrides);
  t.after(() => infoMock.mock.restore());

  const job = {
    data: {
      projectId: 'proj-1',
      jobId: 'job-qa',
      workflowRunId: 'wf-1',
      stage: 'qa',
      memoryVersion: 1,
      config: { sourceLang: 'ko', targetLang: 'en', temps: {} },
      segmentBatch: [
        {
          segmentId: 'seg-1',
          segmentIndex: 0,
          textSource: '원문 문장',
          stageOutputs: {
            literal: { segmentId: 'seg-1', stage: 'literal', textTarget: 'literal-output' },
            style: { segmentId: 'seg-1', stage: 'style', textTarget: 'style-output' },
            emotion: { segmentId: 'seg-1', stage: 'emotion', textTarget: 'emotion-output' },
          },
        },
      ],
      batchNumber: 1,
      batchCount: 1,
    },
  } as const;

  await handleTranslationStageJob(job as any);

  assert.equal(runQaMock.mock.callCount(), 1);
  assert.equal(evaluateGuardsMock.mock.callCount(), 1);
  assert.equal(persistMock.mock.callCount(), 1);
  assert.equal(finalizeMock.mock.callCount(), 1);
  assert.equal(completeActionMock.mock.callCount(), 1);

});

test('qa stage guard failure enqueues retry with downgraded config', async (t) => {
  const runQaMock = t.mock.fn(async () => [
    {
      segmentId: 'seg-1',
      stage: 'qa',
      textTarget: 'qa-output',
      guards: { allOk: false },
    },
  ]);
  const evaluateGuardsMock = t.mock.fn(async () => [
    {
      segmentId: 'seg-1',
      stage: 'qa',
      textTarget: 'qa-output',
      guards: { allOk: false },
    },
  ]);
  const persistMock = t.mock.fn(async () => undefined);
  const fetchMemoryMock = t.mock.fn(async () => null);
  const enqueueMock = t.mock.fn(async () => undefined);

  setOverrides({
    runQaStage: runQaMock,
    evaluateGuards: evaluateGuardsMock,
    persistStageResults: persistMock,
    fetchProjectMemory: fetchMemoryMock,
    enqueueTranslationStageJob: enqueueMock,
  });

  t.after(clearOverrides);

  const job = {
    data: {
      projectId: 'proj-1',
      jobId: 'job-qa',
      workflowRunId: null,
      stage: 'qa',
      memoryVersion: 1,
      config: {
        sourceLang: 'ko',
        targetLang: 'en',
        temps: { literal: 0.35 },
        creativeAutonomy: 'medium',
      },
      segmentBatch: [
        {
          segmentId: 'seg-1',
          segmentIndex: 0,
          textSource: '원문 문장',
          stageOutputs: {
            literal: { segmentId: 'seg-1', stage: 'literal', textTarget: 'literal-output' },
            style: { segmentId: 'seg-1', stage: 'style', textTarget: 'style-output' },
            emotion: { segmentId: 'seg-1', stage: 'emotion', textTarget: 'emotion-output' },
          },
        },
      ],
      batchNumber: 1,
      batchCount: 1,
      retryContext: null,
    },
  } as const;

  const result = await handleTranslationStageJob(job as any);

  assert.equal(result.stage, 'qa');
  assert.equal(enqueueMock.mock.callCount(), 1);
  const payload = enqueueMock.mock.calls[0].arguments[0];
  assert.equal(payload.stage, 'style');
  assert.equal(payload.retryContext.attempt, 1);
  assert.equal(payload.config.creativeAutonomy, 'none');

});
