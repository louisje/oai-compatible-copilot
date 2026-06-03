import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiApi } from "../openai/openaiApi";

function streamFromSseEvents(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const data = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("") + "data: [DONE]\n";
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(data));
			controller.close();
		},
	});
}

async function collectToolCalls(events: Record<string, unknown>[]): Promise<vscode.LanguageModelToolCallPart[]> {
	const api = new OpenaiApi("tool-call-test-model");
	const parts: vscode.LanguageModelResponsePart2[] = [];
	const cts = new vscode.CancellationTokenSource();
	try {
		await api.processStreamingResponse(streamFromSseEvents(events), { report: (part) => parts.push(part) }, cts.token);
	} finally {
		cts.dispose();
	}
	return parts.filter(
		(part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
	);
}

suite("toolCallArguments", () => {
	test("preserves OpenAI string tool call arguments assembled from streaming deltas", async () => {
		const toolCalls = await collectToolCalls([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_read_file",
									function: { name: "read_file", arguments: "{" },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: '"path":"/tmp/test.txt"' },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: "}" },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		]);

		assert.strictEqual(toolCalls.length, 1);
		assert.strictEqual(toolCalls[0].name, "read_file");
		assert.deepStrictEqual(toolCalls[0].input, { path: "/tmp/test.txt" });
	});

	test("preserves object tool call arguments returned by OpenAI-compatible providers", async () => {
		const toolCalls = await collectToolCalls([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_read_file",
									function: {
										name: "read_file",
										arguments: { path: "/tmp/test.txt" },
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		]);

		assert.strictEqual(toolCalls.length, 1);
		assert.strictEqual(toolCalls[0].name, "read_file");
		assert.deepStrictEqual(toolCalls[0].input, { path: "/tmp/test.txt" });
	});
});
