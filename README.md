# Trippy

[![CI](https://github.com/NickTheTurtle/trippy/actions/workflows/ci.yml/badge.svg)](https://github.com/NickTheTurtle/trippy/actions/workflows/ci.yml)

Collaborative, internationally-aware group trip planner. npm workspaces, ESM, TypeScript.

- Working agreements and architecture: see [`AGENTS.md`](AGENTS.md) and [`docs/DESIGN.md`](docs/DESIGN.md).
- Deployment (manual, by design): see [`deploy/README.md`](deploy/README.md).

## Common commands

```
npm run check          # typecheck all workspaces
npm run test           # unit suite (vitest)
npm run build          # build all workspaces
npm run format:check   # prettier, apps/web sources
npm run test:e2e       # Playwright end-to-end suite
```

CI runs the typecheck, unit suite, build, and format check on every pull request
and on every push to `main`, then the Playwright end-to-end suite. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).
