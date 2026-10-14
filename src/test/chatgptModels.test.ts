import * as assert from "assert";
import { buildChatGPTOverride, fromCodexCatalog, fromModelsDev, mergeChatGPTModels } from "../chatgpt/models";

suite("ChatGPT Codex models", () => {
	const sample = {
		models: [
			{
				slug: "gpt-example-a",
				display_name: "GPT Example A",
				visibility: "list",
				supported_in_api: true,
				context_window: 500000,
				max_context_window: 872000,
				default_reasoning_level: "low",
				supported_reasoning_levels: [
					{ effort: "low", description: "Fast" },
					{ effort: "ultra", description: "Deep" },
				],
				input_modalities: ["text", "image"],
			},
			{ slug: "gpt-example-hidden", visibility: "hide", supported_in_api: true },
			{ slug: "gpt-example-no-api", visibility: "list", supported_in_api: false },
		],
	};

	test("keeps only visible supported models and enriches output limit", () => {
		const extra = fromModelsDev({
			openai: { models: { "gpt-example-a": { limit: { output: 128000 }, tool_call: true } } },
		});
		const models = fromCodexCatalog(sample, extra);
		assert.strictEqual(models.length, 1);
		assert.deepStrictEqual(
			{
				id: models[0].id,
				configId: models[0].configId,
				context_length: models[0].context_length,
				catalog_max_output_tokens: models[0].catalog_max_output_tokens,
				reasoning_effort: models[0].reasoning_effort,
				reasoning_efforts: models[0].reasoning_efforts,
				vision: models[0].vision,
				chatgptAuth: models[0].chatgptAuth,
			},
			{
				id: "gpt-example-a",
				configId: "chatgpt",
				context_length: 500000,
				catalog_max_output_tokens: 128000,
				reasoning_effort: "low",
				reasoning_efforts: [
					{ effort: "low", description: "Fast" },
					{ effort: "ultra", description: "Deep" },
				],
				vision: true,
				chatgptAuth: true,
			}
		);
	});

	test("manual overrides win without hiding unrelated API-key configurations", () => {
		const discovered = fromCodexCatalog(sample);
		const merged = mergeChatGPTModels([
			{ id: "gpt-example-a", owned_by: "openai", apiMode: "openai", max_tokens: 1000 },
			{ id: "gpt-example-a", owned_by: "chatgpt", chatgptAuth: true, max_tokens: 8192, reasoning_effort: "ultra" },
		], discovered);
		assert.strictEqual(merged.length, 2);
		assert.strictEqual(merged[0].chatgptAuth, undefined);
		assert.strictEqual(merged[1].context_length, 500000);
		assert.strictEqual(merged[1].max_tokens, 8192);
		assert.strictEqual(merged[1].reasoning_effort, "ultra");
		assert.strictEqual(merged[1].configId, "chatgpt");
	});

	test("explicitly disabled ChatGPT model does not return through discovery", () => {
		const merged = mergeChatGPTModels(
			[{ id: "gpt-example-a", owned_by: "chatgpt", chatgptAuth: true, enabled: false }],
			fromCodexCatalog(sample)
		);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].enabled, false);
	});

	test("saving an unchanged discovered model does not create an override", () => {
		const discovered = fromCodexCatalog(sample)[0];
		assert.strictEqual(buildChatGPTOverride({ ...discovered, enabled: true }, discovered), undefined);
	});

	test("disable creates a minimal override; reset restores the discovered model", () => {
		const discovered = fromCodexCatalog(sample)[0];
		const override = buildChatGPTOverride({ ...discovered, enabled: false }, discovered);
		assert.deepStrictEqual(override, {
			id: discovered.id,
			configId: "chatgpt",
			owned_by: "chatgpt",
			chatgptAuth: true,
		enabled: false,
		});
		assert.strictEqual(mergeChatGPTModels([override!], [discovered])[0].enabled, false);
		assert.strictEqual(mergeChatGPTModels([], [discovered])[0].enabled, undefined);
	});

	test("stores only changed fields and inherits updated catalog metadata", () => {
		const discovered = fromCodexCatalog(sample)[0];
		const override = buildChatGPTOverride(
			{ ...discovered, enabled: true, context_length: 250000, reasoning_effort: "ultra" },
			discovered
		);
		assert.deepStrictEqual(override, {
			id: discovered.id,
			configId: "chatgpt",
			owned_by: "chatgpt",
			chatgptAuth: true,
			context_length: 250000,
			reasoning_effort: "ultra",
		});
		const changedCatalog = { ...discovered, displayName: "Updated name", vision: false };
		const result = mergeChatGPTModels([override!], [changedCatalog]);
		assert.strictEqual(result[0].context_length, 250000);
		assert.strictEqual(result[0].reasoning_effort, "ultra");
		assert.strictEqual(result[0].displayName, "Updated name");
		assert.strictEqual(result[0].vision, false);
		assert.strictEqual(result[0].reasoning_efforts?.[1].effort, "ultra");
	});

	test("rejects invalid model catalogs", () => {
		assert.throws(() => fromCodexCatalog({ data: [] }), /Invalid Codex models response/);
	});
});
