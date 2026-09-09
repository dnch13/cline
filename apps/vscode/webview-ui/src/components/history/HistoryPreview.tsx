import { StringRequest } from "@shared/proto/cline/common"
import { memo, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUsageCostVisibility } from "@/hooks/useUsageCostVisibility"
import { TaskServiceClient } from "@/services/grpc-client"

type HistoryPreviewProps = {
	showHistoryView: () => void
}

// Number of recent chats shown per page on the main screen.
const RECENT_PAGE_SIZE = 20

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const { taskHistory } = useExtensionState()
	const isCostVisible = useUsageCostVisibility()
	const [page, setPage] = useState(1)

	const handleHistorySelect = (id: string) => {
		TaskServiceClient.showTaskWithId(StringRequest.create({ value: id })).catch((error) =>
			console.error("Error showing task:", error),
		)
	}

	const validItems = useMemo(() => taskHistory.filter((item) => item.ts && item.task), [taskHistory])

	const totalPages = Math.max(1, Math.ceil(validItems.length / RECENT_PAGE_SIZE))
	// Clamp the page when the history shrinks (e.g. tasks deleted elsewhere).
	const currentPage = Math.min(page, totalPages)
	const pageItems = validItems.slice((currentPage - 1) * RECENT_PAGE_SIZE, currentPage * RECENT_PAGE_SIZE)

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp)
		return date?.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
		})
	}

	return (
		<div style={{ flexShrink: 0 }}>
			<style>
				{`
					.history-preview-item {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent);
						border-radius: 4px;
						position: relative;
						overflow: hidden;
						cursor: pointer;
						margin-bottom: 8px;
						padding: 10px 12px;
						display: flex;
						align-items: flex-start;
						gap: 12px;
					}
					.history-preview-item:hover {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 100%, transparent);
						pointer-events: auto;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-description {
						flex: 1;
						overflow: hidden;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						line-height: 1.4;
					}
					.history-meta-stack {
						display: flex;
						flex-direction: column;
						align-items: center;
						gap: 4px;
						flex-shrink: 0;
					}
					.history-date {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
					.history-cost-chip {
						background-color: var(--vscode-badge-background);
						color: var(--vscode-badge-foreground);
						padding: 2px 8px;
						border-radius: 12px;
						font-size: 0.85em;
						font-weight: 500;
						white-space: nowrap;
					}
					.history-view-all-btn {
						background: none;
						border: none;
						padding: 4px 0 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					}
					.history-view-all-btn .codicon {
						font-size: 1.2em;
					}
					.history-view-all-btn:hover {
						color: var(--vscode-foreground);
					}
					.history-pagination {
						display: flex;
						align-items: center;
						justify-content: space-between;
						padding: 8px 4px 4px 4px;
					}
					.history-page-btn {
						background: none;
						border: none;
						padding: 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					}
					.history-page-btn:hover:not(:disabled) {
						color: var(--vscode-foreground);
					}
					.history-page-btn:disabled {
						opacity: 0.4;
						cursor: default;
					}
					.history-page-btn .codicon {
						font-size: 1.2em;
					}
					.history-page-indicator {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
				`}
			</style>

			<div
				className="history-header"
				style={{
					color: "var(--vscode-descriptionForeground)",
					margin: "10px 16px 10px 16px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}>
				<div style={{ display: "flex", alignItems: "center" }}>
					<span
						className="codicon codicon-comment-discussion"
						style={{
							marginRight: "4px",
							transform: "scale(0.9)",
						}}
					/>
					<span
						style={{
							fontWeight: 500,
							fontSize: "0.85em",
							textTransform: "uppercase",
						}}>
						Recent
					</span>
				</div>
				{taskHistory.filter((item) => item.ts && item.task).length > 0 && (
					<button
						aria-label="View all history"
						className="history-view-all-btn"
						onClick={() => showHistoryView()}
						type="button">
						View All
						<span className="codicon codicon-chevron-right" />
					</button>
				)}
			</div>

			{
				<div className="px-4">
					{validItems.length > 0 ? (
						pageItems.map((item) => (
							<div className="history-preview-item" key={item.id} onClick={() => handleHistorySelect(item.id)}>
								<div className="history-task-content">
									{item.isFavorited && (
										<span
											aria-label="Favorited"
											className="codicon codicon-star-full"
											style={{
												color: "var(--vscode-button-background)",
												flexShrink: 0,
											}}
										/>
									)}
									<div className="history-task-description ph-no-capture">{item.task}</div>
									{item.isLegacy && <span className="history-cost-chip">Legacy</span>}
								</div>
								<div className="history-meta-stack">
									<span className="history-date">{formatDate(item.ts)}</span>
									{item.totalCost != null && isCostVisible(item.apiProvider) && (
										<span className="history-cost-chip">${item.totalCost.toFixed(2)}</span>
									)}
								</div>
							</div>
						))
					) : (
						<div
							style={{
								textAlign: "center",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "var(--vscode-font-size)",
								padding: "10px 0",
							}}>
							No recent tasks
						</div>
					)}
					{totalPages > 1 && (
						<div className="history-pagination">
							<button
								aria-label="Previous page"
								className="history-page-btn"
								disabled={currentPage <= 1}
								onClick={() => setPage(currentPage - 1)}
								type="button">
								<span className="codicon codicon-chevron-left" />
								Previous
							</button>
							<span className="history-page-indicator">
								Page {currentPage} of {totalPages}
							</span>
							<button
								aria-label="Next page"
								className="history-page-btn"
								disabled={currentPage >= totalPages}
								onClick={() => setPage(currentPage + 1)}
								type="button">
								Next
								<span className="codicon codicon-chevron-right" />
							</button>
						</div>
					)}
				</div>
			}
		</div>
	)
}

export default memo(HistoryPreview)
