import { cn } from '../lib/utils';
import { getAgentAccentColor, agentMeta } from '../lib/agent-style';
import claudePng from '../assets/images/claude.png';
import codexSvg from '../assets/images/openai.svg?raw';
import geminiPng from '../assets/images/gemini.png';
import cursorSvg from '../assets/images/cursor.svg?raw';
import copilotSvg from '../assets/images/gh-copilot.svg?raw';
import ampPng from '../assets/images/ampcode.png';
import goosePng from '../assets/images/goose.png';
import clinePng from '../assets/images/cline.png';
import kiroPng from '../assets/images/kiro.png';
import forgeSvg from '../assets/images/forge.svg?raw';
import qwenPng from '../assets/images/qwen.png';
import droidSvg from '../assets/images/droid.svg?raw';
import opencodePng from '../assets/images/opencode.png';
import hermesJpg from '../assets/images/hermesagent.jpg';
import charmPng from '../assets/images/charm.png';
import auggieSvg from '../assets/images/Auggie.svg?raw';
import kimiPng from '../assets/images/kimi.png';
import kilocodePng from '../assets/images/kilocode.png';
import rovoPng from '../assets/images/atlassian.png';
import continuePng from '../assets/images/continue.png';
import codebuffPng from '../assets/images/codebuff.png';
import mistralPng from '../assets/images/mistral.png';
import piPng from '../assets/images/pi.png';
import autohandSvg from '../assets/images/autohand.svg?raw';

type Asset =
  | { kind: 'svg'; raw: string }
  | { kind: 'png'; url: string };

const ASSETS: Record<string, Asset> = {
  claude:   { kind: 'png', url: claudePng },
  codex:    { kind: 'svg', raw: codexSvg },
  cursor:   { kind: 'svg', raw: cursorSvg },
  gemini:   { kind: 'png', url: geminiPng },
  qwen:     { kind: 'png', url: qwenPng },
  droid:    { kind: 'svg', raw: droidSvg },
  amp:      { kind: 'png', url: ampPng },
  opencode: { kind: 'png', url: opencodePng },
  hermes:   { kind: 'png', url: hermesJpg },
  copilot:  { kind: 'svg', raw: copilotSvg },
  charm:    { kind: 'png', url: charmPng },
  auggie:   { kind: 'svg', raw: auggieSvg },
  goose:    { kind: 'png', url: goosePng },
  kimi:     { kind: 'png', url: kimiPng },
  kilocode: { kind: 'png', url: kilocodePng },
  kiro:     { kind: 'png', url: kiroPng },
  rovo:     { kind: 'png', url: rovoPng },
  cline:    { kind: 'png', url: clinePng },
  continue: { kind: 'png', url: continuePng },
  codebuff: { kind: 'png', url: codebuffPng },
  mistral:  { kind: 'png', url: mistralPng },
  pi:       { kind: 'png', url: piPng },
  autohand: { kind: 'svg', raw: autohandSvg },
  forge:    { kind: 'svg', raw: forgeSvg },
};

function recolor(raw: string) {
  return raw
    .replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"')
    .replace(/stroke="(?!none)[^"]*"/g, 'stroke="currentColor"');
}

interface AgentLogoProps {
  agent: string;
  className?: string;
}

export default function AgentLogo({ agent, className = 'h-4 w-4' }: AgentLogoProps) {
  const asset = ASSETS[agent];
  const label = agentMeta[agent]?.label ?? agent;

  if (asset?.kind === 'svg') {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('inline-flex shrink-0 items-center justify-center text-foreground [&_svg]:h-full [&_svg]:w-full', className)}
        dangerouslySetInnerHTML={{ __html: recolor(asset.raw) }}
      />
    );
  }

  if (asset?.kind === 'png') {
    return (
      <img
        src={asset.url}
        alt={label}
        className={cn('inline-block shrink-0 object-contain', className)}
      />
    );
  }

  const color = getAgentAccentColor(agent);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] text-[8px] font-bold leading-none text-white',
        className
      )}
      style={{ backgroundColor: color }}
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}
