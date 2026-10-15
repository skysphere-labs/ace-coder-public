export type DiffLine = {
  kind: 'context' | 'add' | 'del' | 'meta';
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type DiffEntry =
  | { state: 'loading' }
  | { state: 'loaded'; diff: string; binary: boolean }
  | { state: 'error'; message: string };

export function parseUnifiedDiff(raw: string): DiffHunk[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const oldStart = match ? Number(match[1]) : 0;
      const oldCount = match && match[2] !== undefined ? Number(match[2]) : 1;
      const newStart = match ? Number(match[3]) : 0;
      const newCount = match && match[4] !== undefined ? Number(match[4]) : 1;
      oldNo = oldStart;
      newNo = newStart;
      current = { oldStart, oldCount, newStart, newCount, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: line.slice(2), oldLineNo: null, newLineNo: null });
      continue;
    }
    if (line.startsWith('+')) {
      current.lines.push({
        kind: 'add',
        text: line.slice(1),
        oldLineNo: null,
        newLineNo: newNo,
      });
      newNo += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({
        kind: 'del',
        text: line.slice(1),
        oldLineNo: oldNo,
        newLineNo: null,
      });
      oldNo += 1;
    } else if (line.length === 0) {
      current.lines.push({
        kind: 'context',
        text: '',
        oldLineNo: oldNo,
        newLineNo: newNo,
      });
      oldNo += 1;
      newNo += 1;
    } else {
      const char = line.charAt(0);
      if (char === ' ') {
        current.lines.push({
          kind: 'context',
          text: line.slice(1),
          oldLineNo: oldNo,
          newLineNo: newNo,
        });
        oldNo += 1;
        newNo += 1;
      }
    }
  }
  return hunks;
}
