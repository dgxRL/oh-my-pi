# Reduced mnemopi — main workflow

This document walks the main workflow of `reduced/mnemopi` in execution order.
Everything references files inside `reduced/mnemopi/src`. For the file-by-file
mapping to the real package, see the [README](../README.md).

## 0. The mental model

The engine is three in-memory tiers backed by one SQLite file:

| Tier | Table | Role |
|---|---|---|
| Working memory | `working_memory` | Fast scratch. TTL-trimmed, consolidated away by sleep |
| Episodic memory | `episodic_memory` | Durable summaries produced by sleep, tiered 1→2→3 as they age |
| Facts | `facts` | Atomic `subject predicate object` triples mined/stored by hosts |

Plus two full-text mirrors (`fts_working`, `fts_episodes`, `fts_facts` — FTS5),
a JSON vector side table (`memory_embeddings`), and ancillary stores
(`annotations`, `memoria_facts`, `scratchpad`, `consolidation_log`, `gists`,
`graph_edges`). All DDL lives in `core/beam/schema.ts`; a database is always
opened via `db.ts#openDatabase` and initialized with `initBeam(db)`.

Two memory ids exist:

- `generateId(content, now)` (`util/ids.ts`) — time+nonce salted hash: every
  remember mints a fresh id, even for identical content.
- `generateStableId(content, source)` — pure content hash: used where the same
  fact must always map to the same id.

## 1. remember — writing a memory

Entry points: `BeamMemory.remember` → free function `remember` in
`core/beam/store.ts` (the facade `core/memory.ts` only resolves bank/db path and
wraps runtime options).

```
remember(beam, content, {source, importance, metadata, scope, veracity, embedText, ...})
```

Steps:

1. **Dedup by exact content** (`findDuplicate`) — same content in the same
   session returns the existing id. The row is *updated*: importance takes
   `MAX(old, new)`, timestamp/source refresh, `consolidated_at` resets to NULL
   (the duplicate is fresh again), a non-`unknown` veracity wins. Event
   `MEMORY_UPDATED` is emitted.
2. **Insert** otherwise: id from `generateId`, `scope` defaults to `"session"`,
   `trust_tier` derived from `source` (`conversation/user/assistant → STATED`,
   `tool/api/system → EXTERNAL_WRITE`, `import/backup → IMPORTED`),
   `importance` defaults 0.5. `embed_text` stores a cleaned projection when the
   caller passes `embedText` — FTS and sleep then read the projection instead of
   the raw content (FTS triggers index `COALESCE(embed_text, content)`).
   Event `MEMORY_ADDED` is emitted (both `eventEmitter` and `pluginManager`).
3. **Side enrichments**:
   - `addTemporalAnnotations` — `occurred_on: <date>` plus `has_source` for
     non-conversational sources, into `annotations`.
   - `proactiveLinkIfEnabled` — when `MNEMOPI_PROACTIVE_LINKING=1` (or config),
     the episodic graph ingests the content: a gist row `gist_<id>` + a `ctx`
     edge, plus lexical `related_to`/`ctx` edges to similar known memories
     (`core/episodic-graph.ts`, Jaccard ≥ 0.35).
4. **Trim** (`trimWorkingMemory`) — the write path enforces two limits per
   session: rows older than `workingMemoryTtlHours`, and overflow beyond
   `workingMemoryLimit` (newest kept). `IMPORTED`-tier rows are durable and
   never trimmed. Trimmed rows cascade-delete every linked artifact
   (`purgeWorkingMemoryArtifacts`).

`rememberBatch` is the same insert loop inside one transaction (no dedup —
duplicates get distinct ids).

## 2. recall — reading memories back

Entry points: `recall` / `recallEnhanced` / `factRecall` in
`core/beam/recall.ts`. Signature:
`recall(beam, query, topK, options)` → `Promise<RecallResult[]>`.

### 2.1 Query preparation

1. **Temporal inference** (`inferTemporalOptions`) — `extractTemporal`
   (`core/temporal-parser.ts`) parses NL dates ("last friday", "yesterday").
   A hit sets `queryTime` and `temporalWeight` (0.35). Queries asking about
   "current/latest/now" get `temporalWeight` 0.45 and mark results
   `currentSensitive` (content mentioning "current" boosted, "stale/old" 
   penalized).
2. **Query embedding** — three-state `queryEmbedding` option: `undefined` =
   derive via `embedQuery` (`core/embeddings.ts`; `null` when no provider is
   configured → FTS-only recall), `null` = explicitly FTS-only, array =
   caller-supplied.
3. **Weights** — `[vec, fts, importance]` normalized from config/env
   (`config.ts#normalizedRecallWeights`, defaults 0.5/0.3/0.2). `useIntent`
   re-balances them via `classifyIntent` + `adjustWeights`
   (`core/query-intent.ts`: temporal/factual/preference/entity/procedural).
4. **Tokens** — `expandedTokens`/`expandedTokenGroups` tokenize (stopword- and
   digit-filtered) and expand synonym groups (`core/synonyms.ts`,
   `util/regex.ts#RECALL_SYNONYMS`).

### 2.2 Candidate collection (`collectMemoryCandidates`)

For each tier (working via `fts_working`, episodic via `fts_episodes`):

- **FTS candidates**: `MATCH` the OR-of-quoted-terms query, keep SQLite's
  `rank`, and normalize ranks to 0..1 (`normalizeRanks`). Superseded/expired
  rows are excluded *inside* the query with a correlated `EXISTS` so dead rows
  never consume LIMIT slots.
- **Vector candidates** (only with a query embedding): cosine similarity of the
  query vector against `memory_embeddings.embedding_json` for every visible row
  (`vectorSimilarities`); top ids merge into the candidate set.

Candidates missing from FTS (e.g. fresh rows before any match) come from
`fallbackCandidates` (timestamp-ordered scan). `fetchCandidates` then loads full
rows and records each candidate's signals:
`{fts, ftsMatched, dense, candidateSource: "fts" | "vec" | "fallback"}`.

### 2.3 Scoring (`scoreCandidate`)

```
lexical   = lexicalGroupRelevance(queryGroups, embedText || content)
            // exact group hits + 4-char prefix/suffix partials + phrase bonus
decay     = recencyDecay(timestamp, 72)          // e^-age/72h
            // or temporalBoost against queryTime when a queryTime is set
keyword   = max(lexical, ftsRank * 0.6)

working:  base = keyword * kwShare + importance * importanceWeight
                 + keyword² * 0.08          // superlinear exact-match bonus
          (dense similarity, if any, blends in 80/20)
episodic: base = max(dense*vecW + fts*ftsW + importance*impW, lexical*0.8)

score = base * (0.7 + 0.3 * decay)
      * (1 + temporalWeight * temporalScore)    // + event_date double-count
      * tierWeight                               // episodic tier 1/2/3 → 1/.85/.7
      * veracityWeight                           // true/stated 1.0 … tool 0.5, false 0
      * currentAdjustment                        // current-sensitive queries only
```

Candidates below `minimumRelevance` (token-count dependent, 0.08–0.34) with a
weak dense score are dropped. Content longer than `contentPreviewChars`
(default 500) is clipped with a trailing `…` and flagged
`truncated: true` + `full_length`; the full row stays reachable through `get`.

### 2.4 Assembly

- `dedupeResults` (per tier+id), then `dedupCrossTierSummaryLinks` — an episodic
  summary whose `summary_of` ids also appear as working hits is dropped (the
  summary covers them).
- Long queries (≥4 tokens) with surplus results get coverage diversification
  (`diversifyByCoverage`); `useMmr` switches to `mmrRerank`
  (`core/mmr.ts`, Jaccard-based MMR).
- `updateRecallCounts` bumps `recall_count` / `last_recalled` for the *returned*
  rows only (MMR rejects are not counted).

`recallEnhanced` = recall with intent + MMR forced on, double topK, then
`factRecall` results merged in and one final MMR pass.

`factRecall` — FTS over `fts_facts` (subject/predicate/object), LIKE fallback,
session-scoped with explicit-`global` visibility, scored
`lexical * (0.7 + confidence*0.2 + rank*0.1)`. `filler words` in questions
("what's my name" → "my", "what", clitics) are dropped so the entity token
matches; filler-looking tokens that appear in the *fact text itself* survive.

`formatContext` renders results as a bullet/JSON "sandwich": Top Facts →
Supporting Context → Recent Signals.

## 3. sleep — consolidation

Entry points: `sleep` / `sleepAllSessions` / `consolidateToEpisodic` /
`degradeEpisodic` in `core/beam/consolidate.ts`.

```
sleep(beam, dryRun)
```

1. **Eligibility** (`eligibleWorkingRows`) — rows of this session older than
   `workingMemoryTtlHours / 2` and not yet consolidated, ordered oldest-first.
   Content is `COALESCE(embed_text, content)` — sleep compresses the *clean
   projection*, never raw transcripts.
2. **Claim** (real run only) — `UPDATE ... SET consolidated_at = now` marks the
   batch so a concurrent sleep cannot double-consolidate.
3. **Group + chunk** — rows grouped by `source`; `splitSleepItems` splits any
   group whose joined text would exceed `maxEpisodeChars` into multiple
   episodes (nothing dropped).
4. **Compress** (`buildSleepSummary`) — group text joined with ` | `, then
   **AAAK compression** (`core/aaak.ts`): phrase map ("User prefers " → "PREF "),
   structural rewrites (" and " → "+", " in " → ":"), punctuation compaction.
   Oversized output is truncated with an explicit marker and the metadata
   records `truncated/original_chars/max_chars`.
5. **Write episode** (`consolidateToEpisodic`) — new episodic row with
   `summary_of = <comma-joined source ids>`, scope/validUntil merged from the
   group, veracity aggregated by majority (ties resolved toward the *weaker*
   claim). The episodic graph gains a gist + ctx edge per episode.
   Event `MEMORY_CONSOLIDATED` emitted. Working rows are **kept** (only the
   consolidated_at marker changes).
6. **Log** — one `consolidation_log` row with the item count.
7. **Degrade** (`degradeEpisodic`) — tier maintenance on episodic rows by age:
   tier 1 older than `MNEMOPI_TIER2_DAYS` (30) → tier 2 (content clipped to
   800 chars); tier 2 older than `MNEMOPI_TIER3_DAYS` (180) → tier 3
   (`extractKeySignal` keeps the highest-signal sentences up to
   `TIER3_MAX_CHARS`). Vectors of rewritten rows are invalidated.

Result shape: `{status: "consolidated"|"dry_run"|"no_op", items_consolidated,
summaries_created, degradation, ...}`. `sleepAllSessions` repeats sleep for
every session with eligible rows (the beam state is cloned per session) and
returns per-session results.

`getContaminated` lists high-importance episodic rows with unverified veracity
(inferred/tool/imported/unknown/false) for later human review;
`getConsolidationLog` reads back the log.

## 4. Cross-cutting pieces

- **Embeddings** (`core/embeddings.ts`) — one seam, three sources, resolved in
  order: constructor-scoped provider (`Mnemopi({embeddings})`), test provider
  (`setEmbeddingProviderForTests`), OpenAI-compatible endpoint (model/URL/key
  from `MNEMOPI_EMBEDDING_*` env; custom hosts need no key), and a local-model
  initializer hook (`setLocalModelInitializer` — the reduced copy ships no
  ONNX model). Query vectors are cached per (provider, model, url, text).
- **Runtime options** (`core/runtime-options.ts`) —
  `withMnemopiRuntimeOptions` uses `AsyncLocalStorage` so a `Mnemopi` instance's
  embedding config applies inside any `await` without threading parameters.
- **Veracity consolidation** (`core/veracity-consolidation.ts`) —
  `VeracityConsolidator.consolidateFact` dedups identical triples into
  `consolidated_facts`, nudges confidence Bayesian-style per mention, records
  contradictions into `conflicts`.
- **Banks** (`core/banks.ts`) — a bank is a subdirectory with its own
  `mnemopi.db` under `MNEMOPI_DATA_DIR/banks/`; the facade resolves one db per
  bank, so bank isolation is physical file isolation.
- **Transactions** (`db.ts`) — `transaction(db, fn)` opens a deferred
  transaction, rolls back and rethrows on failure; nested calls join the open
  transaction via `db.inTransaction`.

## 5. One-session example

```ts
const memory = new Mnemopi({ dbPath: "agent.db", sessionId: "today" });
memory.remember("User prefers terse answers", { importance: 0.8 });   // §1
const hits = await memory.recall("answer style", 5);                   // §2
memory.sleep();                                                        // §3
// episodic row "[conversation] PREF terse answers" (AAAK-compressed)
```
