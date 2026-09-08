import type { ClineMessage } from "@shared/ExtensionMessage"
import { TranscriptPageRequest } from "@shared/proto/cline/task"
import { describe, expect, it } from "vitest"
import type { Controller } from ".."
import { getTranscriptPage } from "./getTranscriptPage"

function msg(ts: number, text = `m${ts}`): ClineMessage {
	return { ts, type: "say", say: "text", text, partial: false }
}

/** Build a ts-ascending transcript [1..count] (minter ids are monotonic per process). */
function transcript(count: number): ClineMessage[] {
	return Array.from({ length: count }, (_, i) => msg(i + 1))
}

function controllerWith(messages: ClineMessage[]): Controller {
	return { getTranscriptMessages: async () => messages } as unknown as Controller
}

function req(taskId: string, beforeTs: number, limit: number, loadedCount = 0): TranscriptPageRequest {
	return TranscriptPageRequest.create({ taskId, beforeTs, limit, loadedCount })
}

describe("getTranscriptPage", () => {
	it("returns empty for a blank taskId", async () => {
		const res = await getTranscriptPage(controllerWith(transcript(5)), req("", 0, 50))
		expect(res.messages).toHaveLength(0)
		expect(res.hasMore).toBe(false)
		expect(res.total).toBe(0)
	})

	it("returns empty for an empty transcript", async () => {
		const res = await getTranscriptPage(controllerWith([]), req("t1", 0, 50))
		expect(res.messages).toHaveLength(0)
		expect(res.total).toBe(0)
	})

	it("beforeTs=0 serves the tail page, ascending, with hasMore/total", async () => {
		// The webview holds nothing yet; the tail page is the initial window's worth.
		const res = await getTranscriptPage(controllerWith(transcript(120)), req("t1", 0, 50))
		expect(res.messages.map((m) => m.ts)).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i))
		expect(res.hasMore).toBe(true)
		expect(res.total).toBe(120)
	})

	it("serves the page strictly older than beforeTs (boundary is exclusive)", async () => {
		// Replica holds ts 71..120; asking for what's before ts=71 must not re-serve 71.
		const res = await getTranscriptPage(controllerWith(transcript(120)), req("t1", 71, 50))
		expect(res.messages.map((m) => m.ts)).toEqual(Array.from({ length: 50 }, (_, i) => 21 + i))
		expect(res.hasMore).toBe(true)
	})

	it("final page reaches the start and flips hasMore to false", async () => {
		const res = await getTranscriptPage(controllerWith(transcript(120)), req("t1", 21, 50))
		expect(res.messages.map((m) => m.ts)).toEqual(Array.from({ length: 20 }, (_, i) => 1 + i))
		expect(res.hasMore).toBe(false)
		expect(res.total).toBe(120)
	})

	it("falls back to loadedCount when beforeTs matches nothing (re-minted ids)", async () => {
		// Inactive-task transcripts are re-translated with freshly minted ids, so a
		// beforeTs from the previous translation finds no match. The caller holds the
		// newest loadedCount messages -> the page ends at total - loadedCount - 1.
		const res = await getTranscriptPage(controllerWith(transcript(100)), req("t1", 999_999, 50, 30))
		expect(res.messages.map((m) => m.ts)).toEqual(Array.from({ length: 50 }, (_, i) => 21 + i))
		expect(res.hasMore).toBe(true)
		expect(res.total).toBe(100)
	})

	it("returns an empty page (hasMore=false) when the replica already reaches the start", async () => {
		// beforeTs smaller than every ts AND no usable loadedCount fallback.
		const res = await getTranscriptPage(controllerWith(transcript(10)), req("t1", 1, 50, 10))
		expect(res.messages).toHaveLength(0)
		expect(res.hasMore).toBe(false)
		expect(res.total).toBe(10)
	})

	it("clamps the limit into [1, 200]", async () => {
		// limit=0 becomes the 50 default; limit=10_000 clamps to 200.
		const byDefault = await getTranscriptPage(controllerWith(transcript(120)), req("t1", 0, 0))
		expect(byDefault.messages).toHaveLength(50)
		const clamped = await getTranscriptPage(controllerWith(transcript(1000)), req("t1", 0, 10_000))
		expect(clamped.messages).toHaveLength(200)
		expect(clamped.messages[0].ts).toBe(801)
	})

	it("does not throw when the controller errors (best-effort empty page)", async () => {
		const controller = {
			getTranscriptMessages: async () => {
				throw new Error("boom")
			},
		} as unknown as Controller
		const res = await getTranscriptPage(controller, req("t1", 0, 50))
		expect(res.messages).toHaveLength(0)
		expect(res.total).toBe(0)
	})
})
