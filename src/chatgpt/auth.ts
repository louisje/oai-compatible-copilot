import * as vscode from "vscode";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const REDIRECT = "http://localhost:1455/auth/callback";
const SECRET = "oaicopilot.chatgpt.oauth";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

interface Tokens {
	access_token: string;
	refresh_token: string;
	id_token?: string;
	expires_in?: number;
}

interface Credentials {
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
}

function accountId(token?: string): string | undefined {
	if (!token) { return undefined; }
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
			chatgpt_account_id?: string;
			organizations?: { id: string }[];
			"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
		};
		return claims.chatgpt_account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.organizations?.[0]?.id;
	} catch { return undefined; }
}

function credentials(tokens: Tokens): Credentials {
	return {
		access: tokens.access_token,
		refresh: tokens.refresh_token,
		expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		accountId: accountId(tokens.id_token) ?? accountId(tokens.access_token),
	};
}

async function exchange(params: URLSearchParams): Promise<Tokens> {
	const response = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
	if (!response.ok) { throw new Error(`ChatGPT OAuth token request failed: HTTP ${response.status}`); }
	const tokens = await response.json() as Tokens;
	if (!tokens.access_token || !tokens.refresh_token) { throw new Error("ChatGPT OAuth response is missing tokens"); }
	return tokens;
}

export class ChatGPTAuth {
	private refreshPending?: Promise<Credentials>;
	constructor(private readonly secrets: vscode.SecretStorage) {}

	async login(): Promise<void> {
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const state = randomBytes(32).toString("base64url");
		let server: Server | undefined;
		let listening: Promise<void> | undefined;
		let timeout: NodeJS.Timeout | undefined;
		try {
			const codePromise = new Promise<string>((resolve, reject) => {
				server = createServer((req, res) => {
					const url = new URL(req.url ?? "/", REDIRECT);
					if (url.pathname !== "/auth/callback") {
						res.writeHead(404).end("Not found");
						return;
					}
					if (url.searchParams.get("state") !== state) {
						res.writeHead(400).end("Invalid OAuth state");
						return;
					}
					const error = url.searchParams.get("error");
					const code = url.searchParams.get("code");
					if (error || !code) {
						res.writeHead(400).end("Authorization failed");
						reject(new Error(error ?? "Authorization code missing"));
						return;
					}
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
						.end("<!doctype html><title>ChatGPT connected</title><p>Authorization received. Return to VS Code.</p>");
					resolve(code);
				});
				server.once("error", reject);
				listening = new Promise<void>((ready, fail) => {
					server!.once("error", fail);
					server!.listen(1455, "localhost", ready);
				});
			});
			const params = new URLSearchParams({
				response_type: "code",
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT,
				scope: "openid profile email offline_access",
				code_challenge: challenge,
				code_challenge_method: "S256",
				id_token_add_organizations: "true",
				codex_cli_simplified_flow: "true",
				state,
				originator: "kilo",
			});
			await listening;
			const url = vscode.Uri.parse(`${ISSUER}/oauth/authorize?${params}`);
			if (!await vscode.env.openExternal(url)) { throw new Error("Could not open the browser"); }
			const code = await Promise.race([
				codePromise,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("ChatGPT login timed out after 5 minutes")), 300_000);
				}),
			]);
			const tokens = await exchange(new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT,
				code,
				code_verifier: verifier,
			}));
			await this.secrets.store(SECRET, JSON.stringify(credentials(tokens)));
		} finally {
			if (timeout) { clearTimeout(timeout); }
			server?.close();
		}
	}

	/** Returns a non-secret, account-scoped cache key. Never returns OAuth tokens. */
	async identity(): Promise<string | undefined> {
		const stored = await this.secrets.get(SECRET);
		if (!stored) { return undefined; }
		try {
			const value = JSON.parse(stored) as Credentials;
			const identity = value.accountId ?? value.refresh;
			return identity ? createHash("sha256").update(identity).digest("hex") : undefined;
		} catch { return undefined; }
	}

	async logout(): Promise<void> {
		await this.secrets.delete(SECRET);
	}

	async getHeaders(): Promise<Record<string, string>> {
		const stored = await this.secrets.get(SECRET);
		if (!stored) { throw new Error("ChatGPT subscription is not connected. Run 'OAICopilot: Sign in to ChatGPT'."); }
		let value = JSON.parse(stored) as Credentials;
		if (value.expires <= Date.now() + 60_000) {
			if (!this.refreshPending) {
				this.refreshPending = (async () => {
					const tokens = await exchange(new URLSearchParams({
						grant_type: "refresh_token",
						client_id: CLIENT_ID,
						refresh_token: value.refresh,
					}));
					const updated = credentials(tokens);
					updated.accountId ??= value.accountId;
					await this.secrets.store(SECRET, JSON.stringify(updated));
					return updated;
				})().finally(() => { this.refreshPending = undefined; });
			}
			value = await this.refreshPending;
		}
		return {
			Authorization: `Bearer ${value.access}`,
			...(value.accountId ? { "ChatGPT-Account-Id": value.accountId } : {}),
		};
	}
}
