import React, { useState } from 'react';
import { ChevronRight, FileText, Pencil, Search, Terminal as TerminalIcon, Wrench } from 'lucide-react';
import { cn } from '../../../lib/utils';

function str(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function argsToObj(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== 'object') return null;
  return args as Record<string, unknown>;
}

function jsonObj(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function skillSubtitle(args: unknown, result: unknown): string {
  const argObj = jsonObj(args);
  const resultObj = jsonObj(result);
  const direct =
    stringField(argObj, ['name', 'skill', 'skillId', 'skill_id', 'id']) ||
    stringField(resultObj, ['name', 'skill', 'skillId', 'skill_id', 'id']);
  if (direct) return direct;
  const skills = resultObj?.skills;
  if (Array.isArray(skills)) return `${skills.length} skill${skills.length === 1 ? '' : 's'}`;
  const error = stringField(resultObj, ['error']);
  const ambiguous = /skill name ['"]([^'"]+)['"]/i.exec(error);
  if (ambiguous?.[1]) return ambiguous[1];
  return '';
}

function ToolDetails({ args, result }: { args: unknown; result: unknown }) {
  if (args == null && result == null) {
    return <div className="text-[12px] text-muted-foreground/80">Waiting for tool details…</div>;
  }
  return (
    <>
      {args != null && (
        <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[12px] text-foreground/85">
          {str(args)}
        </pre>
      )}
      {result != null && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11.5px] text-foreground/80">
          {str(result)}
        </pre>
      )}
    </>
  );
}

export function ToolWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  const normalized = name.toLowerCase();
  const obj = argsToObj(args);
  // Route to specialized widgets by name. Fall back to GenericToolWidget.
  if (normalized === 'skill_view' || normalized === 'skill_manage' || normalized === 'skill_load' || normalized === 'skills_list') {
    return <SkillWidget name={name} args={args} result={result} status={status} lifecycle={lifecycle} />;
  }
  if (obj && (normalized === 'edit' || normalized === 'write' || normalized === 'write_file' || normalized === 'apply_patch' || normalized === 'str_replace_editor')) {
    return <DiffWidget name={name} args={obj} result={result} status={status} lifecycle={lifecycle} />;
  }
  if (obj && (normalized === 'read' || normalized === 'read_file' || normalized === 'readfile')) {
    return <ReadWidget name={name} args={obj} result={result} status={status} lifecycle={lifecycle} />;
  }
  if (obj && (normalized === 'tool_search' || normalized === 'tool_search_call')) {
    return <SearchWidget name={name} args={obj} result={result} status={status} lifecycle={lifecycle} />;
  }
  if (
    obj &&
    (normalized === 'bash' ||
      normalized === 'exec' ||
      normalized === 'exec_command' ||
      normalized === 'command_execution' ||
      normalized === 'run_shell_command' ||
      normalized === 'shell' ||
      normalized === 'terminal')
  ) {
    return <BashWidget name={name} args={obj} result={result} status={status} lifecycle={lifecycle} />;
  }
  return <GenericToolWidget name={name} args={args} result={result} status={status} lifecycle={lifecycle} />;
}

function ToolShell({
  icon,
  title,
  subtitle,
  status,
  lifecycle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(status === 'error' || status === 'denied');
  const statusTone =
    status === 'error' || status === 'denied'
      ? 'text-rose-300/85'
      : lifecycle === 'open' || status === 'running'
      ? 'text-amber-200/85'
      : 'text-emerald-300/80';
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="truncate font-medium text-foreground/90">{title}</span>
        {subtitle && (
          <span className="truncate text-[12px] text-muted-foreground/85">{subtitle}</span>
        )}
        <span className={cn('ml-auto text-[11px] uppercase tracking-wider', statusTone)}>
          {lifecycle === 'open' ? 'running' : status}
        </span>
      </button>
      {open && children && <div className="border-t border-white/[0.05] px-3 py-2">{children}</div>}
    </div>
  );
}

function SkillWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  const subtitle = skillSubtitle(args, result);
  return (
    <ToolShell
      icon={<Wrench className="h-3.5 w-3.5" />}
      title={name}
      subtitle={subtitle}
      status={status}
      lifecycle={lifecycle}
    >
      <ToolDetails args={args} result={result} />
    </ToolShell>
  );
}

function DiffWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  const path =
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.path === 'string' && args.path) ||
    (typeof args.filePath === 'string' && args.filePath) ||
    'file';
  const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
  const newStr = typeof args.new_string === 'string' ? args.new_string : '';
  const content = typeof args.content === 'string' ? args.content : null;
  return (
    <ToolShell
      icon={<Pencil className="h-3.5 w-3.5" />}
      title={name}
      subtitle={path}
      status={status}
      lifecycle={lifecycle}
    >
      {content != null && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[12px] text-foreground/85">
          {content}
        </pre>
      )}
      {(oldStr || newStr) && (
        <div className="space-y-2">
          {oldStr && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-rose-500/[0.06] p-2 font-mono text-[12px] text-rose-200/90">
              {oldStr}
            </pre>
          )}
          {newStr && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-emerald-500/[0.06] p-2 font-mono text-[12px] text-emerald-200/90">
              {newStr}
            </pre>
          )}
        </div>
      )}
      {typeof result === 'string' && result && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11.5px] text-foreground/80">
          {result}
        </pre>
      )}
    </ToolShell>
  );
}

function ReadWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  const path =
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.path === 'string' && args.path) ||
    'file';
  return (
    <ToolShell
      icon={<FileText className="h-3.5 w-3.5" />}
      title={name}
      subtitle={path}
      status={status}
      lifecycle={lifecycle}
    >
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[12px] text-foreground/80">
        {str(result) || '(no output)'}
      </pre>
    </ToolShell>
  );
}

function BashWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  const command =
    (typeof args.command === 'string' && args.command) ||
    (Array.isArray(args.command) && (args.command as unknown[]).map((x) => String(x)).join(' ')) ||
    (typeof args.cmd === 'string' && args.cmd) ||
    '';
  return (
    <ToolShell
      icon={<TerminalIcon className="h-3.5 w-3.5" />}
      title={name}
      subtitle={command}
      status={status}
      lifecycle={lifecycle}
    >
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[12px] text-foreground/80">
        {str(result) || '(no output)'}
      </pre>
    </ToolShell>
  );
}

function searchResultCount(result: unknown): number | null {
  if (!Array.isArray(result)) return null;
  return result.length;
}

function SearchWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  const query = typeof args.query === 'string' ? args.query : '';
  const count = searchResultCount(result);
  const subtitle = [query, count == null ? null : `${count} result${count === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <ToolShell
      icon={<Search className="h-3.5 w-3.5" />}
      title={name}
      subtitle={subtitle}
      status={status}
      lifecycle={lifecycle}
    >
      <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[12px] text-foreground/85">
        {str(args)}
      </pre>
      {result != null && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11.5px] text-foreground/80">
          {str(result)}
        </pre>
      )}
    </ToolShell>
  );
}

function GenericToolWidget({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  return (
    <ToolShell
      icon={<Wrench className="h-3.5 w-3.5" />}
      title={name}
      status={status}
      lifecycle={lifecycle}
    >
      <ToolDetails args={args} result={result} />
    </ToolShell>
  );
}
