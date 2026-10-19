/**
 * End-to-end tests that drive the gateway with REAL @ai-sdk clients
 * (`@ai-sdk/anthropic`, `@ai-sdk/openai` Responses, and
 * `@ai-sdk/openai-compatible` chat) against a realistic mock backend
 * (`@copilotkit/aimock`'s `LLMock`) that emits multi-chunk SSE streams and
 * tool calls.
 *
 * What this proves, end-to-end:
 *  - The Anthropic SDK (x-api-key + /v1/messages) successfully consumes the
 *    gateway, which translates to a chat-completions backend and back — for
 *    both plain text and tool calls, streaming and non-streaming.
 *  - The OpenAI Responses SDK (Authorization + /v1/responses) successfully
 *    consumes the gateway, which translates to chat-completions and back —
 *    text + tool calls, streaming and non-streaming.
 *  - The OpenAI-compatible chat SDK hits /v1/chat/completions directly
 *    (passthrough) as a baseline.
 *  - For a provider whose backends only speak the Anthropic Messages API
 *    (`supportsOpenAILikeAPI: false`), the OpenAI-compatible chat SDK and the
 *    OpenAI Responses SDK are translated onto the backend's native
 *    /v1/messages endpoint and back, and the Anthropic SDK passes through.
 *
 * The mock backend is a real HTTP server (LLMock) so the gateway exercises
 * real fetch + real SSE parsing/translation.  The client→gateway leg is
 * routed through a custom fetch into the in-memory Hono app (same pattern as
 * the existing openai-integration AI SDK test).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LLMock } from "@copilotkit/aimock";
import type { BodyInit, HeadersInit } from "bun";
import { authMiddlewareV1 } from "../src/api/versions/v1/auth";
import { router as openaiRouter } from "../src/api/versions/v1/routes/openai";
import { router as anthropicRouter } from "../src/api/versions/v1/routes/anthropic";
import { router as responsesRouter } from "../src/api/versions/v1/routes/responses";
import { ProviderManager } from "../src/loadBalancing/providerManager";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { ApiKeysConfig } from "../src/utils/config/apiKeysConfig";
import { JSON_RESPONSE_TOOL } from "../src/translation";

/* ------------------------------------------------------------------ */
/*  Shared setup                                                       */
/* ------------------------------------------------------------------ */

const CLIENT_KEY = "sk-ai-sdk-e2e";
const PROVIDER_ID = "fake";
/** Provider whose backend is only addressed through its Anthropic API. */
const ANTHROPIC_ONLY_PROVIDER_ID = "fake-anthropic-only";
/** Gateway-facing model id: provider-prefixed, resolved to the bare model. */
const MODEL_ANTHROPIC = `${PROVIDER_ID}/claude-sonnet-4-5`;
const MODEL_OPENAI = `${PROVIDER_ID}/gpt-4o`;
const MODEL_ANTHROPIC_ONLY = `${ANTHROPIC_ONLY_PROVIDER_ID}/claude-sonnet-4-5`;

let mock: LLMock;
let app: Hono;
// Real AI SDK clients, built in beforeAll once `app` exists.
let anthropic: ReturnType<typeof createAnthropic>;
let openai: ReturnType<typeof createOpenAI>;
let compat: ReturnType<typeof createOpenAICompatible>;
/** Sends JSON schemas as `response_format: json_schema` (default: `json_object`). */
let compatStructured: ReturnType<typeof createOpenAICompatible>;

/** Custom fetch routing AI SDK requests into the in-memory Hono app. */
function gatewayFetch(app: Hono): typeof fetch {
	return (async (url, init) => {
		const reqUrl = new URL(typeof url === "string" ? url : (url as Request).url);
		return app.fetch(
			new Request("http://gateway.local" + reqUrl.pathname + reqUrl.search, {
				method: init?.method ?? "POST",
				headers: init?.headers as HeadersInit,
				body: init?.body as BodyInit | undefined,
			}),
		);
	}) as typeof fetch;
}

function resetSingletons() {
	(ProviderManager as any)._initialized = false;
	(ProviderManager as any).providers = new Map();
	(GatewayConfig as any).config = null;
	(ApiKeysConfig as any).config = null;
}

beforeAll(async () => {
	// 1. Realistic mock backend (real HTTP server).  Small chunkSize so
	//    streaming responses arrive as multiple SSE chunks.
	mock = await LLMock.create({ logLevel: "silent", chunkSize: 8, latency: 0 });

	mock.onMessage("Hello", {
		content: "Hi there! I can help with that.",
		usage: { prompt_tokens: 6, completion_tokens: 7 },
	});
	mock.onMessage("weather", {
		content: "Let me check the weather for you.",
		toolCalls: [{ name: "get_weather", arguments: '{"location":"San Francisco"}', id: "call_weather_1" }],
		usage: { prompt_tokens: 9, completion_tokens: 12 },
	});
	// How Claude answers a JSON response_format: by calling the gateway's
	// forced JSON tool.
	mock.onMessage("forecast", {
		toolCalls: [{ name: JSON_RESPONSE_TOOL, arguments: '{"location":"San Francisco","forecast":"sunny"}', id: "call_json_1" }],
		usage: { prompt_tokens: 8, completion_tokens: 10 },
	});

	// 2. Gateway configuration: two providers whose backend is the LLMock
	//    server.  LLMock serves /v1/chat/completions and /v1/messages, so the
	//    gateway base URL includes the /v1 prefix.  The second provider is
	//    declared Anthropic-only, so it is only ever sent /messages requests.
	const backendBaseUrl = `${mock.url}/v1`;
	const providers = [
		{ id: PROVIDER_ID, name: "Fake LLM", backends: [{ name: "aimock", baseUrl: backendBaseUrl }] },
		{
			id: ANTHROPIC_ONLY_PROVIDER_ID,
			name: "Fake Anthropic-only LLM",
			supportsOpenAILikeAPI: false,
			supportsAnthropicLikeAPI: true,
			backends: [{ name: "aimock", baseUrl: backendBaseUrl }],
		},
	];
	resetSingletons();
	(ApiKeysConfig as any).config = { [CLIENT_KEY]: {} };
	(GatewayConfig as any).config = { providers };

	await ProviderManager.init(providers, false);

	// 3. Hono app: auth + all three route groups, mounted under /v1.
	app = new Hono();
	app.use("*", authMiddlewareV1);
	app.route("/v1", openaiRouter);
	app.route("/v1", anthropicRouter);
	app.route("/v1", responsesRouter);

	// 4. Build the real AI SDK clients now that `app` exists.  `baseURL`
	//    includes /v1 so the SDKs hit /v1/messages, /v1/responses,
	//    /v1/chat/completions respectively.
	const fetch = gatewayFetch(app);
	anthropic = createAnthropic({ baseURL: "http://gateway.local/v1", apiKey: CLIENT_KEY, fetch });
	openai = createOpenAI({ baseURL: "http://gateway.local/v1", apiKey: CLIENT_KEY, fetch });
	compat = createOpenAICompatible({ name: "leiai", baseURL: "http://gateway.local/v1", apiKey: CLIENT_KEY, fetch });
	compatStructured = createOpenAICompatible({
		name: "leiai-structured",
		baseURL: "http://gateway.local/v1",
		apiKey: CLIENT_KEY,
		fetch,
		supportsStructuredOutputs: true,
	});
});

afterAll(async () => {
	await mock.stop();
	resetSingletons();
});

/* ------------------------------------------------------------------ */
/*  Helpers to read doGenerate / doStream results                      */
/* ------------------------------------------------------------------ */

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}

async function readStreamParts(stream: ReadableStream<unknown>): Promise<any[]> {
	const reader = stream.getReader();
	const parts: any[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return parts;
}

/* ================================================================== */
/*  @ai-sdk/anthropic  ->  /v1/messages  (translated to chat)          */
/* ================================================================== */

describe("@ai-sdk/anthropic through /v1/messages", () => {
	test("doGenerate: plain text round-trips", async () => {
		const model = anthropic.messages(MODEL_ANTHROPIC);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		expect(extractText(result.content as any)).toContain("Hi there");
		expect(result.finishReason.unified).toBe("stop");
	});

	test("doStream: text deltas arrive then a finish part", async () => {
		const model = anthropic.messages(MODEL_ANTHROPIC);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p: any) => p.delta)
			.join("");
		expect(text).toContain("Hi there");

		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toBeDefined();
		expect(finish.finishReason.unified).toBe("stop");
	});

	test("doGenerate: tool call round-trips", async () => {
		const model = anthropic.messages(MODEL_ANTHROPIC);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] }],
			maxOutputTokens: 200,
			tools: [{
				type: "function",
				name: "get_weather",
				description: "Get the weather for a location",
				inputSchema: {
					type: "object",
					properties: { location: { type: "string" } },
					required: ["location"],
				},
			}],
		});

		const toolCall = (result.content as any[]).find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		expect(toolCall.toolName).toBe("get_weather");
		// The raw provider-level doGenerate returns tool args as a JSON string
		// (the high-level `generateText` would parse them via the tool's
		// inputSchema); accept either the string or the parsed object.
		expect(
			typeof toolCall.input === "string" ? JSON.parse(toolCall.input) : toolCall.input,
		).toEqual({ location: "San Francisco" });
		expect(result.finishReason.unified).toBe("tool-calls");
	});
});

/* ================================================================== */
/*  @ai-sdk/openai Responses  ->  /v1/responses  (translated to chat)  */
/* ================================================================== */

describe("@ai-sdk/openai Responses through /v1/responses", () => {
	test("doGenerate: plain text round-trips", async () => {
		const model = openai.responses(MODEL_OPENAI);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		expect(extractText(result.content as any)).toContain("Hi there");
		expect(result.finishReason.unified).toBe("stop");
	});

	test("doStream: text deltas arrive then a finish part", async () => {
		const model = openai.responses(MODEL_OPENAI);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p: any) => p.delta)
			.join("");
		expect(text).toContain("Hi there");

		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toBeDefined();
		expect(finish.finishReason.unified).toBe("stop");
	});

	test("doGenerate: tool call round-trips", async () => {
		const model = openai.responses(MODEL_OPENAI);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] }],
			maxOutputTokens: 200,
			tools: [{
				type: "function",
				name: "get_weather",
				description: "Get the weather for a location",
				inputSchema: {
					type: "object",
					properties: { location: { type: "string" } },
					required: ["location"],
				},
			}],
		});

		const toolCall = (result.content as any[]).find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		expect(toolCall.toolName).toBe("get_weather");
		// The raw provider-level doGenerate returns tool args as a JSON string
		// (the high-level `generateText` would parse them via the tool's
		// inputSchema); accept either the string or the parsed object.
		expect(
			typeof toolCall.input === "string" ? JSON.parse(toolCall.input) : toolCall.input,
		).toEqual({ location: "San Francisco" });
		expect(result.finishReason.unified).toBe("tool-calls");
	});
});

/* ================================================================== */
/*  @ai-sdk/openai-compatible chat  ->  /v1/chat/completions (passthru) */
/* ================================================================== */

describe("@ai-sdk/openai-compatible chat (passthrough baseline)", () => {
	test("doGenerate: plain text round-trips directly to chat completions", async () => {
		const model = compat.chatModel(MODEL_OPENAI);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		expect(extractText(result.content as any)).toContain("Hi there");
		expect(result.finishReason.unified).toBe("stop");
	});
});

/* ================================================================== */
/*  Anthropic-only provider  (supportsOpenAILikeAPI: false)            */
/* ================================================================== */

const WEATHER_TOOL = {
	type: "function" as const,
	name: "get_weather",
	description: "Get the weather for a location",
	inputSchema: {
		type: "object" as const,
		properties: { location: { type: "string" as const } },
		required: ["location"],
	},
};

/** Tool args come back as a JSON string from the raw provider-level API. */
function toolInput(toolCall: { input: unknown }): unknown {
	return typeof toolCall.input === "string" ? JSON.parse(toolCall.input) : toolCall.input;
}

const FORECAST_SCHEMA = {
	type: "object" as const,
	properties: { location: { type: "string" as const }, forecast: { type: "string" as const } },
	required: ["location", "forecast"],
};

/** LLMock also serves chat-completions, so check which endpoint was used. */
function expectAnthropicBackendCall() {
	const last = mock.getLastRequest();
	expect(last?.path).toBe("/v1/messages");
	expect(last?.headers["anthropic-version"]).toBe("2023-06-01");
}

describe("Anthropic-only backend: @ai-sdk/openai-compatible chat -> /v1/messages", () => {
	test("doGenerate: plain text round-trips", async () => {
		const model = compat.chatModel(MODEL_ANTHROPIC_ONLY);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		expectAnthropicBackendCall();
		expect(extractText(result.content as any)).toContain("Hi there");
		expect(result.finishReason.unified).toBe("stop");
	});

	test("doStream: text deltas arrive then a finish part", async () => {
		const model = compat.chatModel(MODEL_ANTHROPIC_ONLY);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		expectAnthropicBackendCall();
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p: any) => p.delta)
			.join("");
		expect(text).toBe("Hi there! I can help with that.");

		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toBeDefined();
		expect(finish.finishReason.unified).toBe("stop");
	});

	test("doGenerate: tool call round-trips", async () => {
		const model = compat.chatModel(MODEL_ANTHROPIC_ONLY);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] }],
			maxOutputTokens: 200,
			tools: [WEATHER_TOOL],
		});

		expectAnthropicBackendCall();
		const toolCall = (result.content as any[]).find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		expect(toolCall.toolName).toBe("get_weather");
		expect(toolInput(toolCall)).toEqual({ location: "San Francisco" });
		expect(result.finishReason.unified).toBe("tool-calls");
	});

	test("doStream: streamed tool call is reassembled", async () => {
		const model = compat.chatModel(MODEL_ANTHROPIC_ONLY);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] }],
			maxOutputTokens: 200,
			tools: [WEATHER_TOOL],
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		expectAnthropicBackendCall();
		const toolCall = parts.find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		expect(toolCall.toolName).toBe("get_weather");
		expect(toolInput(toolCall)).toEqual({ location: "San Francisco" });

		const finish = parts.find((p) => p.type === "finish");
		expect(finish.finishReason.unified).toBe("tool-calls");
	});

	test("doGenerate: a JSON response_format is answered as JSON text", async () => {
		const model = compat.chatModel(MODEL_ANTHROPIC_ONLY);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Give me the forecast as JSON." }] }],
			maxOutputTokens: 100,
			responseFormat: { type: "json" },
		});

		expectAnthropicBackendCall();
		// The answer was requested through the forced JSON tool.
		const backendTools = (mock.getLastRequest()?.body as any)?.tools ?? [];
		expect(backendTools.map((t: any) => t.function.name)).toContain(JSON_RESPONSE_TOOL);
		expect(JSON.parse(extractText(result.content as any))).toEqual({ location: "San Francisco", forecast: "sunny" });
		expect((result.content as any[]).some((p) => p.type === "tool-call")).toBe(false);
		expect(result.finishReason.unified).toBe("stop");
	});

	test("doStream: a JSON schema response_format streams the JSON as text", async () => {
		const model = compatStructured.chatModel(MODEL_ANTHROPIC_ONLY);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "Give me the forecast as JSON." }] }],
			maxOutputTokens: 100,
			responseFormat: { type: "json", schema: FORECAST_SCHEMA },
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		expectAnthropicBackendCall();
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p: any) => p.delta)
			.join("");
		expect(JSON.parse(text)).toEqual({ location: "San Francisco", forecast: "sunny" });
		expect(parts.some((p) => p.type === "tool-call")).toBe(false);

		const finish = parts.find((p) => p.type === "finish");
		expect(finish.finishReason.unified).toBe("stop");
	});
});

describe("Anthropic-only backend: @ai-sdk/openai Responses -> /v1/messages", () => {
	test("doGenerate: plain text round-trips", async () => {
		const model = openai.responses(MODEL_ANTHROPIC_ONLY);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		expectAnthropicBackendCall();
		expect(extractText(result.content as any)).toContain("Hi there");
		expect(result.finishReason.unified).toBe("stop");
	});

	test("doStream: text deltas arrive then a finish part", async () => {
		const model = openai.responses(MODEL_ANTHROPIC_ONLY);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		expectAnthropicBackendCall();
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p: any) => p.delta)
			.join("");
		expect(text).toBe("Hi there! I can help with that.");

		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toBeDefined();
		expect(finish.finishReason.unified).toBe("stop");
	});

	test("doGenerate: tool call round-trips", async () => {
		const model = openai.responses(MODEL_ANTHROPIC_ONLY);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] }],
			maxOutputTokens: 200,
			tools: [WEATHER_TOOL],
		});

		expectAnthropicBackendCall();
		const toolCall = (result.content as any[]).find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		expect(toolCall.toolName).toBe("get_weather");
		expect(toolInput(toolCall)).toEqual({ location: "San Francisco" });
		expect(result.finishReason.unified).toBe("tool-calls");
	});

	test("doStream: streamed tool call is reassembled", async () => {
		const model = openai.responses(MODEL_ANTHROPIC_ONLY);
		const result = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] }],
			maxOutputTokens: 200,
			tools: [WEATHER_TOOL],
		});

		const parts = await readStreamParts(result.stream as ReadableStream<unknown>);
		expectAnthropicBackendCall();
		const toolCall = parts.find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		expect(toolCall.toolName).toBe("get_weather");
		expect(toolInput(toolCall)).toEqual({ location: "San Francisco" });

		const finish = parts.find((p) => p.type === "finish");
		expect(finish.finishReason.unified).toBe("tool-calls");
	});
});

describe("Anthropic-only backend: @ai-sdk/anthropic -> /v1/messages (passthrough)", () => {
	test("doGenerate: plain text round-trips", async () => {
		const model = anthropic.messages(MODEL_ANTHROPIC_ONLY);
		const result = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello there!" }] }],
			maxOutputTokens: 100,
		});

		expectAnthropicBackendCall();
		expect(extractText(result.content as any)).toContain("Hi there");
		expect(result.finishReason.unified).toBe("stop");
	});
});