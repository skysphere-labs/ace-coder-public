// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  loginStart: vi.fn(),
  loginPoll: vi.fn(),
  loginCancel: vi.fn(),
  refreshAccounts: vi.fn(),
  setDialogOpen: vi.fn(),
}));

vi.mock('../store', () => ({
  useApp: () => ({
    showAddGithubAccountDialog: true,
    setShowAddGithubAccountDialog: mocks.setDialogOpen,
  }),
}));

vi.mock('../lib/ace-api', () => ({
  aceApi: {
    github: {
      loginStart: mocks.loginStart,
      loginPoll: mocks.loginPoll,
      loginCancel: mocks.loginCancel,
    },
    workspaces: { openExternal: vi.fn(async () => ({ ok: true })) },
  },
}));

vi.mock('../runtime/github-registry', () => ({
  refreshAccounts: mocks.refreshAccounts,
}));

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
  );
  MotionDiv.displayName = 'MotionDiv';
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv },
  };
});

import { AddGithubAccountDialog } from './AddGithubAccountDialog';

const roots: Root[] = [];

function startResponse(requestId: string) {
  return {
    ok: true,
    requestId,
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device',
    interval: 5,
    expiresIn: 900,
  };
}

async function renderDialog() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<AddGithubAccountDialog />);
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.loginCancel.mockResolvedValue({ ok: true });
  mocks.refreshAccounts.mockResolvedValue(true);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
});

describe('AddGithubAccountDialog failure lifecycle', () => {
  it('surfaces a rejected device-code start and cancels its pending request', async () => {
    mocks.loginStart.mockRejectedValue(new Error('internal start detail'));

    const container = await renderDialog();

    expect(container.textContent).toContain('ACE could not start GitHub authorization');
    expect(container.textContent).not.toContain('internal start detail');
    expect(mocks.loginCancel).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected poll and cancels the backend session', async () => {
    mocks.loginStart.mockImplementation(async (requestId: string) => startResponse(requestId));
    mocks.loginPoll.mockRejectedValue(new Error('internal poll detail'));

    const container = await renderDialog();

    expect(container.textContent).toContain('ACE lost the GitHub authorization session');
    expect(container.textContent).not.toContain('internal poll detail');
    expect(mocks.loginCancel).toHaveBeenCalledTimes(1);
  });

  it('reports committed auth as success when the account refresh rejects', async () => {
    mocks.loginStart.mockImplementation(async (requestId: string) => startResponse(requestId));
    mocks.loginPoll.mockResolvedValue({ ok: true, login: 'octodev' });
    mocks.refreshAccounts.mockRejectedValue(new Error('internal refresh detail'));

    const container = await renderDialog();

    expect(container.textContent).toContain('Signed in as octodev');
    expect(container.textContent).toContain('account was added, but ACE could not refresh');
    expect(container.textContent).not.toContain('Try again');
    expect(container.textContent).not.toContain('internal refresh detail');
    expect(mocks.loginCancel).not.toHaveBeenCalled();
  });
});
