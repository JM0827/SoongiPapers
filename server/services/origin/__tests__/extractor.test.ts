import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const nodeRequire: NodeJS.Require = createRequire(__filename);
const fixturesDir = path.resolve(__dirname, '../../../..', 'web/files');

const hwpMockText = '엄마의 얼굴엔 피곤이 노인의 상념이 되어 잠겨 들어가고 있었다.';

function createMockSpawn() {
  return function mockSpawn() {
    const child = new EventEmitter() as any;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => void 0;

    queueMicrotask(() => {
      stdout.emit('data', Buffer.from(hwpMockText, 'utf8'));
      stdout.end();
      child.emit('close', 0);
    });

    return child;
  };
}

test('extractOriginFromUpload handles txt, hwp, and pdf inputs', async (t) => {
  const childProcess = nodeRequire('node:child_process') as {
    spawn: typeof import('node:child_process').spawn;
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = createMockSpawn() as any;
  const originalPythonBin = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = 'fake-python';

  const extractorPath = nodeRequire.resolve('../../origin/extractor');
  if (nodeRequire.cache?.[extractorPath]) {
    delete nodeRequire.cache[extractorPath];
  }
  const extractorModule = nodeRequire(extractorPath) as typeof import('../../origin/extractor');
  const { extractOriginFromUpload } = extractorModule;

  try {
    await t.test('hwp extraction uses python output', async () => {
      const buffer = await fs.readFile(path.join(fixturesDir, '검정 우산.hwp'));
      const result = await extractOriginFromUpload({
        buffer,
        filename: '검정 우산.hwp',
        mimeType: 'application/x-hwp',
      });

      assert.equal(result.metadata.extractor, 'hwp-extractor');
      assert.ok(result.text.includes(hwpMockText.slice(0, 10)));
    });
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalPythonBin === undefined) {
      delete process.env.PYTHON_BIN;
    } else {
      process.env.PYTHON_BIN = originalPythonBin;
    }
  }

  await t.test('plain text extraction preserves narrative content', async () => {
    const buffer = await fs.readFile(path.join(fixturesDir, '보리 두 말.txt'));
    const result = await extractOriginFromUpload({
      buffer,
      filename: '보리 두 말.txt',
      mimeType: 'text/plain',
    });

    assert.equal(result.metadata.extractor, 'plain');
    assert.ok(result.text.includes('아버지는 늘 한쪽 다리를 반걸음 뒤에 두었다'));
    assert.ok(result.metadata.characterCount > 1000);
  });

  await t.test('pdf extraction returns text via pdf-parse', async () => {
    const buffer = Buffer.from('%PDF-1.4 synthetic fixture');
    const modulePath = nodeRequire.resolve('pdf-parse');
    const originalEntry = nodeRequire.cache?.[modulePath];

    const stubText = [
      '흐린 공항 앞 광장에서 검정 우산을 든 사람들이 서 있었다.',
      '빗방울이 떨어질 듯한 오후 공기 속에서 우산 천이 바람에 잔잔히 흔들렸다.',
      '멀리서 버스 엔진 소리가 들려오자 모두가 우산을 꼭 쥐고 한 걸음씩 움직였다.',
      '작은 물방울이 우산 끝에서 또르르 떨어져 바닥에 꽃무늬를 그렸다.',
    ].join(' ');

    nodeRequire.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: async () => ({ text: stubText }),
      children: [],
    } as any;

    try {
      const result = await extractOriginFromUpload({
        buffer,
        filename: 'synthetic.pdf',
        mimeType: 'application/pdf',
      });

      assert.equal(result.metadata.extractor, 'pdf-parse');
      assert.ok(result.text.includes('검정 우산'));
      assert.ok(result.text.length > 100);
    } finally {
      if (originalEntry) {
        nodeRequire.cache[modulePath] = originalEntry;
      } else {
        delete nodeRequire.cache[modulePath];
      }
    }
  });

  await t.test('rejects unsupported file type', async () => {
    const buffer = Buffer.from('plain text payload', 'utf8');

    await assert.rejects(
      () =>
        extractOriginFromUpload({
          buffer,
          filename: 'notes.csv',
          mimeType: 'text/csv',
        }),
      (error: any) => {
        assert.match(String(error?.message ?? ''), /Unsupported file type/i);
        return true;
      },
    );
  });

  await t.test('rejects empty upload buffer', async () => {
    await assert.rejects(
      () =>
        extractOriginFromUpload({
          buffer: Buffer.alloc(0),
          filename: 'empty.txt',
          mimeType: 'text/plain',
        }),
      (error: any) => {
        assert.match(String(error?.message ?? ''), /empty/i);
        return true;
      },
    );
  });

  await t.test('rejects files above size limit', async () => {
    const bigBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 0);

    await assert.rejects(
      () =>
        extractOriginFromUpload({
          buffer: bigBuffer,
          filename: 'huge.txt',
          mimeType: 'text/plain',
        }),
      (error: any) => {
        assert.match(String(error?.message ?? ''), /maximum allowed size/i);
        return true;
      },
    );
  });

  await t.test('surfaced python missing error for hwp extraction', async () => {
    const buffer = await fs.readFile(path.join(fixturesDir, '검정 우산.hwp'));
    const childProcess = nodeRequire('node:child_process') as {
      spawn: typeof import('node:child_process').spawn;
    };
    const originalSpawn = childProcess.spawn;

    childProcess.spawn = (() => {
      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
        stdout.end();
        stderr.end();
      });
      return child;
    }) as any;

    const originalPythonBin = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = 'missing-python-binary';

    try {
      await assert.rejects(
        () =>
          extractOriginFromUpload({
            buffer,
            filename: '검정 우산.hwp',
            mimeType: 'application/x-hwp',
          }),
        (error: any) => {
          assert.match(
            String(error?.message ?? ''),
            /Python executable "missing-python-binary" was not found/i,
          );
          return true;
        },
      );
    } finally {
      childProcess.spawn = originalSpawn;
      if (originalPythonBin === undefined) {
        delete process.env.PYTHON_BIN;
      } else {
        process.env.PYTHON_BIN = originalPythonBin;
      }
    }
  });
});
