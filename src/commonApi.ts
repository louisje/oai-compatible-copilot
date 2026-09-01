import * as vscode from "vscode";
import {
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatRequestMessage,
	LanguageModelToolCallPart,
	LanguageModelResponsePart2,
	LanguageModelThinkingPart,
	Progress,
	CancellationToken,
} from "vscode";
import { HFModelItem, CustomDataPartMimeTypes, TokenUsage, ModelPricing } from "./types";
import { tryParseJSONObject } from "./utils";
import { logger } from "./logger";
import { VersionManager } from "./versionManager";

export abstract class CommonApi<TMessage, TRequestBody> {
	/**
	 * Cumulative cost in USD across all requests made during this extension host session.
	 * Reset only when VS Code / the extension host restarts.
	 */
	private static _sessionCostUsd = 0;

	/** Get the accumulated session cost in USD. */
	static getSessionCostUsd(): number {
		return CommonApi._sessionCostUsd;
	}
	/** Buffer for assembling streamed tool calls by index. */
	protected _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	protected _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	protected _hasEmittedAssistantText = false;

	/** Track if we emitted any text. */
	protected _hasEmittedText = false;

	/** Track if we emitted any thinking text. */
	protected _hasEmittedThinking = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	protected _emittedBeginToolCallsHint = false;

	// XML think block parsing state
	protected _xmlThinkActive = false;
	protected _xmlThinkDetectionAttempted = false;

	// Thinking content state management
	protected _currentThinkingId: string | null = null;

	/** Buffer for accumulating thinking content before emitting. */
	protected _thinkingBuffer = "";

	/** Timer for delayed flushing of thinking buffer. */
	protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

	/** System prompts to include in requests. */
	protected _systemContent: string | undefined;

	/** Set the model ID for logging purposes. */
	protected _modelId = "";

	/** Accumulated token usage from the API response. */
	protected _usage: TokenUsage | null = null;

	/** Optional per-model pricing configuration used for local cost estimation. */
	protected _pricing: ModelPricing | undefined;

	/** The last cost in USD computed/reported for a request, if any (used for status bar display). */
	protected _lastCostUsd: number | null = null;

	constructor(modelId: string, pricing?: ModelPricing) {
		this._modelId = modelId;
		this._pricing = pricing;
	}

	/** Get the cost in USD for the most recently reported request, if computed. */
	getLastCostUsd(): number | null {
		return this._lastCostUsd;
	}

	/**
	 * Estimate the USD cost of a request locally, based on the configured `pricing`.
	 * Cached input tokens (if reported) are billed at the `cache_read` rate (falling back
	 * to the `input` rate when not set); cache-write tokens (if reported) are billed at the
	 * `cache_write` rate (falling back to `input`); the remaining, uncached input tokens are
	 * billed at the `input` rate; output tokens are billed at the `output` rate.
	 * @param usage The token usage to estimate cost for.
	 * @returns The estimated cost in USD, or `undefined` if no pricing is configured.
	 */
	private computeLocalCostUsd(usage: TokenUsage): number | undefined {
		if (!this._pricing) {
			return undefined;
		}
		const unit = this._pricing.unit_per_tokens ?? 1_000_000;
		const cachedTokens = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, usage.prompt_tokens);
		const cacheWriteTokens = Math.min(
			Math.max(usage.prompt_tokens_details?.cache_write_tokens ?? 0, 0),
			usage.prompt_tokens - cachedTokens
		);
		const uncachedInputTokens = usage.prompt_tokens - cachedTokens - cacheWriteTokens;
		const cacheReadRate = this._pricing.cache_read ?? this._pricing.input;
		const cacheWriteRate = this._pricing.cache_write ?? this._pricing.input;

		const inputCost = (uncachedInputTokens / unit) * this._pricing.input;
		const cacheCost = (cachedTokens / unit) * cacheReadRate;
		const cacheWriteCost = (cacheWriteTokens / unit) * cacheWriteRate;
		const outputCost = (usage.completion_tokens / unit) * this._pricing.output;

		return inputCost + cacheCost + cacheWriteCost + outputCost;
	}

	/**
	 * Convert VS Code chat messages to specific api message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig Config for special model.
	 * @returns Specific api messages array.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): TMessage[];

	/**
	 * Construct request body for Specific api
	 * @param rb Specific api Request body
	 * @param um Current Model Info
	 * @param options From VS Code
	 */
	abstract prepareRequestBody(
		rb: TRequestBody,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): TRequestBody;

	/**
	 * Process specific api streaming response (JSON lines format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	abstract processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void>;

	/**
	 * Create a message stream for the specific API.
	 * @param model The model to use.
	 * @param systemPrompt The system prompt to use.
	 * @param messages The messages to send.
	 * @param baseUrl The base URL for the API.
	 * @param apiKey The API key to use.
	 * @param signal Optional abort signal to cancel the underlying HTTP request.
	 * @returns An async iterable of text chunks.
	 */
	abstract createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal
	): AsyncGenerator<{ type: "text"; text: string }>;

	/**
	 * Convert OpenAI-compatible tool call arguments into the canonical JSON string used by stream buffers.
	 * Some providers return arguments as an object instead of an escaped JSON string.
	 * @param rawArguments Raw arguments value from the provider response.
	 * @returns A JSON string fragment/full object, or an empty string when no arguments were provided.
	 */
	protected normalizeToolCallArguments(rawArguments: unknown): string {
		if (typeof rawArguments === "string") {
			return rawArguments;
		}
		if (rawArguments && typeof rawArguments === "object") {
			try {
				return JSON.stringify(rawArguments);
			} catch (e) {
				logger.warn("[tool-call] raw arguments stringify failed", {
					modelId: this._modelId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		return "";
	}

	/**
	 * Append raw tool call arguments to a streaming buffer and emit debug logs.
	 * @param index The tool call index from the stream.
	 * @param buf The mutable tool call buffer.
	 * @param rawArguments Raw arguments value from the provider response.
	 * @param mode Whether to append a delta or replace with a complete arguments payload.
	 */
	protected mergeToolCallArguments(
		index: number,
		buf: { id?: string; name?: string; args: string },
		rawArguments: unknown,
		mode: "append" | "replace" = "append"
	): void {
		logger.debug("[tool-call][raw-arguments]", {
			modelId: this._modelId,
			index,
			name: buf.name ?? "",
			rawType: rawArguments === null ? "null" : typeof rawArguments,
			rawArguments,
		});

		const normalized = this.normalizeToolCallArguments(rawArguments);
		if (!normalized) {
			this.logToolCallBuffer(index, buf);
			return;
		}

		if (mode === "replace") {
			buf.args = normalized;
		} else {
			const currentArgs = buf.args.trim();
			const nextArgs = normalized.trim();
			if (currentArgs === "{}" && nextArgs !== "{}" && nextArgs.startsWith("{")) {
				buf.args = normalized;
			} else {
				buf.args += normalized;
			}
		}

		this.logToolCallBuffer(index, buf);
	}

	/**
	 * Log the current streaming buffer for one tool call.
	 * @param index The tool call index from the stream.
	 * @param buf The current tool call buffer.
	 */
	protected logToolCallBuffer(index: number, buf: { id?: string; name?: string; args: string }): void {
		logger.debug("[tool-call][buffer]", {
			modelId: this._modelId,
			index,
			id: buf.id ?? "",
			name: buf.name ?? "",
			args: buf.args,
		});
	}

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>,
		allowEmit = false
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			logger.debug("[tool-call][emit]", {
				modelId: this._modelId,
				index,
				status: "pending-name",
				name: "",
				args: buf.args,
			});
			return;
		}
		const argsText = buf.args.trim() || "{}";
		const canParse = tryParseJSONObject(argsText);
		if (!canParse.ok) {
			logger.debug("[tool-call][emit]", {
				modelId: this._modelId,
				index,
				status: "pending-json",
				name: buf.name,
				args: argsText,
			});
			return;
		}
		if (!allowEmit) {
			logger.debug("[tool-call][emit]", {
				modelId: this._modelId,
				index,
				status: "deferred-until-flush",
				name: buf.name,
				args: argsText,
			});
			return;
		}

		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		let parameters = canParse.value;
		parameters = this.adjustReadFileParameters(buf.name, parameters);
		logger.debug("[tool-call][emit]", {
			modelId: this._modelId,
			index,
			status: "emitting",
			id,
			name: buf.name,
			args: argsText,
			parameters,
		});
		logger.debug("[tool-call][progress-report]", {
			modelId: this._modelId,
			payload: {
				type: "LanguageModelToolCallPart",
				callId: id,
				name: buf.name,
				input: parameters,
			},
		});
		logger.debug("[mcp][request]", {
			modelId: this._modelId,
			tool: buf.name,
			arguments: parameters,
		});
		progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			const argsText = buf.args.trim() || "{}";
			logger.debug("[tool-call][flush]", {
				modelId: this._modelId,
				index: idx,
				id: buf.id ?? "",
				name: buf.name ?? "unknown_tool",
				args: argsText,
			});
			const parsed = tryParseJSONObject(argsText);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[OAI Compatible Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				continue;
			}
			await this.tryEmitBufferedToolCall(idx, progress, true);
		}
	}

	/**
	 * Adjust read_file tool parameters to default to reading configurable number of lines.
	 * @param toolName The name of the tool being called.
	 * @param parameters The tool parameters.
	 * @returns Adjusted parameters.
	 */
	protected adjustReadFileParameters(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
		if (toolName !== "read_file") {
			return parameters;
		}
		const config = vscode.workspace.getConfiguration();
		const defaultLines = config.get<number>("oaicopilot.readFileLines", 0);
		if (defaultLines <= 0) {
			return parameters;
		}

		const startLine = typeof parameters.startLine === "number" ? parameters.startLine : 1;
		const endLine = typeof parameters.endLine === "number" ? parameters.endLine : startLine;
		if (endLine < startLine + defaultLines) {
			return { ...parameters, endLine: startLine + defaultLines };
		}
		return parameters;
	}

	/**
	 * Report to VS Code for ending thinking
	 * @param progress Progress reporter for parts
	 */
	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>) {
		if (!this._currentThinkingId) {
			return;
		}
		// Always clean up state after attempting to end the thinking sequence
		try {
			this.flushThinkingBuffer(progress);
			// End the current thinking sequence with empty content and same ID
			progress.report(new LanguageModelThinkingPart("", this._currentThinkingId));
		} catch (e) {
			console.error("[OAI Compatible Model Provider] Failed to end thinking sequence:", e);
		}
		this._currentThinkingId = null;
		// Clear thinking buffer and timer since sequence ended
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
	}

	/**
	 * Generate a unique thinking ID based on request start time and random suffix
	 */
	protected generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Buffer and schedule a flush for thinking content.
	 * @param text The thinking text to buffer
	 * @param progress Progress reporter for parts
	 */
	protected bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		this._hasEmittedThinking = true;
		// Generate thinking ID if not provided by the model
		if (!this._currentThinkingId) {
			this._currentThinkingId = this.generateThinkingId();
		}

		// Append to thinking buffer
		this._thinkingBuffer += text;

		// Schedule flush with 100ms delay
		if (!this._thinkingFlushTimer) {
			this._thinkingFlushTimer = setTimeout(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	/**
	 * Flush the thinking buffer to the progress reporter.
	 * @param progress Progress reporter for parts.
	 */
	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		// Always clear existing timer first
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}

		// Flush current buffer if we have content
		if (this._thinkingBuffer && this._currentThinkingId) {
			const text = this._thinkingBuffer;
			this._thinkingBuffer = "";
			progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId));
		}
	}

	/**
	 * Prepare headers for API request.
	 * @param apiKey The API key to use.
	 * @param apiMode The apiMode (affects header format).
	 * @param customHeaders Optional custom headers from model config.
	 * @returns Headers object.
	 */
	public static prepareHeaders(
		apiKey: string,
		apiMode: string,
		customHeaders?: Record<string, string>
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": VersionManager.getUserAgent(),
		};

		// Provider-specific header formats
		if (apiMode === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
		} else if (apiMode === "gemini") {
			headers["x-goog-api-key"] = apiKey;
			headers["Accept"] = "text/event-stream";
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		// Merge custom headers
		if (customHeaders) {
			return { ...headers, ...customHeaders };
		}

		return headers;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	protected processTextContent(input: string, progress: Progress<LanguageModelResponsePart2>): { emittedAny: boolean } {
		let emittedAny = false;

		// Emit any visible text
		const textToEmit = input;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedAny = true;
		}

		return { emittedAny };
	}

	/**
	 * Process streamed text content for XML think blocks and buffer thinking content.
	 * Returns whether any XML think tags were processed (preventing text fallback).
	 */
	protected processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		// If we've already attempted detection and found no THINK_START, skip processing
		if (this._xmlThinkDetectionAttempted && !this._xmlThinkActive) {
			return { emittedAny: false };
		}

		const THINK_START = "<think>";
		const THINK_END = "</think>";

		let data = input;
		let emittedAny = false;

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				// Look for think start tag
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					// No think start found, mark detection as attempted and skip future processing
					this._xmlThinkDetectionAttempted = true;
					data = "";
					break;
				}

				// Found think start tag - mark that we processed XML tags
				emittedAny = true;
				this._xmlThinkActive = true;

				// Skip the start tag and continue processing
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			// We are inside a think block, look for end tag
			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
				this.bufferThinkingContent(data, progress);
				emittedAny = true;
				data = "";
				break;
			}

			// Found end tag, buffer final thinking content before the end tag
			const thinkContent = data.slice(0, endIdx);
			this.bufferThinkingContent(thinkContent, progress);

			// Mark end tag as processed and reset state
			emittedAny = true;
			this._xmlThinkActive = false;
			data = data.slice(endIdx + THINK_END.length);
		}

		return { emittedAny };
	}

	/**
	 * Report accumulated token usage as a LanguageModelDataPart so VS Code
	 * can display usage stats in the Context Window widget.
	 *
	 * If the upstream API already reported a `cost_usd` value, that value is used as-is.
	 * Otherwise, if the model has a `pricing` configuration, the cost is estimated locally
	 * from the token usage. Either way, the resulting cost (if any) is added to the
	 * cumulative session cost.
	 */
	protected reportUsage(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this._usage) {
			return;
		}

		// Upstream-reported cost takes precedence; otherwise fall back to local estimation.
		let costUsd = this._usage.cost_usd;
		if (costUsd === undefined) {
			costUsd = this.computeLocalCostUsd(this._usage);
			if (costUsd !== undefined) {
				this._usage = { ...this._usage, cost_usd: costUsd };
			}
		}

		if (costUsd !== undefined) {
			this._lastCostUsd = costUsd;
			CommonApi._sessionCostUsd += costUsd;
		}

		logger.info("usage.report", {
			modelId: this._modelId,
			usage: this._usage,
			sessionCostUsd: CommonApi._sessionCostUsd,
		});
		try {
			const bytes = new TextEncoder().encode(JSON.stringify(this._usage));
			progress.report(new vscode.LanguageModelDataPart(bytes, CustomDataPartMimeTypes.Usage));
		} catch (e) {
			logger.error("usage.report.error", { modelId: this._modelId, error: e instanceof Error ? e.message : String(e) });
		}
	}
}
