import assert from 'node:assert/strict';
import test from 'node:test';

import { applyProofreadingChanges, __setTestMongoDb } from '../mongo';

test('applyProofreadingChanges marks items applied and updates translation', async (t) => {
  const existingReport = {
    results: [
      {
        group: 'Core Corrections',
        subfeatureKey: 'grammar_spelling_punct',
        subfeatureLabel: 'Grammar',
        items: [
          { id: 'issue-1', status: 'pending', appliedAt: null },
          { id: 'issue-2', status: 'pending', appliedAt: null },
        ],
      },
    ],
  };

  const existingQuick = {
    results: [
      {
        group: 'Core Corrections',
        subfeatureKey: 'grammar_spelling_punct',
        subfeatureLabel: 'Grammar',
        items: [
          { id: 'issue-1', status: 'pending', appliedAt: null },
        ],
      },
    ],
  };

  const proofDoc = {
    proofreading_id: 'proof-1',
    project_id: 'proj-1',
    job_id: 'job-1',
    report: existingReport,
    quick_report: existingQuick,
    deep_report: null,
    applied_issue_ids: ['issue-3'],
  } as const;

  const proofUpdateCalls: Array<{ query: unknown; update: any }> = [];
  const translationUpdateCalls: Array<{ query: unknown; update: any }> = [];

  const fakeDb = {
    collection(name: string) {
      if (name === 'proofreading_files') {
        return {
          async findOne(filter: unknown) {
            assert.deepEqual(filter, { proofreading_id: 'proof-1' });
            return proofDoc;
          },
          async updateOne(query: unknown, update: any) {
            proofUpdateCalls.push({ query, update });
            return { matchedCount: 1 };
          },
        };
      }
      if (name === 'translation_files') {
        return {
          async updateOne(query: unknown, update: any) {
            translationUpdateCalls.push({ query, update });
            return { matchedCount: 1 };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  } as const;

  __setTestMongoDb(fakeDb as any);
  t.after(() => __setTestMongoDb(null));

  const result = await applyProofreadingChanges({
    proofreading_id: 'proof-1',
    appliedIssueIds: ['issue-1', 'issue-3'],
    translatedContent: 'updated translation text',
  });

  assert.equal(proofUpdateCalls.length, 1, 'proofreading collection updated once');
  const proofUpdate = proofUpdateCalls[0].update.$set;
  assert.equal(proofUpdate.applied_translated_content, 'updated translation text');
  assert.ok(proofUpdate.updated_at instanceof Date);
  assert.deepEqual(
    new Set(proofUpdate.applied_issue_ids),
    new Set(['issue-3', 'issue-1']),
  );

  const updatedBuckets = proofUpdate.report.results[0].items;
  const appliedItem = updatedBuckets.find((item: any) => item.id === 'issue-1');
  assert.equal(appliedItem.status, 'applied');
  assert.ok(appliedItem.appliedAt);

  assert.equal(result.report.appliedTranslation, 'updated translation text');
  assert.equal(result.quick_report?.appliedTranslation, 'updated translation text');

  assert.equal(translationUpdateCalls.length, 1, 'translation file updated once');
  const translationUpdate = translationUpdateCalls[0].update.$set;
  assert.equal(translationUpdate.translated_content, 'updated translation text');
  assert.ok(translationUpdate.updated_at instanceof Date);
});
