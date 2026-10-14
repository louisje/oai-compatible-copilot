import * as vscode from "vscode";
import type { HFModelItem } from "../types";
import { getEnabledUserModels, normalizeUserModels } from "../utils";
import { ChatGPTModelCatalog } from "./catalog";
import { mergeChatGPTModels } from "./models";

/**
 * The auto-discovered Codex models coexist with existing user-defined providers.
 * Do not modify oaicopilot.models in settings: it remains the user's overrides.
 */
export async function resolveAvailableModels(catalog: ChatGPTModelCatalog): Promise<HFModelItem[]> {
	const config = vscode.workspace.getConfiguration();
	const manual = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));
	const connected = await catalog.isConnected();
	const discovered = connected ? await catalog.list() : [];
	const available = connected
		? mergeChatGPTModels(manual, discovered)
		: manual.filter((model) => model.chatgptAuth !== true);
	return getEnabledUserModels(
		available,
		config.get<string[]>("oaicopilot.disabledProviders", [])
	);
}
