---
name: ace-prompt-frontend-build
description: Type-specific prompt enhancer for FRONTEND / UI / website / landing-page / web-app build goals. Use after ace-prompt-enhancer classifies a request as frontend (taskType ui/frontend/design) and before dispatching a Claude worker. Pins the WHAT that makes UI award-tier — design system, motion discipline, accessibility, a REAL build gate — while leaving layout/composition open. Trigger on "build a website / landing page / web app / dashboard UI", "frontend", "make it look modern/sleek/animated", or any visible-product goal.
metadata:
  type: ace-skill
  tier: prompting
  tags: [ace, prompting, frontend, ui, web, motion, accessibility, claude]
---

# Ace frontend-build prompt enhancer

The domain specialization of `ace-prompt-enhancer` for **visible product** work.
Frontend is where a vague brief produces "generic AI slop" and a tight brief
produces award-tier work — the difference is almost entirely in the WHAT you pin.
This is the brief that drove the proven SkySphere build (atoms→organisms, no
generic purple, deterministic motion, global reduced-motion, green build).

Driver: **Claude** (frontend is judgment + taste — `claude-codex-specialty-router`
hard-routes UI to Claude). Effort: **xhigh + UltraCode** (`/effort ultracode`
prelude); use dynamic-workflow fan-out only for genuinely large multi-page sites.

## Pin the WHAT (frontend contract)
- **Stack** (only if it must be a specific one): framework + styling + animation
  lib + icon set. Otherwise name the constraints ("React + Tailwind, your choice
  of motion lib") and let the worker pick.
- **Design-system discipline**: atoms → molecules → organisms; ONE shared
  primitive set (Button, Card, Section); centralized design tokens (palette,
  spacing, radii, shadows) — never per-component magic values.
- **Anti-generic guardrails** (this is what separates tiers): an explicit,
  intentional palette and a forbidden list ("no generic purple/indigo SaaS
  gradient", "no Inter-on-white default card grid"). A point of view beats a
  component dump.
- **Motion discipline**: centralized easing/variants module; transform/opacity
  only (never animate layout); **deterministic** values (no `Math.random` in
  render); a SINGLE global reduced-motion honor (`<MotionConfig reducedMotion>`),
  not per-component guards.
- **Accessibility floor**: semantic landmarks, skip-to-content, keyboard paths
  (drawer Esc-close, focus management), `aria-*` on interactive/decorative nodes,
  visible focus rings, color-contrast intent.
- **Responsive intent**: mobile-first breakpoints named; the hero + nav behavior
  at small widths called out.
- **Content**: real, specific copy (or a content module) — never lorem ipsum.

## Leave OPEN (the worker's taste)
Layout composition, section order, exact color stops, component internals, which
motion pattern per section, file-by-file structure. Give the standard, not the
pixels.

## Acceptance (frontend, each a runnable check)
- `A1` **REAL build is green**: the exact command (`npm run build` / `tsc -b &&
  vite build`) compiles with 0 type errors — the non-negotiable gate.
- `A2` Design system present: shared primitives + central tokens exist (name the
  files), no per-component palette literals.
- `A3` Motion is deterministic + reduced-motion honored globally (grep: no
  `Math.random` in components; one `reducedMotion` config).
- `A4` Accessibility: semantic structure + skip link + keyboard-closable overlays.
- `A5` Anti-generic: the forbidden tokens do NOT appear; the intended palette does.
- `A6` **PR opened** with the URL in the DONE trailer (every agent produces a PR).

## Driver codewords (Claude)
`/effort ultracode` (prelude) · "production-grade, senior-frontend bar" ·
"think about the design language before writing components" · "minimal-diff,
match existing conventions if a codebase exists" · for big sites only:
"dynamic-workflow fan-out: one internal agent per page/section, cap 3-5, merge
before DONE". End with `DONE: <summary + PR URL>` or `BLOCKED: <reason>`.

## Hard rules
- The REAL build gate (A1) is mandatory — a screenshot is not acceptance.
- Anti-generic guardrails are required, not optional — omission yields slop.
- Reference skill ids (`ace-agent-pack-ui-designer`, `steipete-frontend-design`)
  — never inline their bodies.
- Never prescribe the layout pixel-by-pixel; pin the standard, free the taste.

## References
- `ace-prompt-enhancer` — the general enhancer this specializes.
- `ace-agent-pack-ui-designer`, `steipete-frontend-design` — the mounted UI packs.
- `claude-codex-specialty-router` — why UI routes to Claude at xhigh/ultracode.
