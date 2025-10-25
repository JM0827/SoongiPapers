import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildOriginPrepSnapshot,
  evaluateTranslationPrereqs,
  type OriginProfileJobInfo,
} from '../originPrep';

describe('originPrep snapshot builder', () => {
  const baseOriginDoc = {
    _id: 'origin-1',
    project_id: 'project-1',
    job_id: 'job-1',
    file_type: 'text',
    file_size: 12,
    original_filename: 'origin.txt',
    text_content: 'Once upon a time',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-02T00:00:00Z'),
  } as any;

  const baseOriginProfile = {
    _id: 'profile-1',
    project_id: 'project-1',
    type: 'origin',
    version: 1,
    metrics: {
      wordCount: 100,
      charCount: 500,
      paragraphCount: 10,
      readingTimeMinutes: 3,
      readingTimeLabel: '3m',
    },
    summary: {
      story: 'A story summary',
      intention: 'Share a tale',
      readerPoints: ['point'],
    },
    translation_notes: {
      characters: [],
      namedEntities: [],
      locations: [],
      measurementUnits: [],
      linguisticFeatures: [],
      timePeriod: null,
    },
    created_at: new Date('2024-01-02T00:00:00Z'),
    updated_at: new Date('2024-01-03T00:00:00Z'),
    origin_file_id: 'origin-1',
    source_hash: 'hash-123',
  } as any;

  it('marks upload and analysis missing when nothing exists', () => {
    const snapshot = buildOriginPrepSnapshot({
      projectId: 'project-1',
      originDoc: null,
      originProfile: null,
      latestProfileJob: null,
    });

    assert.strictEqual(snapshot.upload.status, 'missing');
    assert.strictEqual(snapshot.analysis.status, 'missing');
    assert.strictEqual(snapshot.notes.status, 'missing');
    assert.deepStrictEqual(
      snapshot.blockingReasons.map((item) => item.step),
      ['upload', 'analysis', 'notes'],
    );
  });

  it('reports complete when profile is current', () => {
    const snapshot = buildOriginPrepSnapshot({
      projectId: 'project-1',
      originDoc: baseOriginDoc,
      originProfile: baseOriginProfile,
      latestProfileJob: null,
    });

    assert.strictEqual(snapshot.upload.status, 'uploaded');
    assert.strictEqual(snapshot.analysis.status, 'complete');
    assert.strictEqual(snapshot.notes.status, 'complete');
    assert.strictEqual(snapshot.blockingReasons.length, 0);
    assert.deepStrictEqual(evaluateTranslationPrereqs(snapshot), []);
  });

  it('flags stale when origin changes after profile', () => {
    const nextOrigin = {
      ...baseOriginDoc,
      _id: 'origin-2',
      updated_at: new Date('2024-02-01T00:00:00Z'),
    } as any;

    const snapshot = buildOriginPrepSnapshot({
      projectId: 'project-1',
      originDoc: nextOrigin,
      originProfile: baseOriginProfile,
      latestProfileJob: null,
    });

    assert.strictEqual(snapshot.analysis.status, 'stale');
    assert.strictEqual(snapshot.notes.status, 'stale');
    assert.ok(snapshot.blockingReasons.find((item) => item.step === 'analysis'));
    assert.ok(snapshot.blockingReasons.find((item) => item.step === 'notes'));
    assert.deepStrictEqual(evaluateTranslationPrereqs(snapshot), [
      'analysis',
      'notes',
    ]);
  });

  it('shows running when a profile job is active', () => {
    const job: OriginProfileJobInfo = {
      jobId: 'job-profile-1',
      status: 'running',
      createdAt: '2024-03-01T00:00:00Z',
      updatedAt: '2024-03-01T00:10:00Z',
      finishedAt: null,
    };

    const snapshot = buildOriginPrepSnapshot({
      projectId: 'project-1',
      originDoc: baseOriginDoc,
      originProfile: baseOriginProfile,
      latestProfileJob: job,
    });

    assert.strictEqual(snapshot.analysis.status, 'running');
    assert.strictEqual(snapshot.notes.status, 'stale');
    const analysisBlock = snapshot.blockingReasons.find(
      (item) => item.step === 'analysis',
    );
    assert.ok(analysisBlock);
    assert.strictEqual(analysisBlock?.jobId, job.jobId);
  });
});
