import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TEMP_WRITE_ERROR,
  interpretPasteResult,
  planAttachmentPersist,
} from './cli-attachment-persist';

describe('interpretPasteResult', () => {
  test('returns ok when the backend supplied a path', () => {
    const outcome = interpretPasteResult({ path: '/tmp/ace-pastes/paste-x.png' });
    expect(outcome).toEqual({ kind: 'ok', path: '/tmp/ace-pastes/paste-x.png' });
  });

  test('preserves the backend error string instead of the generic temp-file message', () => {
    const outcome = interpretPasteResult({ path: null, error: 'attachment bytes were unreadable' });
    expect(outcome).toEqual({ kind: 'error', error: 'attachment bytes were unreadable' });
    if (outcome.kind === 'error') {
      expect(outcome.error).not.toBe(DEFAULT_TEMP_WRITE_ERROR);
    }
  });

  test('preserves a propagated daemon error (e.g. ENOSPC) verbatim', () => {
    const outcome = interpretPasteResult({
      path: null,
      error: 'ENOSPC: no space left on device, write',
    });
    expect(outcome).toEqual({
      kind: 'error',
      error: 'ENOSPC: no space left on device, write',
    });
  });

  test('falls back to the generic temp-file message only when no error string is supplied', () => {
    expect(interpretPasteResult({ path: null })).toEqual({
      kind: 'error',
      error: DEFAULT_TEMP_WRITE_ERROR,
    });
    expect(interpretPasteResult(null)).toEqual({
      kind: 'error',
      error: DEFAULT_TEMP_WRITE_ERROR,
    });
    expect(interpretPasteResult(undefined)).toEqual({
      kind: 'error',
      error: DEFAULT_TEMP_WRITE_ERROR,
    });
  });

  test('honors a caller-supplied fallback for context-specific messages', () => {
    expect(interpretPasteResult({ path: null }, 'remote workspace unavailable')).toEqual({
      kind: 'error',
      error: 'remote workspace unavailable',
    });
  });

  test('prefers path over error when both are present (defensive)', () => {
    const outcome = interpretPasteResult({ path: '/tmp/x', error: 'partial warning' });
    expect(outcome).toEqual({ kind: 'ok', path: '/tmp/x' });
  });
});

describe('planAttachmentPersist', () => {
  test('local workspace with no taskId uses the local-path-first shortcut', () => {
    expect(planAttachmentPersist({ taskId: null, isRemoteWorkspace: false }))
      .toEqual({ kind: 'local-path-first' });
    expect(planAttachmentPersist({ taskId: undefined, isRemoteWorkspace: false }))
      .toEqual({ kind: 'local-path-first' });
  });

  test('local workspace with a taskId still uses the local-path-first shortcut', () => {
    // The on-disk path lives on the same machine the local agent reads from,
    // so the shortcut is safe and skips the bytes round-trip.
    expect(planAttachmentPersist({ taskId: 'task_local_42', isRemoteWorkspace: false }))
      .toEqual({ kind: 'local-path-first' });
  });

  test('remote workspace MUST persist bytes — the local desktop path is unreachable from the remote host', () => {
    const plan = planAttachmentPersist({ taskId: 'task_remote_99', isRemoteWorkspace: true });
    expect(plan).toEqual({ kind: 'remote-bytes', taskId: 'task_remote_99' });
    // Specifically: the policy must NOT permit returning local-path-first
    // for a remote workspace — that's the regression validator flagged.
    expect(plan.kind).not.toBe('local-path-first');
  });

  test('remote workspace without a taskId falls back to local-path-first', () => {
    // No taskId means the picker has no remote target to write to yet — the
    // composer is unattached, so persisting locally is the only honest
    // option (and the eventual send is gated by attachment.blockReason).
    expect(planAttachmentPersist({ taskId: null, isRemoteWorkspace: true }))
      .toEqual({ kind: 'local-path-first' });
  });
});

