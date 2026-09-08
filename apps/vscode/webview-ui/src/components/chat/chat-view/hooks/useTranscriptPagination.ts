import { TranscriptPageRequest } from "@shared/proto/cline/task"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

/** Page size for backwards transcript paging via TaskService.getTranscriptPage. */
export const TRANSCRIPT_PAGE_SIZE = 50

/**
 * Infinite scroll over a windowed transcript (long-task optimization).
 *
 * The extension's state snapshots deliver only the TAIL of clineMessages
 * (ExtensionState.transcriptWindow). This hook fetches older pages on demand
 * through the getTranscriptPage RPC and merges them into the webview replica
 * via prependTranscriptMessages.
 */
export function useTranscriptPagination() {
	const { clineMessages, transcriptWindow, currentTaskItem, epoch, prependTranscriptMessages } = useExtensionState()

	const [isLoadingEarlierMessages, setIsLoadingEarlierMessages] = useState(false)
	// Monotonic request id: a newer request supersedes an older in-flight one.
	const requestRef = useRef(0)
	// Mirror of the CURRENT epoch so an in-flight response opened for a previous
	// task/epoch (task switched while the RPC was pending) is dropped instead of
	// being prepended into the new task's replica.
	const epochRef = useRef(epoch)
	useEffect(() => {
		epochRef.current = epoch
	}, [epoch])

	const hasEarlierMessages = !!transcriptWindow?.hasMore && clineMessages.length > 0

	const loadEarlierMessages = useCallback(async (): Promise<number> => {
		const taskId = currentTaskItem?.id
		const oldest = clineMessages[0]
		if (!taskId || !oldest || !transcriptWindow?.hasMore) {
			return 0
		}
		const requestId = ++requestRef.current
		const requestEpoch = epochRef.current
		setIsLoadingEarlierMessages(true)
		try {
			const response = await TaskServiceClient.getTranscriptPage(
				TranscriptPageRequest.create({
					taskId,
					beforeTs: oldest.ts,
					limit: TRANSCRIPT_PAGE_SIZE,
					loadedCount: clineMessages.length,
				}),
			)
			if (requestRef.current !== requestId || epochRef.current !== requestEpoch) {
				// Superseded by a newer request, or the task/epoch changed mid-flight.
				return 0
			}
			const messages = response.messages.map(convertProtoToClineMessage)
			prependTranscriptMessages(messages, response.hasMore, response.total)
			return messages.length
		} catch (error) {
			console.error("[useTranscriptPagination] failed to load transcript page:", error)
			return 0
		} finally {
			if (requestRef.current === requestId) {
				setIsLoadingEarlierMessages(false)
			}
		}
	}, [currentTaskItem?.id, clineMessages, transcriptWindow?.hasMore, prependTranscriptMessages])

	return { hasEarlierMessages, isLoadingEarlierMessages, loadEarlierMessages }
}
