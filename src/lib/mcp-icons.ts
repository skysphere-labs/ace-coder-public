import playwrightSvg from '../assets/images/mcp/playwright.svg?raw';
import supabaseSvg from '../assets/images/mcp/supabase.svg?raw';
import vercelSvg from '../assets/images/mcp/vercel.svg?raw';
import sentrySvg from '../assets/images/mcp/sentry.svg?raw';
import stripeSvg from '../assets/images/mcp/stripe.svg?raw';
import figmaSvg from '../assets/images/mcp/figma.svg?raw';
import linearSvg from '../assets/images/mcp/linear.svg?raw';
import slackSvg from '../assets/images/mcp/slack.svg?raw';
import cloudflareSvg from '../assets/images/mcp/cloudflare.svg?raw';
import netlifySvg from '../assets/images/mcp/netlify.svg?raw';
import chromeDevtoolsSvg from '../assets/images/mcp/chrome_devtools.svg?raw';
import atlassianSvg from '../assets/images/mcp/atlassian.svg?raw';
import notionSvg from '../assets/images/mcp/notion.svg?raw';
import clerkSvg from '../assets/images/mcp/clerk.svg?raw';
import planetscaleSvg from '../assets/images/mcp/planetscale.svg?raw';
import huggingFaceSvg from '../assets/images/mcp/hugging_face.svg?raw';
import posthogSvg from '../assets/images/mcp/posthog.svg?raw';
import graphosSvg from '../assets/images/mcp/graphos.svg?raw';
import sanitySvg from '../assets/images/mcp/sanity.svg?raw';
import asanaSvg from '../assets/images/mcp/asana.svg?raw';
import clickupSvg from '../assets/images/mcp/clickup.svg?raw';
import webflowSvg from '../assets/images/mcp/webflow.svg?raw';
import cloudinarySvg from '../assets/images/mcp/cloudinary.svg?raw';
import wordpressSvg from '../assets/images/mcp/wordpress.svg?raw';
import miroSvg from '../assets/images/mcp/miro.svg?raw';
import intercomSvg from '../assets/images/mcp/intercom.svg?raw';
import wixSvg from '../assets/images/mcp/wix.svg?raw';
import makeSvg from '../assets/images/mcp/make.svg?raw';
import bigquerySvg from '../assets/images/mcp/bigquery.svg?raw';
import awsMarketplaceSvg from '../assets/images/mcp/aws_marketplace.svg?raw';
import microsoftLearnSvg from '../assets/images/mcp/microsoft_learn.svg?raw';
import canvaSvg from '../assets/images/mcp/canva.svg?raw';
import devrevSvg from '../assets/images/mcp/devrev.svg?raw';
import context7Svg from '../assets/images/Context7.svg?raw';

import amplitudePng from '../assets/images/mcp/amplitude.png';
import honeycombPng from '../assets/images/mcp/honeycomb.png';
import exaPng from '../assets/images/mcp/exa.png';
import jamPng from '../assets/images/mcp/jam.png';
import motherduckPng from '../assets/images/mcp/motherduck.png';
import magicPatternsPng from '../assets/images/mcp/magic_patterns.png';
import deepwikiPng from '../assets/images/mcp/deepwiki.png';

interface McpIconDef {
  type: 'svg' | 'png';
  data: string;
  preserveColors?: boolean;
}

const mcpIconMap: Record<string, McpIconDef> = {
  playwright: { type: 'svg', data: playwrightSvg },
  context7: { type: 'svg', data: context7Svg, preserveColors: true },
  supabase: { type: 'svg', data: supabaseSvg },
  vercel: { type: 'svg', data: vercelSvg },
  sentry: { type: 'svg', data: sentrySvg },
  stripe: { type: 'svg', data: stripeSvg },
  figma: { type: 'svg', data: figmaSvg },
  linear: { type: 'svg', data: linearSvg },
  slack: { type: 'svg', data: slackSvg },
  cloudflare: { type: 'svg', data: cloudflareSvg },
  netlify: { type: 'svg', data: netlifySvg },
  chrome_devtools: { type: 'svg', data: chromeDevtoolsSvg },
  atlassian: { type: 'svg', data: atlassianSvg },
  notion: { type: 'svg', data: notionSvg },
  clerk: { type: 'svg', data: clerkSvg },
  planetscale: { type: 'svg', data: planetscaleSvg },
  bigquery: { type: 'svg', data: bigquerySvg },
  hugging_face: { type: 'svg', data: huggingFaceSvg },
  posthog: { type: 'svg', data: posthogSvg },
  honeycomb: { type: 'png', data: honeycombPng },
  graphos: { type: 'svg', data: graphosSvg },
  sanity: { type: 'svg', data: sanitySvg },
  amplitude: { type: 'png', data: amplitudePng },
  asana: { type: 'svg', data: asanaSvg },
  clickup: { type: 'svg', data: clickupSvg },
  microsoft_learn: { type: 'svg', data: microsoftLearnSvg },
  jam: { type: 'png', data: jamPng },
  webflow: { type: 'svg', data: webflowSvg },
  cloudinary: { type: 'svg', data: cloudinarySvg },
  wordpress: { type: 'svg', data: wordpressSvg },
  canva: { type: 'svg', data: canvaSvg },
  miro: { type: 'svg', data: miroSvg },
  intercom: { type: 'svg', data: intercomSvg },
  make: { type: 'svg', data: makeSvg },
  aws_marketplace: { type: 'svg', data: awsMarketplaceSvg },
  motherduck: { type: 'png', data: motherduckPng },
  magic_patterns: { type: 'png', data: magicPatternsPng },
  wix: { type: 'svg', data: wixSvg },
  devrev: { type: 'svg', data: devrevSvg, preserveColors: true },
  exa: { type: 'png', data: exaPng },
  deepwiki: { type: 'png', data: deepwikiPng },
};

export function resolveMcpIcon(key: string | undefined): McpIconDef | undefined {
  if (!key) return undefined;
  return mcpIconMap[key] ?? mcpIconMap[key.toLowerCase().replace(/[\s-]+/g, '_')];
}
