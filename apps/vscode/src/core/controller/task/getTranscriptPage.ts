import type { ClineMessage } from "@shared/ExtensionMessage"
import { TranscriptPageRequest, TranscriptPageResponse } from "@shared/proto/cline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/** Clamp page size so a runaway limit cannot make the webview jank on one insert. */
const MAX_PAGE_LIMIT = 200

/**
 * Loads one page of OLDER transcript messages for a task (infinite scroll).
 *
 * Long-task state snapshots carry only the transcript tail (see
 * ExtensionState.transcriptWindow); the webview pages backwards through the
 * rest as the user scrolls up. `beforeTs` is the ts of the oldest message the
 * caller currently holds, and the page returned is the `limit` messages
 * immediately older than it, in ascending order.
 *
 * Id-stability: for the ACTIVE task this slices the same in-memory array the
 * windowed snapshot was sliced from (identical ts ids), so prepending never
 * duplicates rows. For inactive tasks the transcript comes from task history
 * (SQLite-derived cache) — ids are freshly minted per open, but paging stays
 * overlap-free because both the boundary lookup and ordering are positional
 * over an append-only file.
 *
 * @param controller The controller instance
 * @param request taskId, beforeTs (0 = tail), limit
 * @returns TranscriptPageResponse with messages (ascending), hasMore, total
 */
export async function getTranscriptPage(controller: Controller, request: TranscriptPageRequest): Promise<TranscriptPageResponse> {
	const taskId = request.taskId?.trim()
	if (!taskId) {
		return TranscriptPageResponse.create({ messages: [], hasMore: false, total: 0 })
	}
	const limit = Math.max(1, Math.min(request.limit > 0 ? request.limit : 50, MAX_PAGE_LIMIT))
	const beforeTs = request.beforeTs > 0 ? Number(request.beforeTs) : 0

	try {
		const messages = await controller.getTranscriptMessages(taskId)
		if (messages.length === 0) {
			return TranscriptPageResponse.create({ messages: [], hasMore: false, total: 0 })
		}

		// Transcript arrays are ts-ascending (minter ids are monotonic per process
		// and history translation mints them in order). Find the boundary: the
		// newest message strictly older than beforeTs (0 = take the tail).
		//
		// For the ACTIVE task, `messages` is the same in-memory array the windowed
		// snapshot was sliced from, so the ts lookup is exact and id-stable. For an
		// inactive task the transcript was re-translated with freshly minted ids —
		// a beforeTs from the older translation can land ANYWHERE relative to the
		// new ids (not just below them), so an exact-lookup miss must trigger the
		// COUNT-based fallback: the caller holds the newest loadedCount messages,
		// hence the page ends at total - loadedCount - 1. (If both are supplied
		// and the exact ts lookup finds nothing, the count wins.)
		let boundary = messages.length - 1
		if (beforeTs > 0) {
			let exact = -1
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].ts === beforeTs) {
					exact = i
					break
				}
			}
			if (exact >= 0) {
				boundary = exact - 1
			} else if (request.loadedCount > 0 && request.loadedCount < messages.length) {
				boundary = messages.length - request.loadedCount - 1
			}
		}
		if (boundary < 0) {
			// Nothing older than the boundary — the replica already reaches the start.
			return TranscriptPageResponse.create({ messages: [], hasMore: false, total: messages.length })
		}

		const start = Math.max(0, boundary - limit + 1)
		const page: ClineMessage[] = messages.slice(start, boundary + 1)
		return TranscriptPageResponse.create({
			messages: page.map((message) => convertClineMessageToProto(message)),
			hasMore: start > 0,
			total: messages.length,
		})
	} catch (error) {
		Logger.error(`Error in getTranscriptPage for task ${taskId}:`, error)
		return TranscriptPageResponse.create({ messages: [], hasMore: false, total: 0 })
	}
}
