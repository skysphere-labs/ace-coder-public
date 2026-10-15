import { useState } from 'react';
import { ArrowUpRight, Check, Copy, Play } from 'lucide-react';
import { Button } from './ui/button';
import { agentMeta } from '../lib/agent-style';

interface AgentRuntimeBannerProps {
  agent: string;
  installCommand?: string | null;
  mode?: 'missing' | 'start_failed';
  details?: string | null;
  onRunInstall?: (command: string) => void;
}

const HELP_URLS: Record<string, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code',
  codex: 'https://github.com/openai/codex',
  gemini: 'https://github.com/google-gemini/gemini-cli',
};

const INSTALL_COMMANDS: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  cursor: 'curl -fsSL https://cursor.com/install.sh | bash',
  amp: 'npm install -g @sourcegraph/amp',
};

export function AgentRuntimeBanner({
  agent,
  installCommand,
  mode = 'missing',
  details,
  onRunInstall,
}: AgentRuntimeBannerProps) {
  const meta = agentMeta[agent];
  const helpUrl = HELP_URLS[agent] ?? null;
  const baseLabel = meta?.label || 'this agent';
  const command = installCommand === undefined || installCommand === null
    ? INSTALL_COMMANDS[agent] ?? null
    : installCommand;
  const showInstall = mode === 'missing';
  const showDetails = mode === 'start_failed' && Boolean(details?.trim());

  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const handleRunInstall = () => {
    if (command && onRunInstall) onRunInstall(command);
  };

  return (
    <div className="rounded-md border border-border bg-muted p-3 text-sm text-foreground dark:border-border dark:bg-background dark:text-foreground">
      <div className="space-y-2">
        <div className="text-foreground" aria-label={`${baseLabel} status`}>
          <span className="font-normal">
            {helpUrl ? (
              <a
                href={helpUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-foreground hover:text-foreground/80"
              >
                {baseLabel}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : (
              baseLabel
            )}{' '}
            {mode === 'start_failed' ? "couldn't start." : "isn't installed."}
          </span>{' '}
          {showInstall ? (
            <span className="font-normal text-foreground">Run this in the terminal to use it:</span>
          ) : null}
        </div>

        {showDetails ? (
          <div className="text-foreground">
            <span className="font-medium">Error:</span> {details}
          </div>
        ) : null}

        {showInstall && command ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="inline-flex h-7 items-center rounded bg-muted px-2 font-mono text-xs leading-none">
              {command}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              className="text-muted-foreground"
              aria-label="Copy install command"
              title={copied ? 'Copied' : 'Copy command'}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            {onRunInstall ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleRunInstall}
                className="text-muted-foreground"
                aria-label="Run in terminal"
                title="Run in terminal"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        ) : showInstall ? (
          <div className="text-foreground">Install the CLI to use it.</div>
        ) : null}
      </div>
    </div>
  );
}
