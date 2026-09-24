# Trippy - working agreements

Collaborative, internationally-aware group trip planner.
Repo: `github.com/NickTheTurtle/trippy` (private). npm workspaces, ESM, TypeScript.

The full spec and the _rationale_ behind non-obvious decisions live in **`docs/DESIGN.md`**.
Read the relevant section before changing behavior.

## Layout

| Workspace         | Package          | Role                                                                         |
| ----------------- | ---------------- | ---------------------------------------------------------------------------- |
| `apps/web`        | `@trippy/web`    | **React on :5174 - the live app.**                                           |
| `apps/mobile`     | `@trippy/mobile` | Expo / React Native client, now in scope for native parity work              |
| `apps/api`        | `@trippy/api`    | Hono JSON API on :5175 (`tsx watch`)                                         |
| `packages/server` | `@trippy/server` | SQLite persistence + integrations; owns the schema and `data/app.db`         |
| `packages/core`   | `@trippy/core`   | Pure domain logic - no I/O, browser-safe                                     |
| `packages/copy`   | `@trippy/copy`   | Shared UI copy strings; `apps/web/src/copy.ts` re-exports them. Owner-edited |

The SvelteKit -> React port is **complete** and the SvelteKit app has been deleted.
`apps/web` is the only client.

## Standing instructions

- **The calendar page is under active redesign** - the owner is reworking it, so
  changes there are expected. (This reverses an earlier freeze.)
- **Mobile web is in scope**: `apps/web` must work down to 390px. The native
  client (`apps/mobile`, Expo / React Native) is also in scope for the parity port.

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

## Landing changes

- By default, humans and agents land work on `main` through a pull request, not a direct push.
- Use a short descriptive branch name. This repo has no project-specific branch prefix beyond
  Dependabot's generated branches; use `topic/short-description` for human or agent work unless
  the owner gives another name.
- Do not merge until both required checks are green: `Typecheck, unit tests, build, format` and
  `End-to-end (Playwright)`.
- Branch protection intentionally leaves `enforce_admins` false so an admin direct push to `main`
  remains possible in an emergency. Treat that as an exception to call out to the owner, not a
  routine shortcut.
- Agents never merge a PR without the owner explicitly asking. Open the PR, report status, and let
  the owner decide when to merge.

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
- This repo's agents are the seven in `.github/agents/`: Trippy Lead (coordinator and default
  entry point), Trippy Domain, Trippy API, Trippy UI, Trippy Mobile, Trippy Verify, and Trippy Review.

## Concurrency

More than one Copilot CLI session may be editing this tree at once. Never `git stash`,
`git reset`, or `git checkout --` a file you did not write; an unexpected edit is far more
likely to be another session's in-flight work than a mistake.

## Commands

```
npm run check          # typecheck all workspaces
npm run check -w @trippy/web
npm run check -w @trippy/mobile
npm run build          # build all workspaces
npm run format:check   # prettier, apps/web sources
```

For mobile changes, keep the live dev servers on :5174 and :5175 untouched. Use a throwaway API on an isolated port, for example 5191 with `TRIPPY_DB` pointing at a fresh temporary database and `TRIPPY_OFFLINE_PROVIDERS=1`, then run the Expo web preview from `apps/mobile` on another isolated port such as 8091 with `EXPO_PUBLIC_API_URL` pointing at that throwaway API. Exercise it in a real browser at a phone viewport.

## Agents

`.github/agents/` defines a delegation crew: **Trippy Lead** (coordinator) routes to
**Trippy Domain**, **Trippy API**, **Trippy UI**, **Trippy Mobile**, **Trippy Verify**, and **Trippy Review**.
Start with `/agent Trippy Lead` for anything spanning more than one workspace.
