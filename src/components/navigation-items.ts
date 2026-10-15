import { Home, Plug, Wifi, Repeat, Radar, Gauge, BookOpen } from 'lucide-react';
import type { View } from '../store';
import { GithubGlyph } from './ui/github-glyph';

// The global section switcher entries. Extracted from WorkspaceRail so the slim
// NavRail (icon-only) reads from one shared list. Order is load-bearing:
// Home … GitHub. The Operations hub was retired; its kept features are now their
// own top-level surfaces — Intel, Monitor, and Knowledge. Board + Todos stay
// reachable from Home/Today deep-links rather than as their own rail pills. The
// mobile MobileShell nav array is kept inline and is intentionally NOT sourced
// from here.
export const NAV_ITEMS: { id: View; icon: typeof Home; label: string }[] = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'plugins', icon: Plug, label: 'Plugins' },
  { id: 'remote', icon: Wifi, label: 'Remote' },
  // 'Agents' (hermes) nav tab archived; the view is still reachable via Cmd+K.
  // Teams retired: the embed is resident, reachable from the launcher on every
  // route, so full canvas is a host mode rather than a destination.
  // Loops — first-class section (composition over the run-ledger spine).
  { id: 'loops', icon: Repeat, label: 'Loops' },
  { id: 'intel', icon: Radar, label: 'Intel' },
  { id: 'monitor', icon: Gauge, label: 'Monitor' },
  { id: 'knowledge', icon: BookOpen, label: 'Knowledge' },
  { id: 'github', icon: GithubGlyph, label: 'GitHub' },
];
