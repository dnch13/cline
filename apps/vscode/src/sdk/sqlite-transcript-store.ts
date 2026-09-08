import { statSync } from "node:fs"
import { join } from "node:path"
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db"
import { resolveDbDataDir } from "@cline/shared/storage"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"

/**
 * SQLite-backed cache of translated UI transcripts (ClineMessage[]) per task.
 *
 * Purpose: make opening/resuming a long task from history fast. Without this
 * cache every task open must (1) JSON.parse the full SDK messages file and
 * (2) run the full `sdkMessagesToClineMessages` translation (content-block
 * splitting, path relativization, ...), which dominates open latency on
 * multi-thousand-message tasks. The cache stores the translation OUTPUT keyed
 * by the source file's identity (path + mtime + size), so:
 *
 *   - cache hit  -> skip both the SDK file parse and the translation
 *   - cache miss -> translate as before, then persist for the next open
 *
 * It is a PURE derived cache: the SDK messages file remains the single source
 * of truth, and any change to it (append, edit, truncate) bumps mtime/size and
 * invalidates the cached rows wholesale. There are no live/incremental writes;
 * rows are only written right after a full translation. Idempotent by design.
 *
 * Message `ts` values in this cache are minter ids from the process that wrote
 * them (see message-id-minter.ts). Readers must re-stamp `ts` with the current
 * process-wide minter before handing messages back to the UI so cached history
 * ids can never collide with live ids minted by this process. `seq`/`epoch`
 * stamps are not persisted (they are delivery-freshness artifacts, not history
 * data); readers treat cached rows as unstamped.
 */

/** Bump when the row/meta layout changes so old caches are ignored wholesale. */
const TRANSCRIPT_CACHE_SCHEMA_VERSION = 1

/** Env override for the database path — used by tests to isolate on tmp dirs. */
const TRANSCRIPT_DB_PATH_ENV = "CLINE_UI_TRANSCRIPT_DB_PATH"

export interface TranscriptSourceKey {
	path: string
	mtimeMs: number
	size: number
}

/** Identity of the SDK messages file a cached translation was derived from. */
export function computeTranscriptSourceKey(messagesPath: string): TranscriptSourceKey | undefined {
	try {
		const st = statSync(messagesPath)
		return { path: messagesPath, mtimeMs: Math.floor(st.mtimeMs), size: st.size }
	} catch {
		return undefined
	}
}

interface MetaRow {
	source_path: string
	source_mtime_ms: number
	source_size: number
	message_count: number
	schema_version: number
}

function sourceKeysEqual(a: TranscriptSourceKey | undefined, b: TranscriptSourceKey | undefined): boolean {
	if (!a || !b) {
		return false
	}
	return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size
}

export class SqliteTranscriptStore {
	private readonly dbPath: string
	private db: SqliteDb | undefined
	private schemaReady = false

	constructor(dbPath: string) {
		this.dbPath = dbPath
	}

	private getDb(): SqliteDb {
		if (!this.db) {
			this.db = loadSqliteDb(this.dbPath)
		}
		if (!this.schemaReady) {
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS ui_transcript_meta (
					task_id TEXT PRIMARY KEY,
					source_path TEXT NOT NULL,
					source_mtime_ms INTEGER NOT NULL,
					source_size INTEGER NOT NULL,
					message_count INTEGER NOT NULL,
					schema_version INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS ui_transcript_rows (
					task_id TEXT NOT NULL,
					row_index INTEGER NOT NULL,
					ts INTEGER NOT NULL,
					payload TEXT NOT NULL,
					PRIMARY KEY (task_id, row_index)
				);
			`)
			this.schemaReady = true
		}
		return this.db
	}

	private readMeta(taskId: string): MetaRow | undefined {
		const row = this.getDb()
			.prepare(
				"SELECT source_path, source_mtime_ms, source_size, message_count, schema_version FROM ui_transcript_meta WHERE task_id = ?",
			)
			.get(taskId) as unknown as MetaRow | undefined
		return row
	}

	/**
	 * Replace the cached transcript for a task. Synchronous and fast enough for
	 * post-translation persistence (a single transaction of JSON rows).
	 */
	replaceAll(taskId: string, messages: ClineMessage[], source: TranscriptSourceKey): void {
		try {
			const db = this.getDb()
			db.exec("BEGIN IMMEDIATE")
			try {
				db.prepare("DELETE FROM ui_transcript_rows WHERE task_id = ?").run(taskId)
				db.prepare("DELETE FROM ui_transcript_meta WHERE task_id = ?").run(taskId)
				const insertRow = db.prepare(
					"INSERT INTO ui_transcript_rows (task_id, row_index, ts, payload) VALUES (?, ?, ?, ?)",
				)
				for (let i = 0; i < messages.length; i++) {
					insertRow.run(taskId, i, messages[i].ts, JSON.stringify(messages[i]))
				}
				db.prepare(
					"INSERT INTO ui_transcript_meta (task_id, source_path, source_mtime_ms, source_size, message_count, schema_version) VALUES (?, ?, ?, ?, ?, ?)",
				).run(taskId, source.path, source.mtimeMs, source.size, messages.length, TRANSCRIPT_CACHE_SCHEMA_VERSION)
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		} catch (error) {
			// The cache is best-effort: never let a cache write failure break task open.
			Logger.warn(`[SqliteTranscriptStore] replaceAll failed for task ${taskId}`, error)
		}
	}

	/**
	 * Read the cached transcript if it was derived from the exact given source
	 * file state. Returns undefined on miss (no rows, stale source, schema
	 * mismatch, or corrupt payload).
	 */
	readAll(taskId: string, source: TranscriptSourceKey): ClineMessage[] | undefined {
		try {
			const meta = this.readMeta(taskId)
			if (!meta || meta.schema_version !== TRANSCRIPT_CACHE_SCHEMA_VERSION) {
				return undefined
			}
			if (!sourceKeysEqual({ path: meta.source_path, mtimeMs: meta.source_mtime_ms, size: meta.source_size }, source)) {
				return undefined
			}
			const rows = this.getDb()
				.prepare("SELECT payload FROM ui_transcript_rows WHERE task_id = ? ORDER BY row_index ASC")
				.all(taskId) as { payload: string }[]
			if (rows.length !== meta.message_count) {
				// Corrupt/partial write — treat as a miss.
				return undefined
			}
			const messages: ClineMessage[] = []
			for (const row of rows) {
				messages.push(JSON.parse(row.payload) as ClineMessage)
			}
			return messages
		} catch (error) {
			Logger.warn(`[SqliteTranscriptStore] readAll failed for task ${taskId} (treating as cache miss)`, error)
			return undefined
		}
	}

	/** Drop the cached transcript for one task (task deleted). */
	delete(taskId: string): void {
		try {
			const db = this.getDb()
			db.prepare("DELETE FROM ui_transcript_rows WHERE task_id = ?").run(taskId)
			db.prepare("DELETE FROM ui_transcript_meta WHERE task_id = ?").run(taskId)
		} catch (error) {
			Logger.warn(`[SqliteTranscriptStore] delete failed for task ${taskId}`, error)
		}
	}

	/** Drop all cached transcripts (history cleared). */
	deleteAll(): void {
		try {
			const db = this.getDb()
			db.prepare("DELETE FROM ui_transcript_rows").run()
			db.prepare("DELETE FROM ui_transcript_meta").run()
		} catch (error) {
			Logger.warn("[SqliteTranscriptStore] deleteAll failed", error)
		}
	}

	/** Close the underlying handle (tests). */
	close(): void {
		try {
			this.db?.close?.()
		} catch {
			// ignore
		}
		this.db = undefined
		this.schemaReady = false
	}
}

let storeSingleton: SqliteTranscriptStore | undefined

export function getUiTranscriptStore(): SqliteTranscriptStore {
	if (!storeSingleton) {
		const dbPath = process.env[TRANSCRIPT_DB_PATH_ENV] || join(resolveDbDataDir(), "ui-transcripts.db")
		storeSingleton = new SqliteTranscriptStore(dbPath)
	}
	return storeSingleton
}

/** Test seam: drop the singleton (does not delete the file). */
export function resetUiTranscriptStoreForTests(): void {
	storeSingleton?.close()
	storeSingleton = undefined
}
