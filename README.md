# Food Service Management Suite

A modular food-service management suite serving three client lines from one central warehouse:
**Schools (NSLP), Vending & micromarkets, and Private clients.** Built by a team of
specialized Claude Code agents coordinated by a manager session.

## What's in here

```
.
├─ CLAUDE.md                     # Project constitution — read by every agent
├─ docs/
│  └─ shared-core-spec.md        # The shared-core design spec (the build target)
└─ .claude/
   ├─ settings.json              # Permission rules (supervised autonomy)
   └─ agents/                    # The specialist team
      ├─ brainstormer.md
      ├─ backend-developer.md
      ├─ frontend-developer.md
      ├─ security-engineer.md
      ├─ e2e-smoke-tester.md
      └─ code-reviewer.md
```

## Getting started with Claude Code

1. Install: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to sign in.
2. From this folder, run `claude`. It reads `CLAUDE.md` and the agents in `.claude/agents/` automatically.
3. Verify the team loaded with `/agents` — all six should appear.
4. Give the manager its first task (see CLAUDE.md → Team workflow contract).

## Current phase

Building the **shared core** only (see `docs/shared-core-spec.md`). Client-line modules
(Schools/NSLP, Vending, Private) layer on after the core is solid.

## Prerequisite for the scaffold step

The data layer targets Google Sheets in v0. Before the first build step, set up a Google Cloud
service account with Sheets API access and an empty spreadsheet to point at. Keep the
service-account key out of this repo — it belongs only in `.env.local` (git-ignored).
