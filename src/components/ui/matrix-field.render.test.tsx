// @vitest-environment happy-dom
//
// Render test for the decorative MatrixField atom. happy-dom has no canvas 2d
// context, so getContext('2d') returns null — the component must mount a bare
// <canvas> and no-op the animation (no throw, no requestAnimationFrame), which
// is exactly the guard the pre-auth LoginScreen relies on.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MatrixField } = await import('./MatrixField');

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
});

async function render(node: React.ReactNode): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return root;
}

it('mounts a decorative canvas and no-ops without a 2d context', async () => {
  const root = await render(<MatrixField />);
  const canvas = container.querySelector('canvas');
  expect(canvas).toBeTruthy();
  // Purely decorative: hidden from a11y and non-interactive.
  expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  // Unmount cleanly (cancelAnimationFrame / listener teardown must not throw).
  await act(async () => {
    root.unmount();
  });
});

it('accepts an intensity prop without throwing', async () => {
  const root = await render(<MatrixField intensity={2.1} />);
  expect(container.querySelector('canvas')).toBeTruthy();
  await act(async () => {
    root.render(<MatrixField intensity={1} />);
  });
  await act(async () => {
    root.unmount();
  });
});
