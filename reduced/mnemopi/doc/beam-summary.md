# core/beam — code summary

`reduced/mnemopi/src/core/beam/` is the storage + retrieval engine below the
`Mnemopi` facade (see [workflow.md](workflow.md) for the runtime narrative and
the [README](../README.md) for the file-by-file mapping to the real package).
9 files, **4,171 lines**, exercised by the copied test suite (128 tests).

## Files at a glance

| File | Lines | Role |
|---|---|---|
| `recall.ts` | 1,206 | Read path: hybrid candidate collection + scoring + MMR + fact fusion |
| `store.ts` | 870 | Write path: remember/dedup/trim, point reads, scratchpad, export/import |
| `helpers.ts` | 640 | Shared math/text: weights, timestamps, decay, lexical scoring, vectors |
| `consolidate.ts` | 556 | Sleep: claim → group → AAAK-compress → log → tier degrade |
| `index.ts` | 297 | `BeamMemory` hub class wiring everything into methods |
| `types.ts` | 282 | Shared vocabulary (`BeamMemoryState`, `RecallResult`, …) |
| `schema.ts` | 256 | Idempotent SQLite DDL + FTS5 sync triggers |
| `row.ts` | 47 | Row accessors + shared WHERE-fragment builder |
| `events.ts` | 17 | Single Observer fanout (`emitEvent`) |

## index.ts — the hub

`BeamMemory` implements `BeamMemoryState`: opens the DB (`openDatabase`), runs
`initBeam`, builds the `EpisodicGraph`, normalizes config (`workingMemoryLimit`,
`workingMemoryTtlHours`, `recencyHalflifeHours`, `vec/fts/importanceWeight`,
`maxEpisodeChars`, `proactiveLinking`) from options + `MNEMOPI_*` env, and
delegates every method (`remember`, `recall`, `sleep`, `scratchpad*`,
`export/import`, stats) to the module functions below. `close()` is idempotent.

## store.ts — write path

- `remember(beam, content, opts)` — two named steps:
  - `updateDuplicateMemory` (exact-content dedup, in-session): importance
    ratchets up via `MAX`, `consolidated_at` resets to NULL, non-`unknown`
    veracity wins, `MEMORY_UPDATED` emitted.
  - `insertWorkingMemory`: fresh `generateId` (time+nonce salted), trust tier
    derived from source (conversation→STATED, tool/api→EXTERNAL_WRITE,
    import→IMPORTED), `embed_text` projection stored when provided, then
    `addTemporalAnnotations` → `proactiveLinkIfEnabled` → `trimWorkingMemory`
    → `MEMORY_ADDED`.
- `trimWorkingMemory` — TTL + row-limit trim per session; `IMPORTED`-tier rows
  are durable (issue #4819). Deletes cascade via `purgeWorkingMemoryArtifacts`
  (annotations, `memory_embeddings`, `facts.source_msg_id`, `memoria_facts`,
  gists + `graph_edges`).
- `get` — resolution order working → episodic (scope-aware) → fact row
  (`memory_store: "fact"`, read-only, issue #4725).
- `getContext` — global scope first, then importance, then recency.
- `invalidate` — soft-delete (`valid_until` + `superseded_by`), never deletes.
- `rememberBatch` — one transaction, no dedup (duplicates keep distinct ids).
- `exportToDict` / `importFromDict` — four single-purpose per-table importers;
  imported working rows are stamped consolidated so restored banks survive
  trim; force-overwrite cascade-purges the replaced row's artifacts.
- `scratchpadWrite/Read/Clear` — session-scoped notes.

## recall.ts — read path

Pipeline inside `recall(beam, query, topK, options)`:

1. `inferTemporalOptions` — NL date extraction (`temporal-parser`) sets
   `queryTime`/`temporalWeight`; "current/latest" queries mark results
   current-sensitive.
2. `resolveQueryEmbedding` — three-state seam: `undefined` → derive via
   `embedQuery` (null when no provider → FTS-only), `null` → FTS-only,
   array → caller-supplied.
3. Weights from `normalizedRecallWeights` (env-configurable, defaults
   0.5/0.3/0.2); `useIntent` re-balances via `classifyIntent`/`adjustWeights`.
4. `collectMemoryCandidates` — per tier: FTS5 `MATCH` with EXISTS visibility
   filters (superseded/expired rows never occupy LIMIT slots), ranks
   normalized to 0..1; dense cosine over `memory_embeddings` JSON via
   `vectorSimilarities`; fallback = recency scan.
5. `scoreCandidate` — lexical gate (`lexicalGroupRelevance`, min relevance by
   token count) → `tierBaseScore` (working = keyword-dominated with
   superlinear exact-match bonus; episodic = linear dense/FTS/importance
   fusion) → decay (recency or temporal) → temporal event-date boost →
   veracity/tier/current-content multipliers → 500-char preview clip
   (`truncated`/`full_length`, issue #4443).
6. Assembly — per-tier dedup, `dedupCrossTierSummaryLinks` (an episodic summary
   covering already-hit working rows is dropped), coverage diversification or
   `mmrRerank` (topK), `updateRecallCounts` on returned rows only.

`recallEnhanced` — recall with intent+MMR forced on, double topK, facts fused,
final MMR pass. `factRecall` — `matchFactRowidsByFts` then
`matchFactRowidsByLike` fallback, session-scoped + explicit-global visibility,
scored `lexical * (0.7 + confidence*0.2 + rank*0.1)`; conversational filler
("what's my name") stripped unless present in the fact itself.
`formatContext` — Top Facts / Supporting Context / Recent Signals sandwich
(bullet or JSON).

## consolidate.ts — sleep path

- `sleep(beam, dryRun)` — readable pipeline of named steps:
  `eligibleWorkingRows` (older than TTL/2, unconsolidated,
  `COALESCE(embed_text, content)`) → `claimWorkingRows` (stamp
  `consolidated_at`) → `groupRowsBySource` → per chunk
  `splitSleepItems` (fits `maxEpisodeChars`, nothing dropped) +
  `buildSleepSummary` (AAAK compression, truncation metadata) →
  `consolidateSleepChunk` → `consolidateToEpisodic` → `logSleepSummary` →
  `degradeEpisodic`.
- `consolidateToEpisodic` — episodic row with `summary_of` = source ids,
  aggregated veracity (majority, ties resolve to the weaker claim), gist +
  ctx edge in the episodic graph, `MEMORY_CONSOLIDATED`. Working rows are
  only marked, never deleted.
- `degradeEpisodic` — one plan-driven loop: tier 1 >30d → tier 2 (800-char
  clip), tier 2 >180d → tier 3 (`extractKeySignal` keeps highest-signal
  sentences); rewritten rows lose vectors.
- `sleepAllSessions` — `sleepOneSession` per session (state cloned).
- `getContaminated` — high-importance unverified rows for review;
  `getConsolidationLog` — readback.

## helpers.ts — shared engine math

`normalizeWeights`/`normalizeImportance`, fast ISO timestamp parsing with a
per-beam cache, `recencyDecay` (e^-age/72h) and `temporalBoost` (future
clamped to 1), `lexicalRelevance` (exact + synonym partial + substring
partials; English-only — CJK scoring and language sniffing dropped),
`strictFactMatches`, FTS query building (`recallTokens` →
stopword/digit-filtered terms, `ftsQueryTerms` with `RECALL_SYNONYMS`
expansion), `encodeVector`/`decodeVector`,
`inMemoryVecSearch`/`workingMemoryVecSearch` (exact cosine via
`vector-index.ts`), `normalizeMetadata`/`metadataJson`.

## schema.ts — one idempotent DDL function

`initBeam(db)` creates `working_memory` + `episodic_memory` (+ FTS5 mirrors
`fts_working`/`fts_episodes` with insert/delete/update sync triggers that index
`COALESCE(embed_text, content)`), `scratchpad`, `memory_embeddings`,
`consolidation_log`, `facts` + `fts_facts` (+ triggers), `annotations`,
`memoria_facts`, `gists`/`graph_edges`, and all indexes. Fresh-create only —
the original's `addColumnIfMissing` migrations are dropped.

## row.ts + events.ts — shared plumbing

- `row.ts` — `asString`/`asNumber`/`asNullableString`/`asRows`/`rowValue`
  accessors and `scopeFilterClauses` (the author/type/channel WHERE fragment
  reused by `getWorkingStats` and `getEpisodicStats`).
- `events.ts` — `emitEvent(beam, type, payload)`: one Observer fanout to the
  optional `eventEmitter` and `pluginManager` sinks. Three event types:
  `MEMORY_ADDED`, `MEMORY_UPDATED`, `MEMORY_CONSOLIDATED`.

## Design invariants worth remembering

1. **Working memory is scratch; episodic memory is the durable tier** — sleep
   marks, never deletes; trim protects `IMPORTED` and consolidated rows.
2. **Deletions cascade** — no orphaned annotations/embeddings/facts/graph
   nodes on trim, force-import overwrite, or forget.
3. **Visibility is SQL-level** — `superseded_by IS NULL AND (valid_until IS
   NULL OR valid_until > now)` inside every candidate query, so dead rows
   never displace live ones from LIMIT windows.
4. **Scoring is multiplicative**: tier base × decay × (1 + temporal) × tier
   weight × veracity × currency.
5. **No defensive armor** (per the reduced-copy policy): no try/catch swallows,
   no schema probes, no retries — errors fail fast everywhere, including
   embeddings (provider/init failures propagate). The only remaining `try`
   blocks are rollback-and-rethrow in the `db.ts`/veracity transaction
   helpers and close-only `try/finally` in `cost-log.ts`.
