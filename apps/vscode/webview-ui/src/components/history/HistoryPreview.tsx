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

/** Normalizes a filesystem path for workspace comparison (separator, case, trailing slash). */
const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/** Returns the last path segment (repository folder name). */
const getRepoName = (path: string): string => {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
	return parts[parts.length - 1] ?? path
}

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const { taskHistory, workspaceRoots } = useExtensionState()
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

	// Paths of this window's workspace roots, used to tell tasks that belong to
	// the current repository apart from tasks started in other repositories.
	const currentRootPaths = useMemo(() => new Set(workspaceRoots.map((root) => normalizePath(root.path))), [workspaceRoots])

	// Page numbers shown in the pager: all of them when there are few,
	// otherwise a window around the current page with ellipses (1 … 4 5 6 … 12).
	const pageNumbers = useMemo<(number | "…")[]>(() => {
		if (totalPages <= 7) {
			return Array.from({ length: totalPages }, (_, i) => i + 1)
		}
		const pages = [1, totalPages, currentPage - 1, currentPage, currentPage + 1]
			.filter((p) => p >= 1 && p <= totalPages)
			.sort((a, b) => a - b)
		const result: (number | "…")[] = []
		let previous = 0
		for (const p of pages) {
			if (p - previous > 1) {
				result.push("…")
			}
			result.push(p)
			previous = p
		}
		return result
	}, [currentPage, totalPages])

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
					.history-preview-item-external {
						background-color: color-mix(in srgb, var(--vscode-charts-yellow, #dcdcaa) 18%, transparent);
					}
					.history-preview-item-external:hover {
						background-color: color-mix(in srgb, var(--vscode-charts-yellow, #dcdcaa) 28%, transparent);
					}
					.history-date-row {
						display: inline-flex;
						align-items: center;
						gap: 6px;
						max-width: 100%;
					}
					.history-repo-chip {
						display: inline-flex;
						align-items: center;
						gap: 3px;
						color: var(--vscode-foreground);
						font-size: 0.8em;
						background-color: color-mix(in srgb, var(--vscode-charts-yellow, #dcdcaa) 38%, transparent);
						border-radius: 4px;
						padding: 1px 6px;
						max-width: 120px;
						min-width: 0;
					}
					.history-repo-name {
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-text {
						flex: 1;
						min-width: 0;
						display: flex;
						flex-direction: column;
						gap: 2px;
					}
					.history-task-title {
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						font-weight: 600;
						line-height: 1.4;
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
						align-items: flex-end;
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
						justify-content: center;
						gap: 2px;
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
					.history-page-num {
						background: none;
						border: none;
						border-radius: 3px;
						min-width: 22px;
						padding: 2px 6px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
					}
					.history-page-num:hover:not(.active) {
						color: var(--vscode-foreground);
						background-color: var(--vscode-toolbar-hoverBackground);
					}
					.history-page-num.active {
						color: var(--vscode-button-foreground);
						background-color: var(--vscode-button-background);
						cursor: default;
					}
					.history-page-ellipsis {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						padding: 0 2px;
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
						pageItems.map((item) => {
							const cwd = item.cwdOnTaskInitialization
							const isExternalRepo = !!cwd && !currentRootPaths.has(normalizePath(cwd))
							const repoName = cwd ? getRepoName(cwd) : undefined
							return (
								<div
									className={`history-preview-item${isExternalRepo ? " history-preview-item-external" : ""}`}
									key={item.id}
									onClick={() => handleHistorySelect(item.id)}>
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
										<div className="history-task-text">
											{item.customTitle ? (
												<div className="history-task-title ph-no-capture" title={item.customTitle}>
													{item.customTitle}
												</div>
											) : null}
											<div className="history-task-description ph-no-capture">{item.task}</div>
										</div>
										{item.isLegacy && <span className="history-cost-chip">Legacy</span>}
									</div>
									<div className="history-meta-stack">
										<span className="history-date-row">
											{isExternalRepo && repoName && (
												<span className="history-repo-chip" title={cwd}>
													<span className="codicon codicon-folder" />
													<span className="history-repo-name">{repoName}</span>
												</span>
											)}
											<span className="history-date">{formatDate(item.ts)}</span>
										</span>
										{item.totalCost != null && isCostVisible(item.apiProvider) && (
											<span className="history-cost-chip">${item.totalCost.toFixed(2)}</span>
										)}
									</div>
								</div>
							)
						})
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
							</button>
							{pageNumbers.map((pageNumber, index) =>
								pageNumber === "…" ? (
									<span className="history-page-ellipsis" key={`ellipsis-${index}`}>
										…
									</span>
								) : (
									<button
										aria-current={pageNumber === currentPage ? "page" : undefined}
										aria-label={`Go to page ${pageNumber}`}
										className={pageNumber === currentPage ? "history-page-num active" : "history-page-num"}
										disabled={pageNumber === currentPage}
										key={pageNumber}
										onClick={() => setPage(pageNumber)}
										type="button">
										{pageNumber}
									</button>
								),
							)}
							<button
								aria-label="Next page"
								className="history-page-btn"
								disabled={currentPage >= totalPages}
								onClick={() => setPage(currentPage + 1)}
								type="button">
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
