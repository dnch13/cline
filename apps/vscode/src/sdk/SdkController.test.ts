import { describe, expect, it, vi } from "vitest"
import { telemetryService } from "@/services/telemetry"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { Controller as SdkController } from "./SdkController"
import { type RetryAttemptInfo, SdkApiRetryCoordinator } from "./sdk-api-retry-coordinator"
import type { SdkTurnOutcome } from "./sdk-session-lifecycle"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import { resolveWorkspaceManagerPaths, resolveWorkspaceRootPath } from "./workspace-root"

// handleTurnSettled and reDriveAutoRetry are private; tests invoke them on fake
// controllers through this typed view of the prototype.
const privateControllerProto = SdkController.prototype as unknown as {
	handleTurnSettled: (this: never, sessionId: string, outcome: SdkTurnOutcome) => Promise<void>
	reDriveAutoRetry: (this: never, sessionId: string, isCancelled: () => boolean) => Promise<void>
	emitAutoRetryScheduled: (this: never, info: RetryAttemptInfo) => void
	settleAbandonedRetryPhase: (this: never) => void
	settleRecoveredAutoRetry: (this: never) => void
}

describe("isClineManagedProvider", () => {
	it("treats both Cline account providers as Cline providers", () => {
		expect(isClineManagedProvider("cline")).toBe(true)
		expect(isClineManagedProvider("cline-pass")).toBe(true)
		expect(isClineManagedProvider("anthropic")).toBe(false)
		expect(isClineManagedProvider(undefined)).toBe(false)
	})
})

describe("resolveWorkspaceRootPath", () => {
	it("uses the first non-empty workspace path when available", () => {
		expect(resolveWorkspaceRootPath(["", "/workspace"], "/Users/tester/Desktop")).toBe("/workspace")
	})

	it("falls back to Desktop when no workspace folder is open", () => {
		expect(resolveWorkspaceRootPath([], "/Users/tester/Desktop")).toBe("/Users/tester/Desktop")
	})
})

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureRemoteConfigSessionGate: vi.fn(),
	},
}))

const { buildBaseStateMock } = vi.hoisted(() => ({
	buildBaseStateMock: vi.fn(async () => ({ taskHistory: [] })),
}))
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({
	getStateToPostToWebview: buildBaseStateMock,
}))

describe("SDK remote-config coordination", () => {
	it("posts the current remote-config revision to the webview", async () => {
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: true,
			currentRemoteConfigRevision: 7,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: { listHistory: async () => [] },
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
		}

		await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledWith(
			expect.objectContaining({ isRemoteConfigAvailable: true, currentRemoteConfigRevision: 7 }),
		)
	})

	it("rebuilds the snapshot when the epoch moves while the state is being built", async () => {
		buildBaseStateMock.mockClear()
		const minter = { epoch: 1, nextSeq: () => 1 }
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: false,
			currentRemoteConfigRevision: undefined,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: {
				listHistory: async () => {
					// A conversation boundary (follow-up on an idle session) bumps the
					// epoch while this snapshot's transcript copy is already taken.
					minter.epoch = 2
					return []
				},
			},
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => minter },
			getStateToPostToWebview: SdkController.prototype.getStateToPostToWebview,
		}

		const state = await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledTimes(2)
		expect(state.epoch).toBe(2)
	})

	it("keys refreshes by the current user and organization", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({ user: { uid: "user-1" } }),
				getActiveOrganizationId: () => "org-1",
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("user-1:org-1", {})
	})

	it("uses a stable signed-out identity so startup refresh can settle", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({}),
				getActiveOrganizationId: () => null,
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("signed-out:no-org", {})
	})

	it("refreshes remote config after login before posting authenticated state", async () => {
		const events: string[] = []
		const controller = {
			authService: { handleAuthCallback: vi.fn(async () => events.push("auth")) },
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.handleAuthCallback.call(controller as never, "token", "cline")

		expect(events).toEqual(["auth", "refresh", "post"])
	})

	it("rematerializes policy and ends the active session after a managed toggle", async () => {
		const events: string[] = []
		const controller = {
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			sessions: {
				endActiveSession: vi.fn(async () => {
					events.push("end")
				}),
			},
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.rematerializeRemoteConfig.call(controller as never)

		expect(events).toEqual(["refresh", "end", "post"])
		expect(controller.sessions.endActiveSession).toHaveBeenCalledWith("remoteConfigToggle", { awaitStop: true })
	})

	it("allows the current organization to start with its last known-good policy after a transient failure", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => "org-current" },
			remoteConfigBundle: { metadata: { organizationId: "org-current" } },
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "last_known_good", managed: true }),
		)
	})

	it("does not block session start for users without an active organization when refresh fails", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => undefined },
			remoteConfigBundle: undefined,
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unmanaged", managed: false }),
		)
	})

	it("does not block unmanaged session start when the refresh rejects instead of returning false", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => undefined },
			remoteConfigBundle: undefined,
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unmanaged", managed: false }),
		)
	})

	it("blocks session start when the install was managed but the identity cannot be resolved", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => "org-previous" },
			remoteConfigBundle: undefined,
		}

		await expect(SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never)).rejects.toThrow(
			"Could not verify organization policy",
		)
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "blocked", managed: true }),
		)
	})

	it("blocks session start when current organization policy cannot be verified", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => "org-new" },
			remoteConfigBundle: { metadata: { organizationId: "org-old" } },
		}

		await expect(SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never)).rejects.toThrow(
			"Could not verify organization policy",
		)
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "blocked", managed: true }),
		)
	})

	it("does not enter task startup until initial remote config is ready", async () => {
		let finishPolicyCheck!: () => void
		const policyReady = new Promise<void>((resolve) => {
			finishPolicyCheck = resolve
		})
		const events: string[] = []
		const initTask = vi.fn(async () => {
			events.push("task")
			return "task-id"
		})
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => {
				await policyReady
				events.push("policy")
			}),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { initTask },
		}

		const taskPromise = SdkController.prototype.initTask.call(controller as never, "start immediately")
		await Promise.resolve()
		expect(initTask).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()

		finishPolicyCheck()
		const taskId = await taskPromise

		expect(taskId).toBe("task-id")
		expect(events).toEqual(["policy", "task"])
		expect(initTask).toHaveBeenCalledWith("start immediately", undefined, undefined, undefined, undefined)
	})

	describe("after a Cline sign-in error offers to retry a prompt", () => {
		function controllerShowingSignInError(options: { existingTask?: boolean } = {}) {
			const controller = {
				task: undefined as TaskProxy | undefined,
				turnStateTracker: { set: vi.fn(), get: () => ({ phase: "error" }) },
				messageTranslatorState: { clearTurnOutcome: vi.fn() },
				messages: { appendAndEmit: vi.fn() },
				sessions: { getActiveSession: () => undefined },
				postStateToWebview: vi.fn(async () => {}),
				initTask: vi.fn(async () => "task-id"),
				followups: { askResponse: vi.fn(async () => {}) },
				cancelTask: vi.fn(async () => {}),
				// askResponse settles any live recovery marker before driving the funnel.
				settleLiveAutoRecoveryMarker: vi.fn(),
				apiRetry: { cancel: vi.fn() },
				askResponse(prompt?: string, images?: string[], files?: string[]) {
					return SdkController.prototype.askResponse.call(controller as never, prompt, images, files)
				},
			}
			const openTask = (taskId: string) => {
				controller.task = createTaskProxy(taskId, controller.askResponse, controller.cancelTask)
				return controller.task
			}
			if (options.existingTask) {
				openTask("existing-task")
			}
			SdkController.prototype["emitClineAuthError"].call(controller as never, "original prompt")
			const errorTask = controller.task
			if (!errorTask) {
				throw new Error("The sign-in error did not leave a task to answer")
			}
			return { controller, errorTask, openTask }
		}

		it("restarts a new task with the original prompt when Retry is clicked", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("yesButtonClicked")
			expect(controller.initTask).toHaveBeenCalledWith("original prompt", undefined, undefined)
			expect(controller.followups.askResponse).not.toHaveBeenCalled()
		})

		it("restarts a new task with a revised prompt submitted from the composer", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("messageResponse", "revised prompt", ["img"])
			expect(controller.initTask).toHaveBeenCalledWith("revised prompt", ["img"], undefined)
			expect(controller.followups.askResponse).not.toHaveBeenCalled()
		})

		it("keeps the original prompt when the revised submission has attachments but no text", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("messageResponse", "  ", ["img"])
			expect(controller.initTask).toHaveBeenCalledWith("original prompt", ["img"], undefined)
		})

		it("continues an existing conversation with a message submitted from the composer", async () => {
			const { controller, errorTask } = controllerShowingSignInError({ existingTask: true })
			await errorTask.handleWebviewAskResponse("messageResponse", "follow-up")
			expect(controller.initTask).not.toHaveBeenCalled()
			expect(controller.task).toBe(errorTask)
			expect(controller.followups.askResponse).toHaveBeenCalledWith(
				"follow-up",
				undefined,
				undefined,
				"messageResponse",
				"error",
			)

			// The follow-up answered the error, so a later approval continues the conversation.
			await errorTask.handleWebviewAskResponse("yesButtonClicked")
			expect(controller.initTask).not.toHaveBeenCalled()
		})

		it("does not restart the failed prompt from a task opened afterwards", async () => {
			const { controller, openTask } = controllerShowingSignInError()
			const historyTask = openTask("history-task")
			await historyTask.handleWebviewAskResponse("yesButtonClicked", "resume here")
			expect(controller.initTask).not.toHaveBeenCalled()
			expect(controller.followups.askResponse).toHaveBeenCalledWith(
				"resume here",
				undefined,
				undefined,
				"yesButtonClicked",
				"error",
			)
		})
	})

	it("waits for initial remote config before resuming an existing task", async () => {
		const events: string[] = []
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => events.push("policy")),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { reinitExistingTaskFromId: vi.fn(async () => events.push("resume")) },
		}

		await SdkController.prototype.reinitExistingTaskFromId.call(controller as never, "task-id")

		expect(events).toEqual(["policy", "resume"])
	})
})

describe("hasWorkspaceCheckpointForMessage", () => {
	const messages = [
		{ ts: 1, type: "say", say: "task", text: "start" },
		{ ts: 2, type: "say", say: "text", text: "done" },
		{ ts: 3, type: "say", say: "user_feedback", text: "continue" },
	]
	const sdkMessages = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: "done" },
		{ role: "user", content: "continue" },
	]

	it("reads the live conversation of the active session", async () => {
		const readLiveMessages = vi.fn().mockResolvedValue(sdkMessages)
		const readMessages = vi.fn().mockResolvedValue([])
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: {
				getActiveSession: () => ({
					sessionId: "task-a",
					sdkHost: {
						get: async () => ({
							metadata: { checkpoint: { history: [{ ref: "checkpoint-b", createdAt: 1, runCount: 2 }] } },
						}),
						readLiveMessages,
						readMessages,
					},
				}),
			},
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(true)
		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(false)
		expect(readLiveMessages).toHaveBeenCalledWith("task-a")
		expect(readMessages).not.toHaveBeenCalled()
	})

	it("agrees with editMessageAndRegenerate on which messages exist while the transcript lags", async () => {
		// The persisted transcript is written after Core reports the turn done,
		// so it can still lack the newest user message while its checkpoint exists.
		const readLiveMessages = vi.fn().mockResolvedValue(sdkMessages)
		const readMessages = vi.fn().mockResolvedValue(sdkMessages.slice(0, 2))
		const restore = vi.fn().mockRejectedValue(new Error("stop at restore"))
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: {
				getActiveSession: () => ({
					sessionId: "task-a",
					isRunning: false,
					sdkHost: {
						get: async () => ({
							cwd: "C:/work",
							metadata: { checkpoint: { history: [{ ref: "checkpoint-b", createdAt: 1, runCount: 2 }] } },
						}),
						readLiveMessages,
						readMessages,
						restore,
					},
				}),
			},
			taskHistory: { findHistoryItem: async () => undefined },
			getWorkspaceRoot: async () => "C:/work",
			stateManager: { getGlobalSettingsKey: () => "act" },
			sessionConfigBuilder: { build: async () => ({ providerId: "anthropic", apiKey: "key", modelId: "model" }) },
			resolveContextMentions: async (text: string) => text,
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(true)
		await expect(
			SdkController.prototype.editMessageAndRegenerate.call(controller as never, {
				messageTs: 3,
				text: "continue, edited",
				restoreWorkspace: true,
			}),
		).rejects.toThrow("stop at restore")
		expect(restore).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "task-a", checkpointRunCount: 2 }))
		expect(readMessages).not.toHaveBeenCalled()
	})

	it("uses and disposes a temporary host for a history task", async () => {
		const tempHost = {
			get: vi.fn().mockResolvedValue({
				metadata: { checkpoint: { history: [{ ref: "checkpoint-a", createdAt: 1, runCount: 1 }] } },
			}),
			readMessages: vi.fn().mockResolvedValue(sdkMessages),
			dispose: vi.fn().mockRejectedValue(new Error("cleanup failed")),
		}
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: { getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost: vi.fn().mockResolvedValue(tempHost),
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(true)
		expect(tempHost.get).toHaveBeenCalledWith("task-a")
		expect(tempHost.dispose).toHaveBeenCalledWith("workspaceCheckpointForMessage")
	})

	it("reports no checkpoint when the host cannot be read", async () => {
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: { getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost: vi.fn().mockRejectedValue(new Error("host unavailable")),
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(false)
	})

	it("reports no checkpoint for messages that did not start a run", async () => {
		const answerMessages = [
			{ ts: 1, type: "say", say: "task", text: "start" },
			{ ts: 2, type: "ask", ask: "followup", text: "which file?" },
			{ ts: 3, type: "say", say: "user_feedback", text: "src/index.ts" },
		]
		const createRemoteConfigAwareSessionHost = vi.fn()
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => answerMessages } },
			sessions: { getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost,
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(false)
		expect(createRemoteConfigAwareSessionHost).not.toHaveBeenCalled()
	})
})

describe("resolveWorkspaceManagerPaths", () => {
	it("returns the host's workspace folder paths, dropping blank entries", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace", "  ", "/other"], "/Users/tester/Desktop")).toEqual([
			"/workspace",
			"/other",
		])
	})

	it("falls back to a single root when no workspace folder is open", () => {
		// Legacy-parity: an empty VS Code window must still yield a usable root
		// so @-mention file search doesn't fail with workspace_unavailable.
		expect(resolveWorkspaceManagerPaths([], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(undefined, "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(["", "   "], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
	})

	it("prefers real workspace folders over the fallback", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace"], "/Users/tester/Desktop")).toEqual(["/workspace"])
	})

	it("returns no roots when the fallback is also unavailable", () => {
		expect(resolveWorkspaceManagerPaths([], undefined)).toEqual([])
		expect(resolveWorkspaceManagerPaths([], "  ")).toEqual([])
	})
})

describe("turn failure boundary (handleTurnSettled)", () => {
	/** Fake controller surface exercised by handleTurnSettled. */
	function makeBoundaryFake(overrides: Record<string, unknown> = {}) {
		return {
			diffEdits: { discardAllPreviews: vi.fn() },
			apiRetry: { reset: vi.fn(), cancel: vi.fn(), handleSendError: vi.fn(() => true) },
			postStateToWebview: vi.fn(() => Promise.resolve()),
			getSessionProviderId: vi.fn(() => "anthropic"),
			getActiveProviderId: vi.fn(() => "anthropic"),
			isClineBalanceError: vi.fn(() => false),
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: true })),
			captureProviderFailure: vi.fn(),
			emitClineAuthError: vi.fn(),
			emitClineBalanceError: vi.fn(),
			emitAgentError: vi.fn(),
			turnStateTracker: { set: vi.fn() },
			settleAbandonedRetryPhase: vi.fn(),
			interactions: {
				settleAutoRecovery: vi.fn(),
				resetMistakeEscalation: vi.fn(),
				// Guard used by the live-marker settle path; inert by default.
				isAutoRecoveryActive: vi.fn((): boolean => false),
				beginAutoRecoveryCountdown: vi.fn(),
				markAutoRecoveryRetrying: vi.fn(),
			},
			// Delegates exactly like the real helper so assertions on
			// interactions.settleAutoRecovery exercise the boundary's behavior.
			settleLiveAutoRecoveryMarker: vi.fn(function (this: {
				interactions?: { settleAutoRecovery: () => void }
			}) {
				this.interactions?.settleAutoRecovery()
			}),
			...overrides,
		}
	}

	it("resets the retry streak and discards previews when a turn completes", async () => {
		const controller = makeBoundaryFake()

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", { status: "completed" })

		expect(controller.diffEdits.discardAllPreviews).toHaveBeenCalledWith("turn complete")
		expect(controller.apiRetry.reset).toHaveBeenCalledOnce()
		expect(controller.apiRetry.handleSendError).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()
	})

	it("schedules exactly one retry for a retryable send rejection and keeps the phase streaming", async () => {
		const controller = makeBoundaryFake()
		const error = new Error("socket hang up")

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error,
			source: "send_rejection",
		})

		expect(controller.diffEdits.discardAllPreviews).toHaveBeenCalledWith("turn error")
		// Exactly one schedule per failed turn — the boundary never sees the
		// event-channel duplicate of this failure.
		expect(controller.apiRetry.handleSendError).toHaveBeenCalledExactlyOnceWith(error, "session-123", undefined)
		expect(controller.turnStateTracker.set).not.toHaveBeenCalledWith("error")
		expect(controller.emitAgentError).toHaveBeenCalledWith("session-123", "Agent error: socket hang up", "running")
	})

	it("passes a server-provided Retry-After through to the coordinator", async () => {
		const controller = makeBoundaryFake({
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: true, retryAfterSeconds: 42 })),
		})
		const error = Object.assign(new Error("rate limited"), { statusCode: 429 })

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error,
			source: "agent_event",
		})

		expect(controller.apiRetry.handleSendError).toHaveBeenCalledExactlyOnceWith(error, "session-123", 42)
	})

	it("settles the phase on error recovery when a send rejection is not retryable", async () => {
		const controller = makeBoundaryFake({
			// Unmatched failure (e.g. unfamiliar 400): typed classification says permanent.
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: false })),
		})
		const error = new Error("prompt is too long")

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error,
			source: "send_rejection",
		})

		expect(controller.apiRetry.handleSendError).not.toHaveBeenCalled()
		// The streak is over — its counter must not leak into a future streak.
		expect(controller.apiRetry.reset).toHaveBeenCalledOnce()
		expect(controller.turnStateTracker.set).toHaveBeenCalledWith("error")
		expect(controller.emitAgentError).toHaveBeenCalledWith("session-123", "Agent error: prompt is too long", "error")
	})

	it("applies retry policy to event-delivered failures without re-rendering them", async () => {
		const controller = makeBoundaryFake()
		const error = new Error("fetch failed")

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error,
			source: "agent_event",
		})

		// The event stream already rendered the error and captured its provider
		// failure telemetry; the boundary only applies retry policy.
		expect(controller.apiRetry.handleSendError).toHaveBeenCalledExactlyOnceWith(error, "session-123", undefined)
		expect(controller.emitAgentError).not.toHaveBeenCalled()
		expect(controller.captureProviderFailure).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()
	})

	it("routes auth failures to sign-in instead of the retry loop", async () => {
		const controller = makeBoundaryFake({
			getSessionProviderId: vi.fn(() => "cline"),
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: false })),
		})

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error: new Error("Unauthorized: missing api key"),
			source: "send_rejection",
		})

		expect(controller.emitClineAuthError).toHaveBeenCalledOnce()
		expect(controller.apiRetry.handleSendError).not.toHaveBeenCalled()
		expect(controller.emitAgentError).not.toHaveBeenCalled()
	})

	it("emits the failure row before scheduling the retry marker", async () => {
		// The webview binds the countdown marker to the nearest PRECEDING error
		// block (findActiveRecoveryDecoration), so the error row must already
		// exist when the marker lands — otherwise the marker reaches back to a
		// previous streak's error and the hold truncates the chat at it.
		const order: string[] = []
		const controller = makeBoundaryFake({
			emitAgentError: vi.fn(() => order.push("error-row")),
			apiRetry: {
				reset: vi.fn(),
				cancel: vi.fn(),
				handleSendError: vi.fn(() => {
					order.push("schedule")
					return true
				}),
			},
		})

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error: new Error("socket hang up"),
			source: "send_rejection",
		})

		expect(order).toEqual(["error-row", "schedule"])
	})

	it("folds a repeat send rejection into the live streak instead of stacking another error row", async () => {
		// Failure #2+ of a streak: the marker is already armed on the first
		// failure's error block, so the countdown re-arms in place — no new
		// row per failed attempt (the "3 stacked errors" bug).
		const controller = makeBoundaryFake({
			// A marker is live from failure #1.
			interactions: {
				settleAutoRecovery: vi.fn(),
				resetMistakeEscalation: vi.fn(),
				isAutoRecoveryActive: vi.fn((kind: string) => kind === "api"),
				beginAutoRecoveryCountdown: vi.fn(),
				markAutoRecoveryRetrying: vi.fn(),
			},
		})
		const error = new Error("socket hang up again")

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error,
			source: "send_rejection",
		})

		expect(controller.apiRetry.handleSendError).toHaveBeenCalledExactlyOnceWith(error, "session-123", undefined)
		expect(controller.emitAgentError).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalledWith("error")
	})

	it("emits a final error row and resets the schedule when a permanent failure kills a live streak", async () => {
		const controller = makeBoundaryFake({
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: false })),
			interactions: {
				settleAutoRecovery: vi.fn(),
				resetMistakeEscalation: vi.fn(),
				isAutoRecoveryActive: vi.fn((kind: string) => kind === "api"),
				beginAutoRecoveryCountdown: vi.fn(),
				markAutoRecoveryRetrying: vi.fn(),
			},
		})

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error: new Error("Invalid API key"),
			source: "send_rejection",
		})

		// The streak's decorated block still says "running" — the terminal
		// reason needs its own row, and the counter must not leak.
		expect(controller.emitAgentError).toHaveBeenCalledWith("session-123", "Agent error: Invalid API key", "error")
		expect(controller.apiRetry.reset).toHaveBeenCalledOnce()
		expect(controller.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
		expect(controller.turnStateTracker.set).toHaveBeenCalledWith("error")
	})

	it("settles a live recovery marker when a permanent send rejection ends the streak", async () => {
		const controller = makeBoundaryFake({
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: false })),
		})

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error: new Error("prompt is too long"),
			source: "send_rejection",
		})

		expect(controller.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
	})

	it("settles a live recovery marker when a permanent event-delivered failure ends the streak", async () => {
		const controller = makeBoundaryFake({
			classifyAutoRetryFailure: vi.fn(() => ({ retryable: false })),
		})

		await privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
			status: "failed",
			error: new Error("Unauthorized"),
			source: "agent_event",
		})

		expect(controller.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
	})
})

describe("filterDuplicateRecoveryErrors folds retried-attempt failure rows", () => {
	const rows = [
		{ type: "say", say: "error", text: "Agent error: socket hang up", ts: 1, partial: false },
		{ type: "say", say: "text", text: "partial retry output", ts: 2, partial: true },
	] as never[]

	it("drops event-stream error rows while the api streak is live", () => {
		const controller = {
			interactions: { isAutoRecoveryActive: vi.fn(() => true) },
		}

		const filtered = (
			SdkController.prototype as unknown as {
				filterDuplicateRecoveryErrors: (this: never, messages: never[]) => never[]
			}
		).filterDuplicateRecoveryErrors.call(controller as never, rows)

		// Only the proving output row survives; the retried attempt's failure
		// folds into the streak's decorated block (which landed pre-arm).
		expect(filtered).toEqual([rows[1]])
	})

	it("keeps error rows when no streak is live", () => {
		const controller = {
			interactions: { isAutoRecoveryActive: vi.fn(() => false) },
		}

		const filtered = (
			SdkController.prototype as unknown as {
				filterDuplicateRecoveryErrors: (this: never, messages: never[]) => never[]
			}
		).filterDuplicateRecoveryErrors.call(controller as never, rows)

		expect(filtered).toEqual(rows)
	})
})

describe("auto-recovery marker settles when no action is in flight", () => {
	it("cancelTask settles a live marker before the session is torn down", async () => {
		const order: string[] = []
		const fake = {
			apiRetry: { cancel: vi.fn(() => order.push("apiRetry.cancel")) },
			interactions: { settleAutoRecovery: vi.fn(() => order.push("settle")) },
			settleLiveAutoRecoveryMarker: vi.fn(function (this: {
				interactions?: { settleAutoRecovery: () => void }
			}) {
				this.interactions?.settleAutoRecovery()
			}),
			turnStateTracker: { set: vi.fn(() => order.push("phase")) },
			taskControl: { cancelTask: vi.fn(async () => order.push("taskControl")) },
		}

		await SdkController.prototype.cancelTask.call(fake as never)

		// The settle must precede taskControl.cancelTask() — the marker row can
		// only be rewritten while this session is still the active one.
		expect(order).toEqual(["apiRetry.cancel", "settle", "phase", "taskControl"])
	})

	it("clearTask settles a live marker while the session is still active", async () => {
		const order: string[] = []
		const fake = {
			pendingClineAuthRetryPrompt: "prompt",
			apiRetry: { cancel: vi.fn(() => order.push("apiRetry.cancel")) },
			interactions: { settleAutoRecovery: vi.fn(() => order.push("settle")) },
			settleLiveAutoRecoveryMarker: vi.fn(function (this: {
				interactions?: { settleAutoRecovery: () => void }
			}) {
				this.interactions?.settleAutoRecovery()
			}),
			turnStateTracker: { set: vi.fn() },
			taskControl: { clearTask: vi.fn(async () => order.push("taskControl")) },
			postStateToWebview: vi.fn(async () => order.push("post")),
		}

		await SdkController.prototype.clearTask.call(fake as never)

		expect(order.indexOf("settle")).toBeLessThan(order.indexOf("taskControl"))
	})
})

describe("recovered auto-retry releases the hold (settleRecoveredAutoRetry)", () => {
	it("settles a live marker when the retried turn streams model output", () => {
		const controller = {
			interactions: {
				isAutoRecoveryActive: vi.fn(() => true),
				settleAutoRecovery: vi.fn(),
			},
		}

		privateControllerProto.settleRecoveredAutoRetry.call(controller as never)

		expect(controller.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
	})

	it("resets the fibonacci schedule when an api streak recovers, so later failures start at attempt 1", () => {
		// A recovery that streams output has proven itself: the streak's
		// backoff counter must not survive into the next failure (the
		// "counter keeps climbing after successful recoveries" bug).
		const controller = {
			apiRetry: { reset: vi.fn() },
			interactions: {
				isAutoRecoveryActive: vi.fn((kind: string) => kind === "api"),
				settleAutoRecovery: vi.fn(),
			},
		}

		privateControllerProto.settleRecoveredAutoRetry.call(controller as never)

		expect(controller.apiRetry.reset).toHaveBeenCalledOnce()
		expect(controller.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
	})

	it("does not touch the api schedule when only a mistake streak is live", () => {
		const controller = {
			apiRetry: { reset: vi.fn() },
			interactions: {
				isAutoRecoveryActive: vi.fn((kind: string) => kind === "mistake"),
				settleAutoRecovery: vi.fn(),
			},
		}

		privateControllerProto.settleRecoveredAutoRetry.call(controller as never)

		expect(controller.apiRetry.reset).not.toHaveBeenCalled()
		expect(controller.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
	})

	it("is a no-op when no streak is live", () => {
		const controller = {
			interactions: {
				// Neither recovery loop owns a live marker.
				isAutoRecoveryActive: vi.fn(() => false),
				settleAutoRecovery: vi.fn(),
			},
		}

		privateControllerProto.settleRecoveredAutoRetry.call(controller as never)

		expect(controller.interactions.settleAutoRecovery).not.toHaveBeenCalled()
	})

	it("a user-driven askResponse kills the pending streak before the new turn starts", async () => {
		const order: string[] = []
		const fake = {
			task: undefined,
			pendingClineAuthRetryPrompt: undefined,
			apiRetry: { cancel: vi.fn(() => order.push("apiRetry.cancel")) },
			interactions: { settleAutoRecovery: vi.fn(() => order.push("settle")) },
			settleLiveAutoRecoveryMarker: vi.fn(function (this: {
				interactions?: { settleAutoRecovery: () => void }
			}) {
				this.interactions?.settleAutoRecovery()
			}),
			turnStateTracker: {
				get: vi.fn(() => ({ phase: "retrying" })),
				set: vi.fn(() => order.push("phase")),
			},
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			postStateToWebview: vi.fn(() => Promise.resolve()),
			followups: { askResponse: vi.fn(async () => order.push("funnel")) },
		}

		await SdkController.prototype.askResponse.call(fake as never)

		// The streak must die (timer cancelled, marker settled) BEFORE the new
		// turn drives the funnel — otherwise its rows render under a live hold.
		expect(order.indexOf("apiRetry.cancel")).toBeLessThan(order.indexOf("funnel"))
		expect(order.indexOf("settle")).toBeLessThan(order.indexOf("funnel"))
	})
})

describe("auto-retry re-drive (reDriveAutoRetry)", () => {
	function makeReDriveFake(overrides: Record<string, unknown> = {}) {
		return {
			sessions: {
				getActiveSession: vi.fn(() => ({ sessionId: "session-123", isRunning: false })),
			},
			task: { taskId: "session-123" },
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			postStateToWebview: vi.fn(() => Promise.resolve()),
			followups: { askResponse: vi.fn(() => Promise.resolve()) },
			// Abandon/settle collaborators: without these the abandon paths
			// throw into reDriveAutoRetry's catch (which used to swallow it).
			settleAbandonedRetryPhase: vi.fn(),
			settleLiveAutoRecoveryMarker: vi.fn(),
			...overrides,
		}
	}

	it("re-drives the idle failed session through the normal follow-up funnel", async () => {
		const controller = makeReDriveFake()

		await privateControllerProto.reDriveAutoRetry.call(controller as never, "session-123", () => false)

		// Mirror of askResponse's pre-set: the footer flips to streaming and
		// the completion signal resets before the retried turn starts.
		expect(controller.turnStateTracker.set).toHaveBeenCalledWith("streaming")
		expect(controller.messageTranslatorState.clearTurnOutcome).toHaveBeenCalledOnce()
		expect(controller.followups.askResponse).toHaveBeenCalledExactlyOnceWith(
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			expect.any(Function),
		)
	})

	it("does not re-drive when another turn owns the session", async () => {
		const controller = makeReDriveFake({
			sessions: { getActiveSession: vi.fn(() => ({ sessionId: "session-123", isRunning: true })) },
		})

		await privateControllerProto.reDriveAutoRetry.call(controller as never, "session-123", () => false)

		expect(controller.followups.askResponse).not.toHaveBeenCalled()
	})

	it("does not re-drive when the displayed task moved on", async () => {
		const controller = makeReDriveFake({ task: { taskId: "another-task" } })

		await privateControllerProto.reDriveAutoRetry.call(controller as never, "session-123", () => false)

		expect(controller.followups.askResponse).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()
	})

	it("aborts before re-driving when the retry was already cancelled", async () => {
		const controller = makeReDriveFake()

		await privateControllerProto.reDriveAutoRetry.call(controller as never, "session-123", () => true)

		expect(controller.followups.askResponse).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()
		expect(controller.messageTranslatorState.clearTurnOutcome).not.toHaveBeenCalled()
	})

	it("settles the pre-set phase to resumable when cancellation aborts the send mid-funnel", async () => {
		let cancelled = false
		const controller = makeReDriveFake({
			followups: { askResponse: vi.fn(async () => (cancelled = true)) },
		})

		await privateControllerProto.reDriveAutoRetry.call(controller as never, "session-123", () => cancelled)

		expect(controller.followups.askResponse).toHaveBeenCalledOnce()
		expect(controller.turnStateTracker.set).toHaveBeenCalledWith("resumable")
	})

	it("keeps the cancelling flow's own phase when the task moved on mid-funnel", async () => {
		let cancelled = false
		const controller = makeReDriveFake()
		controller.followups.askResponse = vi.fn(async () => {
			cancelled = true
			controller.task = { taskId: "another-task" }
		})

		await privateControllerProto.reDriveAutoRetry.call(controller as never, "session-123", () => cancelled)

		expect(controller.turnStateTracker.set).not.toHaveBeenCalledWith("resumable")
	})
})

describe("auto-retry lifecycle (failed turn → countdown → re-drive)", () => {
	/**
	 * Deterministic timer clock: scheduled retries are captured and fired by the
	 * test instead of waiting real backoff delays, and a cancelled timer can
	 * still be fired to prove the generation guard survives stray wake-ups.
	 */
	function makeManualClock() {
		const timers: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = []
		return {
			timers,
			scheduleTimer: vi.fn((fn: () => void, delayMs: number) => {
				const handle = timers.push({ fn, delayMs, cancelled: false }) - 1
				return handle as unknown as ReturnType<typeof setTimeout>
			}),
			cancelTimer: vi.fn((handle: ReturnType<typeof setTimeout>) => {
				const timer = timers[handle as unknown as number]
				if (timer) {
					timer.cancelled = true
				}
			}),
			fire(index: number): void {
				timers[index]?.fn()
			},
		}
	}

	interface LifecycleHarness {
		controller: Record<string, unknown>
		apiRetry: SdkApiRetryCoordinator
		clock: ReturnType<typeof makeManualClock>
		emitSessionEvents: ReturnType<typeof vi.fn>
		setPhase: ReturnType<typeof vi.fn>
		clearTurnOutcome: ReturnType<typeof vi.fn>
		askResponse: ReturnType<typeof vi.fn>
		/** Auto-recovery marker lifecycle collaborator (settle calls asserted). */
		interactions: { settleAutoRecovery: ReturnType<typeof vi.fn> }
		/** Replace the active session (the session-replacement race). */
		setActiveSession(session: { sessionId: string; isRunning: boolean } | undefined): void
		/** Deliver a turn's terminal outcome to the real handleTurnSettled boundary. */
		settle(source: "agent_event" | "send_rejection", error: unknown): Promise<void>
	}

	/**
	 * The real controller prototype over faked collaborators, with the real
	 * SdkApiRetryCoordinator wired exactly like the constructor (real
	 * classification, real re-drive, manual clock). The boundary tests above
	 * stub the coordinator; these tests exercise the races only the composed
	 * lifecycle produces.
	 */
	function makeLifecycleHarness(): LifecycleHarness {
		const clock = makeManualClock()
		let activeSession: { sessionId: string; isRunning: boolean } | undefined = {
			sessionId: "session-123",
			isRunning: false,
		}
		const emitSessionEvents = vi.fn()
		const setPhase = vi.fn()
		// Phase-aware fake so settleAbandonedRetryPhase()'s currentPhase guard is real.
		const trackerState = { phase: "idle" as string }
		const turnStateTracker = {
			set: (phase: string) => {
				trackerState.phase = phase
				setPhase(phase)
			},
			get currentPhase() {
				return trackerState.phase
			},
		}
		const clearTurnOutcome = vi.fn()
		const askResponse = vi.fn(async () => {})
		const interactions = {
			beginAutoRecoveryCountdown: vi.fn(),
			markAutoRecoveryRetrying: vi.fn(),
			settleAutoRecovery: vi.fn(),
			isAutoRecoveryActive: vi.fn(() => false),
		}
		const controller = Object.create(SdkController.prototype) as Record<string, unknown>
		Object.assign(controller, {
			stateManager: { getGlobalSettingsKey: vi.fn(() => undefined) },
			sessions: { getActiveSession: () => activeSession },
			messages: { emitSessionEvents },
			diffEdits: { discardAllPreviews: vi.fn() },
			postStateToWebview: vi.fn(async () => {}),
			// Unmanaged provider: skips the Cline auth/balance recovery branches.
			getSessionProviderId: vi.fn(() => undefined),
			getActiveProviderId: vi.fn(() => undefined),
			captureProviderFailure: vi.fn(),
			turnStateTracker,
			messageTranslatorState: { clearTurnOutcome },
			task: { taskId: "session-123" },
			followups: { askResponse },
			interactions,
		})
		const apiRetry = new SdkApiRetryCoordinator({
			isSessionActive: (sessionId) => activeSession?.sessionId === sessionId,
			sendTurn: (sessionId, isCancelled) => {
				void privateControllerProto.reDriveAutoRetry.call(controller as never, sessionId, isCancelled)
			},
			emitRetryScheduled: (info) => privateControllerProto.emitAutoRetryScheduled.call(controller as never, info),
			onRetryAbandoned: () => privateControllerProto.settleAbandonedRetryPhase.call(controller as never),
			scheduleTimer: clock.scheduleTimer,
			cancelTimer: clock.cancelTimer,
		})
		controller.apiRetry = apiRetry

		return {
			controller,
			apiRetry,
			clock,
			emitSessionEvents,
			setPhase,
			clearTurnOutcome,
			askResponse,
			interactions,
			setActiveSession: (session) => {
				activeSession = session
			},
			settle: (source, error) =>
				privateControllerProto.handleTurnSettled.call(controller as never, "session-123", {
					status: "failed",
					error,
					source,
				}),
		}
	}

	/** A transient transport failure the classifier marks retryable. */
	const transportError = (message = "socket hang up") => Object.assign(new Error(message), { code: "ECONNRESET" })

	/** Let a fired timer's async re-drive run past its next await. */
	const flushTurnWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

	it("re-drives a retryable event-delivered failure through the follow-up funnel", async () => {
		const harness = makeLifecycleHarness()

		await harness.settle("agent_event", transportError())

		// The countdown is scheduled on the Fibonacci schedule (first delay 3s) and
		// takes over the footer via the "retrying" phase (Cancel only) — nothing is
		// appended below the already-rendered error, so no row is emitted at all.
		expect(harness.clock.timers).toHaveLength(1)
		expect(harness.clock.timers[0]?.delayMs).toBe(3000)
		expect(harness.setPhase).toHaveBeenCalledWith("retrying")
		expect(harness.emitSessionEvents).not.toHaveBeenCalled()
		// …but nothing re-drives yet, and the already-rendered event failure is
		// not re-surfaced as an agent error.
		expect(harness.askResponse).not.toHaveBeenCalled()
		expect(harness.emitSessionEvents).not.toHaveBeenCalledWith([expect.objectContaining({ say: "error" })], expect.anything())

		harness.clock.fire(0)
		await flushTurnWork()

		// The re-drive mirrors askResponse's pre-set, then rides the funnel
		// with the live cancellation guard.
		expect(harness.setPhase).toHaveBeenCalledWith("streaming")
		expect(harness.clearTurnOutcome).toHaveBeenCalledOnce()
		expect(harness.askResponse).toHaveBeenCalledExactlyOnceWith(
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			expect.any(Function),
		)
		// Nothing cancelled: the streaming phase stands until the retried turn settles.
		expect(harness.setPhase).not.toHaveBeenCalledWith("resumable")
	})

	it("surfaces a rejected send as a running error and re-drives it once the delay elapses", async () => {
		const harness = makeLifecycleHarness()
		const error = Object.assign(new Error("provider overloaded"), { statusCode: 503 })

		await harness.settle("send_rejection", error)

		// A rejected send surfaces nowhere else, so the banner reports it while
		// the retry owns the phase — no "error" settle yet.
		expect(harness.setPhase).not.toHaveBeenCalledWith("error")
		expect(harness.emitSessionEvents).toHaveBeenCalledWith(
			[expect.objectContaining({ say: "error", text: "Agent error: provider overloaded" })],
			{ type: "status", payload: { sessionId: "session-123", status: "running" } },
		)
		expect(harness.clock.timers).toHaveLength(1)

		harness.clock.fire(0)
		await flushTurnWork()

		expect(harness.askResponse).toHaveBeenCalledOnce()
	})

	it("aborts the re-drive mid-funnel when cancellation lands while it awaits settlement", async () => {
		const harness = makeLifecycleHarness()
		let releaseFunnel: () => void = () => {}
		harness.askResponse.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					releaseFunnel = resolve
				}),
		)

		await harness.settle("agent_event", transportError())
		harness.clock.fire(0)
		await flushTurnWork()

		// The re-drive is parked inside the funnel awaiting settlement.
		expect(harness.askResponse).toHaveBeenCalledOnce()
		expect(harness.setPhase).toHaveBeenCalledWith("streaming")

		// The user cancels (or the task tears down) while the funnel is pending.
		harness.apiRetry.cancel()
		releaseFunnel()
		await flushTurnWork()

		// The post-await guard settles the pre-set phase so the footer does not
		// hang on Thinking, and the cancelled retry never sends again.
		expect(harness.askResponse).toHaveBeenCalledOnce()
		expect(harness.setPhase).toHaveBeenCalledWith("resumable")
		expect(harness.clock.timers).toHaveLength(1)
	})

	it("never sends a retry that was counting down when the task was cancelled", async () => {
		const harness = makeLifecycleHarness()

		await harness.settle("send_rejection", transportError("fetch failed"))
		expect(harness.clock.timers).toHaveLength(1)

		// The task is cancelled — the pending timer is invalidated…
		harness.apiRetry.cancel()
		expect(harness.clock.cancelTimer).toHaveBeenCalledOnce()
		expect(harness.apiRetry.hasPendingRetry).toBe(false)

		// …and even a stray late wake-up cannot send.
		harness.clock.fire(0)
		await flushTurnWork()

		expect(harness.askResponse).not.toHaveBeenCalled()
		expect(harness.setPhase).not.toHaveBeenCalledWith("streaming")

		// The streak was cleared too: a later failure schedules a fresh streak
		// instead of resuming the cancelled one.
		await harness.settle("send_rejection", transportError("fetch failed again"))
		expect(harness.clock.timers).toHaveLength(2)
		expect(harness.apiRetry.currentRetryCount).toBe(1)
	})

	it("treats an unrecognized 4xx as permanent and leaves recovery to the user", async () => {
		const harness = makeLifecycleHarness()
		const error = Object.assign(new Error("Unavailable For Legal Reasons"), { statusCode: 451 })

		await harness.settle("send_rejection", error)

		// Nothing is scheduled, nothing re-drives…
		expect(harness.clock.timers).toHaveLength(0)
		expect(harness.askResponse).not.toHaveBeenCalled()
		expect(harness.setPhase).not.toHaveBeenCalledWith("retrying")
		// …the phase settles on error recovery and the banner reports "error".
		expect(harness.setPhase).toHaveBeenCalledWith("error")
		expect(harness.emitSessionEvents).toHaveBeenCalledWith(
			[expect.objectContaining({ say: "error", text: "Agent error: Unavailable For Legal Reasons" })],
			{ type: "status", payload: { sessionId: "session-123", status: "error" } },
		)
	})

	it("treats a flattened content-block validation rejection as permanent instead of retrying forever", async () => {
		const harness = makeLifecycleHarness()
		// Anthropic-compatible gateways flatten 400 request-shape verdicts to
		// plain text with no status metadata. Left retryable this arms an
		// endless countdown streak on a resend that can never succeed.
		const error = new Error("messages.content.type is invalid, allowed values: ['text']")

		await harness.settle("send_rejection", error)

		// No streak is armed and nothing re-drives…
		expect(harness.clock.timers).toHaveLength(0)
		expect(harness.askResponse).not.toHaveBeenCalled()
		expect(harness.setPhase).not.toHaveBeenCalledWith("retrying")
		// …the phase settles on error recovery so the user can act (Retry /
		// Start New Task) instead of watching an immortal countdown.
		expect(harness.setPhase).toHaveBeenCalledWith("error")
		expect(harness.emitSessionEvents).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					say: "error",
					text: "Agent error: messages.content.type is invalid, allowed values: ['text']",
				}),
			],
			{ type: "status", payload: { sessionId: "session-123", status: "error" } },
		)
	})

	it("abandons a pending retry when its session was replaced before the timer fired", async () => {
		const harness = makeLifecycleHarness()

		await harness.settle("agent_event", transportError("fetch failed"))
		expect(harness.apiRetry.hasPendingRetry).toBe(true)

		// The user moved to a new task; the failed session is no longer active.
		harness.setActiveSession({ sessionId: "session-456", isRunning: false })

		harness.clock.fire(0)
		await flushTurnWork()

		// The live session guard fails at fire time: no re-drive, no phase churn.
		expect(harness.askResponse).not.toHaveBeenCalled()
		expect(harness.setPhase).not.toHaveBeenCalledWith("streaming")
		expect(harness.setPhase).not.toHaveBeenCalledWith("resumable")
	})

	it("settles the marker and restores error recovery when the re-drive funnel throws", async () => {
		const harness = makeLifecycleHarness()
		// The re-drive reaches the funnel, but the send path blows up (e.g. the
		// session host connection died while the machine slept) before any
		// turn outcome can be produced.
		harness.askResponse.mockImplementation(() => Promise.reject(new Error("session host disconnected")))

		await harness.settle("agent_event", transportError())
		expect(harness.clock.timers).toHaveLength(1)

		harness.clock.fire(0)
		await flushTurnWork()

		// Without the catch-path settle the marker strands as "retrying" with
		// the phase parked on "streaming": Cancel-only footer, spinner, and
		// the recovery hold hiding rows below the frozen error block forever.
		expect(harness.interactions.settleAutoRecovery).toHaveBeenCalledOnce()
		expect(harness.setPhase).toHaveBeenLastCalledWith("error")
	})
})
