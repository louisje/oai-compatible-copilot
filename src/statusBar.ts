import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Token Count";
	tokenCountStatusBarItem.text = "$(symbol-numeric) Ready";
	tokenCountStatusBarItem.tooltip = "Current model token usage - Click to Open Configuration UI";
	tokenCountStatusBarItem.command = "oaicopilot.openConfig";
	context.subscriptions.push(tokenCountStatusBarItem);
	// Show the status bar item initially
	tokenCountStatusBarItem.show();
	return tokenCountStatusBarItem;
}

/**
 * Format a USD amount for display (e.g. "$0.258", "$1.35").
 * @param value The cost in USD.
 */
export function formatCostUsd(value: number): string {
	if (value === 0) {
		return "$0.00";
	}
	if (value < 0.01) {
		return `$${value.toFixed(4)}`;
	}
	return `$${value.toFixed(2)}`;
}

/**
 * Update the status bar to additionally display the cost (in USD) of the last completed
 * request alongside the cumulative session cost. This is called after a chat response
 * finishes, independent of the pre-request context/token estimate updated by
 * {@linkcode updateContextStatusBar}.
 * @param statusBarItem The status bar item to update.
 * @param lastCostUsd Cost in USD of the most recently completed request, or `null` if unknown
 * (e.g. no pricing configured and the upstream API did not report `cost_usd`).
 * @param sessionCostUsd Cumulative cost in USD across all requests during this session.
 */
export function updateStatusBarCost(
	statusBarItem: vscode.StatusBarItem,
	lastCostUsd: number | null,
	sessionCostUsd: number
): void {
	if (lastCostUsd === null && sessionCostUsd === 0) {
		// Nothing to show; leave the existing token/context display untouched.
		return;
	}

	const costPrefix = lastCostUsd !== null ? `$(credit-card) ${formatCostUsd(lastCostUsd)} ` : "";
	// Preserve the existing text but prepend the cost segment if not already present.
	const existingText = statusBarItem.text.replace(/^\$\(credit-card\)\s+\$[0-9.]+\s+/, "");
	statusBarItem.text = `${costPrefix}${existingText}`;

	const costTooltipLines = [
		lastCostUsd !== null ? `Last Request Cost: ${formatCostUsd(lastCostUsd)}` : "Last Request Cost: N/A",
		`Session Cost: ${formatCostUsd(sessionCostUsd)}`,
	].join("\n");

	const existingTooltip =
		typeof statusBarItem.tooltip === "string"
			? statusBarItem.tooltip
			: statusBarItem.tooltip instanceof vscode.MarkdownString
				? statusBarItem.tooltip.value
				: "";
	// Strip any previously appended cost block, then append the fresh one.
	const baseTooltip = existingTooltip.split("\n\n---\n")[0];
	statusBarItem.tooltip = `${baseTooltip}\n\n---\n${costTooltipLines}`;
}

/**
 * Format number to thousands (K, M, B) format
 * @param value The number to format
 * @returns Formatted string (e.g., "2.3K", "168.0K")
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage
 * @param usedTokens Tokens used
 * @param maxTokens Maximum tokens available
 * @returns Progress bar string (e.g., "▆ 75.2%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

	return `${blocks[blockIndex]} ${usagePercentage.toFixed(1)}%`;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<void> {
	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) => countMessageTokens(message, modelConfig));

	const tokenCounts = await Promise.all(tokenCountPromises);
	const messagesTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Calculate tool definition tokens
	let toolTokens = 0;
	if (tools && tools.length > 0) {
		toolTokens = await countToolTokens(tools);
	}

	// Total tokens: messages + tool definitions + reserved output
	const totalTokenCount = messagesTokens + toolTokens;
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	// Create visual progress bar with single progressive block
	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	const displayText = `$(symbol-parameter) ${progressBar}`;
	statusBarItem.text = displayText;
	statusBarItem.tooltip = `Token Usage: ${formatTokenCount(totalTokenCount)} / ${formatTokenCount(maxTokens)}\n
${progressBar}\n
  - Messages: ${formatTokenCount(messagesTokens)}  (${Math.min((messagesTokens / maxTokens) * 100, 100).toFixed(1)}%)
  - Tools: ${formatTokenCount(toolTokens)}  (${Math.min((toolTokens / maxTokens) * 100, 100).toFixed(1)}%) \n
Click to Open Configuration UI`;

	// Add color coding based on token usage
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	if (usagePercentage >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		statusBarItem.backgroundColor = undefined;
	}

	statusBarItem.show();
}
