import assert from 'node:assert/strict';
import test from 'node:test';

import type { SequentialStageResult } from '../../types';
import { resolveQaTextTarget } from '../qaStage';

const makeResult = (textTarget: string | null): SequentialStageResult => ({
  segmentId: 'seg-1',
  stage: 'style',
  textTarget: textTarget ?? undefined,
}) as SequentialStageResult;

test('resolves target from emotion result when available', () => {
  const segment = {
    stageOutputs: {
      emotion: makeResult('emotion output'),
      style: makeResult('style output'),
      literal: makeResult('literal output'),
    },
  };

  const resolved = resolveQaTextTarget(segment as any, makeResult('from emotion'));

  assert.equal(resolved, 'from emotion');
});

test('falls back to emotion stage output on segment when prior result missing', () => {
  const segment = {
    stageOutputs: {
      emotion: makeResult('emotion output'),
      style: makeResult('style output'),
      literal: makeResult('literal output'),
    },
  };

  const resolved = resolveQaTextTarget(segment as any, undefined);

  assert.equal(resolved, 'emotion output');
});

test('falls back to style stage output when emotion missing', () => {
  const segment = {
    stageOutputs: {
      style: makeResult('style output'),
      literal: makeResult('literal output'),
    },
  };

  const resolved = resolveQaTextTarget(segment as any, undefined);

  assert.equal(resolved, 'style output');
});

test('falls back to literal stage output when emotion and style missing', () => {
  const segment = {
    stageOutputs: {
      literal: makeResult('literal output'),
    },
  };

  const resolved = resolveQaTextTarget(segment as any, undefined);

  assert.equal(resolved, 'literal output');
});

test('returns empty string when no prior text targets exist', () => {
  const segment = {
    stageOutputs: {},
  };

  const resolved = resolveQaTextTarget(segment as any, undefined);

  assert.equal(resolved, '');
});
