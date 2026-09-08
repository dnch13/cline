import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { computeTranscriptSourceKey, SqliteTranscriptStore } from "./sqlite-transcript-store"

function msg(ts: number, text = `m${ts}`): ClineMessage {
	return { ts, type: "say", say: "text", text, partial: false }
}

let dir: string
let store: SqliteTranscriptStore

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "cline-transcript-store-"))
	store = new SqliteTranscriptStore(join(dir, "ui-transcripts.db"))
})

afterAll(() => {
	store.close()
	rmSync(dir, { recursive: true, force: true })
})

function writeSource(name: string, contents = "{}\n"): string {
	const path = join(dir, name)
	writeFileSync(path, contents, { flag: "w" })
	return path
}

describe("SqliteTranscriptStore", () => {
	it("round-trips a cached transcript keyed by exact source identity", () => {
		const sourcePath = writeSource("messages-a.json")
		const source = computeTranscriptSourceKey(sourcePath)
		expect(source).toBeDefined()
		const messages = [msg(1), msg(2), msg(3)]
		store.replaceAll("task-a", messages, source!)

		const read = store.readAll("task-a", source!)
		expect(read).toEqual(messages)
	})

	it("misses when the source file changed (mtime/size differ)", async () => {
		const sourcePath = writeSource("messages-b.json")
		const source = computeTranscriptSourceKey(sourcePath)!
		store.replaceAll("task-b", [msg(1)], source)

		// Same size but bumped mtime: write then await a new mtime tick.
		writeFileSync(sourcePath, "{}\n", { flag: "w" })
		await new Promise((resolve) => setTimeout(resolve, 5))
		writeFileSync(sourcePath, "{} ", { flag: "w" })
		const changed = computeTranscriptSourceKey(sourcePath)!
		expect(store.readAll("task-b", changed)).toBeUndefined()

		// Rows stay readable under the identity they were WRITTEN with — readAll
		// validates the caller-supplied key against the stored meta, not against
		// the live file. Callers always pass the live file's identity, so stale
		// rows are unreachable in practice; eviction happens on the next
		// replaceAll (covered in the overwrite test below).
		expect(store.readAll("task-b", source)).toEqual([msg(1)])
	})

	it("misses for an unknown task", () => {
		const sourcePath = writeSource("messages-c.json")
		expect(store.readAll("never-written", computeTranscriptSourceKey(sourcePath)!)).toBeUndefined()
	})

	it("misses when the source file no longer exists (computeTranscriptSourceKey -> undefined)", () => {
		expect(computeTranscriptSourceKey(join(dir, "does-not-exist.json"))).toBeUndefined()
	})

	it("delete() drops the cached rows for one task only", () => {
		const pathA = writeSource("messages-d.json")
		const pathB = writeSource("messages-e.json")
		const keyA = computeTranscriptSourceKey(pathA)!
		const keyB = computeTranscriptSourceKey(pathB)!
		store.replaceAll("task-d", [msg(1)], keyA)
		store.replaceAll("task-e", [msg(2)], keyB)

		store.delete("task-d")
		expect(store.readAll("task-d", keyA)).toBeUndefined()
		expect(store.readAll("task-e", keyB)).toEqual([msg(2)])
	})

	it("replaceAll() overwrites a previous cache for the same task", () => {
		const path = writeSource("messages-f.json")
		const key1 = computeTranscriptSourceKey(path)!
		store.replaceAll("task-f", [msg(1), msg(2)], key1)

		// Source advances (file appended) -> re-cache under the new identity.
		writeFileSync(path, '{"messages":[1,2,3]}', { flag: "w" })
		const key2 = computeTranscriptSourceKey(path)!
		store.replaceAll("task-f", [msg(1), msg(2), msg(3), msg(4)], key2)

		expect(store.readAll("task-f", key1)).toBeUndefined()
		expect(store.readAll("task-f", key2)).toHaveLength(4)
	})

	it("deleteAll() clears every task", () => {
		const pathG = writeSource("messages-g.json")
		const pathH = writeSource("messages-h.json")
		const keyG = computeTranscriptSourceKey(pathG)!
		const keyH = computeTranscriptSourceKey(pathH)!
		store.replaceAll("task-g", [msg(1)], keyG)
		store.replaceAll("task-h", [msg(2)], keyH)

		store.deleteAll()
		expect(store.readAll("task-g", keyG)).toBeUndefined()
		expect(store.readAll("task-h", keyH)).toBeUndefined()
	})
})
