# Trippy E2E harness

This workspace contains Playwright infrastructure for smoke coverage only. DOM-level user journey specs are intentionally left out while the web UI is being rewritten.

## Run

Run:

```powershell
npm run test:e2e
```

Playwright starts its own stack:

- web: `http://localhost:5184`
- api: `http://localhost:5185`

It does not start, restart, or reuse the regular dev servers on `5174` or `5175`. The runner creates a unique throwaway SQLite database under `tests-e2e/.tmp/` for each run and passes it to the API with `TRIPPY_DB`.

`E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_WEB_URL`, `E2E_API_URL`, and `E2E_TRIPPY_DB` can override the defaults.

## Teardown limitation

There is no `DELETE /trips/:tripId` endpoint. The fixture creates users and trips through the API, then removes the created user row directly from the throwaway SQLite database so foreign keys cascade the related trip data. The fixture refuses to touch `data/app.db` or `packages/server/src/app.db`.
