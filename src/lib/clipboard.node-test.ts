import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dataTransferHasType,
  filesFromClipboard,
  pathsFromDataTransfer,
} from './clipboard';

test('dataTransferHasType supports DOMStringList-style contains()', () => {
  const data = {
    types: {
      contains: (value: string) => value === 'application/x-ace-paths',
    },
  } as unknown as DataTransfer;

  assert.equal(dataTransferHasType(data, 'application/x-ace-paths'), true);
  assert.equal(dataTransferHasType(data, 'Files'), false);
});

test('dataTransferHasType supports array-style includes()', () => {
  const data = {
    types: ['Files', 'text/plain'],
  } as unknown as DataTransfer;

  assert.equal(dataTransferHasType(data, 'Files'), true);
  assert.equal(dataTransferHasType(data, 'application/x-ace-paths'), false);
});

test('dataTransferHasType supports plain iterable fallback', () => {
  const data = {
    types: {
      *[Symbol.iterator]() {
        yield 'text/plain';
        yield 'application/x-ace-paths';
      },
    },
  } as unknown as DataTransfer;

  assert.equal(dataTransferHasType(data, 'application/x-ace-paths'), true);
  assert.equal(dataTransferHasType(data, 'Files'), false);
});

test('dataTransferHasType returns false for missing data or missing types', () => {
  assert.equal(dataTransferHasType(null, 'Files'), false);
  assert.equal(dataTransferHasType(undefined, 'Files'), false);
  assert.equal(dataTransferHasType({} as DataTransfer, 'Files'), false);
});

test('filesFromClipboard prefers file items over files fallback', () => {
  const fileFromItems = new File(['item'], 'item.png', { type: 'image/png' });
  const fileFromFiles = new File(['fallback'], 'fallback.txt', { type: 'text/plain' });
  const data = {
    items: [{ kind: 'file', getAsFile: () => fileFromItems }],
    files: [fileFromFiles],
  } as unknown as DataTransfer;

  assert.deepEqual(filesFromClipboard(data), [fileFromItems]);
});

test('filesFromClipboard falls back to files when items is empty', () => {
  const fileFromFiles = new File(['fallback'], 'fallback.txt', { type: 'text/plain' });
  const data = {
    items: [],
    files: [fileFromFiles],
  } as unknown as DataTransfer;

  assert.deepEqual(filesFromClipboard(data), [fileFromFiles]);
});

test('filesFromClipboard ignores items with non-file kind', () => {
  const fileFromItems = new File(['item'], 'item.png', { type: 'image/png' });
  const fileFromFiles = new File(['fallback'], 'fallback.txt', { type: 'text/plain' });
  const data = {
    items: [
      { kind: 'string', getAsFile: () => fileFromFiles },
      { kind: 'file', getAsFile: () => fileFromItems },
    ],
    files: [fileFromFiles],
  } as unknown as DataTransfer;

  assert.deepEqual(filesFromClipboard(data), [fileFromItems]);
});

test('filesFromClipboard stages arbitrary documents, not just images (generic file support)', () => {
  // A2: PDF / Excel / CSV / DOCX File objects must come through exactly like
  // images — the helper keys off item.kind === 'file', never the MIME type.
  const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
  const xlsx = new File(['x'], 'sheet.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const csv = new File(['a,b'], 'data.csv', { type: 'text/csv' });
  const docx = new File(['d'], 'doc.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  const fromItems = {
    items: [
      { kind: 'file', getAsFile: () => pdf },
      { kind: 'file', getAsFile: () => xlsx },
    ],
    files: [],
  } as unknown as DataTransfer;
  assert.deepEqual(filesFromClipboard(fromItems), [pdf, xlsx]);

  const fromFiles = {
    items: [],
    files: [csv, docx],
  } as unknown as DataTransfer;
  assert.deepEqual(filesFromClipboard(fromFiles), [csv, docx]);
});

test('filesFromClipboard returns empty arrays for missing or empty data', () => {
  assert.deepEqual(filesFromClipboard(null), []);
  assert.deepEqual(filesFromClipboard(undefined), []);
  assert.deepEqual(filesFromClipboard({ items: [], files: [] } as unknown as DataTransfer), []);
});

// NOTE: resolveLocalFilePath depends on browser/Electron File APIs that do not
// exist cleanly under node --test, so pathsFromDataTransfer coverage stays on
// path payload parsing and empty fallback behavior.
test('pathsFromDataTransfer parses path payloads and filters invalid entries', () => {
  const data = {
    getData: (type: string) =>
      type === 'application/x-ace-paths'
        ? JSON.stringify(['/repo/a.ts', '', '   ', 42, '/repo/b.ts'])
        : '',
    items: [],
    files: [],
  } as unknown as DataTransfer;

  assert.deepEqual(pathsFromDataTransfer(data), ['/repo/a.ts', '/repo/b.ts']);
});

test('pathsFromDataTransfer returns empty arrays for malformed or absent payloads', () => {
  const malformedData = {
    getData: (type: string) =>
      type === 'application/x-ace-paths' ? '{not json' : '',
    items: [],
    files: [],
  } as unknown as DataTransfer;
  const emptyData = {
    getData: () => '',
    items: [],
    files: [],
  } as unknown as DataTransfer;

  assert.deepEqual(pathsFromDataTransfer(malformedData), []);
  assert.deepEqual(pathsFromDataTransfer(emptyData), []);
});
