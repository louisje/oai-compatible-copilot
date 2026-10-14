import type * as vscode from "vscode";
import type { HFModelItem } from "./types";

export type ReasoningEffortPickerValue = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

const DEFAULT_REASONING_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_VALUES: readonly ReasoningEffortPickerValue[] = [
	...DEFAULT_REASONING_EFFORT_VALUES,
	"none",
	"ultra",
];

export const REASONING_EFFORT_CONFIGURATION_SCHEMA = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			enum: DEFAULT_REASONING_EFFORT_VALUES,
			enumItemLabels: ["Minimal", "Low", "Medium", "High", "XHigh", "Max"],
			enumDescriptions: [
				"Smallest reasoning budget",
				"Low reasoning budget",
				"Balanced reasoning budget",
				"High reasoning budget",
				"Very high reasoning budget",
				"Maximum reasoning budget",
			],
			default: "medium",
			group: "navigation",
		},
	},
} as const;

export function createReasoningEffortConfigurationSchema(
	defaultValue: ReasoningEffortPickerValue,
	levels?: readonly { effort: string; description?: string }[]
) {
	const source = REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort;
	const validLevels = levels?.filter((level) => isReasoningEffortValue(level.effort));
	const choices = validLevels?.length
		? [...new Map(validLevels.map((level) => [level.effort, level])).values()]
		: source.enum.map((effort, index) => ({
				effort,
				description: source.enumDescriptions[index],
			}));
	return {
		properties: {
			reasoningEffort: {
				...source,
				enum: choices.map((choice) => choice.effort),
				enumItemLabels: choices.map((choice) => choice.effort.charAt(0).toUpperCase() + choice.effort.slice(1)),
				enumDescriptions: choices.map((choice) => choice.description || ""),
				default: choices.some((choice) => choice.effort === defaultValue) ? defaultValue : choices[0].effort,
			},
		},
	};
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable?: boolean;
	readonly detail?: string;
	readonly tooltip?: string;
	readonly configurationSchema?: ReturnType<typeof createReasoningEffortConfigurationSchema>;
	// From the `languageModelPricing` proposed API.
	readonly pricing?: string;
	readonly inputCost?: number;
	readonly outputCost?: number;
	readonly cacheCost?: number;
	readonly cacheWriteCost?: number;
};

/**
 * Build the `languageModelPricing` proposed-API fields (`pricing`, `inputCost`, `outputCost`,
 * `cacheCost`) for a model, based on its configured {@linkcode ModelPricing}. All costs are
 * expressed in USD per 1,000,000 tokens, matching the proposed API's unit convention.
 * Returns an empty object when no pricing is configured.
 */
export function buildPricingPickerFields(pricing: import("./types").ModelPricing | undefined) {
	if (!pricing) {
		return {};
	}
	const unit = pricing.unit_per_tokens ?? 1_000_000;
	// Normalize to "per 1M tokens" for the proposed API, regardless of the configured unit.
	const scale = 1_000_000 / unit;
	const inputCost = pricing.input * scale;
	const outputCost = pricing.output * scale;
	const cacheCost = pricing.cache_read !== undefined ? pricing.cache_read * scale : undefined;
	const cacheWriteCost = pricing.cache_write !== undefined ? pricing.cache_write * scale : undefined;

	const label = `$${inputCost.toFixed(2)}/1M input · $${outputCost.toFixed(2)}/1M output`;

	return {
		pricing: label,
		inputCost,
		outputCost,
		...(cacheCost !== undefined ? { cacheCost } : {}),
		...(cacheWriteCost !== undefined ? { cacheWriteCost } : {}),
	};
}

export function isReasoningEffortPickerEnabled(
	model: HFModelItem | undefined
): model is HFModelItem & { reasoning_effort: ReasoningEffortPickerValue } {
	return isReasoningEffortValue(model?.reasoning_effort);
}

export function getConfiguredReasoningEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined,
	fallback: ReasoningEffortPickerValue = "medium"
): ReasoningEffortPickerValue {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configuredEffort =
		modelOptions?.modelConfiguration?.reasoningEffort ?? modelOptions?.configuration?.reasoningEffort;

	if (isReasoningEffortValue(configuredEffort)) {
		return configuredEffort;
	}
	return fallback;
}

export function isReasoningEffortValue(value: unknown): value is ReasoningEffortPickerValue {
	return typeof value === "string" && REASONING_EFFORT_VALUES.includes(value as ReasoningEffortPickerValue);
}
