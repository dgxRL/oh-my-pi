# stats-reduced

Educational, reduced copy of [`packages/stats`](../../packages/stats) — the local
usage-observability pipeline (`omp stats`). **8,134 lines of source → 1,946**;
53 tests carried from the original suite (adapted where features were dropped).

## The main workflow

```
~/.omp/agent/sessions/**/*.jsonl   (session transcripts)
        │  syncAllSessions — cross-process file lock, per-file cursor
        │  parseSessionFile: resume via (dev,ino,birthtime,size,mtime,checkpoint)
        ▼
   messages / tool_calls  (SQLite, WAL)
        │  flat-rate cost: $3.00 per 1M tokens for ANY model
        ▼
   getDashboardStats / getToolDashboardStats  (SQL aggregates)
        ▼
   Bun.serve JSON APIs (/api/stats*, /api/sync) + CLI summary
```

- **Write path** (`parser.ts`): lenient JSONL scan (malformed lines skipped —
  tested), assistant/model-usage extraction with malformed-entry coercion,
  tool-call + result-link extraction, tool-name sanitization, agent-type
  classification by transcript path.
- **Storage** (`db.ts`): idempotent schema (+ `agent_type` backfill migration),
  fork-lineage dedup (`WHERE NOT EXISTS` on entry identity — first write wins),
  incremental cursors (`file_offsets` + tail checkpoint), reconcile loop (a
  reset that drops rows replays every file so fork copies re-resolve).
- **Read path** (`db.ts` queries + `aggregator.ts`): overall / by-model /
  by-folder / by-agent-type summaries, hourly time series, tool stats with
  turn-usage splitting (`total_tokens / calls_in_turn` shared per call),
  range filtering (1h/24h/7d/30d/90d/all, unknown → 24h).
- **Serving** (`server.ts`): `handleApi(request)` is the whole API surface
  (tests drive it without a socket); `Bun.serve` delegates to it.

## What was dropped vs the original (and why)

| Dropped | Reason |
|---|---|
| Catalog rate cards, `cost_unpriced`, scheduled-card pricing, cost backfills | "No specific provider": one flat rate (`FLAT_RATE_PER_1M = 3.0`); a recorded session cost still wins |
| Service tiers + premium requests (`classifyModel`, `service_tier_change`) | Subscription-specific provider logic |
| Provider stats, `usage-windows.ts` (fleet token burn, snapshots) | Provider integrations |
| `trace.ts` + trace/fork-dedup view tests | Separate trace-view feature |
| `gain-aggregator.ts`, `user-metrics.ts` (`user_messages` table) | Secondary dashboards |
| Embedded web client (`client/`, `embedded-client*`) + port-conflict takeover | Dashboard UI/deployment plumbing |
| Worker pool fan-out | `syncAllSessions` parses inline; the worker entry + ping smoke test remain |

**Edge-case policy**: same as reduced/mnemopi — no defensive armor; errors fail
fast. The only remaining `try/catch` blocks are tested contracts: malformed
JSONL line skip (parser), worker error-reporting protocol (`sync-worker.ts`),
malformed persisted cursor reconstruction (`db.ts#getFileOffset`), and the
cross-process lock conflict error.

## Files

| File | Lines | Role |
|---|---|---|
| `src/db.ts` | 764 | Schema, ingest, cursors, dashboard queries |
| `src/parser.ts` | 432 | JSONL → typed stats (lenient, incremental) |
| `src/types.ts` | 259 | Shared vocabulary |
| `src/aggregator.ts` | 243 | Lock, sync orchestration, query assembly |
| `src/index.ts` | 132 | CLI: `--sync` / `--json` / dashboard serve |
| `src/server.ts` | 60 | `handleApi` + Bun.serve |
| `src/sync-worker.ts` | 38 | Worker entry + ping protocol |
| `src/paths.ts` | 18 | Env-overridable sessions/db paths |

## Tests

Copied from `packages/stats/test/` with import-path adaptation:
`parser-malformed-entries`, `parser-large-session`, `parser-model-usage`,
`incremental-tail` (tier/premium cases pruned), `tool-stats`, `agent-type`,
`db-cost` (rewritten to the flat-rate contract), `db-range`, `errors-range`,
`stats-cli`, `smoke-worker-darwin` — plus a reduced `helpers/temp-agent.ts`
(isolation via `OMP_SESSIONS_DIR` / `STATS_DB_PATH` env, per-file hooks).

Dropped: `trace-builder`, `fork-dedup` (view), `provider-stats`,
`server-port-conflict`, `user-metrics`, `priority-premium-requests`,
`gain-aggregator`, `behavior-backfill`, `trace-scale`, `sync-serial`,
`client-view-models`, `embedded-client-archive`, `model-color-consistency`,
`errors-route-range`/`overview-token-labels` (React client), the `.tsx` client
tests.

## Run

```sh
cd reduced/stats
bun test
```

Typecheck (folder is outside the repo pipelines):

```sh
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Smoke the CLI against a throwaway database:

```sh
STATS_DB_PATH=/tmp/s.db OMP_SESSIONS_DIR=/tmp/sessions bun src/index.ts --sync
```
