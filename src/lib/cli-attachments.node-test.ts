import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildCliAttachmentSubmission,
  fileExtensionForAttachment,
  getCliAttachmentBlockReason,
  type CliAttachment,
} from './cli-attachments';
import {
  dataTransferHasType,
  filesFromClipboard,
  pathsFromDataTransfer,
} from './clipboard';
import { parseHermesStatusLine } from './hermes-status';
import type { TranscriptEntry } from './ace-api';
import {
  matchesOptimisticUserEntry,
  filterPendingOptimisticUserEntries,
  mergePendingOptimisticUserEntries,
  pruneStaleOptimisticEntries,
  type TranscriptViewEntry,
} from '../runtime/transcript-registry';
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from '../runtime/composer-draft-registry';
import { getAceChatMode, setAceChatMode } from '../runtime/ace-chat-mode-registry';
import { isVisibleSystemInfoText } from '../components/ace-chat/entries/system-info-filter';
import {
  dedupeComposedValue,
  shouldCommitComposerInput,
} from '../components/mobile-composer/composition';

test('CLI attachment submission appends resolved @path lines after body', () => {
  const attachments: CliAttachment[] = [
    { id: 'a', name: 'one.png', status: 'ready', path: '/tmp/one.png' },
    { id: 'b', name: 'two.txt', status: 'ready', path: '/Users/me/two.txt' },
  ];

  // The body stays first so a leading slash command (e.g. `/goal …`) remains at
  // the start of the message and is still recognized by the CLI.
  assert.deepEqual(buildCliAttachmentSubmission('  explain these  ', attachments), {
    ok: true,
    text: 'explain these\n\n@/tmp/one.png\n@/Users/me/two.txt',
  });
});

test('CLI attachment submission keeps a leading /goal slash command on the first line', () => {
  const attachments: CliAttachment[] = [
    { id: 'a', name: 'shot.png', status: 'ready', path: '/tmp/shot.png' },
  ];

  const result = buildCliAttachmentSubmission('/goal fix the mobile bug', attachments);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.text.startsWith('/goal '));
});

test('CLI attachment submission allows empty text with ready attachments', () => {
  const attachments: CliAttachment[] = [
    { id: 'a', name: 'one.png', status: 'ready', path: '/tmp/one.png' },
  ];

  assert.deepEqual(buildCliAttachmentSubmission('', attachments), {
    ok: true,
    text: '@/tmp/one.png',
  });
});

test('CLI attachment submission blocks uploading, failed, and unresolved attachments', () => {
  assert.equal(
    getCliAttachmentBlockReason([{ id: 'a', name: 'image.png', status: 'uploading' }]),
    'Still attaching image.png'
  );
  assert.equal(
    getCliAttachmentBlockReason([
      { id: 'b', name: 'file.txt', status: 'error', error: 'Path unavailable' },
    ]),
    'Path unavailable'
  );
  assert.equal(
    getCliAttachmentBlockReason([{ id: 'c', name: 'ghost.txt', status: 'ready' }]),
    'No path available for ghost.txt'
  );
});

test('clipboard helpers tolerate DOMStringList-style types and file fallbacks', () => {
  const fileFromItems = new File(['image'], 'pasted.png', { type: 'image/png' });
  const fileFromFiles = new File(['legacy'], 'legacy.txt', { type: 'text/plain' });

  const typedData = {
    types: { contains: (value: string) => value === 'application/x-ace-pane-tab' },
  } as unknown as DataTransfer;
  assert.equal(dataTransferHasType(typedData, 'application/x-ace-pane-tab'), true);
  assert.equal(dataTransferHasType(typedData, 'Files'), false);

  const itemData = {
    items: [{ kind: 'file', getAsFile: () => fileFromItems }],
    files: [fileFromFiles],
  } as unknown as DataTransfer;
  assert.deepEqual(filesFromClipboard(itemData), [fileFromItems]);

  const filesOnlyData = {
    items: [],
    files: [fileFromFiles],
  } as unknown as DataTransfer;
  assert.deepEqual(filesFromClipboard(filesOnlyData), [fileFromFiles]);
});

test('drop path helper preserves ace path MIME before file fallback', () => {
  const data = {
    getData: (type: string) =>
      type === 'application/x-ace-paths' ? JSON.stringify(['/repo/a.ts', '/repo/b.ts']) : '',
    items: [],
    files: [],
  } as unknown as DataTransfer;

  assert.deepEqual(pathsFromDataTransfer(data), ['/repo/a.ts', '/repo/b.ts']);
});

test('desktop Codex, Gemini, Claude, and Hermes composers share CLI attachment overlay wiring', () => {
  const root = process.cwd();
  const composer = readFileSync(join(root, 'src/components/ace-chat/Composer.tsx'), 'utf8');
  const codex = readFileSync(join(root, 'src/components/ace-chat/composers/CodexComposer.tsx'), 'utf8');
  const gemini = readFileSync(join(root, 'src/components/ace-chat/composers/GeminiComposer.tsx'), 'utf8');
  const claude = readFileSync(join(root, 'src/components/ace-chat/composers/ClaudeComposer.tsx'), 'utf8');
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const shell = readFileSync(join(root, 'src/components/ace-chat/ComposerShell.tsx'), 'utf8');

  assert.match(composer, /<CodexComposer[\s\S]*taskId=\{taskId\}/);
  assert.match(composer, /<GeminiComposer[\s\S]*taskId=\{taskId\}/);
  assert.match(composer, /<HermesComposer[\s\S]*taskId=\{taskId\}/);
  assert.match(composer, /case 'hermes':/);
  for (const source of [codex, gemini, claude, hermes]) {
    assert.match(source, /useDesktopCliAttachments/);
    assert.match(source, /DesktopCliAttachmentButton/);
    assert.match(source, /DesktopCliAttachmentTray/);
    assert.match(source, /buildCliAttachmentSubmission/);
    assert.match(source, /aceApi\.streams\.sendSubmit/);
  }
  assert.match(shell, /Enter send · Shift\+Enter newline/);
  assert.match(shell, /rows=\{1\}/);
  assert.match(claude, /Enter send · Shift\+Enter newline/);
  assert.match(claude, /rows=\{2\}/);
});

test('HermesComposer reuses the full attachment + slash + sendSubmit pipeline', () => {
  const hermes = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/composers/HermesComposer.tsx'),
    'utf8'
  );
  // Slash-then-fallback contract: try profile-declared slash first, then plain text.
  assert.match(hermes, /aceApi\.streams\.slash\(streamId, cmd, args\)/);
  assert.match(hermes, /aceApi\.streams\.sendSubmit\(streamId, submission\.text\)/);
  assert.match(hermes, /appendOptimisticUserEntry\(streamId, submission\.text\)[\s\S]*aceApi\.streams\.sendSubmit\(streamId, submission\.text\)/);
  assert.match(hermes, /confirmOptimisticUserEntry\(streamId, optimisticEntryId\)/);
  assert.match(hermes, /removeOptimisticUserEntry\(streamId, optimisticEntryId\)/);
  // Block reasons from useDesktopCliAttachments must gate sending.
  assert.match(hermes, /attachments\.blockReason/);
  // Empty-text submit allowed when only attachments are present.
  assert.match(hermes, /allowEmptySubmit=\{attachments\.attachments\.length > 0\}/);
});

test('mobile Agents/Hermes lane swaps to the + composer but reuses the sendSubmit pipeline', () => {
  const root = process.cwd();
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const mobile = readFileSync(join(root, 'src/components/ace-chat/MobileChatComposer.tsx'), 'utf8');
  const shell = readFileSync(join(root, 'src/components/ace-chat/ComposerShell.tsx'), 'utf8');
  const plus = readFileSync(join(root, 'src/components/mobile-composer/PlusSheet.tsx'), 'utf8');

  // HermesComposer branches to the mobile composer on a narrow viewport and
  // hands it the very same submitBody (sendSubmit / slash / optimistic) +
  // staged attachments + slash menu — the desktop ComposerShell stays intact
  // below the branch so nothing about the Hermes pipeline changes.
  assert.match(hermes, /import \{ useIsMobileViewport \} from '\.\.\/\.\.\/\.\.\/runtime\/use-mobile-viewport';/);
  assert.match(hermes, /const isMobile = useIsMobileViewport\(\);/);
  assert.match(hermes, /if \(isMobile\) \{[\s\S]*<MobileChatComposer/);
  assert.match(hermes, /<MobileChatComposer[\s\S]*onSubmit=\{submitBody\}/);
  assert.match(hermes, /<MobileChatComposer[\s\S]*attachments=\{attachments\}/);
  assert.match(hermes, /<MobileChatComposer[\s\S]*slashCommands=\{slashItems\}/);
  assert.match(hermes, /<MobileChatComposer[\s\S]*leftExtra=\{[\s\S]*<HermesSlashCommandMenu/);
  // The task id rides into the mobile composer so the task-backed actions can
  // turn on for a workspace-backed Hermes lane.
  assert.match(hermes, /<MobileChatComposer[\s\S]*taskId=\{taskId \?\? null\}/);

  // The mobile composer rides the shared ComposerShell (slash palette, paste→
  // attach, Enter-send, busy/interrupt) and only swaps the desktop attach
  // popover for the native + → PlusSheet sheet with composer-mounted inputs.
  assert.match(mobile, /import \{[\s\S]*ComposerShell[\s\S]*\} from '\.\/ComposerShell';/);
  assert.match(mobile, /<ComposerShell/);
  assert.match(mobile, /onSubmit=\{onSubmit\}/);
  assert.match(mobile, /onAttachFiles=\{attachments\.addFiles\}/);
  assert.match(mobile, /onAttachPaths=\{attachments\.addPaths\}/);
  assert.match(mobile, /slashCommands=\{slashCommands\}/);
  assert.match(mobile, /<DesktopCliAttachmentTray[\s\S]*attachments=\{attachments\.attachments\}/);
  assert.match(mobile, /aria-label="Attach"/);
  assert.match(mobile, /<Plus className="h-5 w-5"/);
  assert.match(mobile, /onClick=\{\(\) => setSheet\('plus'\)\}/);
  // PlusSheet rows render as <label htmlFor> via the composer-mounted inputs —
  // the iOS picker opens from the user tap with no programmatic .click().
  assert.match(mobile, /<PlusSheet[\s\S]*imageInputId=\{imageInputId\}[\s\S]*fileInputId=\{fileInputId\}/);
  assert.match(mobile, /id=\{imageInputId\}/);
  assert.match(mobile, /id=\{fileInputId\}/);
  assert.match(mobile, /accept="image\/\*"/);
  assert.match(mobile, /className="sr-only"/);
  assert.match(mobile, /onChange=\{onAttachInputChange\}/);
  assert.match(mobile, /attachments\.addFiles\(Array\.from\(input\.files\)\)/);
  assert.match(plus, /label="Photo"[\s\S]*htmlFor=\{imageInputId\}/);
  assert.match(plus, /label="File"[\s\S]*htmlFor=\{fileInputId\}/);
  // MobileChatComposer gets paste-file staging from ComposerShell; plain text
  // paste stays native because preventDefault only runs after files exist.
  assert.match(shell, /const files = filesFromClipboard\(e\.clipboardData\);/);
  assert.match(shell, /if \(files\.length === 0\) return;\s*e\.preventDefault\(\);\s*onAttachFiles\(files\);/);
  assert.doesNotMatch(mobile, /Paste from clipboard/);
  assert.doesNotMatch(mobile, /ClipboardPaste/);
  assert.doesNotMatch(mobile, /navigator\.clipboard\.readText/);
  // No control may gate on busy — Chief must steer/attach mid-turn.
  assert.doesNotMatch(mobile, /disabled=\{isBusy\}/);

  // FULL actions when a task backs the lane: Terminal reuses MobileTaskComposer's
  // terminal-mode registry pattern, and Clean-up routes the existing pruning
  // prompt back through the same onSubmit (so sendSubmit / optimistic transcript
  // stay intact — no raw terminal paste). Both are passed to PlusSheet guarded
  // on taskId, so a task-backed Hermes lane shows Photo / File / Terminal /
  // Clean-up while a task-less lane shows just Photo / File.
  assert.match(mobile, /from '\.\.\/\.\.\/runtime\/terminal-mode'/);
  assert.match(mobile, /from '\.\.\/\.\.\/runtime\/pane-layout-registry'/);
  assert.match(mobile, /import \{ PRUNE_PROMPT \} from '\.\.\/\.\.\/lib\/prune-prompt';/);
  assert.match(mobile, /useTerminalState\(taskId \?\? null\)/);
  assert.match(mobile, /if \(terminalState\.mode !== 'tab'\) setTerminalMode\(taskId, 'tab'\);/);
  assert.match(mobile, /if \(!terminalState\.open\) toggleTerminal\(taskId\);/);
  assert.match(mobile, /openRef\(taskId, \{ kind: 'terminal' \}\)/);
  assert.match(mobile, /void onSubmit\(PRUNE_PROMPT\)/);
  assert.match(mobile, /onOpenTerminal=\{taskId \? onOpenTerminal : undefined\}/);
  assert.match(mobile, /onCleanupCodebase=\{taskId \? onCleanupCodebase : undefined\}/);

  // PlusSheet keeps the actions optional (the task-less lane shows just the
  // Photo / File pickers plus the usage block).
  assert.match(plus, /onOpenTerminal\?: \(\) => void;/);
  assert.match(plus, /onCleanupCodebase\?: \(\) => void;/);
  assert.match(plus, /\{onOpenTerminal && \(/);
  assert.match(plus, /\{onCleanupCodebase && \(/);
});

test('Hermes slash toolbar exposes required lane commands and keeps stream submit path', () => {
  const root = process.cwd();
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const profile = JSON.parse(readFileSync(join(root, 'electron/ace-control/profiles/hermes.json'), 'utf8'));

  for (const command of profile.slash) {
    assert.match(hermes, new RegExp(`name: '${command}'`));
    assert.ok(profile.slash.includes(command), `Hermes profile should declare /${command}`);
  }

  assert.match(hermes, /function mergeHermesSlashCommands\(commands: string\[\]\): SlashCommand\[\]/);
  assert.match(hermes, /<HermesSlashCommandMenu[\s\S]*commands=\{slashItems\}/);
  assert.match(hermes, /onPick=\{\(command\) => \{[\s\S]*setText\(`\/\$\{command\.name\} `\);/);
  assert.match(hermes, /requestAnimationFrame\(\(\) => composerRef\.current\?\.focus\(\)\);/);
  assert.match(hermes, /const cmdMatch = \/\^\\\/\(\[a-zA-Z0-9_-\]\+\)/);
  assert.match(hermes, /aceApi\.streams\.slash\(streamId, cmd, args\)/);
  assert.match(hermes, /aceApi\.streams\.sendSubmit\(streamId, submission\.text\)/);
});

test('Hermes optimistic user bubbles reconcile against real transcript entries', () => {
  const registry = readFileSync(
    join(process.cwd(), 'src/runtime/transcript-registry.ts'),
    'utf8'
  );
  assert.match(registry, /export function appendOptimisticUserEntry\(streamId: string, text: string\): number/);
  assert.match(registry, /const OPTIMISTIC_USER_ENTRY_WINDOW_MS = 5 \* 60 \* 1000;/);
  assert.match(registry, /optimisticConfirmed\?: boolean/);
  assert.match(registry, /optimistic\.text !== real\.text/);
  assert.match(registry, /matchesOptimisticUserEntry\(candidate, entry\)/);
  assert.match(registry, /mergeSnapshotEntries\(streamId, snap\.entries\)/);
  assert.match(registry, /filterPendingOptimisticUserEntries\([\s\S]*mergedRealEntries,[\s\S]*current\.filter\(isOptimisticUserEntry\)/);
  assert.match(
    registry,
    /globalUnsub = aceApi\.streams\.onEvent\(\(eventPayload\) => \{[\s\S]*if \(event !== 'state-change'\) return;/
  );
  assert.match(registry, /isActiveStreamState\(streamState\)[\s\S]*patch\(streamId, \{ phase: 'streaming' \}\)/);
  assert.match(registry, /isSettledStreamState\(streamState\)[\s\S]*loadTranscript\(streamId\)/);
  assert.match(registry, /shouldRetainDetachedTranscript\(streamId\)/);
  assert.match(registry, /disposeTranscriptSubscription\(streamId\)/);
  assert.match(registry, /SETTLED_TRANSCRIPT_REFRESH_DELAYS_MS = \[80, 180\]/);
  assert.match(registry, /oldestRealEntryId\(state\.entries\)/);
  assert.match(registry, /if \(at !== bt\) return at - bt;\s+return a\.id - b\.id;/);
  // The optimistic Chief bubble must stamp its tAt just past the newest
  // existing entry (ignoring corrupt far-future stamps), so an agent-clock-ahead
  // previous turn can never sort a fresh send above the messages it follows
  // (the "my message jumped above the previous turn" bug).
  assert.match(registry, /const tAt = Math\.max\(now, maxTAt \+ 1\);/);
  assert.match(registry, /existing\.tAt <= now \+ OPTIMISTIC_USER_ENTRY_BACKWARD_SKEW_MS/);
  // TTL-based eviction must run on every transcript event, not just on
  // matching reconciliation, otherwise stale optimistic bubbles pin to the
  // bottom of the chat after their text fails to echo back exactly.
  assert.match(registry, /export function pruneStaleOptimisticEntries\(/);
  assert.match(registry, /export function mergePendingOptimisticUserEntries\(/);
  assert.match(registry, /withAliasOptimisticUserEntries\(streamId, state\.entries, payload\.sessionFile\)/);
  assert.match(registry, /withAliasOptimisticUserEntries\([\s\S]*mergeSnapshotEntries\(streamId, snap\.entries\),[\s\S]*snap\.sessionFile/);
  assert.match(registry, /nextEntries = pruneStaleOptimisticEntries\(nextEntries\);/);
  assert.match(registry, /export function confirmOptimisticUserEntry\(streamId: string, entryId: number\): void/);
  assert.match(registry, /optimisticConfirmed: true/);
  assert.match(registry, /!\(entry as TranscriptViewEntry\)\.optimisticConfirmed/);
});

test('native chat composers stay sendable while the agent is busy', () => {
  const root = process.cwd();
  const shell = readFileSync(join(root, 'src/components/ace-chat/ComposerShell.tsx'), 'utf8');
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const codex = readFileSync(join(root, 'src/components/ace-chat/composers/CodexComposer.tsx'), 'utf8');
  const gemini = readFileSync(join(root, 'src/components/ace-chat/composers/GeminiComposer.tsx'), 'utf8');
  const claude = readFileSync(join(root, 'src/components/ace-chat/composers/ClaudeComposer.tsx'), 'utf8');

  // ComposerShell only swaps the Send button for Interrupt when busy AND
  // there's nothing to send — text in the box flips it back to Send so the
  // user can steer mid-turn.
  assert.match(shell, /const showInterrupt = isBusy && !hasInput;/);
  assert.match(shell, /\{showInterrupt \?/);
  assert.match(shell, /const effectiveCanSend = canSend \?\? hasInput;/);
  assert.doesNotMatch(shell, /canSend \?\? \(!isBusy && /);

  // Per-agent canSend must not include `!isBusy &&`.
  for (const source of [hermes, codex, gemini]) {
    assert.doesNotMatch(source, /const canSend =\s*\n\s*!isBusy &&/);
  }
  // Claude has its own send button; busy alone must not pre-empt the send
  // affordance — only empty input + busy renders the interrupt button.
  assert.match(claude, /isBusy && !text\.trim\(\) && attachments\.attachments\.length === 0 \?/);
});

test('pruneStaleOptimisticEntries evicts optimistic bubbles past the reconciliation window', () => {
  const window = 5 * 60 * 1000;
  const now = 10_000_000;
  const fresh: TranscriptEntry = {
    id: 9_000_000_000_010,
    role: 'user',
    text: 'fresh',
    lifecycle: 'finished',
    tAt: now - 1000,
  };
  const stale: TranscriptEntry = {
    id: 9_000_000_000_011,
    role: 'user',
    text: 'stale',
    lifecycle: 'finished',
    tAt: now - window - 1,
  };
  const real: TranscriptEntry = {
    id: 1,
    role: 'user',
    text: 'old browser-use prompt',
    lifecycle: 'finished',
    tAt: now - window - 1, // ancient real entry must not be evicted
  };

  const out = pruneStaleOptimisticEntries([real, fresh, stale], now);
  assert.deepEqual(out.map((e) => e.id), [real.id, fresh.id]);
  // Inputs without stale optimistics return the original array (no churn).
  const noChurn = [real, fresh];
  assert.equal(pruneStaleOptimisticEntries(noChurn, now), noChurn);
});

test('confirmed optimistic Chief bubbles survive non-durable relink windows', () => {
  const window = 5 * 60 * 1000;
  const now = 10_000_000;
  const confirmed: TranscriptViewEntry = {
    id: 9_000_000_000_012,
    role: 'user',
    text: 'sent but no durable echo yet',
    lifecycle: 'finished',
    tAt: now - window - 1,
    optimisticConfirmed: true,
  };
  const stale: TranscriptViewEntry = {
    id: 9_000_000_000_013,
    role: 'user',
    text: 'send failed before confirmation',
    lifecycle: 'finished',
    tAt: now - window - 1,
  };

  assert.deepEqual(
    pruneStaleOptimisticEntries([confirmed, stale], now).map((entry) => entry.id),
    [confirmed.id]
  );
  assert.deepEqual(
    filterPendingOptimisticUserEntries([], [confirmed, stale], now).map((entry) => entry.id),
    [confirmed.id]
  );
});

test('confirmed optimistic Chief bubbles can move across Hermes state.db aliases', () => {
  const now = 10_000_000;
  const real: TranscriptViewEntry = {
    id: 1,
    role: 'agent',
    text: 'prior answer',
    lifecycle: 'finished',
    tAt: now - 2000,
  };
  const confirmed: TranscriptViewEntry = {
    id: 9_000_000_000_014,
    role: 'user',
    text: 'sent before alias relink',
    lifecycle: 'finished',
    tAt: now - 1000,
    optimisticConfirmed: true,
  };
  const duplicateRealEcho: TranscriptViewEntry = {
    id: 2,
    role: 'user',
    text: 'sent before alias relink',
    lifecycle: 'finished',
    tAt: now - 900,
  };

  const adopted = mergePendingOptimisticUserEntries([real], [confirmed], now);
  assert.deepEqual(adopted.map((entry) => entry.id), [real.id, confirmed.id]);
  const noChurn = [real, confirmed];
  assert.equal(
    mergePendingOptimisticUserEntries(noChurn, [confirmed], now),
    noChurn
  );
  assert.deepEqual(
    mergePendingOptimisticUserEntries([real, duplicateRealEcho], [confirmed], now).map((entry) => entry.id),
    [real.id, duplicateRealEcho.id]
  );
});

test('optimistic user dedupe ignores older identical text and accepts the real echo', () => {
  const optimistic = {
    id: 9_000_000_000_001,
    role: 'user',
    text: 'repeat',
    lifecycle: 'finished',
    tAt: 20_000,
  } satisfies TranscriptEntry;
  const olderDuplicate = {
    id: 4,
    role: 'user',
    text: 'repeat',
    lifecycle: 'finished',
    tAt: 18_500,
  } satisfies TranscriptEntry;
  const matchingEcho = {
    id: 5,
    role: 'user',
    text: 'repeat',
    lifecycle: 'finished',
    tAt: 20_150,
  } satisfies TranscriptEntry;

  assert.equal(matchesOptimisticUserEntry(optimistic, olderDuplicate), false);
  assert.equal(matchesOptimisticUserEntry(optimistic, matchingEcho), true);
});

test('optimistic user dedupe absorbs minor backward timestamp skew from the real echo', () => {
  // Real-world reproduction: the agent's session-file write lands a few
  // hundred ms before the renderer's Date.now() at submit. Without skew
  // tolerance the optimistic Chief bubble survives and we render two copies.
  const optimistic = {
    id: 9_000_000_000_010,
    role: 'user',
    text: 'sync skew check',
    lifecycle: 'finished',
    tAt: 30_000,
  } satisfies TranscriptEntry;
  const skewedEcho = {
    id: 11,
    role: 'user',
    text: 'sync skew check',
    lifecycle: 'finished',
    tAt: 29_500,
  } satisfies TranscriptEntry;
  const farOlder = {
    id: 12,
    role: 'user',
    text: 'sync skew check',
    lifecycle: 'finished',
    tAt: 28_000,
  } satisfies TranscriptEntry;

  assert.equal(matchesOptimisticUserEntry(optimistic, skewedEcho), true);
  assert.equal(matchesOptimisticUserEntry(optimistic, farOlder), false);

  // The pending filter must drop the optimistic once a backward-skewed real
  // echo lands, so the bottom of the transcript holds exactly one bubble.
  assert.deepEqual(
    filterPendingOptimisticUserEntries([skewedEcho], [optimistic], 30_500).map((entry) => entry.id),
    []
  );
});

test('optimistic user pending filter drops expired and reconciled bubbles', () => {
  const now = 10 * 60 * 1000;
  const fresh = {
    id: 9_000_000_000_002,
    role: 'user',
    text: 'fresh steer',
    lifecycle: 'finished',
    tAt: now - 1_000,
  } satisfies TranscriptEntry;
  const expired = {
    id: 9_000_000_000_003,
    role: 'user',
    text: 'old leaked steer',
    lifecycle: 'finished',
    tAt: now - 10 * 60 * 1000,
  } satisfies TranscriptEntry;
  const reconciled = {
    id: 9_000_000_000_004,
    role: 'user',
    text: 'echoed',
    lifecycle: 'finished',
    tAt: now - 2_000,
  } satisfies TranscriptEntry;
  const realEcho = {
    id: 7,
    role: 'user',
    text: 'echoed',
    lifecycle: 'finished',
    tAt: now - 1_900,
  } satisfies TranscriptEntry;

  assert.deepEqual(
    filterPendingOptimisticUserEntries([realEcho], [fresh, expired, reconciled], now).map((entry) => entry.id),
    [fresh.id]
  );
});

test('smart composer drafts persist per stream across unmounts', () => {
  clearComposerDraft('stream-a');
  clearComposerDraft('stream-b');

  setComposerDraft('stream-a', 'keep this steering note');
  assert.equal(getComposerDraft('stream-a'), 'keep this steering note');
  assert.equal(getComposerDraft('stream-b'), '');

  setComposerDraft('stream-b', 'other tab draft');
  setComposerDraft('stream-a', '');
  assert.equal(getComposerDraft('stream-a'), '');
  assert.equal(getComposerDraft('stream-b'), 'other tab draft');

  clearComposerDraft('stream-b');
});

test('native smart composers bind draft text to streamId registry', () => {
  const root = process.cwd();
  const registry = readFileSync(join(root, 'src/runtime/composer-draft-registry.ts'), 'utf8');
  const files = [
    'src/components/ace-chat/composers/HermesComposer.tsx',
    'src/components/ace-chat/composers/CodexComposer.tsx',
    'src/components/ace-chat/composers/GeminiComposer.tsx',
    'src/components/ace-chat/composers/ClaudeComposer.tsx',
  ];

  assert.match(registry, /const drafts = new Map<string, string>\(\);/);
  assert.match(registry, /export function useComposerDraft\(streamId: string\)/);
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.match(source, /useComposerDraft\(streamId\)/);
    assert.doesNotMatch(source, /const \[text, setText\] = useState\(''\)/);
  }
});

test('native chat composers allow steering sends while busy', () => {
  const root = process.cwd();
  const shell = readFileSync(join(root, 'src/components/ace-chat/ComposerShell.tsx'), 'utf8');
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const codex = readFileSync(join(root, 'src/components/ace-chat/composers/CodexComposer.tsx'), 'utf8');
  const gemini = readFileSync(join(root, 'src/components/ace-chat/composers/GeminiComposer.tsx'), 'utf8');
  const claude = readFileSync(join(root, 'src/components/ace-chat/composers/ClaudeComposer.tsx'), 'utf8');

  assert.match(shell, /allowBusySubmit\?: boolean/);
  assert.match(shell, /const showInterrupt = isBusy && !hasInput;/);
  assert.match(shell, /\{showInterrupt \?/);
  assert.match(shell, /const effectiveCanSend = canSend \?\? hasInput;/);
  assert.doesNotMatch(shell, /canSend \?\? \(!isBusy && /);

  for (const source of [hermes, codex, gemini]) {
    assert.doesNotMatch(source, /const canSend =\s*\n\s*!isBusy &&/);
  }
  assert.doesNotMatch(hermes, /HermesSlashCommandMenu[\s\S]*disabled=\{isBusy\}/);
  assert.match(claude, /isBusy && !text\.trim\(\) && attachments\.attachments\.length === 0 \?/);
});

test('native smart composers do not expose mic dictation controls', () => {
  const root = process.cwd();
  const shell = readFileSync(join(root, 'src/components/ace-chat/ComposerShell.tsx'), 'utf8');
  const codex = readFileSync(join(root, 'src/components/ace-chat/composers/CodexComposer.tsx'), 'utf8');
  const gemini = readFileSync(join(root, 'src/components/ace-chat/composers/GeminiComposer.tsx'), 'utf8');
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const claude = readFileSync(join(root, 'src/components/ace-chat/composers/ClaudeComposer.tsx'), 'utf8');

  for (const source of [shell, claude]) {
    assert.doesNotMatch(source, /useVoiceController/);
    assert.doesNotMatch(source, /VoiceButton/);
    assert.doesNotMatch(source, /VoiceRealtimeBar/);
  }
  for (const source of [codex, gemini, hermes]) {
    assert.doesNotMatch(source, /voiceLaneId=\{streamId\}/);
  }
});

test('native Hermes chat busy copy is operator-driven', () => {
  const root = process.cwd();
  const pane = readFileSync(join(root, 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');
  const copy = readFileSync(join(root, 'src/components/ace-chat/operator-copy.ts'), 'utf8');
  const list = readFileSync(join(root, 'src/components/ace-chat/TranscriptList.tsx'), 'utf8');

  // Identity resolves through the operator registry; the busy/placeholder
  // copy is looked up on the resolved operator profile with the neutral
  // strings as defaults — no per-identity hardcodes in the renderer.
  assert.match(pane, /getWorkspacePersonalIdentity\(ws, operators\) \?\? agentsChatIdentity \?\? DEFAULT_OPERATORS\.defaultOperatorId/);
  assert.match(pane, /const identityOperator = getOperator\(operators, workspaceContext\.identity\);/);
  assert.match(pane, /function busyCopyFor\(operator: OperatorProfile \| null, fallback\?: string\)/);
  assert.match(pane, /const row = operatorBusyRow\(operator\) \?\? fallback \?\? `\$\{operator\.label\} is working…`;/);
  assert.match(pane, /placeholder: operatorBusyPlaceholder\(operator\) \?\? row,/);
  assert.match(pane, /row: 'Agent is working…',/);
  assert.match(pane, /placeholder: fallback \?\? 'Agent is working… \(Esc to interrupt\)',/);
  assert.match(pane, /return operatorPlaceholder\(operator\) \?\? `Message \$\{operator\.label\}`;/);
  assert.doesNotMatch(pane, /identity === 'king'|identity === 'rook'|♔|♜/);
  // The copy helpers tolerate the looser electron chat shape (nullable chat,
  // optional fields, busyPlaceholder) so migrated configs render byte-exact.
  assert.match(copy, /busyPlaceholder\?: string \| null;/);
  assert.match(copy, /export function operatorBusyPlaceholder/);
  assert.match(pane, /function LaneIdentityPill/);
  assert.match(pane, /title=\{`Messaging \$\{label\} · \$\{stateLabel\}`\}/);
  assert.match(pane, /aria-label=\{`Messaging \$\{label\}, \$\{stateLabel\}`\}/);
  assert.match(pane, /<LaneIdentityPill[\s\S]*operator=\{identityOperator\}[\s\S]*agentLabel=\{agentLabel\}[\s\S]*state=\{streamStatus\.state\}/);
  assert.doesNotMatch(pane, /busyLabel=\{busyCopy\.row\}/);
  assert.match(pane, /placeholders=\{\{ \.\.\.placeholders, default: defaultPlaceholder, busy: busyCopy\.placeholder \}\}/);
  assert.doesNotMatch(list, /busyLabel/);
});

test('ComposerShell submits on Enter and inserts newline on Shift+Enter', () => {
  const shell = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/ComposerShell.tsx'),
    'utf8'
  );
  // Enter (no modifiers, no Shift) submits.
  assert.match(shell, /e\.key === 'Enter' && !e\.shiftKey[\s\S]*void submit\(\)/);
  // The old Cmd/Ctrl+Enter-only branch must not be the submit gate any more.
  assert.doesNotMatch(shell, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/);
});

test('ClaudeComposer submits on Enter and inserts newline on Shift+Enter', () => {
  const claude = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/composers/ClaudeComposer.tsx'),
    'utf8'
  );
  assert.match(claude, /e\.key === 'Enter' && !e\.shiftKey[\s\S]*await submit\(\)/);
  assert.doesNotMatch(claude, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/);
});

test('desktop AceChatPane keeps the CLI/Chat ViewToggle wired for Hermes status fallback', () => {
  const pane = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/AceChatPane.tsx'),
    'utf8'
  );
  const registry = readFileSync(
    join(process.cwd(), 'src/runtime/ace-chat-mode-registry.ts'),
    'utf8'
  );

  assert.match(pane, /const showToggle = \(available \|\| agent === 'hermes'\) && !isRemoteWorkspace;/);
  assert.match(pane, /const modeScopeKey = streamId;/);
  assert.match(pane, /const \[mode, setMode\] = useAceChatMode\(agent, modeScopeKey\);/);
  assert.match(pane, /const effectiveMode = showToggle \? mode : 'cli';/);
  assert.match(pane, /<ViewToggle[\s\S]*kind=\{effectiveMode\}[\s\S]*onChange=\{\(next\) =>/);
  assert.match(registry, /export function useAceChatMode/);
  assert.match(registry, /writeStoredMode\(key, mode\)/);
});

test('chat mode registry isolates stream scopes', () => {
  const rookStream = 'conversation:conv-a613af35';
  const kingStream = 'conversation:conv-c8f2cb1e';

  assert.equal(getAceChatMode('hermes', rookStream), 'cli');
  assert.equal(getAceChatMode('hermes', kingStream), 'cli');

  setAceChatMode('hermes', 'cli', rookStream);

  assert.equal(getAceChatMode('hermes', rookStream), 'cli');
  assert.equal(getAceChatMode('hermes', kingStream), 'cli');

  // Every agent now defaults to cli (chat overlay is hermes-only), so flip one
  // stream to chat and confirm the explicit choice doesn't leak to the other
  // stream (which keeps the cli default).
  setAceChatMode('codex', 'chat', rookStream);

  assert.equal(getAceChatMode('codex', rookStream), 'chat');
  assert.equal(getAceChatMode('codex', kingStream), 'cli');
});

test('composer state is keyed by streamId', () => {
  const pane = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/AceChatPane.tsx'),
    'utf8'
  );
  const agents = readFileSync(
    join(process.cwd(), 'src/components/AgentsScreen.tsx'),
    'utf8'
  );
  const conv = readFileSync(
    join(process.cwd(), 'src/components/ConversationPane.tsx'),
    'utf8'
  );
  const variant = readFileSync(
    join(process.cwd(), 'src/components/multi-agent/VariantChatPane.tsx'),
    'utf8'
  );

  assert.match(pane, /key=\{streamId\}/);
  assert.match(pane, /data-ace-chat-pane-stream=\{streamId\}/);
  assert.match(pane, /\}, \[agent, showComposer\]\);/);
  assert.match(agents, /<AgentLaneScreen key=\{activeLane\.id\} lane=\{activeLane\} \/>/);
  assert.match(conv, /key=\{agent === 'hermes' \? streamId : undefined\}/);
  assert.match(variant, /key=\{variant\.agent === 'hermes' \? streamId : undefined\}/);
});

test('native chat bubbles and smart composer chrome use tint-aware class markers', () => {
  const root = process.cwd();
  const entries = readFileSync(join(root, 'src/components/ace-chat/entries/Entries.tsx'), 'utf8');
  const shell = readFileSync(join(root, 'src/components/ace-chat/ComposerShell.tsx'), 'utf8');
  const pane = readFileSync(join(root, 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/index.css'), 'utf8');

  for (const marker of ['ace-chat-user-bubble', 'ace-chat-agent-bubble']) {
    assert.match(entries, new RegExp(marker));
    assert.match(css, new RegExp(`\\.${marker}[\\s\\S]*--glass-tint-h`));
  }
  for (const marker of ['ace-composer-shell', 'ace-composer-shell-dragging', 'ace-composer-send']) {
    assert.match(shell, new RegExp(marker));
    assert.match(css, new RegExp(`\\.${marker}[\\s\\S]*--glass-tint-h`));
  }
  assert.match(pane, /ace-composer-slot/);
  assert.match(css, /\.ace-composer-slot[\s\S]*--glass-tint-h/);
});

test('Hermes/Rook/King personal CLI panes route through AceChatPane → smart composer', () => {
  const conv = readFileSync(
    join(process.cwd(), 'src/components/ConversationPane.tsx'),
    'utf8'
  );
  const variant = readFileSync(
    join(process.cwd(), 'src/components/multi-agent/VariantChatPane.tsx'),
    'utf8'
  );
  const parallel = readFileSync(
    join(process.cwd(), 'src/components/ParallelTaskScreen.tsx'),
    'utf8'
  );
  const registry = readFileSync(
    join(process.cwd(), 'src/runtime/ace-chat-mode-registry.ts'),
    'utf8'
  );
  // ConversationPane routes hermes — and only hermes — through AceChatPane, so
  // AgentsScreen + AgentLaneScreen hermes lanes keep the composer + attachments
  // while coding agents (claude/codex/gemini) always get the raw TerminalFeed
  // (chat overlay removed for them, owner decision 2026-07-03).
  assert.match(conv, /<AceChatPane[\s\S]*streamId=\{streamId\}[\s\S]*agent=\{agent\}[\s\S]*taskId=\{taskId \?\? null\}/);
  assert.match(conv, /isAceChatAgent\(agent\)/);
  assert.match(registry, /return value === 'hermes';/);
  assert.doesNotMatch(registry, /value === 'claude'/);
  // Variant panes and task variant bodies must route all smart agents through AceChatPane.
  assert.match(variant, /isAceChatAgent\(variant\.agent\)/);
  assert.match(variant, /<AceChatPane[\s\S]*streamId=\{streamId\}[\s\S]*agent=\{variant\.agent\}/);
  assert.match(parallel, /if \(isAceChatAgent\(variant\.agent\)\)[\s\S]*<VariantChatPane/);
  assert.doesNotMatch(parallel, /variant\.agent === 'claude'/);
});

test('ConversationPane uses fallbackAgent so persistent Rook/King lanes still get AceChatPane', () => {
  const conv = readFileSync(
    join(process.cwd(), 'src/components/ConversationPane.tsx'),
    'utf8'
  );
  // Conversation may be null on persistent lanes — the agent must fall back
  // to the lane's declared agent so canAceChat still resolves to true for
  // hermes/claude/codex/gemini and the smart toolbar mounts.
  assert.match(conv, /fallbackAgent\?: string \| null;/);
  assert.match(conv, /conversation\?\.agent \?\? fallbackAgent \?\? null/);
});

test('AgentLaneScreen passes lane.agent so persistent Hermes lanes get the smart toolbar', () => {
  const screen = readFileSync(
    join(process.cwd(), 'src/components/agents/AgentLaneScreen.tsx'),
    'utf8'
  );
  // Both the no-laneTask fallback path and the populated path must forward
  // lane.agent — otherwise persistent Rook/King Hermes lanes lose their
  // composer the moment the conversation is missing.
  const matches = screen.match(/fallbackAgent=\{lane\.agent\}/g) || [];
  assert.equal(matches.length, 2, 'expected fallbackAgent on both ConversationPane sites');
});

test('Rook/King Hermes lanes do not persist the generic resume sentinel', () => {
  const core = readFileSync(join(process.cwd(), 'electron/local-core.cts'), 'utf8');
  assert.doesNotMatch(core, /function seedPersonalHermesResumeSentinels\(\)/);
  assert.doesNotMatch(core, /update\.run\('seen', row\.conversation_id\)/);
  // The 'seen' sentinel must never resume-by-latest: hermes (--continue can
  // attach a background session) and codex (resume --last attaches another
  // tab's rollout) both fall back to a fresh spawn instead.
  assert.match(core, /sessionId === 'seen' && \(agent === 'hermes' \|\| agent === 'codex'\)/);
  assert.match(core, /persistTokenSentinel: agent !== 'hermes'/);
  assert.match(core, /hermes-seen-cleared-v2/);
});

test('ComposerShell paste handler accepts items + files fallback and only blocks default for files', () => {
  const shell = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/ComposerShell.tsx'),
    'utf8'
  );
  assert.match(shell, /import \{ dataTransferHasType, filesFromClipboard \} from '..\/..\/lib\/clipboard';/);
  // Walk clipboardData.items first (mobile-safe) but fall back to
  // clipboardData.files so browsers that surface only the legacy list still
  // attach pasted images.
  assert.doesNotMatch(shell, /function filesFromClipboard/);
  // Plain text paste must not be swallowed: short-circuit before
  // preventDefault when no files are present.
  assert.match(shell, /if \(files\.length === 0\) return;\s*e\.preventDefault\(\);/);
});

test('Claude composer uses shared clipboard file fallback and DnD type checks', () => {
  const claude = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/composers/ClaudeComposer.tsx'),
    'utf8'
  );
  assert.match(claude, /import \{ dataTransferHasType, filesFromClipboard \} from '..\/..\/..\/lib\/clipboard';/);
  assert.match(claude, /const files = filesFromClipboard\(e\.clipboardData\);/);
  assert.match(claude, /dataTransferHasType\(e\.dataTransfer, 'application\/x-ace-paths'\)/);
  assert.match(claude, /dataTransferHasType\(e\.dataTransfer, 'Files'\)/);
  assert.doesNotMatch(claude, /const items = e\.clipboardData\?\.items;/);
});

test('DesktopCliAttachmentButton uses native label htmlFor for mobile-safe file pickers', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/DesktopCliAttachments.tsx'),
    'utf8'
  );
  // Labels are tied to the input ids — no programmatic .click() on a hidden
  // ref, which is brittle on iOS Safari/Chrome inside a portaled popover.
  assert.match(source, /<label[\s\S]*htmlFor=\{htmlFor\}/);
  assert.match(source, /htmlFor=\{imageInputId\}/);
  assert.match(source, /htmlFor=\{fileInputId\}/);
  assert.match(source, /id=\{imageInputId\}/);
  assert.match(source, /id=\{fileInputId\}/);
  assert.doesNotMatch(source, /imageInputRef\.current\?\.click\(\)/);
  assert.doesNotMatch(source, /fileInputRef\.current\?\.click\(\)/);
  // Inputs stay focusable-by-label on iOS but out of the layout — `display:
  // none` would block the picker entirely.
  assert.doesNotMatch(source, /className="hidden"/);
  assert.match(source, /className="sr-only"/);
});

test('mobile composer stages PlusSheet attachments through the desktop attachment hook', () => {
  const mobile = readFileSync(join(process.cwd(), 'src/components/MobileTaskComposer.tsx'), 'utf8');

  // The sheet is still the entry point — only the dummy handlers are gone.
  assert.match(mobile, /<PlusSheet/);
  assert.doesNotMatch(mobile, /onPickImage=\{\(\) => undefined\}/);
  assert.doesNotMatch(mobile, /onPickFile=\{\(\) => undefined\}/);
  assert.doesNotMatch(mobile, /onPickImage=\{\(\) => setSheet\(null\)\}/);
  assert.doesNotMatch(mobile, /onPickFile=\{\(\) => setSheet\(null\)\}/);

  // Reuses the desktop CLI attachment hook + tray so staging/error/blocking
  // behavior matches the desktop chat composer.
  assert.match(mobile, /useDesktopCliAttachments\(\{ taskId \}\)/);
  assert.match(mobile, /<DesktopCliAttachmentTray[\s\S]*attachments=\{attachments\.attachments\}/);
  assert.match(mobile, /buildCliAttachmentSubmission\(text, attachments\.attachments\)/);

  // PlusSheet rows render as <label htmlFor> by forwarding the composer-
  // mounted file input ids — the iOS picker opens from the user tap, no
  // brittle programmatic .click() on display:none inputs.
  assert.match(mobile, /imageInputId=\{imageInputId\}/);
  assert.match(mobile, /fileInputId=\{fileInputId\}/);
  assert.match(mobile, /id=\{imageInputId\}/);
  assert.match(mobile, /id=\{fileInputId\}/);
  assert.match(mobile, /accept="image\/\*"/);
  assert.match(mobile, /className="sr-only"/);
  assert.match(mobile, /onChange=\{onAttachInputChange\}/);
  // Dummy hidden CLI button must not leak in — staging is sheet-driven.
  assert.doesNotMatch(mobile, /DesktopCliAttachmentButton/);
});

test('renderer entry guards against stray Electron file drops navigating away', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
  assert.match(main, /dataTransferHasType\(e\.dataTransfer, 'Files'\)/);
  assert.match(main, /dataTransferHasType\(e\.dataTransfer, 'application\/x-ace-paths'\)/);
  assert.match(main, /window\.addEventListener\('dragover'[\s\S]*\{ capture: true \}/);
  assert.match(main, /window\.addEventListener\('drop'[\s\S]*\{ capture: true \}/);
});

test('mobile composer paste handler accepts clipboard files but leaves text paste alone', () => {
  const mobile = readFileSync(join(process.cwd(), 'src/components/MobileTaskComposer.tsx'), 'utf8');

  assert.match(mobile, /import \{ filesFromClipboard \} from '..\/lib\/clipboard';/);
  // Paste handler is wired on the composer textarea.
  assert.match(mobile, /onPaste=\{onTextareaPaste\}/);
  // Walk clipboardData.items first (mobile-safe) then fall back to the
  // legacy clipboardData.files list — matches the desktop ComposerShell
  // contract.
  assert.doesNotMatch(mobile, /function filesFromClipboard/);
  // Plain text paste must not be swallowed: short-circuit before
  // preventDefault when no files are present.
  assert.match(mobile, /if \(files\.length === 0\) return;\s*e\.preventDefault\(\);/);
});

test('composer input gate commits everything except an active IME composition', () => {
  // Authoritative isComposing flag: true means a composition is mid-flight and
  // the controlled value must NOT be overwritten; anything else (committed
  // autocorrect, plain typing, paste) must commit.
  assert.equal(shouldCommitComposerInput(true), false);
  assert.equal(shouldCommitComposerInput(false), true);
  assert.equal(shouldCommitComposerInput(undefined), true);
});

test('composer composition dedupe strips an iOS double-append but leaves clean input', () => {
  // Composed "the" lands as "thethe" → strip one copy.
  assert.equal(dedupeComposedValue('thethe', 'the'), 'the');
  assert.equal(dedupeComposedValue('say thethe', 'the'), 'say the');
  // No data, no doubling, or a single occurrence → untouched.
  assert.equal(dedupeComposedValue('the', 'the'), 'the');
  assert.equal(dedupeComposedValue('hello', 'lo'), 'hello');
  assert.equal(dedupeComposedValue('hello', null), 'hello');
  assert.equal(dedupeComposedValue('hello', ''), 'hello');
});

test('mobile composer never wedges the textarea on autocorrect / keyboard suggestions', () => {
  const mobile = readFileSync(join(process.cwd(), 'src/components/MobileTaskComposer.tsx'), 'utf8');

  // The onChange gate must ride the browser's authoritative isComposing flag,
  // not a manually-held composing ref — so a committed suggestion always
  // reaches state and the visible textarea can't freeze mid-typing.
  assert.match(
    mobile,
    /import \{ dedupeComposedValue, shouldCommitComposerInput \} from '.\/mobile-composer\/composition';/
  );
  assert.match(mobile, /shouldCommitComposerInput\(\(e\.nativeEvent as InputEvent\)\.isComposing\)/);
  // The deadlock source — a beforeinput handler that set composingRef true for
  // insertReplacementText / insertFromYank with no reset path — must be gone.
  assert.doesNotMatch(mobile, /onBeforeInput/);
  assert.doesNotMatch(mobile, /insertReplacementText/);
  assert.doesNotMatch(mobile, /if \(composingRef\.current\) return;/);
  // onChange must no longer gate on the manual ref.
  assert.doesNotMatch(mobile, /onTextareaChange[\s\S]{0,160}composingRef\.current/);
  // Autocorrect stays enabled on the visible textarea (A1).
  assert.match(mobile, /autoCorrect="on"/);
  assert.match(mobile, /spellCheck/);
});

test('terminal and pane DnD handlers preserve custom MIME contracts', () => {
  const terminal = readFileSync(join(process.cwd(), 'src/components/TerminalFeed.tsx'), 'utf8');
  const strip = readFileSync(join(process.cwd(), 'src/components/multi-agent/PaneTabStrip.tsx'), 'utf8');
  const grid = readFileSync(join(process.cwd(), 'src/components/multi-agent/PaneGrid.tsx'), 'utf8');

  assert.doesNotMatch(terminal, /ClipboardPaste/);
  assert.doesNotMatch(terminal, /Paste from clipboard/);
  assert.doesNotMatch(terminal, /navigator\.clipboard\.readText/);
  assert.doesNotMatch(terminal, /onMobilePaste/);
  assert.match(terminal, /pathsFromDataTransfer\(e\.dataTransfer\)/);
  assert.match(terminal, /pasteToTerminal\(streamId, \{ text \}\)/);
  assert.match(terminal, /dataTransferHasType\(e\.dataTransfer, 'Files'\)/);
  assert.match(strip, /dataTransferHasType\(e\.dataTransfer, PANE_TAB_DRAG_MIME\)/);
  assert.match(grid, /dataTransferHasType\(e\.dataTransfer, PANE_TAB_DRAG_MIME\)/);
});

test('terminal paste key handler leaves Cmd/Ctrl+V to native paste events', () => {
  const registry = readFileSync(join(process.cwd(), 'src/runtime/terminal-registry.ts'), 'utf8');
  assert.doesNotMatch(registry, /key === 'v' && !event\.shiftKey\) return false/);
  assert.match(registry, /wrapper\.addEventListener\(\s*'paste'/);
});

test('mobile composer submit appends @paths and clears attachments after send', () => {
  const mobile = readFileSync(join(process.cwd(), 'src/components/MobileTaskComposer.tsx'), 'utf8');

  // Submit goes through buildCliAttachmentSubmission so attachments travel
  // alongside (or instead of) the typed text.
  assert.match(mobile, /const submission = buildCliAttachmentSubmission\(text, attachments\.attachments\);/);
  assert.match(mobile, /if \(!submission\.ok\) return;/);
  // Pastes the body-first / @paths-appended payload through the bracketed-paste
  // helper, then clears the staged attachments so the next message starts clean.
  assert.match(mobile, /pasteToTerminal\(focused\.streamId, \{ text: payload \}\)/);
  assert.match(mobile, /attachments\.clearAttachments\(\)/);
});

test('mobile composer submit is re-entrancy guarded so a repeated tap cannot double-send a staged attachment', () => {
  const mobile = readFileSync(join(process.cwd(), 'src/components/MobileTaskComposer.tsx'), 'utf8');

  // The staged @path travels on the awaited (network-latency on a remote
  // workspace) pasteToTerminal call, and the Send button never disables. A
  // ref flipped true for the whole send — checked at the top, reset in
  // finally — makes submit idempotent, so a second Send tap during that round
  // trip can't re-paste the same @path and double the CLI's [Image #1] token.
  assert.match(mobile, /const submittingRef = useRef\(false\);/);
  assert.match(mobile, /if \(submittingRef\.current\) return;/);
  assert.match(mobile, /submittingRef\.current = true;/);
  assert.match(mobile, /finally \{\s*submittingRef\.current = false;\s*\}/);
});

test('PlusSheet renders Photo and File rows as <label htmlFor> when input ids are provided', () => {
  const sheet = readFileSync(join(process.cwd(), 'src/components/mobile-composer/PlusSheet.tsx'), 'utf8');
  const action = readFileSync(join(process.cwd(), 'src/components/mobile-composer/ActionSheet.tsx'), 'utf8');

  // PlusSheet plumbs the input ids straight into SheetButton's htmlFor prop.
  assert.match(sheet, /imageInputId\?: string;/);
  assert.match(sheet, /fileInputId\?: string;/);
  assert.match(sheet, /onPickImage\?: \(\) => void;/);
  assert.match(sheet, /onPickFile\?: \(\) => void;/);
  assert.match(sheet, /htmlFor=\{imageInputId\}/);
  assert.match(sheet, /htmlFor=\{fileInputId\}/);
  assert.match(sheet, /until the input change event reports selected files/);

  // SheetButton renders a real <label> when htmlFor is set so iOS Safari can
  // open the file picker without a programmatic .click().
  assert.match(action, /htmlFor\?: string;/);
  assert.match(action, /<label[\s\S]*htmlFor=\{htmlFor\}/);
});

test('mobile composer exposes the native CLI/Chat switch for available smart transcripts', () => {
  const mobile = readFileSync(join(process.cwd(), 'src/components/MobileTaskComposer.tsx'), 'utf8');
  const toggle = readFileSync(join(process.cwd(), 'src/components/ace-chat/ViewToggle.tsx'), 'utf8');
  const pane = readFileSync(join(process.cwd(), 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');

  assert.match(mobile, /const chatAgent = focused && isAceChatAgent\(focused\.agent\) \? focused\.agent : null;/);
  assert.match(mobile, /useChatAvailable\(chatAgent \? focused\?\.streamId \?\? null : null\)/);
  assert.match(mobile, /const chatModeScopeKey = focused\?\.streamId \?\? null;/);
  assert.match(mobile, /const \[chatMode, setChatMode\] = useAceChatMode\(chatAgent, chatModeScopeKey\);/);
  assert.match(mobile, /const showChatToggle = !!chatAgent && chatAvailable && !isRemoteWorkspace;/);
  assert.match(mobile, /<ViewToggle[\s\S]*kind=\{chatMode\}[\s\S]*onChange=\{setChatMode\}[\s\S]*showLabels/);
  assert.match(toggle, /showLabels\?: boolean;/);
  assert.match(toggle, /label=\{showLabels \? 'Chat' : undefined\}/);
  assert.match(pane, /const \[mode, setMode\] = useAceChatMode\(agent, modeScopeKey\);/);
});

test('attachment extension helper preserves image and generic file suffixes', () => {
  assert.equal(fileExtensionForAttachment({ name: 'screen.jpeg', type: 'image/jpeg' }), 'jpeg');
  assert.equal(fileExtensionForAttachment({ name: '', type: 'image/png' }), 'png');
  assert.equal(fileExtensionForAttachment({ name: 'archive.tar.gz', type: '' }), 'gz');
  assert.equal(fileExtensionForAttachment({ name: 'nope', type: '' }), 'bin');
});

test('attachment extension helper covers PDF and video suffixes (paste-store accepts <=6 chars)', () => {
  // The backend writePasteImage.sanitizeExt only keeps an extension when it is
  // 1-6 [a-z0-9] chars (else it falls back to png). pdf/mp4/mov/webm all pass,
  // so a pasted (path-less) PDF or video is written with the right suffix.
  assert.equal(fileExtensionForAttachment({ name: 'spec.pdf', type: 'application/pdf' }), 'pdf');
  assert.equal(fileExtensionForAttachment({ name: 'clip.mp4', type: 'video/mp4' }), 'mp4');
  assert.equal(fileExtensionForAttachment({ name: 'demo.mov', type: 'video/quicktime' }), 'mov');
  assert.equal(fileExtensionForAttachment({ name: 'capture.webm', type: 'video/webm' }), 'webm');
  // Extension-less drops/pastes recover a safe suffix from the MIME subtype.
  assert.equal(fileExtensionForAttachment({ name: 'pasted', type: 'application/pdf' }), 'pdf');
});

test('CLI attachment submission carries mixed file/image/PDF/video @paths with and without body', () => {
  const attachments: CliAttachment[] = [
    { id: 'img', name: 'shot.png', status: 'ready', path: '/tmp/shot.png' },
    { id: 'doc', name: 'spec.pdf', status: 'ready', path: '/tmp/spec.pdf' },
    { id: 'vid', name: 'clip.mp4', status: 'ready', path: '/tmp/clip.mp4' },
  ];

  // With prose: each @path follows the body on its own line (slash-safe order).
  assert.deepEqual(buildCliAttachmentSubmission('review these', attachments), {
    ok: true,
    text: 'review these\n\n@/tmp/shot.png\n@/tmp/spec.pdf\n@/tmp/clip.mp4',
  });
  // Attachment-only submit (no typed text) still resolves to readable @paths.
  assert.deepEqual(buildCliAttachmentSubmission('   ', attachments), {
    ok: true,
    text: '@/tmp/shot.png\n@/tmp/spec.pdf\n@/tmp/clip.mp4',
  });
});

test('chat composers keep the attach picker enabled while busy for Chief steering', () => {
  const root = process.cwd();
  const claude = readFileSync(join(root, 'src/components/ace-chat/composers/ClaudeComposer.tsx'), 'utf8');
  const codex = readFileSync(join(root, 'src/components/ace-chat/composers/CodexComposer.tsx'), 'utf8');
  const gemini = readFileSync(join(root, 'src/components/ace-chat/composers/GeminiComposer.tsx'), 'utf8');
  const hermes = readFileSync(join(root, 'src/components/ace-chat/composers/HermesComposer.tsx'), 'utf8');
  const mobile = readFileSync(join(root, 'src/components/MobileTaskComposer.tsx'), 'utf8');

  // The regression: Claude/Codex/Gemini disabled the attach button mid-turn
  // (disabled={isBusy}) while still allowing send/paste/drop, so Chief could
  // not attach a screenshot to steer a working agent. Hermes never gated it.
  // No composer may gate any control on `disabled={isBusy}`.
  for (const source of [claude, codex, gemini, hermes, mobile]) {
    assert.doesNotMatch(source, /disabled=\{isBusy\}/);
  }
  // ...and every desktop composer still wires the attach picker to addFiles.
  for (const source of [claude, codex, gemini, hermes]) {
    assert.match(source, /<DesktopCliAttachmentButton[\s\S]*?onAddFiles=\{attachments\.addFiles\}/);
  }
});

test('useDesktopCliAttachments persist path encodes bytes as base64 (PWA/HTTP safe)', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/useDesktopCliAttachments.ts'),
    'utf8'
  );
  // The HTTP/PWA bridge JSON-stringifies the IPC payload — a Uint8Array
  // would collapse to {"0":n,...} and the backend would write zero bytes.
  // Lock in the base64 contract so this can't regress.
  assert.match(source, /fileToBase64\(file\)/);
  assert.match(source, /pasteClipboardImage\(base64,\s*ext\)/);
  assert.match(source, /pasteClipboardImageRemote\(taskId,\s*base64,\s*ext\)/);
  assert.doesNotMatch(source, /new Uint8Array\(await file\.arrayBuffer\(\)\)/);
});

test('terminal-registry image paste uses the same base64 bytes contract', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/runtime/terminal-registry.ts'),
    'utf8'
  );
  assert.match(source, /fileToBase64\(file\)/);
  assert.match(source, /pasteClipboardImage\(base64,\s*ext\)/);
  assert.match(source, /pasteClipboardImageRemote\(taskId,\s*base64,\s*ext\)/);
});

test('attachment picker tries the on-disk path first on local workspaces before reading bytes', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/useDesktopCliAttachments.ts'),
    'utf8'
  );
  // In the local-workspace branch, resolveLocalFilePath must be checked
  // before persistFile(file, null) so picker- and drag-dropped files (image
  // or not) avoid the bytes round-trip entirely. (The remote branch above
  // intentionally has no on-disk shortcut — the desktop path is unreadable
  // to the remote agent.)
  const localBranchStart = source.indexOf('// Local workspace');
  assert.ok(localBranchStart >= 0, 'expected the local-workspace branch comment');
  const localBranch = source.slice(localBranchStart);
  const localIdx = localBranch.indexOf('resolveLocalFilePath(file)');
  const tempIdx = localBranch.indexOf('persistFile(file, null)');
  assert.ok(localIdx >= 0, 'expected resolveLocalFilePath in the local branch');
  assert.ok(tempIdx >= 0, 'expected persistFile(file, null) in the local branch');
  assert.ok(localIdx < tempIdx, 'local path must be tried before temp persist');
});

test('attachment picker gates the local-path shortcut on workspace locality (remote agents cannot read desktop paths)', () => {
  const hook = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/useDesktopCliAttachments.ts'),
    'utf8'
  );
  // Hook must read isRemote off the resolved workspace for the active task
  // and feed it into planAttachmentPersist. Without this gate the picker
  // returned a /Users/<me>/... path that the remote SSH agent could not open.
  assert.match(hook, /useCoreSelector\(\(snap\) => \{[\s\S]*ws\.isRemote === true/);
  assert.match(hook, /planAttachmentPersist\(\{[\s\S]*isRemoteWorkspace: isRemoteRef\.current/);

  // The remote branch must persist bytes BEFORE resolveLocalFilePath runs —
  // ordering proves the desktop-path shortcut is unreachable on remote.
  const remoteBranchIdx = hook.indexOf("plan.kind === 'remote-bytes'");
  const localPathIdx = hook.indexOf('resolveLocalFilePath(file)');
  assert.ok(remoteBranchIdx >= 0, 'expected remote-bytes branch');
  assert.ok(localPathIdx >= 0, 'expected resolveLocalFilePath call');
  assert.ok(
    remoteBranchIdx < localPathIdx,
    'remote-bytes persist must come before the local-path shortcut'
  );

  // And the remote branch must not fall back to a local /tmp persist (that
  // path is also unreachable to the remote agent — fail honestly instead).
  const remoteBlock = hook.slice(
    remoteBranchIdx,
    hook.indexOf('// Local workspace', remoteBranchIdx)
  );
  assert.doesNotMatch(remoteBlock, /persistFile\(file, null\)/);
});

test('attachment picker surfaces backend persistence errors instead of collapsing to the generic temp-file message', () => {
  const hook = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/useDesktopCliAttachments.ts'),
    'utf8'
  );
  // The picker must consume the discriminated outcome and throw the
  // backend's error string so attachment.error in the UI reads e.g.
  // "attachment bytes were unreadable" / "ENOSPC ..." instead of the
  // generic "Could not write attachment to a temp file" message.
  assert.match(hook, /interpretPasteResult/);
  assert.match(hook, /throw new Error\(localOutcome\.error\)/);
  // The generic message must only live in the shared helper as a fallback,
  // never as a hard-coded throw inside the picker hook.
  assert.doesNotMatch(
    hook,
    /throw new Error\(['"]Could not write attachment to a temp file['"]\)/
  );

  const helper = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/cli-attachment-persist.ts'),
    'utf8'
  );
  assert.match(helper, /Could not write attachment to a temp file/);
  assert.match(helper, /export function interpretPasteResult/);
});

test('chat entries no longer force every paragraph and list item to bold', () => {
  const entries = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/entries/Entries.tsx'),
    'utf8'
  );
  // The previous bubble strings cranked p/li to font-medium on mobile —
  // that's what made the whole chat read as bold. Strip the rule entirely
  // (markdown's own bold/headings still work).
  assert.doesNotMatch(entries, /\[&_p\]:font-medium/);
  assert.doesNotMatch(entries, /\[&_li\]:font-medium/);
  assert.doesNotMatch(entries, /font-medium leading-\[1\.5\] text-foreground md:text-\[13\.5px\]/);
});

test('chat surfaces guard against horizontal scroll with min-w-0/break-words', () => {
  const root = process.cwd();
  const entries = readFileSync(join(root, 'src/components/ace-chat/entries/Entries.tsx'), 'utf8');
  const list = readFileSync(join(root, 'src/components/ace-chat/TranscriptList.tsx'), 'utf8');
  const md = readFileSync(join(root, 'src/components/ace-chat/render/MarkdownText.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/index.css'), 'utf8');

  // Every bubble must be containable: min-w-0 + max-w-* + break-words so a
  // long URL/code-span can't push the whole page sideways on a phone.
  assert.match(entries, /ace-chat-user-bubble[^"]*min-w-0[^"]*max-w-\[85%\][^"]*break-words/);
  assert.match(entries, /ace-chat-agent-bubble[^"]*min-w-0[^"]*max-w-full[^"]*break-words/);

  // The transcript scroller pins horizontal overflow to hidden — vertical
  // scroll is preserved.
  assert.match(list, /min-w-0[\s\S]*overflow-x-hidden overflow-y-auto/);
  assert.match(list, /flex w-full min-w-0 max-w-3xl/);

  // Markdown links and inline code wrap; code blocks stay self-contained.
  assert.match(md, /break-all text-sky-300/);
  assert.match(css, /\[data-streamdown='code-block-body'\][\s\S]*max-height: 26rem/);
  assert.match(md, /break-all rounded bg-white/);
});

test('TranscriptList follows transcript updates without hard-pinning manual scrollback', () => {
  const list = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/TranscriptList.tsx'),
    'utf8'
  );

  assert.match(list, /const stickyRef = useRef\(true\);/);
  assert.match(list, /const lastStreamIdRef = useRef\(streamId\);/);
  assert.match(list, /const streamChanged = lastStreamIdRef\.current !== streamId;/);
  assert.match(list, /stickyRef\.current = true;/);
  assert.match(list, /const prepended = !streamChanged/);
  assert.match(list, /el\.scrollTop \+= el\.scrollHeight - prev\.scrollHeight/);
  assert.match(list, /const contentRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(list, /new ResizeObserver\(\(\) => \{/);
  assert.match(list, /if \(stickyRef\.current\) scroller\.scrollTop = scroller\.scrollHeight;/);
  assert.match(list, /}, \[streamId, entries\]\);/);
  assert.doesNotMatch(list, /}, \[entries\.length\]\);/);
  assert.match(list, /stickyRef\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < \d+;/);
  assert.doesNotMatch(list, /HERMES_CHAT_BOTTOM_PIN/);
});

test('ComposerShell serializes submit clicks so Enter/button cannot double-fire', () => {
  const shell = readFileSync(
    join(process.cwd(), 'src/components/ace-chat/ComposerShell.tsx'),
    'utf8'
  );

  assert.match(shell, /const \[submitting, setSubmitting\] = useState\(false\);/);
  assert.match(shell, /const submittingRef = useRef\(false\);/);
  assert.match(shell, /if \(submittingRef\.current\) return;/);
  assert.match(shell, /submittingRef\.current = true;/);
  assert.match(shell, /setSubmitting\(true\);/);
  assert.match(shell, /setText\(text\);/);
  assert.match(shell, /submittingRef\.current = false;/);
  assert.match(shell, /disabled=\{!effectiveCanSend \|\| submitting\}/);
});

test('transcript reset reasons only clear entries for destructive resets', () => {
  const registry = readFileSync(
    join(process.cwd(), 'src/runtime/transcript-registry.ts'),
    'utf8'
  );

  assert.match(registry, /phase: 'unavailable' \| 'linked' \| 'streaming' \| 'settled' \| 'compacted' \| 'cleared' \| 'error'/);
  assert.match(registry, /function isDestructiveResetReason\(reason: TranscriptResetPayload\['reason'\]\): boolean \{/);
  assert.match(registry, /return reason === 'clear' \|\| reason === 'file-truncate';/);
  assert.match(registry, /function resetStream\(streamId: string, payload: TranscriptResetPayload/);
  assert.match(registry, /if \(!isDestructiveResetReason\(reason\)\) \{[\s\S]*pruneExpiredOptimisticUserEntries\(streamId\)[\s\S]*phaseForEntries\(entries, 'linked'\)[\s\S]*return;/);
  assert.match(registry, /optimisticConfirmed[\s\S]*now - entry\.tAt > OPTIMISTIC_USER_ENTRY_WINDOW_MS/);
  assert.match(registry, /entries: \[\],[\s\S]*phase: 'cleared'/);
});

test('transcript registry merges snapshots and keeps compact as an explicit replace', () => {
  const registry = readFileSync(
    join(process.cwd(), 'src/runtime/transcript-registry.ts'),
    'utf8'
  );
  const api = readFileSync(join(process.cwd(), 'src/lib/ace-api.ts'), 'utf8');

  assert.match(registry, /function mergeSnapshotEntries\(streamId: string, entries: TranscriptEntry\[\]\)/);
  assert.match(registry, /for \(const entry of current\) \{[\s\S]*!isOptimisticUserEntry\(entry\)[\s\S]*byId\.set\(entry\.id, entry\)/);
  assert.match(registry, /for \(const entry of entries\) \{[\s\S]*extendEntry\(entry, currentById\.get\(entry\.id\)\)/);
  assert.match(registry, /const pendingOptimistic = filterPendingOptimisticUserEntries/);
  assert.match(registry, /const mergedEntries = withAliasOptimisticUserEntries\([\s\S]*mergeSnapshotEntries\(streamId, snap\.entries\),[\s\S]*snap\.sessionFile/);
  assert.match(registry, /lastResetReason: TranscriptResetReason \| null;/);
  assert.match(registry, /revivalState: TranscriptRevivalState \| null;/);
  assert.match(registry, /function replaceStream\(streamId: string, payload: TranscriptReplacePayload\)/);
  assert.match(registry, /const reason = payload\.reason \?\? 'compact';/);
  assert.match(registry, /entries: \[summary\],[\s\S]*phase: compacted \? 'compacted'/);
  assert.match(registry, /lastResetReason: reason,[\s\S]*revivalState: compacted \? 'reviving' : null/);
  assert.match(api, /export type TranscriptResetReason =[\s\S]*'relink'[\s\S]*'alias-prune'/);
  assert.doesNotMatch(api, /'session-change'/);
  assert.match(api, /onTranscriptReset: \(streamId: string, listener: \(payload: TranscriptResetPayload\) => void\)/);
  assert.match(api, /onTranscriptReplace:[\s\S]*reason\?: TranscriptResetReason/);
});

test('native chat bubbles surface Chief vs operator labels', () => {
  const root = process.cwd();
  const entries = readFileSync(join(root, 'src/components/ace-chat/entries/Entries.tsx'), 'utf8');
  const render = readFileSync(join(root, 'src/components/ace-chat/entries/render.tsx'), 'utf8');
  const list = readFileSync(join(root, 'src/components/ace-chat/TranscriptList.tsx'), 'utf8');
  const pane = readFileSync(join(root, 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');

  // UserEntry pins "Chief" as the author label, right-aligned via items-end.
  assert.match(entries, /flex min-w-0 flex-col items-end gap-1[\s\S]*ace-chat-author-label-user[\s\S]*Chief/);
  // AgentEntry takes an agentLabel and renders it left-aligned via items-start.
  assert.match(entries, /agentLabel\?: string \| null;[\s\S]*flex min-w-0 flex-col items-start gap-1[\s\S]*ace-chat-author-label-agent[\s\S]*\{agentLabel\}/);

  // renderEntry forwards agentLabel into AgentEntry.
  assert.match(render, /agentLabel\?: string \| null/);
  assert.match(render, /<AgentEntry[\s\S]*agentLabel=\{agentLabel\}/);

  // TranscriptList accepts agentLabel and threads it through.
  assert.match(list, /agentLabel\?: string \| null;/);
  assert.match(list, /renderEntry\(e, streamId, streamState, agentLabel\)/);

  // AceChatPane resolves the agent label from the operator registry via
  // the workspace identity and passes it down. Lanes without a configured
  // operator stay unlabeled.
  assert.match(pane, /function agentLabelFor\(operator: OperatorProfile \| null\): string \| null \{/);
  assert.match(pane, /return operator\?\.label \?\? null;/);
  assert.match(pane, /const agentLabel = agentLabelFor\(identityOperator\);/);
  assert.match(pane, /<TranscriptList[\s\S]*agentLabel=\{agentLabel\}/);
});

test('native chat reasoning labels use the operator registry vocab', () => {
  const root = process.cwd();
  const entries = readFileSync(join(root, 'src/components/ace-chat/entries/Entries.tsx'), 'utf8');
  const copy = readFileSync(join(root, 'src/components/ace-chat/operator-copy.ts'), 'utf8');
  const render = readFileSync(join(root, 'src/components/ace-chat/entries/render.tsx'), 'utf8');
  const expectPair = (emoji: string, verb: string) => {
    assert.match(copy, new RegExp(`\\{ emoji: '${emoji}', verb: '${verb}' \\}`));
  };

  assert.match(render, /<ReasoningEntry[\s\S]*agentLabel=\{agentLabel\}/);
  // The universal built-in vocab (the neutral Hermes set) lives in
  // operator-copy.ts and is the fallback for every unresolved label.
  assert.match(copy, /export type GerundPair = \{ emoji: string; verb: string \};/);
  assert.match(copy, /export type IdentityVocab = \{ default: string; pairs: GerundPair\[\] \};/);
  assert.match(copy, /export const DEFAULT_REASONING_VOCAB: IdentityVocab = \{[\s\S]*default: '🧠',/);
  expectPair('💭', 'Thinking');
  expectPair('🤔', 'Pondering');
  expectPair('🔎', 'Searching');
  expectPair('⚗️', 'Synthesizing');
  expectPair('✍️', 'Drafting');
  expectPair('🌀', 'Spinning-up');
  // Entries.tsx resolves identity vocab from the registry — no hardcoded
  // per-identity gerund table or chess-set identities in the renderer.
  assert.match(entries, /const operators = useOperators\(\);/);
  assert.match(entries, /reasoningVocabFor\(operators, agentLabel\)/);
  assert.match(entries, /const operator = findOperatorByLabelOrId\(config, agentLabel\);/);
  assert.match(entries, /const vocab = operatorIdentityVocab\(operator\);/);
  assert.match(entries, /return \{ vocab: DEFAULT_REASONING_VOCAB, operatorLabel: null \};/);
  assert.doesNotMatch(entries, /GERUNDS/);
  assert.doesNotMatch(entries, /'King'|'Rook'|♔|♜|👑|🏰/);
  assert.match(entries, /streaming \? `\$\{pair\.emoji\} \$\{operatorLabel\} \$\{pair\.verb\}` : `\$\{vocab\.default\} \$\{operatorLabel\} — summary`/);
  assert.match(entries, /streaming \? `\$\{pair\.emoji\} \$\{pair\.verb\}` : `\$\{vocab\.default\} Thought summary`/);
  assert.match(entries, /setPairIndex\(\(idx\) => \(idx \+ 1\) % gerunds\.pairs\.length\)/);
  assert.match(entries, /reasoningLabelFor\(operatorLabel, streaming, gerunds\.pairs\[pairIndex\] \|\| gerunds\.pairs\[0\], gerunds\)/);
});

test('Hermes chat formatter removes raw tool markers and turns dense status prose into Markdown bullets', async () => {
  const { extractHermesToolMarkers, formatHermesReadableText } = await import('../components/ace-chat/hermes-chat-format.ts');

  assert.deepEqual(
    extractHermesToolMarkers('Checking repo now. [3 tool calls: skill_view]'),
    {
      text: 'Checking repo now.',
      tools: [{ count: 3, toolName: 'skill_view' }],
    }
  );
  assert.deepEqual(
    extractHermesToolMarkers('Checking repo now. [1 tool call:'),
    {
      text: 'Checking repo now.',
      tools: [],
    }
  );

  const formatted = formatHermesReadableText(
    'We are not clean green yet. Confirmed live just now: - Time checked: Sat May 16 - Ace installed runtime is up - Not clean: local repo is behind origin/main'
  );

  assert.equal(
    formatted,
    [
      'We are not clean green yet. Confirmed live just now:',
      '',
      '- **Time checked:** Sat May 16',
      '- Ace installed runtime is up',
      '- **Not clean:** local repo is behind origin/main',
    ].join('\n')
  );
});

test('Hermes Chat filters internal background skill chatter from status breadcrumbs', () => {
  assert.equal(isVisibleSystemInfoText('[background] skill-review notify: curator is checking skill updates'), false);
  assert.equal(isVisibleSystemInfoText('creation_nudge: self-improvement skill update review'), false);
  assert.equal(isVisibleSystemInfoText('self-improvement skill update review completed'), false);
  assert.equal(isVisibleSystemInfoText('skill update review completed'), false);
  assert.equal(isVisibleSystemInfoText("💾 Self-improvement review: Skill 'ace-task-worker' patched"), true);
  assert.equal(isVisibleSystemInfoText('Self-improvement review: skill update review completed'), true);
  assert.equal(isVisibleSystemInfoText('┊ tool.terminal ace mission dispatch --feature ft_42'), true);
  assert.equal(isVisibleSystemInfoText('[running] process poll session proc_123'), true);
  assert.equal(isVisibleSystemInfoText('⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel'), true);
  assert.equal(isVisibleSystemInfoText('Skill updates are available for this workspace.'), true);
  assert.equal(isVisibleSystemInfoText('A self-improvement pass could make the skill docs clearer.'), true);
});

test('native tool widgets route modern Codex exec and tool search activity to specialized cards', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/ace-chat/widgets/ToolWidgets.tsx'), 'utf8');
  assert.match(source, /normalized === 'exec_command'/);
  assert.match(source, /normalized === 'command_execution'/);
  assert.match(source, /return <BashWidget name=\{name\} args=\{obj\}/);
  assert.match(source, /normalized === 'tool_search'/);
  assert.match(source, /return <SearchWidget name=\{name\} args=\{obj\}/);
  assert.match(source, /<Search className="h-3\.5 w-3\.5" \/>/);
});

test('native tool widgets surface Hermes skill targets in the collapsed row', async () => {
  const { ToolWidget } = await import('../components/ace-chat/widgets/ToolWidgets.tsx');
  const html = renderToStaticMarkup(
    createElement(ToolWidget, {
      name: 'skill_view',
      args: { name: 'ace-cli' },
      result: JSON.stringify({ success: true, name: 'ace-cli', description: 'CLI tool contract' }),
      status: 'ok',
      lifecycle: 'finished',
    })
  );

  assert.match(html, /skill_view/);
  assert.match(html, /ace-cli/);
});

test('GitHub section and agents expose tracked Ace project wiki index', () => {
  const root = process.cwd();
  const githubScreen = readFileSync(join(root, 'src/components/GithubScreen.tsx'), 'utf8');
  const api = readFileSync(join(root, 'src/lib/ace-api.ts'), 'utf8');
  const localCore = readFileSync(join(root, 'electron/local-core.cts'), 'utf8');
  const aceControl = readFileSync(join(root, 'electron/ace-control/index.cts'), 'utf8');
  const commands = readFileSync(join(root, 'tools/ace/src/commands.cts'), 'utf8');
  const prompt = readFileSync(join(root, 'electron/orchestrator-prompt.cts'), 'utf8');

  assert.match(githubScreen, /type Tab = 'tracked' \| 'repos' \| 'stars' \| 'trending'/);
  assert.match(githubScreen, /function TrackedProjectsTab/);
  assert.match(githubScreen, /listTrackedGithubProjects/);
  assert.match(githubScreen, /wikiExists/);
  assert.match(api, /export type TrackedGithubProject/);
  assert.match(api, /listTrackedGithubProjects: \(\)/);
  assert.match(localCore, /function listTrackedGithubProjects\(\)/);
  assert.match(localCore, /path\.join\(workspace\.path, '.ace', 'wiki', 'index\.md'\)/);
  assert.match(aceControl, /streamTrackedGithubProjects/);
  assert.match(commands, /cli: 'github tracked-projects'/);
  assert.match(prompt, /ace github tracked-projects --json/);
});

test('native chat user bubble is gold by default, not only on ace-touch', () => {
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  // The default .ace-chat-user-bubble rule (no :root.ace-touch prefix)
  // pins gold gradient + dark text so desktop chat reads as Chief-gold too.
  assert.match(
    css,
    /\.ace-chat-user-bubble \{[\s\S]*hsl\(45 92% 64% \/ 0\.95\)[\s\S]*color: hsl\(0 0% 7%\)/
  );
  // Default agent bubbles also keep the warm orange/gold return language.
  assert.match(
    css,
    /\.ace-chat-agent-bubble \{[\s\S]*hsl\(32 92% 58% \/ 0\.22\)[\s\S]*color: hsl\(34 95% 88%\)/
  );
});

test('native Ace chat pages transcripts instead of loading whole sessions', () => {
  const root = process.cwd();
  const registry = readFileSync(join(root, 'src/runtime/transcript-registry.ts'), 'utf8');
  const list = readFileSync(join(root, 'src/components/ace-chat/TranscriptList.tsx'), 'utf8');
  const pane = readFileSync(join(root, 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');

  assert.match(registry, /const TRANSCRIPT_PAGE_SIZE = 80;/);
  assert.match(registry, /aceApi\.streams\.transcript\(streamId, \{ limit: TRANSCRIPT_PAGE_SIZE \}\)/);
  assert.match(registry, /before,\s+limit: TRANSCRIPT_PAGE_SIZE/);
  assert.match(registry, /if \(idx < 0\) return;/);
  assert.match(
    registry,
    /if \(!streamId \|\| !subscribedStreams\.has\(streamId\)\) return;[\s\S]*if \(event === 'transcript:update' && payload\?\.entry\) \{[\s\S]*updateEntry\(streamId, payload\.entry as TranscriptEntry\);/
  );

  assert.match(pane, /loadOlderTranscript/);
  assert.match(list, /Show older messages/);
  assert.match(list, /disabled=\{loadingOlder \|\| !hasOlder\}/);
  assert.match(list, /olderError/);
  assert.match(list, /el\.scrollTop \+= el\.scrollHeight - prev\.scrollHeight/);
});

test('Mission Board reads stay passive instead of synchronously refreshing GitHub PR state', () => {
  const core = readFileSync(join(process.cwd(), 'electron/local-core.cts'), 'utf8');
  assert.match(core, /refreshLinkedPrStates/);
  assert.doesNotMatch(
    core,
    /function getMissionBoard\(filters = \{\}\) \{\s*refreshLinkedMissionPrStates\(filters\);/
  );
});

test('native chat bubble palette — warm gold on desktop, Indigo Ledger on touch', () => {
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  // Desktop chat keeps the warm orange/gold bubble language for Chief prompts
  // and agent returns; agent replies never fall back to grey.
  assert.match(css, /\.ace-chat-user-bubble[\s\S]*hsl\(45 92% 64%/);
  assert.match(css, /\.ace-chat-agent-bubble[\s\S]*hsl\(32 92% 58%/);
  // Touch clients re-skin both turns in the mobile theme's indigo so bubbles
  // pair with the Indigo Spade mark (see mobile-theme.test.ts).
  assert.match(css, /:root\.ace-touch \.ace-chat-user-bubble[\s\S]*hsl\(230 82% 76%/);
  assert.match(css, /:root\.ace-touch \.ace-chat-user-bubble[\s\S]*color: hsl\(232 50% 8%\)/);
  assert.match(css, /:root\.ace-touch \.ace-chat-agent-bubble[\s\S]*hsl\(231 70% 64%/);
});

test('Hermes lanes mount the context status pill, prefer screen status, fall back to unknown', () => {
  const root = process.cwd();
  const pane = readFileSync(join(root, 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');
  const pill = readFileSync(join(root, 'src/components/ace-chat/ContextStatusPill.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/index.css'), 'utf8');

  // Pane only shows the pill on Hermes-shaped agents (Rook/King are Hermes
  // identity lanes), and feeds it the live streamId + transcript entries
  // so the pill can read the live screen for the real status line.
  assert.match(pane, /import \{ ContextStatusPill \} from '\.\/ContextStatusPill';/);
  assert.match(
    pane,
    /agent === 'hermes' \? \([\s\S]*<ContextStatusPill[\s\S]*entries=\{transcript\.entries\}[\s\S]*streamId=\{streamId\}[\s\S]*agent=\{agent\}/
  );

  // Pill nudges aceApi.streams.readScreen from PTY activity, parses the Hermes status line
  // first, falls back to transcript token totals, and finally to an honest
  // unknown — never to a fabricated percent. Copy assembly lives in
  // hermes-status.ts so it stays unit-testable.
  assert.match(pill, /aceApi\.streams\.readScreen\(streamId\)/);
  assert.match(pill, /aceApi\.core\.onPtyData/);
  assert.doesNotMatch(pill, /setInterval/);
  assert.match(pill, /parseHermesStatusLine/);
  assert.match(pill, /buildContextPillCopy/);

  const status = readFileSync(join(root, 'src/lib/hermes-status.ts'), 'utf8');
  assert.match(status, /Context \$\{hermesStatus\.limitLabel\}/);
  assert.match(status, /\$\{hermesStatus\.percentLeft\}% left/);
  assert.match(status, /'Context · unknown'/);
  assert.match(status, /'no token telemetry'/);

  assert.match(css, /\.ace-chat-context-pill[\s\S]*hsl\(45 70% 50%/);
  assert.match(css, /\.ace-chat-identity-pill[\s\S]*hsl\(34 82% 54%/);
});

test('buildContextPillCopy prioritizes screen status over transcript over unknown', async () => {
  const { buildContextPillCopy } = await import('./hermes-status');

  const fromScreen = buildContextPillCopy({
    hermesStatus: {
      usedTokens: 19_400,
      usedLabel: '19.4K',
      limitTokens: 600_000,
      limitLabel: '600K',
      percentUsed: 3,
      percentLeft: 97,
    },
    transcript: { used: 0, haveData: false },
  });
  assert.equal(fromScreen.primary, 'Context 600K');
  assert.equal(fromScreen.secondary, '97% left');

  const fromTranscript = buildContextPillCopy({
    hermesStatus: null,
    transcript: { used: 12_500, haveData: true },
  });
  assert.match(fromTranscript.primary, /^Context · ~/);
  assert.equal(fromTranscript.secondary, 'used');

  const fallback = buildContextPillCopy({
    hermesStatus: null,
    transcript: { used: 0, haveData: false },
  });
  assert.equal(fallback.primary, 'Context · unknown');
  assert.equal(fallback.secondary, 'no token telemetry');
});

test('parseHermesStatusLine extracts used/limit and percent from the live status bar', () => {
  const screen = `
 ─  ⚕ Hermes  ─────────────────────────────────────────────────────────────

     Some agent reply text here.

 ──────────────────────────────────────────────────────────────────────────
 ⚕ gpt-5.5 │ 19.4K/600K │ [░░░░░░░░░░] 3% │ 31m │ ⏲ 3s
───────────────────────────────────────────────────────────────────────────
❯
`;
  const parsed = parseHermesStatusLine(screen);
  assert.ok(parsed, 'expected status line to parse');
  assert.equal(parsed!.usedLabel, '19.4K');
  assert.equal(parsed!.limitLabel, '600K');
  assert.equal(parsed!.usedTokens, 19_400);
  assert.equal(parsed!.limitTokens, 600_000);
  assert.equal(parsed!.percentUsed, 3);
  assert.equal(parsed!.percentLeft, 97);
});

test('parseHermesStatusLine picks the freshest line when the bar has been redrawn', () => {
  const screen = [
    '⚕ gpt-5.5 │ 1.0K/200K │ [░░░░░░░░░░] 1% │ 1m',
    'something in between',
    '⚕ gpt-5.5 │ 250K/600K │ [████░░░░░░] 42% │ 12m │ ⏲ 5s',
  ].join('\n');
  const parsed = parseHermesStatusLine(screen);
  assert.ok(parsed);
  assert.equal(parsed!.limitLabel, '600K');
  assert.equal(parsed!.percentUsed, 42);
  assert.equal(parsed!.percentLeft, 58);
});

test('parseHermesStatusLine returns null when the screen has no parseable status line', () => {
  assert.equal(parseHermesStatusLine(''), null);
  assert.equal(parseHermesStatusLine('⚕ Hermes\n❯ '), null);
  assert.equal(parseHermesStatusLine('total: 100/200 things'), null);
});

test('native chat transcript presentation markers stay wired to source + css', () => {
  const root = process.cwd();
  const markdown = readFileSync(join(root, 'src/components/ace-chat/render/MarkdownText.tsx'), 'utf8');
  const entries = readFileSync(join(root, 'src/components/ace-chat/entries/Entries.tsx'), 'utf8');
  const list = readFileSync(join(root, 'src/components/ace-chat/TranscriptList.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/index.css'), 'utf8');

  // Markdown wrapper drives prose rhythm without the prose plugin; fenced code
  // renders through streamdown's code plugin into a self-contained card
  // (data-streamdown=code-block), no raw <pre> leak.
  assert.match(markdown, /ace-chat-md/);
  assert.match(markdown, /ace-chat-md-code/);
  assert.match(markdown, /plugins=\{\{ math: mathPlugin, code: codePlugin \}\}/);
  assert.match(css, /\.ace-chat-md > \*:first-child/);
  assert.match(css, /\.ace-chat-md > \*:last-child/);
  assert.match(css, /\[data-streamdown='code-block'\]/);

  // AgentEntry no longer relies on the tailwind-typography prose classes —
  // the bubble keeps its own readable rhythm via ace-chat-md.
  assert.doesNotMatch(entries, /prose prose-invert/);

  // ReasoningEntry header wraps cleanly on narrow widths: meta + preview
  // share a flex column so the label/elapsed row never trips truncation.
  assert.match(entries, /ace-chat-reasoning-header/);

  // Status rows are not duplicated below the durable transcript/live mirror.
  assert.doesNotMatch(list, /ace-chat-status-row/);
  assert.doesNotMatch(css, /\.ace-chat-status-row/);
});

test('main process remote event broadcasts keep the server instance after shutdown starts', () => {
  const main = readFileSync(join(process.cwd(), 'electron/main.cts'), 'utf8');

  assert.match(main, /function wireRemoteServerEvents\(\) \{[\s\S]*const server = remoteServer;/);
  assert.match(main, /const notify = \(\) => \{[\s\S]*const status = server\.getStatus\(\);/);
  assert.match(main, /server\.events\.on\('tunnel-changed', notify\)/);
  assert.doesNotMatch(main, /const notify = \(\) => \{[\s\S]{0,80}remoteServer\.getStatus\(\);/);
});

test('main process opens the first BrowserWindow visibly during startup', () => {
  const main = readFileSync(join(process.cwd(), 'electron/main.cts'), 'utf8');

  assert.match(main, /const win = new BrowserWindow\(\{[\s\S]*show: true,/);
  assert.doesNotMatch(main, /const win = new BrowserWindow\(\{[\s\S]*show: false,/);
});

test('main process defers background boot until the first renderer load', () => {
  const main = readFileSync(join(process.cwd(), 'electron/main.cts'), 'utf8');

  assert.match(main, /function loadWindow\(win: any\)/);
  assert.match(main, /function createWindow\(options: \{ deferLoad\?: boolean \} = \{\}\)/);
  assert.match(main, /if \(!options\.deferLoad\) loadWindow\(win\)/);
  assert.match(main, /const mainWindow = createWindow\(\{ deferLoad: true \}\)/);
  assert.match(main, /const deferredBootTasks: Array<\(\) => void> = \[\]/);
  assert.match(main, /win\.webContents\.once\('did-finish-load', startDeferredBootTasks\)/);
  // Front-door split: deferred boot arms only inside the auth-gated
  // bootRuntime(); the window loads pre-auth to show the login screen.
  assert.match(main, /armDeferredBootAfterWindow\(mainWindow\)/);
  // Failure-safe boot: the construction sequence runs through the createRuntimeBoot
  // seam, and runtimeBooted flips ONLY from the seam's result — never eagerly at the
  // top — so a constructor throw can't leave the app claiming authed over a broken shell.
  assert.match(main, /const runtimeBoot = createRuntimeBoot\(\{[\s\S]{0,1500}\}; \/\/ end bootRuntime/);
  assert.match(main, /const bootResult = await runtimeBoot\.boot\(\);\s*runtimeBooted = bootResult\.ok;/);
  assert.doesNotMatch(main, /if \(runtimeBooted\) return;\s*runtimeBooted = true;/);
  assert.match(main, /\}; \/\/ end bootRuntime[\s\S]{0,500}loadWindow\(mainWindow\)/);
  // The gate boots then FOLDS the outcome — a failed boot becomes the effective auth
  // decision so ace:auth-state can't re-derive 'authed' over a broken shell.
  assert.match(main, /const bootResult = bootRuntime \? await bootRuntime\(\) : null;\s*decision = effectiveAuthDecision\(decision, bootResult\);/);
  assert.match(main, /if \(!loading\) \{ startDeferredBootTasks\(\); return; \}/);
  assert.match(main, /aceSocketBridge\.start\(\)\s*\.catch/);
  assert.doesNotMatch(main, /deferredBootTasks\.push\(\(\) => \{[\s\S]{0,300}aceSocketBridge\.start\(\)/);
  assert.match(main, /deferredBootTasks\.push\(\(\) => \{[\s\S]*aceStore\?\.startWorkspaceMetaRefresh\?\.\(\)/);
  assert.match(main, /deferredBootTasks\.push\(\(\) => \{[\s\S]*remoteServer\.start\(\)\.catch/);
  assert.match(main, /deferredBootTasks\.push\(\(\) => \{[\s\S]*aceStore\.startAlwaysOnOrchestratorWatchdog\(\)/);
  assert.match(main, /restoreAgentStreams\?\.\(\{ relaunchMissing: true \}\)/);
  assert.doesNotMatch(main, /transcripts\?\.resumeAllFromDisk\?\.\(\)/);
  assert.doesNotMatch(main, /db-monitoring-scheduler/);
  assert.doesNotMatch(main, /ace:db-monitor-status/);
  assert.doesNotMatch(main, /ace:db-scan|ace:db-purge|ace:hermes-monitoring|ace:hermes-orphan-sweep|ace:hermes-embed-check-updates/);
});

test('Operations monitoring database and Hermes collectors are retired', () => {
  const root = process.cwd();
  const localCore = readFileSync(join(root, 'electron/local-core.cts'), 'utf8');
  const controller = readFileSync(join(root, 'electron/ace-control/index.cts'), 'utf8');
  const api = readFileSync(join(root, 'src/lib/ace-api.ts'), 'utf8');

  assert.equal(existsSync(join(root, 'electron/db-monitoring.cts')), false);
  assert.equal(existsSync(join(root, 'electron/hermes-monitoring.cts')), false);
  assert.equal(existsSync(join(root, 'src/components/operations/organisms/DatabaseMonitoringPanel.tsx')), false);
  assert.equal(existsSync(join(root, 'src/components/operations/organisms/HermesMonitoringPanel.tsx')), false);
  assert.equal(existsSync(join(root, 'src/runtime/hermes-update-registry.ts')), false);
  assert.doesNotMatch(localCore, /dbMonitoring|hermesMonitoring|dbScan|dbPurge|dbMonitorTick|hermesMonitoringStatus|hermesOrphanSweep|hermesEmbedCheckUpdates/);
  assert.doesNotMatch(controller, /sys-db-monitor|dbMonitorTick/);
  assert.doesNotMatch(api, /dbMonitoring|HermesMonitoring|HermesOrphanSweep|HermesEmbedUpdateCheck|hermesMonitoring|hermesOrphanSweep|hermesEmbedCheckUpdates/);
});

test('main process handles Hermes deep-link readiness during renderer boot', () => {
  const main = readFileSync(join(process.cwd(), 'electron/main.cts'), 'utf8');

  assert.match(main, /ipcMain\.handle\('hermes:deep-link-ready', \(\) => \(\{ ok: true \}\)\)/);
});

test('workspace metadata refresh is not started during store construction', () => {
  const localCore = readFileSync(join(process.cwd(), 'electron/local-core.cts'), 'utf8');

  assert.match(localCore, /function startWorkspaceMetaRefresh\(\)/);
  assert.match(localCore, /function refreshAllWorkspaceMeta\(\)/);
  assert.match(localCore, /ORDER BY order_index ASC, created_at ASC/);
  assert.doesNotMatch(
    localCore,
    /setImmediate\(\(\) => \{\s*try \{\s*const rows = db\.prepare\('SELECT id FROM projects WHERE is_remote=0'\)\.all\(\);[\s\S]{0,200}refreshWorkspaceMeta\(r\.id\)/
  );
});

test('run-ledger event log is not parsed during controller construction', () => {
  const controller = readFileSync(join(process.cwd(), 'electron/ace-control/index.cts'), 'utf8');
  const beforeLazyInitializer = controller.slice(0, controller.indexOf('function ensureRunLedgerHarness()'));

  assert.match(controller, /function ensureRunLedgerHarness\(\)/);
  assert.doesNotMatch(beforeLazyInitializer, /createRunLedgerHarness\(\{ ledgerPath/);
  // The intake gate (workspace fail-fast + acceptance + codex pre-trust) sits
  // between the lazy init and the submit. Assert the call ORDER directly:
  // lazy harness init -> intake validation -> submit through the harness.
  const initAt = controller.indexOf('const h = ensureRunLedgerHarness();');
  const gateAt = controller.indexOf('intakeGate.validateRunIntake({ intent, workspaceId, workspace })');
  const submitAt = controller.indexOf('const runId = h.submit(intent)');
  assert.ok(initAt !== -1, 'runSubmit lazily initializes the harness');
  assert.ok(gateAt !== -1, 'runSubmit validates intake before minting');
  assert.ok(submitAt !== -1, 'runSubmit submits through the harness');
  assert.ok(initAt < gateAt && gateAt < submitAt, 'order: lazy init -> intake gate -> submit');
});

test('Hermes SQLite transcript live tail is retired from Electron main', () => {
  const root = process.cwd();
  const index = readFileSync(join(root, 'electron/ace-control/transcript/index.cts'), 'utf8');
  const normalizer = readFileSync(join(root, 'electron/ace-control/transcript/normalize/hermes.cts'), 'utf8');

  assert.equal(existsSync(join(root, 'electron/ace-control/transcript/tails/hermes-sqlite.cts')), false);
  assert.doesNotMatch(index, /HERMES_SQLITE_|createHermesSqliteTail|normalizeHermesMessageRow|FROM messages|tail:nudge|nudgeStream|resyncTail|resumeAllFromDisk/);
  assert.doesNotMatch(normalizer, /normalizeHermesMessageRow/);
});

test('transcript controller does not open transcript SQLite during construction', () => {
  const index = readFileSync(join(process.cwd(), 'electron/ace-control/transcript/index.cts'), 'utf8');

  assert.match(index, /function createLazyTranscriptStore\(\{ userDataPath, db, injectedStore \}: any = \{\}\)/);
  assert.match(index, /const store = createLazyTranscriptStore\(\{ userDataPath, db, injectedStore \}\)/);
  assert.doesNotMatch(index, /store = injectedStore \|\| createTranscriptStore\(\{ userDataPath, db \}\)/);
});

test('Hermes profile home resolution does not open state.db during startup', () => {
  const localCore = readFileSync(join(process.cwd(), 'electron/local-core.cts'), 'utf8');

  assert.match(localCore, /function hermesHomeStateDbSize\(home\)/);
  assert.doesNotMatch(localCore, /function hermesHomeMessageCount\(home\)/);
  assert.doesNotMatch(localCore, /SELECT COUNT\(\*\) AS n FROM sessions/);
  assert.doesNotMatch(localCore, /SELECT COUNT\(\*\) AS n FROM messages/);
  assert.doesNotMatch(localCore, /new Database\(dbPath, \{ readonly: true, fileMustExist: true \}\)/);
});

test('remote server injects a root base tag for deep-link mobile asset loading', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /function htmlWithRemoteBase\(data: any\)/);
  assert.match(remote, /<base href="\/" data-ace-remote-base \/>/);
  assert.match(remote, /function sendIndexHtml\(res: any, data: any\)/);
  assert.ok(remote.includes("if (ext === '.html')"));
  assert.match(remote, /if \(ext === '[^']+'\) \{[\s\S]*sendIndexHtml\(res, data\);/);
  assert.match(remote, /const fallback = path\.join\(distDir, 'index\.html'\);[\s\S]*sendIndexHtml\(res, data\);/);
});

test('chat overlay terminal mirror is fully removed; CLI pane keeps the smart composer', () => {
  const root = process.cwd();
  const pane = readFileSync(join(root, 'src/components/ace-chat/AceChatPane.tsx'), 'utf8');
  const list = readFileSync(join(root, 'src/components/ace-chat/TranscriptList.tsx'), 'utf8');

  // The live-CLI mirror (per-PTY-chunk readScreen + reparse) is gone: files
  // deleted, no imports, no terminalMirror plumbing anywhere.
  assert.equal(existsSync(join(root, 'src/components/ace-chat/HermesTerminalMirror.tsx')), false);
  assert.equal(existsSync(join(root, 'src/components/ace-chat/hermes-terminal-mirror-parser.ts')), false);
  assert.equal(existsSync(join(root, 'src/components/ace-chat/CodexToolPill.tsx')), false);
  assert.equal(existsSync(join(root, 'src/components/ace-chat/hermes-overlay-state.ts')), false);
  assert.doesNotMatch(pane, /HermesTerminalMirror|terminalMirror|showLiveMirror|keepTerminalLiveInChat/);
  assert.doesNotMatch(list, /terminalMirror|showTerminalMirror/);

  // The terminal is live exactly when the CLI view is showing.
  assert.match(pane, /const terminalActive = effectiveMode === 'cli';/);
  assert.match(pane, /<TerminalFeed[\s\S]*streamId=\{streamId\}[\s\S]*active=\{terminalActive\}[\s\S]*interactive=\{effectiveMode === 'cli'\}/);

  // The smart composer still rides the CLI pane on desktop; mobile keeps the
  // dedicated MobileTaskComposer on the workspace task view only.
  assert.match(pane, /import\s+\{\s*Composer\s*\}\s+from\s+'\.\/Composer'/);
  assert.match(pane, /<Composer[\s\S]*streamId=\{streamId\}[\s\S]*agent=\{agent\}[\s\S]*state=\{streamStatus\.state\}/);
  assert.match(pane, /ace-composer-slot min-w-0 shrink-0/);
  assert.match(pane, /const showComposer = !isRemoteWorkspace;/);
  assert.match(pane, /const mobileComposerCoversPane = isMobile && view === 'workspace';/);
  assert.match(pane, /const showInlineComposer = showComposer && !mobileComposerCoversPane;/);
  assert.match(pane, /\{showInlineComposer && \(\s*<div[\s\S]*<Composer/);

  // Durable-transcript chat wiring survives (hermes lanes still get chat).
  assert.match(pane, /const showToggle = \(available \|\| agent === 'hermes'\) && !isRemoteWorkspace;/);
  assert.match(pane, /entries=\{transcript\.entries\}/);
  assert.match(pane, /hasOlder=\{transcript\.hasOlder\}/);
  assert.match(pane, /loadingOlder=\{transcript\.loadingOlder\}/);
  assert.match(pane, /olderError=\{transcript\.olderError\}/);
});
