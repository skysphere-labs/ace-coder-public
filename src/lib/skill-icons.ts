import cloudflareSvg from '../assets/images/mcp/cloudflare.svg?raw';
import figmaSvg from '../assets/images/mcp/figma.svg?raw';
import linearSvg from '../assets/images/mcp/linear.svg?raw';
import netlifySvg from '../assets/images/mcp/netlify.svg?raw';
import notionSvg from '../assets/images/mcp/notion.svg?raw';
import playwrightSvg from '../assets/images/mcp/playwright.svg?raw';
import sentrySvg from '../assets/images/mcp/sentry.svg?raw';
import vercelSvg from '../assets/images/mcp/vercel.svg?raw';
import stripeSvg from '../assets/images/mcp/stripe.svg?raw';
import slackSvg from '../assets/images/mcp/slack.svg?raw';

import openaiSvg from '../assets/images/skills/openai.svg?raw';
import anthropicSvg from '../assets/images/skills/anthropic.svg?raw';
import githubSvg from '../assets/images/skills/github.svg?raw';
import jupyterSvg from '../assets/images/skills/jupyter.svg?raw';
import renderSvg from '../assets/images/skills/render.svg?raw';
import swiftSvg from '../assets/images/skills/swift.svg?raw';
import appleSvg from '../assets/images/skills/apple.svg?raw';
import mysqlSvg from '../assets/images/skills/mysql.svg?raw';
import postgresqlSvg from '../assets/images/skills/postgresql.svg?raw';
import reactSvg from '../assets/images/skills/react.svg?raw';
import shadcnSvg from '../assets/images/skills/shadcn.svg?raw';
import resendSvg from '../assets/images/skills/resend.svg?raw';
import bunSvg from '../assets/images/skills/bun.svg?raw';
import xcodeSvg from '../assets/images/skills/xcode.svg?raw';

interface SkillIconDef {
  data: string;
  preserveColors?: boolean;
}

const exact: Record<string, SkillIconDef> = {
  'cloudflare-deploy': { data: cloudflareSvg },
  figma: { data: figmaSvg },
  'figma-implement-design': { data: figmaSvg },
  'gh-address-comments': { data: githubSvg },
  'gh-fix-ci': { data: githubSvg },
  'jupyter-notebook': { data: jupyterSvg },
  linear: { data: linearSvg },
  'netlify-deploy': { data: netlifySvg },
  'notion-knowledge-capture': { data: notionSvg },
  'notion-meeting-intelligence': { data: notionSvg },
  'notion-research-documentation': { data: notionSvg },
  'notion-spec-to-implementation': { data: notionSvg },
  playwright: { data: playwrightSvg },
  'render-deploy': { data: renderSvg },
  sentry: { data: sentrySvg },
  'vercel-deploy': { data: vercelSvg },
  yeet: { data: githubSvg },

  'openai-docs': { data: openaiSvg },
  sora: { data: openaiSvg },
  imagegen: { data: openaiSvg },
  'skill-creator': { data: openaiSvg },
  'skill-installer': { data: openaiSvg },

  cloudflare: { data: cloudflareSvg },
  'durable-objects': { data: cloudflareSvg },
  wrangler: { data: cloudflareSvg },
  'ai-sdk': { data: vercelSvg },
  'vercel-react-best-practices': { data: vercelSvg },
  'gh-issue-fix-flow': { data: githubSvg },
  shadcn: { data: shadcnSvg },
  mysql: { data: mysqlSvg },
  postgres: { data: postgresqlSvg },
  'react-doctor': { data: reactSvg },
  'react-email': { data: reactSvg },
  resend: { data: resendSvg },
  'resend-design-skills': { data: resendSvg },
  'resend-brand': { data: resendSvg },
  elysiajs: { data: bunSvg },
  'frontend-design': { data: anthropicSvg },
  'webapp-testing': { data: anthropicSvg },
  'web-artifacts-builder': { data: anthropicSvg },
  'mcp-builder': { data: anthropicSvg },
  'algorithmic-art': { data: anthropicSvg },
  'canvas-design': { data: anthropicSvg },
  'theme-factory': { data: anthropicSvg },
  'brand-guidelines': { data: anthropicSvg },
  'doc-coauthoring': { data: anthropicSvg },
  'internal-comms': { data: anthropicSvg },
  stripe: { data: stripeSvg },
  slack: { data: slackSvg },
  notion: { data: notionSvg },
  netlify: { data: netlifySvg },
};

const sourceFallback: Record<string, SkillIconDef> = {
  openai: { data: openaiSvg },
  anthropic: { data: anthropicSvg },
};

const keywordRules: Array<{ test: (id: string) => boolean; icon: SkillIconDef }> = [
  { test: (id) => /^swiftui[-_]/.test(id) || id === 'swift-concurrency-expert', icon: { data: swiftSvg } },
  { test: (id) => /\b(ios|xcode)\b/.test(id) || id.startsWith('ios-'), icon: { data: xcodeSvg } },
  { test: (id) => /\b(macos|app-store|appstore)\b/.test(id) || id.startsWith('macos-'), icon: { data: appleSvg } },
  { test: (id) => id.startsWith('gh-') || id.includes('github'), icon: { data: githubSvg } },
  { test: (id) => id.includes('cloudflare') || id.includes('worker'), icon: { data: cloudflareSvg } },
  { test: (id) => id.includes('vercel') || id.includes('nextjs') || id.includes('next-js'), icon: { data: vercelSvg } },
  { test: (id) => id.startsWith('react-') || id.startsWith('react:'), icon: { data: reactSvg } },
  { test: (id) => id.includes('notion'), icon: { data: notionSvg } },
  { test: (id) => id.includes('figma'), icon: { data: figmaSvg } },
  { test: (id) => id.includes('sentry'), icon: { data: sentrySvg } },
  { test: (id) => id.includes('linear'), icon: { data: linearSvg } },
  { test: (id) => id.includes('stripe'), icon: { data: stripeSvg } },
  { test: (id) => id.includes('resend'), icon: { data: resendSvg } },
  { test: (id) => id.includes('postgres') || id.includes('postgresql'), icon: { data: postgresqlSvg } },
  { test: (id) => id.includes('mysql'), icon: { data: mysqlSvg } },
  { test: (id) => id.includes('playwright'), icon: { data: playwrightSvg } },
];

export function resolveSkillIcon(skillId: string, source: string): SkillIconDef | undefined {
  return exact[skillId] ?? keywordRules.find((r) => r.test(skillId))?.icon ?? sourceFallback[source];
}
