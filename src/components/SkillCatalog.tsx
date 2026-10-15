import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import {
  Check,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { aceApi } from '../lib/ace-api';
import type { Skill } from '../lib/types';
import {
  loadSkillCatalog,
  useSkillCatalog,
} from '../runtime/catalog-registry';
import { cn } from '../lib/utils';
import { resolveSkillIcon } from '../lib/skill-icons';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

const SOURCE_LABEL: Record<Skill['source'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  local: 'Local',
  'skills-sh': 'skills.sh',
};

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/.test(name) && !name.includes('--');
}

export function SkillsPanel() {
  const catalog = useSkillCatalog();
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Skill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setSearchResults(null);
      return;
    }
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const results = await aceApi.skills.search(q);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => window.clearTimeout(handle);
  }, [search]);

  const { installed, recommended } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (s: Skill) =>
      !q ||
      s.id.toLowerCase().includes(q) ||
      s.displayName.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q);
    const installed = catalog.filter((s) => s.installed && matches(s));
    const recommended = catalog.filter((s) => !s.installed && matches(s));
    return { installed, recommended };
  }, [catalog, search]);

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search skills or skills.sh..."
            className="h-9 pl-9 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {searching && (
            <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Skill
        </Button>
      </div>

      <Section
        title="Installed"
        items={installed}
        emptyHint={catalog.length === 0 ? null : undefined}
        onSelect={setSelected}
      />

      <Section
        title={search ? 'Catalog' : 'Recommended'}
        items={recommended}
        emptyHint={catalog.length === 0 ? 'Loading catalog…' : 'No skills match your search.'}
        onSelect={setSelected}
      />

      {searchResults && searchResults.length > 0 && (
        <Section
          title="From skills.sh"
          items={searchResults}
          onSelect={setSelected}
        />
      )}

      {selected && (
        <SkillDetailModal
          skill={selected}
          onClose={() => setSelected(null)}
        />
      )}
      {showCreate && <CreateSkillDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function Section({
  title,
  items,
  emptyHint,
  onSelect,
}: {
  title: string;
  items: Skill[];
  emptyHint?: string | null;
  onSelect: (skill: Skill) => void;
}) {
  if (items.length === 0 && emptyHint === undefined) return null;
  return (
    <div className="mb-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {items.length === 0 ? (
        emptyHint ? (
          <p className="text-xs text-muted-foreground">{emptyHint}</p>
        ) : null
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((skill) => (
            <SkillCard key={`${skill.source}:${skill.id}`} skill={skill} onClick={() => onSelect(skill)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({ skill, onClick }: { skill: Skill; onClick: () => void }) {
  const subtitle = skill.description || skill.id;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/card relative flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-left transition-all hover:-translate-y-[1px] hover:border-white/20 hover:bg-white/[0.06] hover:shadow-[0_10px_30px_hsl(0_0%_0%/0.35)]"
    >
      <SkillIcon skill={skill} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {skill.displayName}
          </span>
          {skill.installed && (
            <Check className="h-3 w-3 shrink-0 text-emerald-400" />
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          <span className="text-muted-foreground/70">
            {SOURCE_LABEL[skill.source]}
          </span>
          {subtitle && <span className="mx-1.5 text-muted-foreground/40">·</span>}
          {subtitle}
        </p>
      </div>
    </button>
  );
}

function processSkillSvg(raw: string, preserveColors: boolean): string {
  let svg = raw.replace(/\bwidth="[^"]*"/g, '').replace(/\bheight="[^"]*"/g, '');
  if (!preserveColors) {
    svg = svg.replace('<svg ', '<svg fill="#ffffff" ');
  }
  return svg.replace('<svg ', '<svg class="h-full w-full" ');
}

function SkillIcon({ skill }: { skill: Skill }) {
  const def = resolveSkillIcon(skill.id, skill.source);
  const containerClass =
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.05]';

  if (def) {
    return (
      <div
        className={cn(containerClass, 'p-2')}
        dangerouslySetInnerHTML={{ __html: processSkillSvg(def.data, def.preserveColors ?? false) }}
      />
    );
  }
  if (skill.iconUrl) {
    const isAvatar = skill.iconUrl.includes('github.com/') && skill.iconUrl.includes('.png');
    return (
      <div className={cn(containerClass, 'overflow-hidden p-1')}>
        <img
          src={skill.iconUrl}
          alt=""
          loading="lazy"
          className={cn('h-full w-full rounded-md object-contain', !isAvatar && 'invert')}
        />
      </div>
    );
  }
  const letter = skill.displayName.charAt(0).toUpperCase() || '?';
  return (
    <div className={cn(containerClass, 'text-sm font-semibold text-foreground/70')}>
      {letter}
    </div>
  );
}

function SkillDetailModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const [detail, setDetail] = useState<Skill>(skill);
  const [loading, setLoading] = useState(!skill.skillMdContent);
  const [working, setWorking] = useState<'install' | 'uninstall' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (skill.skillMdContent) return;
    setLoading(true);
    aceApi.skills
      .getDetail(
        skill.id,
        skill.owner && skill.repo ? { owner: skill.owner, repo: skill.repo } : undefined
      )
      .then((fresh) => {
        if (!alive || !fresh) return;
        setDetail(fresh);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [skill.id, skill.owner, skill.repo, skill.skillMdContent]);

  const handleInstall = async () => {
    setWorking('install');
    setError(null);
    try {
      await aceApi.skills.install(
        skill.id,
        skill.owner && skill.repo ? { owner: skill.owner, repo: skill.repo } : undefined
      );
      await loadSkillCatalog();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  };

  const handleUninstall = async () => {
    setWorking('uninstall');
    setError(null);
    try {
      await aceApi.skills.uninstall(skill.id);
      await loadSkillCatalog();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  };

  const body = detail.skillMdContent ?? '';
  const markdown = body.replace(/^---[\s\S]*?---\r?\n?/, '');

  return (
    <div
      className="glass-overlay fixed inset-0 z-[140] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="glass-surface flex h-full max-h-[min(720px,85vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-white/[0.06] px-6 py-4">
          <SkillIcon skill={detail} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-base font-semibold">
                {detail.displayName}
              </h2>
              <Badge variant="muted" className="shrink-0 text-micro">
                {SOURCE_LABEL[detail.source]}
              </Badge>
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {detail.description || detail.id}
            </p>
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

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading SKILL.md…
            </div>
          ) : markdown ? (
            <div className="prose prose-invert prose-sm max-w-none prose-pre:text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{markdown}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No SKILL.md content available.
            </p>
          )}

          {detail.defaultPrompt && (
            <div className="mt-4 rounded-lg border border-white/[0.08] bg-black/30 p-3">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Example prompt
              </p>
              <p className="text-xs text-foreground/80">{detail.defaultPrompt}</p>
            </div>
          )}
          {error && (
            <p className="mt-3 text-[11px] text-red-300/85">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-6 py-3">
          {detail.sourceUrl ? (
            <a
              href={detail.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Source
            </a>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {detail.installed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUninstall}
                disabled={working !== null}
              >
                {working === 'uninstall' ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 h-3 w-3" />
                )}
                Uninstall
              </Button>
            ) : (
              <Button size="sm" onClick={handleInstall} disabled={working !== null}>
                {working === 'install' ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Download className="mr-1.5 h-3 w-3" />
                )}
                Install
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateSkillDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => firstInputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Name is required');
    if (!isValidSkillName(trimmed)) {
      return setError('Use lowercase letters, digits, and hyphens (1-64 chars).');
    }
    setSaving(true);
    setError(null);
    try {
      await aceApi.skills.create(trimmed, description.trim(), content);
      await loadSkillCatalog();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="glass-overlay fixed inset-0 z-[150] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface flex w-full max-w-md flex-col gap-4 rounded-2xl p-6"
      >
        <div>
          <h2 className="font-display text-base font-semibold">New skill</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Stored under <code className="text-[10px]">~/.agentskills/</code> and symlinked
            into each installed agent.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Name</label>
          <Input
            ref={firstInputRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder="my-skill"
            className="h-9 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short summary shown in the catalog"
            className="h-9 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            SKILL.md body (optional)
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={5}
            className="rounded-md border border-border bg-background/40 p-2 font-mono text-[12px] text-foreground/90 focus:border-foreground/40 focus:outline-none"
            placeholder="# Instructions…"
          />
        </div>
        {error && <p className="text-[11px] text-red-300/85">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Create
          </Button>
        </div>
      </form>
    </div>
  );
}
