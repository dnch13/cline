import { createHandlerAsync } from "@cline/llms";
import type { BasicLogger } from "@cline/shared";
import { countUserRunMessages } from "../../session/user-run-messages";
import type {
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionSummarizerConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import { runBasicCompaction } from "./basic-compaction";
import {
	type BudgetProjectionResult,
	buildBudgetProjection,
} from "./budget-projection";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	type EstimateMessageTokens,
	ensureFilesSection,
	estimateTokens,
	extractFileOps,
	findCutIndex,
	findLatestSummaryIndex,
	getCompactionSummaryMetadata,
	resolveEffectiveMaxInputTokens,
	resolveSummarizerConfig,
	serializeConversation,
} from "./compaction-shared";

const MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 1_024;

/**
 * Hard ceiling on a single summarizer stream. The summarizer request rides the
 * same flaky provider connection that likely triggered the turn failure this
 * compaction is recovering from; without a deadline a hung connection (or a
 * provider that never closes the stream) stalls `prepareTurn` forever — the
 * task sits on "compacting" indefinitely. On timeout the error propagates and
 * compaction.ts falls back to deterministic basic compaction.
 */
const SUMMARY_STREAM_TIMEOUT_MS = 120_000;

export class CompactionSummaryTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(
			`Compaction summarizer stream timed out after ${Math.round(timeoutMs / 1000)}s`,
		);
		this.name = "CompactionSummaryTimeoutError";
	}
}

async function nextChunkWithTimeout<T>(
	iterator: AsyncIterator<T>,
	deadline: number,
	timeoutMs: number,
): Promise<IteratorResult<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			iterator.next(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new CompactionSummaryTimeoutError(timeoutMs)),
					Math.max(0, deadline - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function resolveProviderMaxInputTokens(
	providerConfig: ProviderConfig,
): number | undefined {
	const modelInfoLimit = resolveEffectiveMaxInputTokens({
		maxInputTokens:
			providerConfig.maxInputTokens ?? providerConfig.modelInfo?.maxInputTokens,
		contextWindow: providerConfig.modelInfo?.contextWindow,
	});
	if (modelInfoLimit !== undefined) {
		return modelInfoLimit;
	}
	const knownModelInfo = providerConfig.knownModels?.[providerConfig.modelId];
	return resolveEffectiveMaxInputTokens({
		maxInputTokens: knownModelInfo?.maxInputTokens,
		contextWindow: knownModelInfo?.contextWindow,
	});
}

export function buildAgenticSummaryInputBudget(options: {
	messages: CoreCompactionContext["messages"];
	targetTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
}): BudgetProjectionResult {
	return buildBudgetProjection({
		messages: options.messages,
		targetTokens: Math.max(1, options.targetTokens),
		policyIntent: "agentic_summary",
		estimateMessageTokens: options.estimateMessageTokens,
	});
}

interface SummaryGenerationResult {
	text: string;
	/** Reasoning/thinking output length; discarded from the summary itself. */
	reasoningChars: number;
	/** Provider-reported reason the response is incomplete (e.g. "max_output_tokens"). */
	incompleteReason?: string;
}

async function generateSummary(options: {
	providerConfig: ProviderConfig;
	request: string;
	logger?: BasicLogger;
}): Promise<SummaryGenerationResult> {
	const handler = await createHandlerAsync(options.providerConfig);
	let text = "";
	let reasoningChars = 0;
	let incompleteReason: string | undefined;
	const iterator = handler
		.createMessage(
			"Summarize the provided coding session into a concise continuation note with detailed next steps.",
			[{ role: "user", content: options.request }],
		)
		[Symbol.asyncIterator]();
	// One overall deadline for the whole stream: a provider that drips a chunk
	// every 119s must not extend the wait forever. On any timeout the stream is
	// closed best-effort and the timeout error propagates, so callers can fall
	// back to deterministic basic compaction.
	const deadline = Date.now() + SUMMARY_STREAM_TIMEOUT_MS;
	try {
		while (true) {
			const next = await nextChunkWithTimeout(
				iterator,
				deadline,
				SUMMARY_STREAM_TIMEOUT_MS,
			);
			if (next.done) {
				break;
			}
			const chunk = next.value;
			if (chunk.type === "text") {
				text += chunk.text;
				continue;
			}
			if (chunk.type === "reasoning") {
				reasoningChars += chunk.reasoning?.length ?? 0;
				continue;
			}
			if (chunk.type === "done") {
				if (!chunk.success && chunk.error) {
					throw new Error(chunk.error);
				}
				incompleteReason = chunk.incompleteReason ?? incompleteReason;
			}
		}
	} catch (error) {
		void iterator.return?.(undefined as never)?.catch(() => {});
		throw error;
	}
	options.logger?.debug("Generated compaction summary", {
		outputChars: text.length,
		reasoningChars,
		incompleteReason,
		modelId: options.providerConfig.modelId,
		providerId: options.providerConfig.providerId,
	});
	return { text: text.trim(), reasoningChars, incompleteReason };
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

export async function runAgenticCompaction(options: {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	preserveRecentTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const cutIndex = findCutIndex(
		messages,
		options.preserveRecentTokens,
		options.estimateMessageTokens,
	);
	if (cutIndex <= 0 || cutIndex >= messages.length) {
		return undefined;
	}

	const messagesToSummarize = messages.slice(0, cutIndex);
	const latestSummaryIndex = findLatestSummaryIndex(messagesToSummarize);
	const previousSummary =
		latestSummaryIndex >= 0
			? getCompactionSummaryMetadata(messagesToSummarize[latestSummaryIndex])
					?.summary
			: undefined;
	const newMessagesToFold =
		latestSummaryIndex >= 0
			? messagesToSummarize.slice(latestSummaryIndex + 1)
			: messagesToSummarize;
	if (newMessagesToFold.length === 0) {
		return undefined;
	}

	const preProjectionFileOps = extractFileOps(messagesToSummarize);
	const summarizerProviderConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
	});
	const resolvedSummarizerInputLimit = resolveProviderMaxInputTokens(
		summarizerProviderConfig,
	);
	const canUseActiveContextLimit = options.summarizer === undefined;
	const activeCompactionInputLimit = Math.max(
		options.context.budget.request.maxInputTokens,
		options.context.budget.request.triggerTokens,
		MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
	);
	if (resolvedSummarizerInputLimit === undefined && !canUseActiveContextLimit) {
		options.logger?.log(
			"Agentic compaction summarizer has no known input limit; using conservative summary budget",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				fallbackInputLimit: MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
			},
		);
	}
	const summarizerInputLimit =
		resolvedSummarizerInputLimit ??
		(canUseActiveContextLimit
			? activeCompactionInputLimit
			: MIN_AGENTIC_SUMMARY_INPUT_TOKENS);
	const summaryRequestOverheadTokens = estimateTokens(
		buildSummaryRequest({
			previousSummary,
			conversationText: "",
			fileOps: preProjectionFileOps,
		}).length,
	);
	const availableSummaryInputTokens =
		summarizerInputLimit - summaryRequestOverheadTokens;
	if (availableSummaryInputTokens <= 0) {
		options.logger?.debug(
			"Skipped agentic compaction: summarizer budget exhausted",
			{
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerInputLimit,
				summaryRequestOverheadTokens,
			},
		);
		return undefined;
	}
	const summaryInputBudget = buildAgenticSummaryInputBudget({
		messages: newMessagesToFold,
		targetTokens: availableSummaryInputTokens,
		estimateMessageTokens: options.estimateMessageTokens,
	});
	if (summaryInputBudget.status === "failed") {
		options.logger?.log(
			"Skipped agentic compaction: summary input budget failed",
			{
				severity: "warn",
				budgetWarnings: summaryInputBudget.warnings.map(
					(warning) => warning.code,
				),
				summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
				targetTokens: availableSummaryInputTokens,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}
	const fileOps = extractFileOps(summaryInputBudget.messages);
	const conversationText = serializeConversation(summaryInputBudget.messages);
	const summaryRequest = buildSummaryRequest({
		previousSummary,
		conversationText,
		fileOps,
	});
	options.logger?.debug("Agentic compaction summarizer diagnostics", {
		messagesToSummarize: messagesToSummarize.length,
		newMessagesToFold: newMessagesToFold.length,
		preservedMessages: messages.length - cutIndex,
		previousSummaryChars: previousSummary?.length ?? 0,
		conversationTextChars: conversationText.length,
		summaryRequestChars: summaryRequest.length,
		summaryRequestEstimatedTokens: estimateTokens(summaryRequest.length),
		newMessagesJsonChars: safeJsonSize(newMessagesToFold),
		summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
		summaryInputActions: summaryInputBudget.actions.length,
		summaryInputWarnings: summaryInputBudget.warnings.map(
			(warning) => warning.code,
		),
		summaryRequestOverheadTokens,
		summarizerProviderId: summarizerProviderConfig.providerId,
		summarizerModelId: summarizerProviderConfig.modelId,
		summarizerInputLimit,
		maxInputTokens: options.context.budget.request.maxInputTokens,
		triggerTokens: options.context.budget.request.triggerTokens,
	});
	const summaryResult = await generateSummary({
		providerConfig: summarizerProviderConfig,
		request: summaryRequest,
		logger: options.logger,
	});
	const rawSummary = summaryResult.text;
	if (!rawSummary) {
		options.logger?.log(
			"Agentic summarizer returned no summary text; falling back to basic compaction",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerMaxOutputTokens: summarizerProviderConfig.maxOutputTokens,
				reasoningChars: summaryResult.reasoningChars,
				incompleteReason: summaryResult.incompleteReason,
				likelyCause:
					summaryResult.reasoningChars > 0
						? "output_budget_consumed_by_reasoning"
						: "empty_response",
			},
		);
		// A summarizer that cannot produce text (reasoning consumed the output
		// budget, or the provider answered empty) must not leave the pipeline
		// empty-handed: the conversation is over the compaction trigger, so
		// returning undefined makes the NEXT turn re-run the same giant
		// summarize on an identical transcript — big conversations stall in a
		// summarize/skip loop that looks hung and costs one huge request per
		// turn. Basic compaction is deterministic and bounded.
		return runBasicCompaction({
			context: options.context,
			estimateMessageTokens: options.estimateMessageTokens,
			logger: options.logger,
		});
	}

	const summary = ensureFilesSection(rawSummary, fileOps);
	const tokensBefore = messages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	const resultMessages = [
		buildSummaryMessage({
			summary,
			fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(messagesToSummarize),
		}),
		...messages.slice(cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction", {
		messagesBefore: messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: cutIndex,
		messagesPreserved: messages.length - cutIndex,
		tokensBefore,
		tokensAfter,
		maxInputTokens: options.context.budget.request.maxInputTokens,
	});
	const budgetActionCount = summaryInputBudget.actions.filter(
		(action) =>
			action.reason === "over_budget" || action.reason === "tool_pair_boundary",
	).length;
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: budgetActionCount,
			warningCount: summaryInputBudget.warnings.length,
			liveTailHandling: summaryInputBudget.liveTailHandling,
		},
	};
}
