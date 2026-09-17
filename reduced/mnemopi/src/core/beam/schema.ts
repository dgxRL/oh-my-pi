/**
 * Reduced port of packages/mnemopi/src/core/beam/schema.ts.
 * Fresh-create DDL only (the original carries addColumnIfMissing migrations for
 * pre-existing banks). Tables kept: working_memory, episodic_memory (+FTS
 * mirrors fts_working/fts_episodes with sync triggers), scratchpad,
 * memory_embeddings, consolidation_log, facts (+fts_facts), annotations,
 * memoria_facts. Dropped: memoria_timelines/instructions/preferences/kg,
 * memory_validations, triples. gists/graph_edges live in episodic-graph.ts.
 */
import type { Database } from "bun:sqlite";

export function initBeam(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS working_memory (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			embed_text TEXT DEFAULT NULL,
			source TEXT,
			timestamp TEXT,
			session_id TEXT DEFAULT 'default',
			importance REAL DEFAULT 0.5,
			metadata_json TEXT,
			veracity TEXT DEFAULT 'unknown',
			memory_type TEXT DEFAULT 'unknown',
			consolidated_at TEXT,
			recall_count INTEGER DEFAULT 0,
			last_recalled TIMESTAMP DEFAULT NULL,
			valid_until TIMESTAMP DEFAULT NULL,
			superseded_by TEXT DEFAULT NULL,
			scope TEXT DEFAULT 'global',
			author_id TEXT DEFAULT NULL,
			author_type TEXT DEFAULT NULL,
			channel_id TEXT DEFAULT NULL,
			trust_tier TEXT DEFAULT 'STATED',
			validator TEXT DEFAULT NULL,
			validated_at TIMESTAMP DEFAULT NULL,
			validation_count INTEGER DEFAULT 0,
			event_date TEXT DEFAULT NULL,
			event_date_precision TEXT DEFAULT 'unknown',
			temporal_tags TEXT DEFAULT '[]',
			corrected_by INTEGER DEFAULT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS episodic_memory (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT UNIQUE NOT NULL,
			content TEXT NOT NULL,
			source TEXT,
			timestamp TEXT,
			session_id TEXT DEFAULT 'default',
			importance REAL DEFAULT 0.5,
			metadata_json TEXT,
			summary_of TEXT DEFAULT '',
			veracity TEXT DEFAULT 'unknown',
			tier INTEGER DEFAULT 1,
			degraded_at TEXT,
			memory_type TEXT DEFAULT 'unknown',
			recall_count INTEGER DEFAULT 0,
			last_recalled TIMESTAMP DEFAULT NULL,
			valid_until TIMESTAMP DEFAULT NULL,
			superseded_by TEXT DEFAULT NULL,
			scope TEXT DEFAULT 'global',
			author_id TEXT DEFAULT NULL,
			author_type TEXT DEFAULT NULL,
			channel_id TEXT DEFAULT NULL,
			trust_tier TEXT DEFAULT 'STATED',
			validator TEXT DEFAULT NULL,
			validated_at TIMESTAMP DEFAULT NULL,
			validation_count INTEGER DEFAULT 0,
			event_date TEXT DEFAULT NULL,
			event_date_precision TEXT DEFAULT 'unknown',
			temporal_tags TEXT DEFAULT '[]',
			corrected_by INTEGER DEFAULT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS scratchpad (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			session_id TEXT DEFAULT 'default',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
			content,
			content='episodic_memory',
			content_rowid='rowid'
		)
	`);
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_working USING fts5(
			id UNINDEXED,
			content
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS consolidation_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT,
			items_consolidated INTEGER,
			summary_preview TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS memory_embeddings (
			memory_id TEXT PRIMARY KEY,
			embedding_json TEXT NOT NULL,
			model TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS facts (
			fact_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			subject TEXT NOT NULL,
			predicate TEXT NOT NULL,
			object TEXT NOT NULL,
			timestamp TEXT,
			source_msg_id TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_facts USING fts5(
			subject, predicate, object, content='facts'
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS annotations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			value TEXT NOT NULL,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_facts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			fact_type TEXT,
			key TEXT,
			value TEXT,
			context_snippet TEXT,
			importance REAL DEFAULT 0.5,
			timestamp TEXT,
			source_memory_id TEXT
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS gists (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			timestamp TEXT,
			participants_json TEXT,
			location TEXT,
			emotion TEXT,
			time_scope TEXT,
			memory_id TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS graph_edges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source TEXT NOT NULL,
			target TEXT NOT NULL,
			edge_type TEXT NOT NULL,
			weight REAL DEFAULT 1.0,
			timestamp TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(source, target, edge_type)
		)
	`);


	for (const statement of [
		"CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_timestamp ON working_memory(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_em_session ON episodic_memory(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_timestamp ON episodic_memory(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_em_tier ON episodic_memory(tier)",
		"CREATE INDEX IF NOT EXISTS idx_sp_session ON scratchpad(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)",
		"CREATE INDEX IF NOT EXISTS idx_annot_memory_kind ON annotations(memory_id, kind)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_annot_unique ON annotations(memory_id, kind, value)",
		"CREATE INDEX IF NOT EXISTS idx_mem_emb_type ON memory_embeddings(memory_id, model)",
		"CREATE INDEX IF NOT EXISTS idx_gists_memory ON gists(memory_id)",
		"CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source)",
		"CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target)",
		"CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type)",
		"CREATE INDEX IF NOT EXISTS idx_wm_unconsolidated ON working_memory(session_id, timestamp) WHERE consolidated_at IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_em_scope_imp ON episodic_memory(scope, importance) WHERE superseded_by IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_wm_session_recall ON working_memory(session_id, last_recalled) WHERE valid_until IS NULL",
	]) {
		db.run(statement);
	}

	// FTS sync triggers. Episodic rows live in an external-content FTS keyed by
	// rowid; working rows use (id, content) with embed_text preferred over
	// content for indexing (embed_text is the cleaned projection).
	for (const statement of [
		`CREATE TRIGGER IF NOT EXISTS em_ai AFTER INSERT ON episodic_memory BEGIN
			INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS em_ad AFTER DELETE ON episodic_memory BEGIN
			INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS em_au AFTER UPDATE ON episodic_memory BEGIN
			INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS wm_ai AFTER INSERT ON working_memory BEGIN
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`,
		`CREATE TRIGGER IF NOT EXISTS wm_ad AFTER DELETE ON working_memory BEGIN
			DELETE FROM fts_working WHERE id = old.id;
		END`,
		`CREATE TRIGGER IF NOT EXISTS wm_au AFTER UPDATE OF content, embed_text ON working_memory BEGIN
			DELETE FROM fts_working WHERE id = old.id;
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`,
		`CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
			INSERT INTO fts_facts(rowid, subject, predicate, object)
			VALUES (new.rowid, new.subject, new.predicate, new.object);
		END`,
		`CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
			INSERT INTO fts_facts(fts_facts, rowid, subject, predicate, object)
			VALUES ('delete', old.rowid, old.subject, old.predicate, old.object);
		END`,
	]) {
		db.run(statement);
	}
}
