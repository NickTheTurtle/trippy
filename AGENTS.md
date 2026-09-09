# Trippy - working agreements

Collaborative, internationally-aware group trip planner.
Repo: `github.com/NickTheTurtle/trippy` (private). npm workspaces, ESM, TypeScript.

The full spec and the *rationale* behind non-obvious decisions live in **`docs/DESIGN.md`**.
Read the relevant section before changing behavior.

## Layout

| Workspace | Package | Role |
|---|---|---|
| `apps/web` | `@trippy/web` | **React on :5174 - the live app.** All new UI work goes here |
| `apps/api` | `@trippy/api` | Hono JSON API on :5175 (`tsx watch`) |
| `packages/server` | `@trippy/server` | SQLite persistence + integrations; owns `app.db` |
| `packages/core` | `@trippy/core` | Pure domain logic - no I/O, browser-safe |

The SvelteKit -> React port is **complete** and the SvelteKit app has been deleted.
`apps/web` is the only client.

## Standing instructions

- **Do not invest further in the calendar page** - a redesign is planned.
- **Mobile is not in scope yet.**

## Working method

- **Work from the code, not from memory.** Re-read a file before editing it.
- **Verify in a real browser. Never trust a type-check alone.** A green `tsc` is necessary,
  not sufficient.
- **Run each browser suite twice** - first-run flakiness is common and hides real failures.
- **Record the rationale** for every non-obvious decision in `docs/DESIGN.md`, not just the
  decision.
- Browser probes are throwaway `zz-*.cjs` scripts in the repo root, run with `node`.
  They are **not gitignored**.

## Before every commit

1. Delete your `zz-*` scratch files.
2. Clean `ZZ*` demo rows out of the database.
3. **Grep for em dashes** and remove them.
4. Stage deliberately - `git add -A` sweeps up other people's in-flight work.

## Hard rules

- `data/app.db` is **real data**. Never delete, reset, or rebuild it. Its `-shm`
  and `-wal` siblings live beside it; use `TRIPPY_DB` for throwaway test databases.
  Schema changes are **additive migrations** in `db.ts`, with defaults for existing rows.
- `.env` holds **live paid API keys** (places / geocode / routing / fx). Never print it,
  read it back into a transcript, or commit it. New keys go into `.env.example` by name only.
- External providers cost money and rate-limit. Respect the `cache.ts` layer; never add an
  uncached provider call inside a loop.
- **Dev servers are already running** (:5174 web, :5175 api) with
  watch/HMR. Never kill, restart, or start a competing server, and never bind those ports.
- `packages/core` stays pure - no SQLite, no `fetch`, no `process.env`. It must run
  in a browser and stay portable to a future Expo / React Native client.

## Scope

- This repo is self-contained: everything an agent needs is in this tree.
- This machine also carries global agents and skills belonging to unrelated codebases.
  None of them applies here. Never load one, and never carry a convention from another
  codebase into this one - notably, do not use a global `git` skill, which may assume a
  build environment this repo does not have. This repo has no git hooks.
- This repo's agents are the six in `.github/agents/`: Trippy Lead (coordinator and default
  entry point), Trippy Domain, Trippy API, Trippy UI, Trippy Verify, and Trippy Review.

## Concurrency

More than one Copilot CLI session may be editing this tree at once. Never `git stash`,
`git reset`, or `git checkout --` a file you did not write; an unexpected edit is far more
likely to be another session's in-flight work than a mistake.

## Commands

```
npm run check          # typecheck all workspaces
npm run check -w @trippy/web
npm run build          # build all workspaces
npm run format:check   # prettier, apps/web sources
```

## Agents

`.github/agents/` defines a delegation crew: **Trippy Lead** (coordinator) routes to
**Trippy Domain**, **Trippy API**, **Trippy UI**, and **Trippy Verify**.
Start with `/agent Trippy Lead` for anything spanning more than one workspace.
