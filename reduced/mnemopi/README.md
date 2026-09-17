# mnemopi-reduced

Educational, reduced copy of [`packages/mnemopi`](../../packages/mnemopi) (the local SQLite
memory engine for Oh My Pi agents). Not production code — it exists so the main workflow can be
read end-to-end in ~6.7k lines of source instead of ~20k.

## The main workflow

```
remember ──▶ working_memory (SQLite row + FTS5 index + optional vector)
                │  TTL/overflow trim (IMPORTED rows are durable)
                ▼
recall ──────▶ hybrid scoring over working + episodic + facts tiers
                │  FTS5 rank · dense cosine (memory_embeddings JSON) · lexical
                │  groups · importance · recency/temporal decay (Weibull-like)
                │  veracity + tier weights · MMR diversification · truncation
                ▼
sleep ───────▶ claim rows older than TTL/2, group by source, compress each
                group into one episodic row (AAAK text compression), log,
                then tier-degrade old episodes (tier1→2→3)
```


## Edge-case policy

Second-pass rule: the reduced src carries **no defensive armor**. All best-effort
`try/catch` swallows, schema-existence probes (`tableExists` guards), savepoint
rollback loops, tx-depth re-entrancy tracking, fetch retries, input-size caps,
LRU eviction, and "never blocks the caller" wrappers were removed — errors fail
fast and bubble to the caller. The only remaining `try` blocks are load-bearing
semantics, each pinned by a kept test:

| Location | Why it stays |
|---|---|
| `db.ts` / `veracity-consolidation.ts` transaction helpers | ROLLBACK-and-rethrow on failure (correctness, not swallowing); nested calls join the open transaction via `db.inTransaction` |
| `embeddings.ts` provider call | a throwing provider degrades to `null` (test: "returns null instead of throwing when the provider fails") |
| `embeddings.ts` local-model load | transient init failure → `null`, promise reset → retry succeeds (test: "retries local model initialization after a transient failure") |
| `cost-log.ts` | `try/finally` close-only (resource cleanup, no swallowing) |

Supporting cast: `temporal-parser` (NL date extraction feeding temporal boost), `query-intent` +
`synonyms` (query rewriting), `mmr` (diversity), `aaak` (sleep compression), `episodic-graph`
(gists + graph_edges for consolidated memories), `veracity-consolidation` (fact dedup/conflicts),
`embeddings` (provider seam: injected test provider, OpenAI-compatible endpoint, local-model hook).

## Layout & mapping

| Reduced file | Real source | Notes |
|---|---|---|
| `src/db.ts` | `packages/mnemopi/src/db.ts` | Dropped page-size detection (`getconf`), extension plumbing kept minimal |
| `src/config.ts` | `.../src/config.ts` | Only knobs the reduced modules read; data dir moved to `~/.omp/reduced-mnemopi/data` so runs never touch real data |
| `src/util/ids.ts` | `.../src/util/ids.ts` | Verbatim (16-char sha256 content ids) |
| `src/util/regex.ts` | `.../src/util/regex.ts` | Verbatim (tokenization, stopwords, synonyms, CJK) |
| `src/util/datetime.ts` | `.../src/util/datetime.ts` | Minimal ISO parse helpers |
| `src/core/beam/schema.ts` | `.../src/core/beam/schema.ts` | Fresh-create DDL only — no `addColumnIfMissing` migrations; dropped memoria_timelines/instructions/preferences/kg, memory_validations, triples |
| `src/core/beam/types.ts` | `.../src/core/beam/types.ts` | Trimmed to used types |
| `src/core/beam/helpers.ts` | `.../src/core/beam/helpers.ts` | Dropped sqlite-vec paths (`vecInsert`/`vecSearch`), background embedding scheduling, binary-vector re-exports |
| `src/core/beam/store.ts` | `.../src/core/beam/store.ts` | Dropped embedding scheduling, LLM fact extraction, sqlite-vec import, embedding-model reconciliation; kept dedup, trim cascade, annotations, proactive linking, scratchpad, export/import |
| `src/core/beam/recall.ts` | `.../src/core/beam/recall.ts` | Biggest file, ported nearly fully: FTS + dense + lexical-group scoring, temporal, MMR, fact fusion, truncation. Dropped polyphonic voices, query cache, diagnostics |
| `src/core/beam/consolidate.ts` | `.../src/core/beam/consolidate.ts` | Sleep/claim/AAAK/degrade/contaminated/stats kept; dropped `extractAndStoreFacts`, `memoriaRetrieve`, `getMemoriaStats`, `health` |
| `src/core/beam/index.ts` | `.../src/core/beam/index.ts` | BeamMemory hub; dropped health/reconcile/flushExtractions/memoria methods |
| `src/core/memory.ts` | `.../src/core/memory.ts` | Mnemopi facade + module-level singleton + banks; dropped LLM runtime resolution, embedding reconciliation |
| `src/core/beam/../../core/embeddings.ts` | `.../src/core/embeddings.ts` | Provider seam kept (test provider injection, OpenAI-compatible HTTP with omp headers, local-model initializer hook with retry); fastembed/ONNX, fetch retry, cache quarantine dropped |
| `src/core/runtime-options.ts` | `.../src/core/runtime-options.ts` | AsyncLocalStorage scope only |
| `src/core/annotations.ts` | `.../src/core/annotations.ts` | Minimal add/query |
| `src/core/banks.ts` | `.../src/core/banks.ts` | `listBanks` + `getBankDbPath` only |
| `src/core/temporal-parser.ts` | `.../src/core/temporal-parser.ts` | Faithful port |
| `src/core/weibull.ts` `mmr.ts` `query-intent.ts` `synonyms.ts` | same | Faithful; mmr dropped the native kernel path (TS fallback only) |
| `src/core/aaak.ts` | `.../src/core/aaak.ts` | Verbatim (sleep compression) |
| `src/core/vector-math.ts` | `.../src/core/vector-math.ts` | Verbatim cosine |
| `src/core/vector-index.ts` | `.../src/core/vector-index.ts` | Pure-TS scoring replacing the `pi-natives` kernel |
| `src/core/episodic-graph.ts` | `.../src/core/episodic-graph.ts` | gists/graph_edges schema, gist extraction, ctx + lexical linking; dropped entity/fact extraction and traversal |
| `src/core/veracity-consolidation.ts` | `.../src/core/veracity-consolidation.ts` | Kept dedup/Bayesian/conflict/close semantics |
| `src/core/chat-normalize.ts` `cost-log.ts` `token-counter.ts` | same | Faithful ports (used by `text-utilities.test.ts`) |

**Dropped entirely**: MCP server + tools, CLI, diagnose, dr/recovery, plugins, shmr,
polyphonic-recall, typed-memory/AAAK typed store, streaming, query-cache, orchestrator,
local-llm/fastembed runtime, extraction heuristics, cost/telemetry logging, banks create/delete/rename.

## Tests

Copied from `packages/mnemopi/test/` with only import paths rewritten (`../src/...`):

`beam-store` (11), `beam-recall-unit` (20), `beam-consolidate-unit` (10 of 18 — the 8 regex
fact-extraction tests are pruned with the feature), `beam-helpers` (8), `beam-index`,
`temporal-parser` (21), `temporal-recall`, `weibull-mmr-intent` (19), `vector-index` (2),
`configurable-scoring` (6), `veracity-consolidation`, `memory-facade` (6), `foundation`,
`optional-embeddings` (8, `getFastembedCacheDir` swapped for the reduced `defaultCacheDir`),
`text-utilities` (5) — **128 tests total**, same assertions as the originals.

## Run

```sh
cd reduced/mnemopi
bun test
```

Typecheck (repo-wide `bun check` cannot see this folder; oxlint ignores `reduced/**`):

```sh
cd reduced/mnemopi
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
```
