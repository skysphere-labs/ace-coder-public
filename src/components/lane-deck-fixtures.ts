import type { Task } from '../lib/types';
import type { ValidatorLink } from '../lib/lane-deck-model';

// Shared fixture workspace for the lane-deck test files: a codex worker, a
// claude worker (with a chat variant that must be excluded), a codex
// validator lane pointed at the claude worker, and a gemini CLI thread.

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'name' | 'agent'>): Task {
  return {
    branch: 'main',
    type: 'task',
    status: 'idle',
    ...overrides,
  } as Task;
}

export const DECK_FIXTURE_TASKS: Task[] = [
  makeTask({
    id: 't-codex',
    name: 'codex worker',
    agent: 'codex',
    worktrees: [
      {
        worktreeId: 'w1',
        displayName: 'w1',
        branch: 'feat/x',
        path: '/tmp/w1',
        variants: [
          { id: 'v-codex', name: 'Codex', agent: 'codex', branch: 'feat/x', worktreeId: 'w1' },
        ],
      },
    ],
  }),
  makeTask({
    id: 't-claude',
    name: 'claude worker',
    agent: 'claude',
    worktrees: [
      {
        worktreeId: 'w2',
        displayName: 'w2',
        branch: 'feat/y',
        path: '/tmp/w2',
        variants: [
          { id: 'v-claude', name: 'Claude', agent: 'claude', branch: 'feat/y', worktreeId: 'w2' },
          { id: 'v-chat', name: 'Chat', agent: 'hermes', branch: 'feat/y', worktreeId: 'w2', kind: 'chat' },
        ],
      },
    ],
  }),
  makeTask({
    id: 't-validator',
    name: 'validator lane',
    agent: 'codex',
    worktrees: [
      {
        worktreeId: 'w3',
        displayName: 'w3',
        branch: 'feat/y-validate',
        path: '/tmp/w3',
        variants: [
          { id: 'v-val', name: 'Codex', agent: 'codex', branch: 'feat/y-validate', worktreeId: 'w3' },
        ],
      },
    ],
  }),
  makeTask({
    id: 't-thread',
    name: 'gemini thread',
    agent: 'gemini',
    type: 'thread',
    conversations: [
      { id: 'c1', title: 'CLI', agent: 'gemini', kind: 'cli', isMain: true, isActive: true },
      { id: 'c2', title: 'Chat', agent: 'hermes', kind: 'chat', isMain: false, isActive: false },
    ],
  }),
];

export const DECK_FIXTURE_LINKS: ValidatorLink[] = [
  { validatorTaskId: 't-validator', targetTaskId: 't-claude', featureName: 'feature y' },
];
