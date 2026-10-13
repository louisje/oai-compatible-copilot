import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

const LOG_RETENTION_DAYS = 7;
const SENSITIVE_HEADER_KEYS = ["Authorization", "x-api-key", "x-goog-api-key"];

class Logger {
	private _logDir = "";
	private _initialized = false;
	private _outputChannel: vscode.LogOutputChannel | undefined;

	/**
	 * Initialize the logger: create the log output channel, ensure log directory exists.
	 * Optionally register an extension context so the output channel gets disposed on deactivate.
	 *
	 * The log level is controlled by the user via the Output channel's own UI (or the
	 * editor-wide `env.logLevel`), following VS Code's built-in LogOutputChannel convention
	 * instead of a custom `oaicopilot.logLevel` setting.
	 */
	init(context?: vscode.ExtensionContext): void {
		this._logDir = path.join(os.homedir(), ".copilot", "oaicopilot", "logs");
		this._outputChannel = vscode.window.createOutputChannel("OAI Compatible Provider", { log: true });
		if (context) {
			context.subscriptions.push(this._outputChannel);
		}
		this.ensureLogDir();
		this._initialized = true;
	}

	verbose(tag: string, data: Record<string, unknown>): void {
		if (!this._outputChannel || this._outputChannel.logLevel > vscode.LogLevel.Trace) {
			return;
		}
		this.write("verbose", tag, data);
	}

	debug(tag: string, data: Record<string, unknown>): void {
		if (!this._outputChannel || this._outputChannel.logLevel > vscode.LogLevel.Debug) {
			return;
		}
		this.write("debug", tag, data);
	}

	info(tag: string, data: Record<string, unknown>): void {
		if (!this._outputChannel || this._outputChannel.logLevel > vscode.LogLevel.Info) {
			return;
		}
		this.write("info", tag, data);
	}

	warn(tag: string, data: Record<string, unknown>): void {
		if (!this._outputChannel || this._outputChannel.logLevel > vscode.LogLevel.Warning) {
			return;
		}
		this.write("warn", tag, data);
	}

	error(tag: string, data: Record<string, unknown>): void {
		if (!this._outputChannel || this._outputChannel.logLevel > vscode.LogLevel.Error) {
			return;
		}
		this.write("error", tag, data);
	}

	/**
	 * Sanitize sensitive headers: show only first 4 chars + "***" for auth-related keys.
	 */
	sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
		const sanitized: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			if (SENSITIVE_HEADER_KEYS.includes(key)) {
				// Extract the token part after "Bearer " if present
				const tokenPrefix = value.startsWith("Bearer ") ? "Bearer " : "";
				const token = value.startsWith("Bearer ") ? value.slice(7) : value;
				if (token.length <= 4) {
					sanitized[key] = tokenPrefix + "***";
				} else {
					sanitized[key] = tokenPrefix + token.slice(0, 4) + "***";
				}
			} else {
				sanitized[key] = value;
			}
		}
		return sanitized;
	}

	/**
	 * Sanitize any object that may contain headers deeply.
	 * Looks for "headers" keys at any level and sanitates them.
	 */
	sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (key === "headers" && value && typeof value === "object" && !Array.isArray(value)) {
				result[key] = this.sanitizeHeaders(value as Record<string, string>);
			} else if (value && typeof value === "object" && !Array.isArray(value)) {
				result[key] = this.sanitizeData(value as Record<string, unknown>);
			} else {
				result[key] = value;
			}
		}
		return result;
	}

	private ensureLogDir(): void {
		if (!fs.existsSync(this._logDir)) {
			fs.mkdirSync(this._logDir, { recursive: true });
		}
	}

	private getLogFilePath(): string {
		const now = new Date();
		const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
		return path.join(this._logDir, `oaicopilot-${dateStr}.log`);
	}

	private write(
		level: "verbose" | "debug" | "info" | "warn" | "error",
		tag: string,
		data: Record<string, unknown>
	): void {
		if (!this._initialized) {
			return;
		}

		const sanitizedData = this.sanitizeData(data);
		const logEntry = {
			ts: new Date().toISOString(),
			level,
			tag,
			data: sanitizedData,
		};

		const line = JSON.stringify(logEntry) + "\n";
		const filePath = this.getLogFilePath();

		// Use the LogOutputChannel's own level methods so its built-in log level
		// filtering, colouring, and "Help: Open Logs Folder" integration apply.
		this._outputChannel?.[level === "verbose" ? "trace" : level](`[${tag}] ${JSON.stringify(sanitizedData)}`);

		try {
			fs.appendFileSync(filePath, line, "utf8");
			this.cleanOldLogs();
		} catch (e) {
			console.error("[OAICopilot Logger] Failed to write log:", e);
		}
	}

	private cleanOldLogs(): void {
		try {
			if (!fs.existsSync(this._logDir)) {
				return;
			}

			const files = fs.readdirSync(this._logDir);
			const now = new Date();
			const cutoffTime = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

			for (const file of files) {
				// Extract date from filename: oaicopilot-YYYYMMDD.log
				const match = file.match(/^oaicopilot-(\d{4})(\d{2})(\d{2})\.log$/);
				if (!match) {
					continue;
				}

				const year = parseInt(match[1], 10);
				const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
				const day = parseInt(match[3], 10);
				const fileDate = new Date(year, month, day);

				if (fileDate.getTime() < cutoffTime) {
					const filePath = path.join(this._logDir, file);
					fs.unlinkSync(filePath);
				}
			}
		} catch (e) {
			console.error("[OAICopilot Logger] Failed to clean old logs:", e);
		}
	}

	/**
	 * Reveal the output channel in the VS Code UI.
	 */
	show(): void {
		this._outputChannel?.show();
	}
}

export const logger = new Logger();
