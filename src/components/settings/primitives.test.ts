import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const primitives = readFileSync(
  resolve(process.cwd(), 'src/components/settings/primitives.tsx'),
  'utf8'
);

describe('settings primitives', () => {
  it('does not wrap ReactNode titles or descriptions in paragraphs', () => {
    expect(primitives).toContain('<div className="text-sm font-medium text-foreground">{title}</div>');
    expect(primitives).toContain('<div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</div>');
    expect(primitives).not.toContain('<p className="text-sm font-medium text-foreground">{title}</p>');
  });
});
