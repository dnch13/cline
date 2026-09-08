// Extracted from classic src/core/controller/index.ts (see origin/main)
//
// Standalone function to build ExtensionState from a Controller instance.
// This allows the SdkController to reuse the classic state-building logic
// without inheriting the entire classic Controller implementation.

import { isModelToolEnabledGlobally, readCompactionStrategyGlobally } from "@cline/core"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import type { ExtensionState, Platform } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { ClineEnv } from "@/config"
import { ExtensionRegistryInfo } from "@/registry"
import { BannerService } from "@/services/banner/BannerService"
import { featureFlagsService } from "@/services/feature-flags"
import { getDistinctId } from "@/services/logging/distinctId"
import { getExtensionVariant } from "@/services/telemetry/rollout-metadata"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getClineOnboardingModels } from "../models/getClineOnboardingModels"

/**
 * Maximum transcript messages included in a state snapshot. Longer transcripts are
 * delivered tail-first; older pages load on demand via TaskService.getTranscriptPage.
 * Generous enough that the overwhelming majority of tasks are never windowed.
 */
export const TRANSCRIPT_WINDOW_LIMIT = 120

/**
 * Builds the ExtensionState object to push to the webview.
 * Extracted from the classic Controller.getStateToPostToWebview().
 */
export async function getStateToPostToWebview(controller: {
	task?: any
	stateManager: any
	mcpHub?: any
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	foregroundCommandRunning?: boolean
	workspaceManager?: any
	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]
	isRemoteConfigAvailable?: boolean
	currentRemoteConfigRevision?: number
}): Promise<ExtensionState> {
	const stateManager = controller.stateManager

	// Get API configuration from cache for immediate access
	const onboardingModels = getClineOnboardingModels()
	const apiConfiguration = stateManager.getApiConfiguration()
	const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
	const taskHistory = stateManager.getGlobalStateKey("taskHistory")
	const autoApprovalSettings = stateManager.getGlobalSettingsKey("autoApprovalSettings")
	const browserSettings = stateManager.getGlobalSettingsKey("browserSettings")
	const preferredLanguage = stateManager.getGlobalSettingsKey("preferredLanguage")
	const mode = stateManager.getGlobalSettingsKey("mode")
	const useAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense")
	const compactionStrategy = readCompactionStrategyGlobally()
	const webSearchEnabled = isModelToolEnabledGlobally("web_search")
	const subagentsEnabled = stateManager.getGlobalSettingsKey("subagentsEnabled")
	const userInfo = stateManager.getGlobalStateKey("userInfo")
	const mcpMarketplaceEnabled = stateManager.getGlobalStateKey("mcpMarketplaceEnabled")
	const mcpDisplayMode = stateManager.getGlobalStateKey("mcpDisplayMode")
	const telemetrySetting = stateManager.getGlobalSettingsKey("telemetrySetting")
	const planActSeparateModelsSetting = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
	const enableCheckpointsSetting = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
	const globalClineRulesToggles = stateManager.getGlobalStateKey("globalClineRulesToggles")
	const globalWorkflowToggles = stateManager.getGlobalStateKey("globalWorkflowToggles")
	const globalSkillsToggles = stateManager.getGlobalStateKey("globalSkillsToggles")
	const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles")
	const remoteRulesToggles = stateManager.getGlobalStateKey("remoteRulesToggles")
	const remoteWorkflowToggles = stateManager.getGlobalStateKey("remoteWorkflowToggles")
	const shellIntegrationTimeout = stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
	const terminalReuseEnabled = stateManager.getGlobalStateKey("terminalReuseEnabled")
	const vscodeTerminalExecutionMode = stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
	const defaultTerminalProfile = stateManager.getGlobalSettingsKey("defaultTerminalProfile")
	const isNewUser = stateManager.getGlobalStateKey("isNewUser")
	const welcomeViewCompleted = !!stateManager.getGlobalStateKey("welcomeViewCompleted")

	const mcpResponsesCollapsed = stateManager.getGlobalStateKey("mcpResponsesCollapsed")
	const favoritedModelIds = stateManager.getGlobalStateKey("favoritedModelIds")
	const lastDismissedInfoBannerVersion = stateManager.getGlobalStateKey("lastDismissedInfoBannerVersion") || 0
	const lastDismissedModelBannerVersion = stateManager.getGlobalStateKey("lastDismissedModelBannerVersion") || 0
	const lastDismissedCliBannerVersion = stateManager.getGlobalStateKey("lastDismissedCliBannerVersion") || 0
	const dismissedBanners = stateManager.getGlobalStateKey("dismissedBanners")
	const showFeatureTips = stateManager.getGlobalSettingsKey("showFeatureTips")

	const localClineRulesToggles = stateManager.getWorkspaceStateKey("localClineRulesToggles")
	const localWindsurfRulesToggles = stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
	const localCursorRulesToggles = stateManager.getWorkspaceStateKey("localCursorRulesToggles")
	const localAgentsRulesToggles = stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
	const workflowToggles = stateManager.getWorkspaceStateKey("workflowToggles")

	const currentTaskItem = controller.task?.taskId
		? (taskHistory || []).find((item: any) => item.id === controller.task?.taskId)
		: undefined
	const fullClineMessages = [...(controller.task?.messageStateHandler?.getClineMessages?.() || [])]
	// Long-conversation optimization: deliver only the transcript TAIL to the webview.
	// Older pages are fetched on demand via TaskService.getTranscriptPage (infinite
	// scroll). This bounds both the state snapshot size and the initial webview render
	// for multi-thousand-message tasks. Same-epoch merges never truncate the webview
	// replica, so this only shapes what a NEW epoch (task open) initially receives.
	// The full array is kept for metrics below (token/cost totals must reflect the
	// WHOLE conversation, not the window).
	const transcriptWindow =
		fullClineMessages.length > TRANSCRIPT_WINDOW_LIMIT
			? {
					total: fullClineMessages.length,
					hasMore: true,
				}
			: undefined
	const clineMessages = transcriptWindow
		? fullClineMessages.slice(fullClineMessages.length - TRANSCRIPT_WINDOW_LIMIT)
		: fullClineMessages
	// Full-conversation usage totals: computed over the complete transcript whenever
	// we window, so the task header stays correct even though the replica only holds
	// the tail. (When un-windowed, the webview's own getApiMetrics over clineMessages
	// is equivalent, so we skip the redundant field.)
	const transcriptMetrics = transcriptWindow ? getApiMetrics(fullClineMessages) : undefined
	const checkpointRestoreInput = controller.checkpointRestoreInput

	const processedTaskHistory = (taskHistory || [])
		.filter((item: any) => item.ts && item.task)
		.sort((a: any, b: any) => b.ts - a.ts)
		.slice(0, 100)

	const latestAnnouncementId = getLatestAnnouncementId()
	const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
	const platform = process.platform as Platform
	const distinctId = getDistinctId()
	const version = ExtensionRegistryInfo.version
	const clineConfig = ClineEnv.config()
	const environment = clineConfig.environment
	const banners = BannerService.get().getActiveBanners() ?? []
	const welcomeBanners = BannerService.get().getWelcomeBanners() ?? []

	// Check OpenAI Codex authentication status
	let openAiCodexIsAuthenticated = false
	try {
		const { openAiCodexOAuthManager } = await import("@/integrations/openai-codex/oauth")
		openAiCodexIsAuthenticated = await openAiCodexOAuthManager.isAuthenticated()
	} catch {
		// Codex OAuth not available
	}

	return {
		version,
		extensionVariant: getExtensionVariant(),
		apiConfiguration,
		currentTaskItem,
		clineMessages,
		transcriptWindow,
		transcriptMetrics,
		checkpointRestoreInput,
		autoApprovalSettings,
		browserSettings,
		preferredLanguage,
		mode,
		useAutoCondense,
		compactionStrategy,
		webSearchEnabled,
		subagentsEnabled,
		userInfo,
		mcpMarketplaceEnabled,
		mcpDisplayMode,
		telemetrySetting,
		planActSeparateModelsSetting,
		enableCheckpointsSetting: enableCheckpointsSetting ?? true,
		platform,
		environment,
		distinctId,
		globalClineRulesToggles: globalClineRulesToggles || {},
		localClineRulesToggles: localClineRulesToggles || {},
		localWindsurfRulesToggles: localWindsurfRulesToggles || {},
		localCursorRulesToggles: localCursorRulesToggles || {},
		localAgentsRulesToggles: localAgentsRulesToggles || {},
		localWorkflowToggles: workflowToggles || {},
		globalWorkflowToggles: globalWorkflowToggles || {},
		globalSkillsToggles: globalSkillsToggles || {},
		localSkillsToggles: localSkillsToggles || {},
		remoteRulesToggles,
		remoteWorkflowToggles,
		shellIntegrationTimeout,
		terminalReuseEnabled,
		vscodeTerminalExecutionMode,
		defaultTerminalProfile,
		isNewUser,
		welcomeViewCompleted,
		onboardingModels,
		mcpResponsesCollapsed,
		taskHistory: processedTaskHistory,
		shouldShowAnnouncement,
		favoritedModelIds,
		backgroundCommandRunning: controller.backgroundCommandRunning ?? false,
		backgroundCommandTaskId: controller.backgroundCommandTaskId,
		foregroundCommandRunning: controller.foregroundCommandRunning ?? false,
		workspaceRoots: controller.workspaceManager?.getRoots?.() ?? [],
		primaryRootIndex: controller.workspaceManager?.getPrimaryIndex?.() ?? 0,
		isMultiRootWorkspace: (controller.workspaceManager?.getRoots?.()?.length ?? 0) > 1,
		multiRootSetting: {
			user: stateManager.getGlobalStateKey("multiRootEnabled"),
			featureFlag: true,
		},
		worktreesEnabled: {
			user: stateManager.getGlobalSettingsKey("worktreesEnabled"),
			featureFlag: featureFlagsService.getWorktreesEnabled(),
		},
		hooksEnabled: getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled")),
		lastDismissedInfoBannerVersion,
		lastDismissedModelBannerVersion,
		remoteConfigSettings: stateManager.getRemoteConfigSettings?.(),
		remoteConfigRevision: controller.currentRemoteConfigRevision ?? 0,
		lastDismissedCliBannerVersion,
		dismissedBanners,
		backgroundEditEnabled: stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
		optOutOfRemoteConfig: stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
		remoteConfigAvailable: controller.isRemoteConfigAvailable ?? false,
		showFeatureTips,
		banners,
		welcomeBanners,
		openAiCodexIsAuthenticated,
	} as ExtensionState
}
