import { useMemo, useState } from 'react';
import {
  Check,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { aceApi } from '../lib/ace-api';
import type {
  McpCatalogEntry,
  McpProvider,
  McpServer,
  McpTransport,
} from '../lib/types';
import { loadMcp, useMcpState } from '../runtime/catalog-registry';
import { cn } from '../lib/utils';
import { resolveMcpIcon } from '../lib/mcp-icons';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';

type ModalMode =
  | { kind: 'add-custom' }
  | { kind: 'add-catalog'; entry: McpCatalogEntry }
  | { kind: 'edit'; server: McpServer };

export function ToolServersPanel() {
  const { installed, catalog, providers } = useMcpState();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<ModalMode | null>(null);

  const installedNames = useMemo(
    () => new Set(installed.map((s) => s.name)),
    [installed]
  );

  const { addedFiltered, recommendedFiltered } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (haystack: string) => !q || haystack.toLowerCase().includes(q);
    return {
      addedFiltered: installed.filter((s) => match(`${s.name} ${s.url ?? ''} ${s.command ?? ''}`)),
      recommendedFiltered: catalog.filter(
        (e) =>
          !installedNames.has(e.key) &&
          !installedNames.has(e.name) &&
          match(`${e.name} ${e.description}`)
      ),
    };
  }, [installed, catalog, search, installedNames]);

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search servers..."
            className="h-9 pl-9 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => setModal({ kind: 'add-custom' })}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Custom MCP
        </Button>
      </div>

      <Section title="Added" emptyHint={installed.length === 0 ? 'No servers installed yet.' : undefined}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {addedFiltered.map((server) => (
            <InstalledCard
              key={server.name}
              server={server}
              providers={providers}
              onClick={() => setModal({ kind: 'edit', server })}
            />
          ))}
        </div>
      </Section>

      <Section title={search ? 'Catalog' : 'Recommended'}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {recommendedFiltered.map((entry) => (
            <CatalogCard
              key={entry.key}
              entry={entry}
              onClick={() => setModal({ kind: 'add-catalog', entry })}
            />
          ))}
        </div>
        {recommendedFiltered.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {search ? 'No servers match your search.' : 'All catalog servers are already added.'}
          </p>
        )}
      </Section>

      {modal && (
        <McpServerModal
          mode={modal}
          providers={providers}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function Section({
  title,
  emptyHint,
  children,
}: {
  title: string;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {emptyHint ? <p className="text-xs text-muted-foreground">{emptyHint}</p> : children}
    </div>
  );
}

function processMcpSvg(raw: string, preserveColors: boolean): string {
  let svg = raw.replace(/\bwidth="[^"]*"/g, '').replace(/\bheight="[^"]*"/g, '');
  if (!preserveColors) {
    svg = svg.replace('<svg ', '<svg fill="#ffffff" ');
  }
  return svg.replace('<svg ', '<svg class="h-full w-full" ');
}

function McpIcon({ catalogKey, transport, name }: { catalogKey?: string; transport: McpTransport; name: string }) {
  const def = resolveMcpIcon(catalogKey);
  const containerClass =
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.05]';

  if (def?.type === 'svg' && def.data) {
    return (
      <div
        className={cn(containerClass, 'p-2')}
        dangerouslySetInnerHTML={{ __html: processMcpSvg(def.data, def.preserveColors ?? false) }}
      />
    );
  }
  if (def?.type === 'png') {
    return (
      <div className={cn(containerClass, 'overflow-hidden p-1')}>
        <img src={def.data} alt="" loading="lazy" className="h-full w-full rounded-md object-contain" />
      </div>
    );
  }
  const Icon = transport === 'http' ? Globe : Terminal;
  if (!name.trim()) {
    return (
      <div className={cn(containerClass, 'text-foreground/70')}>
        <Icon className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className={cn(containerClass, 'text-sm font-semibold text-foreground/70')}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function InstalledCard({
  server,
  providers,
  onClick,
}: {
  server: McpServer;
  providers: McpProvider[];
  onClick: () => void;
}) {
  const providerNames = server.providers
    .map((id) => providers.find((p) => p.id === id)?.name ?? id)
    .slice(0, 3);
  const remaining = server.providers.length - providerNames.length;
  const detail = server.transport === 'http' ? server.url : server.command;
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-left transition-all hover:-translate-y-[1px] hover:border-white/20 hover:bg-white/[0.06] hover:shadow-[0_10px_30px_hsl(0_0%_0%/0.35)]"
    >
      <McpIcon catalogKey={server.name} transport={server.transport} name={server.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{server.name}</span>
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          <span className="text-muted-foreground/70">{server.transport}</span>
          {detail && <span className="mx-1.5 text-muted-foreground/40">·</span>}
          <span className="font-mono">{detail}</span>
        </p>
      </div>
      {providerNames.length > 0 && (
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          {providerNames.map((pname) => (
            <span
              key={pname}
              className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
            >
              {pname}
            </span>
          ))}
          {remaining > 0 && (
            <span className="text-[9px] text-muted-foreground">+{remaining}</span>
          )}
        </div>
      )}
    </button>
  );
}

function CatalogCard({
  entry,
  onClick,
}: {
  entry: McpCatalogEntry;
  onClick: () => void;
}) {
  const transport: McpTransport = entry.defaultConfig.type === 'http' ? 'http' : 'stdio';
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/card relative flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-left transition-all hover:-translate-y-[1px] hover:border-white/20 hover:bg-white/[0.06] hover:shadow-[0_10px_30px_hsl(0_0%_0%/0.35)]"
    >
      <McpIcon catalogKey={entry.key} transport={transport} name={entry.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{entry.name}</span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          <span className="text-muted-foreground/70">{transport}</span>
          {entry.description && (
            <>
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              {entry.description}
            </>
          )}
        </p>
      </div>
      <Plus className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/card:opacity-100" />
    </button>
  );
}

type FormState = {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  headers: string;
  env: string;
  providers: string[];
};

function defaultsForCatalog(entry: McpCatalogEntry): FormState {
  const config = entry.defaultConfig;
  const http = config.type === 'http';
  const args = Array.isArray(config.args) ? (config.args as string[]).join(' ') : '';
  const headers = jsonish(config.headers);
  const env = jsonish(config.env);
  return {
    name: entry.key,
    transport: http ? 'http' : 'stdio',
    command: typeof config.command === 'string' ? config.command : '',
    args,
    url: typeof config.url === 'string' ? config.url : '',
    headers,
    env,
    providers: [],
  };
}

function defaultsForServer(server: McpServer): FormState {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).join(' '),
    url: server.url ?? '',
    headers: jsonish(server.headers),
    env: jsonish(server.env),
    providers: [...server.providers],
  };
}

function jsonish(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}

function parseJsonMap(raw: string, label: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

function McpServerModal({
  mode,
  providers,
  onClose,
}: {
  mode: ModalMode;
  providers: McpProvider[];
  onClose: () => void;
}) {
  const initial = useMemo<FormState>(() => {
    if (mode.kind === 'edit') return defaultsForServer(mode.server);
    if (mode.kind === 'add-catalog') return defaultsForCatalog(mode.entry);
    return {
      name: '',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      headers: '',
      env: '',
      providers: [],
    };
  }, [mode]);

  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const title =
    mode.kind === 'edit'
      ? `Edit ${mode.server.name}`
      : mode.kind === 'add-catalog'
        ? `Add ${mode.entry.name}`
        : 'Custom MCP server';

  const docsUrl = mode.kind === 'add-catalog' ? mode.entry.docsUrl : null;
  const nameLocked = mode.kind !== 'add-custom';

  const toggleProvider = (id: string) => {
    setForm((prev) => {
      const has = prev.providers.includes(id);
      return {
        ...prev,
        providers: has ? prev.providers.filter((p) => p !== id) : [...prev.providers, id],
      };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) return setError('Name is required');
    if (!/^[\w\-._]+$/.test(form.name.trim())) {
      return setError('Name must contain only letters, digits, dashes, dots, or underscores');
    }
    if (form.providers.length === 0) return setError('Pick at least one agent to sync to');

    let server: McpServer;
    try {
      server = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() || undefined : undefined,
        args:
          form.transport === 'stdio' && form.args.trim()
            ? form.args.trim().split(/\s+/)
            : undefined,
        url: form.transport === 'http' ? form.url.trim() || undefined : undefined,
        headers: form.transport === 'http' ? parseJsonMap(form.headers, 'Headers') : undefined,
        env: parseJsonMap(form.env, 'Environment'),
        providers: form.providers,
      };
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }

    if (server.transport === 'http' && !server.url) {
      return setError('URL is required for http servers');
    }
    if (server.transport === 'stdio' && !server.command) {
      return setError('Command is required for stdio servers');
    }

    setSaving(true);
    try {
      await aceApi.mcp.saveServer(server);
      await loadMcp();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (mode.kind !== 'edit') return;
    setRemoving(true);
    setError(null);
    try {
      await aceApi.mcp.removeServer(mode.server.name);
      await loadMcp();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRemoving(false);
    }
  };

  return (
    <div
      className="glass-overlay fixed inset-0 z-[140] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface flex h-full max-h-[min(720px,90vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl"
      >
        <div className="flex items-start gap-3 border-b border-white/[0.06] px-6 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="truncate font-display text-base font-semibold">{title}</h2>
            {docsUrl && (
              <a
                href={docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                Docs
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={nameLocked}
              className="h-9 text-sm"
            />
          </Field>

          <Field label="Transport">
            <div className="flex gap-2">
              {(['stdio', 'http'] as McpTransport[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setForm({ ...form, transport: t })}
                  className={cn(
                    'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    form.transport === t
                      ? 'border-foreground/60 bg-white/[0.06] text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t === 'http' ? 'http' : 'stdio (local)'}
                </button>
              ))}
            </div>
          </Field>

          {form.transport === 'stdio' ? (
            <>
              <Field label="Command">
                <Input
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="npx"
                  className="h-9 font-mono text-xs"
                />
              </Field>
              <Field label="Args (space-separated)">
                <Input
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder="@playwright/mcp@latest"
                  className="h-9 font-mono text-xs"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <Input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://example.com/mcp"
                  className="h-9 font-mono text-xs"
                />
              </Field>
              <Field label="Headers (JSON object)">
                <JsonArea
                  value={form.headers}
                  onChange={(v) => setForm({ ...form, headers: v })}
                  placeholder={'{\n  "Authorization": "Bearer ..."\n}'}
                />
              </Field>
            </>
          )}

          <Field label="Environment (JSON object)">
            <JsonArea
              value={form.env}
              onChange={(v) => setForm({ ...form, env: v })}
              placeholder={'{\n  "MY_API_KEY": "..."\n}'}
            />
          </Field>

          <Field label="Sync to agents">
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {providers.map((p) => {
                const disabled = form.transport === 'http' && !p.supportsHttp;
                const checked = form.providers.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={cn(
                      'flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs transition-colors',
                      disabled ? 'opacity-40' : 'hover:bg-white/[0.04]',
                      checked && !disabled && 'border-foreground/40 bg-white/[0.04]'
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={() => !disabled && toggleProvider(p.id)}
                    />
                    <span className="flex-1 truncate">{p.name}</span>
                    {!p.installed && (
                      <span className="text-micro text-muted-foreground">not installed</span>
                    )}
                    {disabled && (
                      <span className="text-micro text-muted-foreground">no http</span>
                    )}
                  </label>
                );
              })}
            </div>
          </Field>

          {error && <p className="text-[11px] text-red-300/85">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-6 py-3">
          {mode.kind === 'edit' ? (
            confirmRemove ? (
              <div className="flex items-center gap-2 text-[11px] text-red-300/85">
                <span>Remove from all agents?</span>
                <button
                  type="button"
                  onClick={handleRemove}
                  className="rounded-md bg-red-500/20 px-2 py-0.5 font-medium text-red-200 hover:bg-red-500/30"
                  disabled={removing}
                >
                  {removing ? 'Removing…' : 'Yes'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="rounded-md px-2 py-0.5 text-muted-foreground hover:text-foreground"
                >
                  No
                </button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 className="mr-1.5 h-3 w-3" />
                Remove
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function JsonArea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={4}
      placeholder={placeholder}
      className="rounded-md border border-border bg-background/40 p-2 font-mono text-[12px] text-foreground/90 focus:border-foreground/40 focus:outline-none"
    />
  );
}
