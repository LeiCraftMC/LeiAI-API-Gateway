/**
 * Tests for providers whose backends only speak the Anthropic Messages API
 * (`supportsOpenAILikeAPI: false`): the OpenAI Chat -> Anthropic converters
 * and the OpenAI-style endpoints translating onto a fake Anthropic backend.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import {
	DEFAULT_ANTHROPIC_MAX_TOKENS,
	JSON_RESPONSE_TOOL,
	TranslationError,
	openAIChatRequestToAnthropic,
	anthropicResponseToOpenAIChat,
	anthropicSseToOpenaiChatSse,
	openaiChatSseToResponsesSse,
} from "../src/translation";
import { authMiddlewareV1 } from "../src/api/versions/v1/auth";
import { router as openaiRouter } from "../src/api/versions/v1/routes/openai";
import { router as anthropicRouter } from "../src/api/versions/v1/routes/anthropic";
import { router as responsesRouter } from "../src/api/versions/v1/routes/responses";
import { ProviderManager } from "../src/loadBalancing/providerManager";
import { ProviderModelsIndex } from "../src/loadBalancing/providerModelsIndex";
import { BackendAPIClient } from "../src/loadBalancing/backendAPIClient";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { ApiKeysConfig } from "../src/utils/config/apiKeysConfig";
import { FakeAnthropicAPI } from "./helpers/fakeAnthropicAPI";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function runTransform(
	input: string,
	transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<string> {
	const writer = transform.writable.getWriter();
	const reader = transform.readable.getReader();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	// Don't await write/close before reading — see anthropic-translation tests.
	writer.write(encoder.encode(input));
	writer.close();
	let result = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
	}
	result += decoder.decode();
	return result;
}

async function readStream(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let result = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
	}
	result += decoder.decode();
	return result;
}

/** Parse the `data:` payloads of an SSE body (`[DONE]` is kept as a string). */
function sseData(text: string): any[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length))
		.map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

/** Serialize Anthropic stream events the way an Anthropic backend sends them. */
function anthropicStream(events: Array<{ type: string }>): string {
	return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function resetSingletons() {
	(ProviderManager as any)._initialized = false;
	(ProviderManager as any).providers = new Map();
	(GatewayConfig as any).config = null;
	(ApiKeysConfig as any).config = null;
}

/* ================================================================== */
/*  Unit: openAIChatRequestToAnthropic                                 */
/* ================================================================== */

describe("openAIChatRequestToAnthropic", () => {
	test("hoists system/developer messages and keeps plain turns as strings", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [
				{ role: "system", content: "Be helpful." },
				{ role: "developer", content: [{ type: "text", text: "Be brief." }] },
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: "Hello!" },
				{ role: "user", content: "Bye" },
			],
		});
		expect(out.system).toBe("Be helpful.\n\nBe brief.");
		expect(out.messages).toEqual([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello!" },
			{ role: "user", content: "Bye" },
		]);
		// Anthropic requires max_tokens; OpenAI requests may omit it.
		expect(out.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_TOKENS);
		expect(out.stream).toBe(false);
	});

	test("turns tool_calls + tool messages into tool_use / tool_result blocks", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [
				{ role: "user", content: "Weather in SF and NYC?" },
				{
					role: "assistant",
					content: "Checking.",
					tool_calls: [
						{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
						{ id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "Sunny" },
				{ role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "Rainy" }] },
				{ role: "user", content: "Thanks" },
			],
		});
		// Both tool results land in one user turn, ahead of the user's text.
		expect(out.messages).toEqual([
			{ role: "user", content: "Weather in SF and NYC?" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Checking." },
					{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
					{ type: "tool_use", id: "call_2", name: "get_weather", input: { city: "NYC" } },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "Sunny" },
					{ type: "tool_result", tool_use_id: "call_2", content: "Rainy" },
					{ type: "text", text: "Thanks" },
				],
			},
		]);
	});

	test("rewrites tool-call ids Anthropic would reject, keeping the pairs matched", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [
				{ role: "user", content: "Look it up" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "functions.lookup:0", type: "function", function: { name: "lookup", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "functions.lookup:0", content: "done" },
			],
		});
		expect(out.messages[1]!.content).toEqual([{ type: "tool_use", id: "functions_lookup_0", name: "lookup", input: {} }]);
		expect(out.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "functions_lookup_0", content: "done" }]);
	});

	test("converts image and PDF parts, normalising data-URL media types", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "Compare" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
					{ type: "image_url", image_url: { url: "data:image/jpg;name=cat.jpg;base64,/9j/4AAQ" } },
					{ type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
					{ type: "file", file: { filename: "doc.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
				],
			}],
		});
		expect(out.messages[0]!.content).toEqual([
			{ type: "text", text: "Compare" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
			{ type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
			{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
		]);
	});

	test("skips whitespace-only text, which Anthropic rejects", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [
				{ role: "system", content: "  " },
				{ role: "user", content: "Look it up" },
				{
					role: "assistant",
					content: "\n\n",
					tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call_1", content: " " },
				{ role: "user", content: [{ type: "text", text: " " }, { type: "text", text: "Thanks" }] },
			],
		});
		expect(out.system).toBeUndefined();
		expect(out.messages).toEqual([
			{ role: "user", content: "Look it up" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1" }, { type: "text", text: "Thanks" }] },
		]);
	});

	test("sends a system-only request as a user turn", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [{ role: "system", content: "Write a haiku" }],
		});
		expect(out.system).toBeUndefined();
		expect(out.messages).toEqual([{ role: "user", content: "Write a haiku" }]);
	});

	test("maps limits and sampling parameters into Anthropic's ranges", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [{ role: "user", content: "Hi" }],
			max_tokens: 100,
			max_completion_tokens: 200,
			temperature: 1.5,
			top_p: 0.9,
			stop: ["END", "\n\nUser:"],
			stream: true,
		});
		expect(out.max_tokens).toBe(200); // max_completion_tokens takes precedence
		expect(out.temperature).toBe(1); // Anthropic's maximum
		expect(out.top_p).toBeUndefined(); // newer Claude models reject it next to temperature
		expect(out.stop_sequences).toEqual(["END", "\n\nUser:"]);
		expect(out.stream).toBe(true);

		const topPOnly = openAIChatRequestToAnthropic({ model: "claude", messages: [{ role: "user", content: "Hi" }], top_p: 0.9 });
		expect(topPOnly.top_p).toBe(0.9);
	});

	test("rejects what Anthropic cannot honour instead of silently dropping it", () => {
		const base = { model: "claude", messages: [{ role: "user" as const, content: "Hi" }] };
		const rejects = (overrides: object) =>
			expect(() => openAIChatRequestToAnthropic({ ...base, ...overrides })).toThrow(TranslationError);

		rejects({ n: 2 });
		rejects({ logprobs: true });
		rejects({ stop: ["END", "\n"] });
		rejects({ messages: [] });
		rejects({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }] }] });
		rejects({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/svg+xml,%3Csvg%3E" } }] }] });
		rejects({ messages: [{ role: "user", content: [{ type: "file", file: { file_data: "data:text/plain;base64,SGk=" } }] }] });
	});

	test("requests a JSON response_format through a forced tool", () => {
		const schema = { type: "object", properties: { city: { type: "string" } } };
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [{ role: "user", content: "Where?" }],
			response_format: { type: "json_schema", json_schema: { name: "place", schema } },
		});
		expect(out.tools).toEqual([{ name: JSON_RESPONSE_TOOL, description: expect.any(String), input_schema: schema }]);
		expect(out.tool_choice).toEqual({ type: "tool", name: JSON_RESPONSE_TOOL });

		// With client tools on offer the model may call one of those instead.
		const withTools = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [{ role: "user", content: "Where?" }],
			response_format: { type: "json_object" },
			tools: [{ type: "function", function: { name: "lookup" } }],
		});
		expect(withTools.tools?.map((t) => t.name)).toEqual(["lookup", JSON_RESPONSE_TOOL]);
		expect(withTools.tools?.[1]?.input_schema).toEqual({ type: "object" });
		expect(withTools.tool_choice).toEqual({ type: "any" });
	});

	test("maps tools, tool_choice and parallel_tool_calls", () => {
		const base = {
			model: "claude",
			messages: [{ role: "user" as const, content: "Hi" }],
			tools: [
				{
					type: "function" as const,
					function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
				},
				{ type: "function" as const, function: { name: "ping" } },
			],
		};

		const out = openAIChatRequestToAnthropic(base);
		expect(out.tools).toEqual([
			{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
			{ name: "ping", input_schema: { type: "object", properties: {} } },
		]);
		expect(out.tool_choice).toBeUndefined();

		expect(openAIChatRequestToAnthropic({ ...base, tool_choice: "required" }).tool_choice).toEqual({ type: "any" });
		expect(openAIChatRequestToAnthropic({ ...base, tool_choice: "none" }).tool_choice).toEqual({ type: "none" });
		expect(
			openAIChatRequestToAnthropic({ ...base, tool_choice: { type: "function", function: { name: "ping" } } }).tool_choice,
		).toEqual({ type: "tool", name: "ping" });
		expect(openAIChatRequestToAnthropic({ ...base, parallel_tool_calls: false }).tool_choice)
			.toEqual({ type: "auto", disable_parallel_tool_use: true });
	});

	test("drops OpenAI-only parameters, and tool_choice without tools", () => {
		const out = openAIChatRequestToAnthropic({
			model: "claude",
			messages: [{ role: "user", content: "Hi" }],
			n: 1,
			seed: 7,
			user: "user-1",
			frequency_penalty: 0.5,
			response_format: { type: "text" },
			stream_options: { include_usage: true },
			tool_choice: "auto",
		});
		expect(Object.keys(out).sort()).toEqual(["max_tokens", "messages", "model", "stream"]);
	});
});

/* ================================================================== */
/*  Unit: anthropicResponseToOpenAIChat                                */
/* ================================================================== */

describe("anthropicResponseToOpenAIChat", () => {
	test("converts a text response, counting cached tokens as prompt tokens", () => {
		const out = anthropicResponseToOpenAIChat({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude",
			content: [{ type: "text", text: "Hello!" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
		});
		expect(out.object).toBe("chat.completion");
		expect(out.id).toBe("msg_1");
		expect(out.choices).toEqual([{
			index: 0,
			message: { role: "assistant", content: "Hello!" },
			finish_reason: "stop",
		}]);
		expect(out.usage).toEqual({
			prompt_tokens: 33,
			completion_tokens: 5,
			total_tokens: 38,
			prompt_tokens_details: { cached_tokens: 20 },
		});
	});

	test("converts tool_use blocks into tool_calls and thinking into reasoning_content", () => {
		const out = anthropicResponseToOpenAIChat({
			id: "msg_2",
			type: "message",
			role: "assistant",
			model: "claude",
			content: [
				{ type: "thinking", thinking: "Need the weather.", signature: "sig" },
				{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
			],
			stop_reason: "tool_use",
			stop_sequence: null,
			usage: { input_tokens: 8, output_tokens: 2 },
		});
		expect(out.choices[0]!.message).toEqual({
			role: "assistant",
			content: null,
			reasoning_content: "Need the weather.",
			tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
		});
		expect(out.choices[0]!.finish_reason).toBe("tool_calls");
	});

	test("maps stop reasons to finish reasons", () => {
		const finishFor = (stop_reason: string) => anthropicResponseToOpenAIChat({
			id: "m",
			type: "message",
			role: "assistant",
			model: "c",
			content: [{ type: "text", text: "..." }],
			stop_reason,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1 },
		}).choices[0]!.finish_reason;

		expect(finishFor("max_tokens")).toBe("length");
		expect(finishFor("stop_sequence")).toBe("stop");
		expect(finishFor("refusal")).toBe("content_filter");
	});

	test("turns the JSON-answer tool call into message content", () => {
		const resp = {
			id: "msg_3",
			type: "message" as const,
			role: "assistant" as const,
			model: "claude",
			content: [{ type: "tool_use" as const, id: "toolu_1", name: JSON_RESPONSE_TOOL, input: { city: "SF" } }],
			stop_reason: "tool_use",
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 3 },
		};
		const out = anthropicResponseToOpenAIChat(resp, { jsonResponse: true });
		expect(out.choices[0]!.message).toEqual({ role: "assistant", content: '{"city":"SF"}' });
		expect(out.choices[0]!.finish_reason).toBe("stop");

		// Without a JSON response_format it stays an ordinary tool call.
		expect(anthropicResponseToOpenAIChat(resp).choices[0]!.message.tool_calls).toHaveLength(1);
	});
});

/* ================================================================== */
/*  Unit: anthropicSseToOpenaiChatSse                                  */
/* ================================================================== */

describe("anthropicSseToOpenaiChatSse", () => {
	const textEvents = [
		{
			type: "message_start",
			message: {
				id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-bare",
				stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "ping" },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];

	test("converts a text stream into chat-completion chunks", async () => {
		const out = sseData(await runTransform(anthropicStream(textEvents), anthropicSseToOpenaiChatSse("alias/claude")));
		expect(out[out.length - 1]).toBe("[DONE]");

		const chunks = out.slice(0, -1);
		for (const chunk of chunks) {
			expect(chunk.object).toBe("chat.completion.chunk");
			expect(chunk.id).toBe("msg_1");
			expect(chunk.model).toBe("alias/claude");
		}
		expect(chunks.map((c) => c.choices[0].delta)).toEqual([
			{ role: "assistant", content: "" },
			{ content: "Hel" },
			{ content: "lo" },
			{},
		]);
		expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
		// No usage chunk unless it was asked for.
		expect(chunks.some((c) => c.usage)).toBe(false);
	});

	test("emits a usage chunk when includeUsage is set", async () => {
		const out = sseData(await runTransform(
			anthropicStream(textEvents),
			anthropicSseToOpenaiChatSse("m", { includeUsage: true }),
		));
		expect(out[out.length - 1]).toBe("[DONE]");
		const usageChunk = out[out.length - 2];
		expect(usageChunk.choices).toEqual([]);
		expect(usageChunk.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
	});

	test("converts tool_use blocks into tool_calls deltas and thinking into reasoning_content", async () => {
		const events = [
			{ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm." } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city"' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"SF"}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
			{ type: "message_stop" },
		];
		const out = sseData(await runTransform(anthropicStream(events), anthropicSseToOpenaiChatSse("m")));
		expect(out.slice(0, -1).map((c) => c.choices[0].delta)).toEqual([
			{ role: "assistant", content: "" },
			{ reasoning_content: "Hmm." },
			{ tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "get_weather", arguments: "" } }] },
			{ tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] },
			{ tool_calls: [{ index: 0, function: { arguments: ':"SF"}' } }] },
			{},
		]);
		expect(out[out.length - 2].choices[0].finish_reason).toBe("tool_calls");
	});

	test("forwards an error event as an OpenAI error chunk", async () => {
		const events = [
			textEvents[0]!,
			{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
		];
		const out = sseData(await runTransform(anthropicStream(events), anthropicSseToOpenaiChatSse("m")));
		expect(out[out.length - 1]).toEqual({ error: { message: "Overloaded", type: "overloaded_error" } });
		expect(out).not.toContain("[DONE]");
	});

	test("reports a stream cut off before the stop reason as an error", async () => {
		const out = sseData(await runTransform(anthropicStream(textEvents.slice(0, 5)), anthropicSseToOpenaiChatSse("m")));
		expect(out[out.length - 1].error.type).toBe("api_error");
		expect(out).not.toContain("[DONE]");
		expect(out.some((c) => c.choices?.[0]?.finish_reason)).toBe(false);
	});

	test("finishes a stream whose message_stop is missing after the stop reason", async () => {
		const out = sseData(await runTransform(anthropicStream(textEvents.slice(0, 7)), anthropicSseToOpenaiChatSse("m")));
		expect(out[out.length - 2].choices[0].finish_reason).toBe("stop");
		expect(out[out.length - 1]).toBe("[DONE]");
	});

	test("completes the arguments of a tool call without input as {}", async () => {
		const events = [
			{ type: "message_start", message: { id: "msg_4", usage: { input_tokens: 5, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "get_time", input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
			{ type: "message_stop" },
		];
		const out = sseData(await runTransform(anthropicStream(events), anthropicSseToOpenaiChatSse("m")));
		const args = out
			.slice(0, -1)
			.flatMap((c) => c.choices[0].delta.tool_calls ?? [])
			.map((tc: any) => tc.function.arguments ?? "")
			.join("");
		expect(args).toBe("{}");
		expect(out[out.length - 2].choices[0].finish_reason).toBe("tool_calls");
	});

	test("streams the JSON-answer tool call as content", async () => {
		const events = [
			{ type: "message_start", message: { id: "msg_5", usage: { input_tokens: 5, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_3", name: JSON_RESPONSE_TOOL, input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city"' } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"SF"}' } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } },
			{ type: "message_stop" },
		];
		const out = sseData(await runTransform(anthropicStream(events), anthropicSseToOpenaiChatSse("m", { jsonResponse: true })));
		const chunks = out.slice(0, -1);
		expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe('{"city":"SF"}');
		expect(chunks.some((c) => c.choices[0].delta.tool_calls)).toBe(false);
		expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
	});

	test("an upstream error fails a translated Responses stream", async () => {
		const events = [
			textEvents[0]!,
			textEvents[1]!,
			textEvents[3]!,
			{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
		];
		// The /v1/responses chain: Anthropic events -> chat chunks -> Responses events.
		const toChat = anthropicSseToOpenaiChatSse("m", { includeUsage: true });
		const chain = { writable: toChat.writable, readable: toChat.readable.pipeThrough(openaiChatSseToResponsesSse("m")) };
		const out = sseData(await runTransform(anthropicStream(events), chain as TransformStream<Uint8Array, Uint8Array>));
		const types = out.map((e) => e.type);
		expect(types).toContain("response.output_text.delta");
		expect(types.slice(-2)).toEqual(["error", "response.failed"]);
		expect(types).not.toContain("response.completed");
		expect(out[out.length - 1].response.error).toEqual({ code: "overloaded_error", message: "Overloaded" });
	});
});

/* ================================================================== */
/*  Unit: ProviderModelsIndex with an Anthropic /models endpoint      */
/* ================================================================== */

describe("ProviderModelsIndex (Anthropic /models)", () => {
	test("stops paginating when a backend repeats a cursor", async () => {
		let calls = 0;
		// Ignores after_id and keeps alternating between two cursors.
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				calls++;
				return Response.json({
					data: [{ id: "m1", created_at: "2024-01-01T00:00:00Z" }],
					has_more: true,
					last_id: calls % 2 === 1 ? "a" : "b",
				});
			},
		});
		try {
			const index = new ProviderModelsIndex("anthropic");
			await index.refreshModelsList([new BackendAPIClient({ baseUrl: `http://127.0.0.1:${server.port}/v1` })]);
			expect([...index.getModels().keys()]).toEqual(["m1"]);
			expect(calls).toBe(3);
		} finally {
			server.stop();
		}
	});
});

/* ================================================================== */
/*  Integration: OpenAI-style endpoints on an Anthropic-only provider  */
/* ================================================================== */

describe("Anthropic-only provider (supportsOpenAILikeAPI: false)", () => {
	let fakeBackend: FakeAnthropicAPI;
	let app: Hono;
	const clientKey = "sk-anthropic-only";
	const backendKey = "backend-secret";

	const providerConfig = () => ({
		id: "claude",
		name: "Anthropic-only",
		supportsOpenAILikeAPI: false,
		supportsAnthropicLikeAPI: true,
		backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl, apiKey: backendKey }],
	});

	const post = (path: string, body: object) =>
		app.fetch(
			new Request(`http://test.local/v1${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${clientKey}` },
				body: JSON.stringify(body),
			}),
		);

	const lastMessagesRequest = () => fakeBackend.requests.findLast((r) => r.pathname === "/v1/messages");

	beforeAll(async () => {
		resetSingletons();
		fakeBackend = new FakeAnthropicAPI({
			model: "claude-fake",
			apiKey: backendKey,
			models: ["claude-fake", "claude-other", "claude-third"],
			modelsPageSize: 2,
		});
		await fakeBackend.start();

		(ApiKeysConfig as any).config = { [clientKey]: {} };
		(GatewayConfig as any).config = { providers: [providerConfig()] };

		// init() fetches the model list through the Anthropic /models endpoint.
		await ProviderManager.init([providerConfig()], true);

		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
		app.route("/v1", anthropicRouter);
		app.route("/v1", responsesRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		resetSingletons();
	});

	test("lists the backend's models via the paginated Anthropic /models endpoint", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", { headers: { Authorization: `Bearer ${clientKey}` } }),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.data.map((m: any) => m.id)).toEqual(["claude/claude-fake", "claude/claude-other", "claude/claude-third"]);
		// created_at (2024-01-01T00:00:00Z) as unix seconds.
		expect(json.data[0].created).toBe(1704067200);

		const modelRequests = fakeBackend.requests.filter((r) => r.pathname === "/v1/models");
		expect(modelRequests.map((r) => r.search)).toEqual(["", "?after_id=claude-other"]);
		for (const r of modelRequests) {
			expect(r.headers["anthropic-version"]).toBe("2023-06-01");
		}
	});

	test("chat completions are translated to /v1/messages and back", async () => {
		const res = await post("/chat/completions", {
			model: "claude/claude-fake",
			messages: [
				{ role: "system", content: "Be nice." },
				{ role: "user", content: "Hi" },
			],
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("chat.completion");
		expect(json.model).toBe("claude/claude-fake");
		expect(json.choices[0].message).toEqual({ role: "assistant", content: "Hello!" });
		expect(json.choices[0].finish_reason).toBe("stop");
		expect(json.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

		// The backend got a native Anthropic request: bare model, hoisted
		// system prompt, default max_tokens, version header and its own key.
		const fwd = lastMessagesRequest();
		expect(fwd).toBeDefined();
		expect(fwd!.headers["anthropic-version"]).toBe("2023-06-01");
		expect(fwd!.headers["x-api-key"]).toBe(backendKey);
		expect(JSON.parse(fwd!.body!)).toEqual({
			model: "claude-fake",
			system: "Be nice.",
			messages: [{ role: "user", content: "Hi" }],
			max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
			stream: false,
		});
	});

	test("streaming chat completions are translated from the Anthropic event stream", async () => {
		const res = await post("/chat/completions", {
			model: "claude/claude-fake",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);

		const out = sseData(await readStream(res));
		expect(out[out.length - 1]).toBe("[DONE]");
		const chunks = out.slice(0, -1);
		expect(chunks.every((c) => c.model === "claude/claude-fake")).toBe(true);
		expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("Hello");
		expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("stop");
		expect(chunks[chunks.length - 1].usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
	});

	test("responses are translated (via chat) to /v1/messages and back", async () => {
		const res = await post("/responses", {
			model: "claude/claude-fake",
			instructions: "Be nice.",
			input: "Hi",
			max_output_tokens: 100,
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("response");
		expect(json.status).toBe("completed");
		expect(json.model).toBe("claude/claude-fake");
		expect(json.output_text).toBe("Hello!");
		expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });

		const sent = JSON.parse(lastMessagesRequest()!.body!);
		expect(sent.system).toBe("Be nice.");
		expect(sent.messages).toEqual([{ role: "user", content: "Hi" }]);
		expect(sent.max_tokens).toBe(100);
	});

	test("streaming responses are translated from the Anthropic event stream", async () => {
		const res = await post("/responses", { model: "claude/claude-fake", input: "Hi", stream: true });
		expect(res.status).toBe(200);

		const text = await readStream(res);
		expect(text).toContain("event: response.created");
		expect(text).toContain('"delta":"Hello"');
		const completed = sseData(text).find((e) => e.type === "response.completed");
		expect(completed.response.model).toBe("claude/claude-fake");
		expect(completed.response.output_text).toBe("Hello");
		expect(completed.response.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
	});

	test("/v1/messages is passed through, defaulting anthropic-version", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": clientKey },
				body: JSON.stringify({ model: "claude/claude-fake", max_tokens: 50, messages: [{ role: "user", content: "Hi" }] }),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.type).toBe("message");
		expect(json.model).toBe("claude/claude-fake");

		const fwd = lastMessagesRequest();
		expect(fwd!.headers["anthropic-version"]).toBe("2023-06-01");
		expect(JSON.parse(fwd!.body!)).toEqual({
			model: "claude-fake",
			max_tokens: 50,
			messages: [{ role: "user", content: "Hi" }],
		});
	});

	test("/v1/messages treats an empty anthropic-version like a missing one", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": clientKey, "anthropic-version": "" },
				body: JSON.stringify({ model: "claude/claude-fake", max_tokens: 50, messages: [{ role: "user", content: "Hi" }] }),
			}),
		);
		expect(res.status).toBe(200);
		expect(lastMessagesRequest()!.headers["anthropic-version"]).toBe("2023-06-01");
	});

	test("completions and embeddings are rejected without reaching the backend", async () => {
		const before = fakeBackend.requests.length;
		for (const path of ["/completions", "/embeddings"]) {
			const res = await post(path, { model: "claude/claude-fake", prompt: "Hi", input: "Hi" });
			expect(res.status).toBe(400);
			const json = (await res.json()) as any;
			expect(json.error.type).toBe("invalid_request_error");
			expect(json.error.message).toContain(`/v1${path}`);
		}
		expect(fakeBackend.requests.length).toBe(before);
	});

	test("untranslatable requests get a 400 without reaching the backend", async () => {
		const before = fakeBackend.requests.length;

		const chat = await post("/chat/completions", {
			model: "claude/claude-fake",
			messages: [{ role: "user", content: "Hi" }],
			n: 2,
		});
		expect(chat.status).toBe(400);
		expect(((await chat.json()) as any).error.type).toBe("invalid_request_error");

		const responses = await post("/responses", {
			model: "claude/claude-fake",
			input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/svg+xml,%3Csvg%3E" }] }],
		});
		expect(responses.status).toBe(400);
		expect(((await responses.json()) as any).error.type).toBe("invalid_request_error");

		expect(fakeBackend.requests.length).toBe(before);
	});

	test("backend errors keep Anthropic's status and message, and a 400 leaves the backend healthy", async () => {
		fakeBackend.setNextError(400, JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "max_tokens: 999999 > 64000" },
		}));
		try {
			const requests: Array<[string, object]> = [
				["/chat/completions", { model: "claude/claude-fake", messages: [{ role: "user", content: "Hi" }] }],
				["/responses", { model: "claude/claude-fake", input: "Hi" }],
			];
			for (const [path, body] of requests) {
				const res = await post(path, body);
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error: { message: "max_tokens: 999999 > 64000", type: "invalid_request_error" },
				});
			}
			expect(ProviderManager.getProvider("claude")!.healthMonitor.isHealthy(0)).toBe(true);
		} finally {
			fakeBackend.clearNextError();
		}
	});

	test("a 2xx body that is not a message is passed through unchanged", async () => {
		const errorBody = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
		fakeBackend.setNextError(200, errorBody);
		try {
			const res = await post("/chat/completions", { model: "claude/claude-fake", messages: [{ role: "user", content: "Hi" }] });
			expect(await res.text()).toBe(errorBody);
		} finally {
			fakeBackend.clearNextError();
		}
	});
});
