import * as vscode from "vscode";
import type { HFModelItem, RetryConfig } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";

import { logger } from "./logger";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

const UNSUPPORTED_FUNCTION_SCHEMA_KEYS = new Set([
	"$schema",
	"$id",
	"$defs",
	"definitions",
	"additionalItems",
	"unevaluatedItems",
	"unevaluatedProperties",
	"dependentRequired",
	"dependentSchemas",
	"patternProperties",
	"propertyNames",
	"prefixItems",
	"contains",
	"minContains",
	"maxContains",
	"if",
	"then",
	"else",
	"not",
	"allOf",
	"anyOf",
	"oneOf",
]);

function cloneAndNormalizeFunctionSchema(value: unknown): Record<string, unknown> {
	const normalized = normalizeJsonSchema(value);
	if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
		return { type: "object", properties: {} };
	}
	const schema = normalized as Record<string, unknown>;
	if (typeof schema.type !== "string") {
		schema.type = "object";
	}
	if (
		schema.type === "object" &&
		(!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))
	) {
		schema.properties = {};
	}
	return schema;
}

function normalizeJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeJsonSchema(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(source)) {
		if (UNSUPPORTED_FUNCTION_SCHEMA_KEYS.has(key)) {
			continue;
		}
		if (key === "additionalProperties" && typeof raw !== "boolean" && (typeof raw !== "object" || raw === null)) {
			continue;
		}
		out[key] = normalizeJsonSchema(raw);
	}
	return out;
}

/**
 * Bridge a VS Code CancellationToken to a standard AbortSignal so it can be
 * passed directly to `fetch()`. This lets Copilot Chat's stop/cancel action
 * actually abort the underlying HTTP request instead of just stopping local
 * processing of an already-open stream.
 * @param token The cancellation token to bridge.
 * @returns An AbortSignal that aborts when the token is cancelled.
 */
export function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		const subscription = token.onCancellationRequested(() => {
			controller.abort();
			subscription.dispose();
		});
	}
	return controller.signal;
}

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
}

export function getModelProviderId(model: unknown): string {
	if (!model || typeof model !== "object") {
		return "";
	}
	const obj = model as Record<string, unknown>;
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provide) ||
		pick(obj.provider) ||
		pick(obj.ownedBy) ||
		pick(obj.owner) ||
		pick(obj.vendor)
	);
}

export function normalizeUserModels(models: unknown): HFModelItem[] {
	const list = Array.isArray(models) ? models : [];
	const out: HFModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const provider = getModelProviderId(item);
		out.push({ ...(item as HFModelItem), owned_by: provider });
	}
	return out;
}

export function getEnabledUserModels(models: unknown, disabledProviders: readonly string[] = []): HFModelItem[] {
	const disabled = new Set(disabledProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean));
	return normalizeUserModels(models).filter(
		(model) => model.enabled !== false && !disabled.has(model.owned_by.trim().toLowerCase())
	);
}

/**
 * Parse a model ID that may contain a configuration ID separator.
 * Format: "baseId::configId" or just "baseId"
 */
export function parseModelId(modelId: string): ParsedModelId {
	const parts = modelId.split("::");
	if (parts.length >= 2) {
		return {
			baseId: parts[0],
			configId: parts.slice(1).join("::"), // In case configId itself contains '::'
		};
	}
	return {
		baseId: modelId,
	};
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = cloneAndNormalizeFunctionSchema(t.inputSchema);
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[OAI Compatible Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

export type OpenAIResponsesToolChoice = "auto" | { type: "function"; name: string };

/**
 * Convert VS Code tool definitions to OpenAI Responses API tool definitions.
 * Responses uses `{ type:"function", name, description, parameters }` (no nested `function` object).
 */
export function convertToolsToOpenAIResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: OpenAIResponsesToolChoice;
} {
	const toolConfig = convertToolsToOpenAI(options);
	if (!toolConfig.tools || toolConfig.tools.length === 0) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = toolConfig.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = {
			type: "function",
			name: t.function.name,
		};
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: OpenAIResponsesToolChoice | undefined;
	if (toolConfig.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (toolConfig.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: toolConfig.tool_choice.function.name };
	}

	return { tools, tool_choice };
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

export function throwIfStreamErrorPayload(payload: Record<string, unknown>, providerName: string): void {
	const errorValue = payload.error;
	if (!errorValue) {
		return;
	}

	let message = "Unknown streaming error";
	if (typeof errorValue === "string") {
		message = errorValue;
	} else if (errorValue && typeof errorValue === "object") {
		const errorObj = errorValue as Record<string, unknown>;
		if (typeof errorObj.message === "string" && errorObj.message.trim()) {
			message = errorObj.message;
		} else {
			try {
				message = JSON.stringify(errorObj);
			} catch {
				message = String(errorValue);
			}
		}
	}

	let code = "";
	if (errorValue && typeof errorValue === "object") {
		const rawCode = (errorValue as Record<string, unknown>).code;
		if (typeof rawCode === "string" && rawCode.trim()) {
			code = ` (${rawCode})`;
		}
	}

	throw new Error(`${providerName} stream error${code}: ${message}`);
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("oaicopilot.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const baseIntervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableStatusError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));
			// Check if error is retryable based on network error patterns
			const isRetryableNetworkError = networkErrorPatterns.some((pattern) => lastError?.message.includes(pattern));
			const isRetryableError = isRetryableStatusError || isRetryableNetworkError;

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			// Exponential backoff: interval doubles each attempt, capped at 60s
			const delayMs = Math.min(baseIntervalMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt), RETRY_MAX_INTERVAL_MS);

			logger.warn("retry.attempt", {
				attempt: attempt + 1,
				maxAttempts,
				delayMs,
				errorName: lastError.name,
				errorMessage: lastError.message,
			});

			console.error(
				`[OAI Compatible Model Provider] Retryable error detected, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts}). Error:`,
				lastError instanceof Error ? { name: lastError.name, message: lastError.message } : String(lastError)
			);

			// Wait for the calculated interval before retrying
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// This should never be reached, but TypeScript needs it
	logger.error("retry.exhausted", {
		maxAttempts,
		lastError: lastError ? { name: lastError.name, message: lastError.message } : String(lastError),
	});
	throw lastError || new Error("Retry failed");
}
