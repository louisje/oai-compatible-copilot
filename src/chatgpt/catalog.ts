import type * as vscode from "vscode";
import type { HFModelItem } from "../types";
import { ChatGPTAuth } from "./auth";
import { fromCodexCatalog, fromModelsDev, type ModelsDevModel } from "./models";
import { logger } from "../logger";

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
// Codex supplies this query parameter; update when the upstream protocol changes.
const CODEX_CLIENT_VERSION = "0.161.0";
const CATALOG_CACHE_KEY = "oaicopilot.chatgpt.modelCatalog.v1";
const SUPPLEMENT_CACHE_KEY = "oaicopilot.chatgpt.publicModels.v1";
const CATALOG_TTL = 30 * 60_000;
const SUPPLEMENT_TTL = 24 * 60 * 60_000;

interface CatalogCache {
	identity: string;
	fetchedAt: number;
	etag?: string;
	models: HFModelItem[];
}

interface SupplementCache {
	fetchedAt: number;
	models: Record<string, ModelsDevModel>;
}

export class ChatGPTModelCatalog {
	private pending?: Promise<HFModelItem[]>;
	constructor(
		private readonly auth: ChatGPTAuth,
		private readonly storage: vscode.Memento
	) {}

	async isConnected(): Promise<boolean> {
		return !!(await this.auth.identity());
	}

	async invalidate(): Promise<void> {
		this.pending = undefined;
		await this.storage.update(CATALOG_CACHE_KEY, undefined);
	}

	async list(force = false): Promise<HFModelItem[]> {
		const identity = await this.auth.identity();
		if (!identity) { return []; }
		const cache = this.storage.get<CatalogCache>(CATALOG_CACHE_KEY);
		if (!force && cache?.identity === identity && Date.now() - cache.fetchedAt < CATALOG_TTL) {
			return cache.models;
		}
		if (this.pending) { return this.pending; }
		this.pending = this.refresh(identity, cache?.identity === identity ? cache : undefined)
			.finally(() => { this.pending = undefined; });
		return this.pending;
	}

	private async refresh(identity: string, old?: CatalogCache): Promise<HFModelItem[]> {
		try {
			const headers = await this.auth.getHeaders();
			if (old?.etag) { headers["If-None-Match"] = old.etag; }
			const url = `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`;
			const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
			if (response.status === 304 && old) {
				await this.storage.update(CATALOG_CACHE_KEY, { ...old, fetchedAt: Date.now() } satisfies CatalogCache);
				return old.models;
			}
			if (!response.ok) { throw new Error(`Codex model discovery failed: HTTP ${response.status}`); }
			const json: unknown = await response.json();
			const supplement = await this.supplementalModels();
			const models = fromCodexCatalog(json, supplement);
			if (!models.length) {
				// An empty/unsupported catalog must not silently overwrite a known-good list.
				throw new Error("Codex returned no selectable models");
			}
			await this.storage.update(CATALOG_CACHE_KEY, {
				identity,
				fetchedAt: Date.now(),
				etag: response.headers.get("etag") ?? undefined,
				models,
			} satisfies CatalogCache);
			logger.info("chatgpt.models.loaded", { count: models.length });
			return models;
		} catch (error) {
			logger.warn("chatgpt.models.refresh.failed", { error: String(error) });
			return old?.models ?? [];
		}
	}

	private async supplementalModels(): Promise<Record<string, ModelsDevModel>> {
		const cache = this.storage.get<SupplementCache>(SUPPLEMENT_CACHE_KEY);
		if (cache && Date.now() - cache.fetchedAt < SUPPLEMENT_TTL) { return cache.models; }
		try {
			const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(8_000) });
			if (!response.ok) { throw new Error(`models.dev: HTTP ${response.status}`); }
			const models = fromModelsDev(await response.json() as unknown);
			if (Object.keys(models).length) {
				await this.storage.update(SUPPLEMENT_CACHE_KEY, {
					fetchedAt: Date.now(),
					models,
				} satisfies SupplementCache);
				return models;
			}
		} catch (error) {
			logger.debug("chatgpt.models.supplement.failed", { error: String(error) });
		}
		return cache?.models ?? {};
	}
}
