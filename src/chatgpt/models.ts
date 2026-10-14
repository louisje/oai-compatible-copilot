/**
 * Normalize the Codex account-scoped model catalog into OAICopilot's model shape.
 * This module is deliberately free of credentials and VS Code dependencies.
 */
import type { HFModelItem } from "../types";

export interface CodexModelInfo {
	slug: string;
	display_name?: string;
	visibility?: string;
	supported_in_api?: boolean;
	context_window?: number | null;
	max_context_window?: number | null;
	default_reasoning_level?: string | null;
	supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
	input_modalities?: string[];
}

export interface ModelsDevModel {
	limit?: { context?: number; input?: number; output?: number };
	tool_call?: boolean;
	modalities?: { input?: string[] };
}

const positiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Only include models intended for the picker and usable with Codex. */
export function fromCodexCatalog(raw: unknown, supplementary: Record<string, ModelsDevModel> = {}): HFModelItem[] {
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { models?: unknown }).models)) {
		throw new Error("Invalid Codex models response");
	}
	const models = (raw as { models: unknown[] }).models;
	const results: HFModelItem[] = [];
	const seen = new Set<string>();
	for (const value of models) {
		if (!value || typeof value !== "object") {
			continue;
		}
		const model = value as CodexModelInfo;
		if (typeof model.slug !== "string" || !model.slug || seen.has(model.slug)) {
			continue;
		}
		if (model.visibility !== "list" || model.supported_in_api !== true) {
			continue;
		}
		seen.add(model.slug);
		const extra = supplementary[model.slug];
		const validLevels = (model.supported_reasoning_levels ?? [])
			.filter((level) => level && typeof level.effort === "string" && level.effort.length > 0)
			.map((level) => ({ effort: level.effort, description: level.description ?? "" }));
		const preferred = model.default_reasoning_level;
		const defaultEffort =
			typeof preferred === "string" && validLevels.some((item) => item.effort === preferred)
				? preferred
				: validLevels[0]?.effort;
		results.push({
			id: model.slug,
			configId: "chatgpt",
			displayName: model.display_name || model.slug,
			owned_by: "chatgpt",
			apiMode: "openai-responses",
			chatgptAuth: true,
			...(positiveInteger(model.context_window)
				? { context_length: model.context_window }
				: positiveInteger(extra?.limit?.context)
					? { context_length: extra.limit.context }
					: {}),
			// Catalog metadata informs the picker but should not force max_output_tokens on every request.
			...(positiveInteger(extra?.limit?.output) ? { catalog_max_output_tokens: extra.limit.output } : {}),
			...(defaultEffort ? { reasoning_effort: defaultEffort } : {}),
			...(validLevels.length ? { reasoning_efforts: validLevels } : {}),
			vision: model.input_modalities?.includes("image") ?? extra?.modalities?.input?.includes("image") ?? false,
		});
	}
	return results;
}

/**
 * Merge account-discovered models with manual settings. Explicit manual entries
 * take priority, including enabled:false (which hides an auto-discovered model).
 * Models with non-ChatGPT authentication retain their own independent entry.
 */
export function mergeChatGPTModels(manual: HFModelItem[], discovered: HFModelItem[]): HFModelItem[] {
	const matching = new Map(discovered.map((model) => [model.id, model]));
	const output: HFModelItem[] = manual.map((model) => {
		if (model.chatgptAuth !== true) {
			return model;
		}
		const info = matching.get(model.id);
		if (!info) {
			return model;
		}
		return {
			...info,
			...model,
			configId: model.configId ?? "chatgpt",
			owned_by: model.owned_by || "chatgpt",
		};
	});
	for (const model of discovered) {
		if (
			manual.some(
				(item) => item.id === model.id && (item.configId === "chatgpt" || (item.chatgptAuth === true && !item.configId))
			)
		) {
			continue;
		}
		output.push(model);
	}
	return output;
}

/** Parse just the OpenAI section from models.dev's public catalog. */
export function fromModelsDev(raw: unknown): Record<string, ModelsDevModel> {
	if (!raw || typeof raw !== "object") {
		return {};
	}
	const openai = (raw as Record<string, unknown>).openai;
	if (!openai || typeof openai !== "object") {
		return {};
	}
	const models = (openai as { models?: unknown }).models;
	if (!models || typeof models !== "object" || Array.isArray(models)) {
		return {};
	}
	return models as Record<string, ModelsDevModel>;
}

/** Only user-controlled fields are stored; current catalog metadata stays refreshable. */
const OVERRIDABLE_FIELDS = [
	"enabled",
	"displayName",
	"family",
	"context_length",
	"max_tokens",
	"max_completion_tokens",
	"vision",
	"reasoning_effort",
	"temperature",
	"top_p",
	"delay",
	"pricing",
	"top_k",
	"min_p",
	"frequency_penalty",
	"presence_penalty",
	"repetition_penalty",
	"include_reasoning_in_request",
	"extra",
] as const satisfies ReadonlyArray<keyof HFModelItem>;

/** Calculate a minimal, serializable override instead of copying catalog fields into settings. */
export function buildChatGPTOverride(edited: HFModelItem, discovered: HFModelItem): HFModelItem | undefined {
	if (edited.id !== discovered.id || discovered.chatgptAuth !== true) {
		throw new Error("Cannot override an unrelated ChatGPT model");
	}
	const override: HFModelItem = {
		id: discovered.id,
		configId: "chatgpt",
		owned_by: "chatgpt",
		chatgptAuth: true,
	};
	for (const field of OVERRIDABLE_FIELDS) {
		const requested = edited[field];
		// An omitted catalog 'enabled' flag means enabled by default.
		if (field === "enabled" && requested === true && discovered.enabled !== false) {
			continue;
		}
		if (requested === undefined || JSON.stringify(requested) === JSON.stringify(discovered[field])) {
			continue;
		}
		// Use a typed mutable record for the dynamic pick list.
		(override as unknown as Record<string, unknown>)[field] = requested;
	}
	return Object.keys(override).length === 4 ? undefined : override;
}
