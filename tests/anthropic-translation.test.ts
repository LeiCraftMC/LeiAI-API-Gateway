import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import {
	anthropicRequestToOpenAIChat,
	openAIChatResponseToAnthropic,
	openaiChatSseToAnthropicSse,
	anthropicSseModelRewrite,
} from "../src/translation";
import { authMiddlewareV1 } from "../src/api/versions/v1/auth";
import { router as openaiRouter } from "../src/api/versions/v1/routes/openai";
import { router as anthropicRouter } from "../src/api/versions/v1/routes/anthropic";
import { ProviderManager } from "../src/loadBalancing/providerManager";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { ApiKeysConfig } from "../src/utils/config/apiKeysConfig";
import { FakeOpenAICompatibleAPI } from "./helpers/fakeOpenAICompatibleAPI";
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

	// Write + close WITHOUT awaiting: awaiting close before draining the
	// readable deadlocks a TransformStream (close waits for the readable to
	// drain, which only happens once we start reading below).
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

function resetSingletons() {
	(ProviderManager as any)._initialized = false;
	(ProviderManager as any).providers = new Map();
	(GatewayConfig as any).config = null;
	(ApiKeysConfig as any).config = null;
}

/* ================================================================== */
/*  Unit: anthropicRequestToOpenAIChat                                 */
/* ================================================================== */

describe("anthropicRequestToOpenAIChat", () => {
	test("converts system + messages", () => {
		const req = {
			model: "claude",
			max_tokens: 100,
			system: "Be helpful.",
			messages: [
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: "Hello!" },
				{ role: "user", content: "Bye" },
			],
		};
		const out = anthropicRequestToOpenAIChat(req as any);
		expect(out.model).toBe("claude");
		expect(out.max_tokens).toBe(100);
		expect(out.messages[0]).toEqual({ role: "system", content: "Be helpful." });
		expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
		expect(out.messages[2]).toEqual({ role: "assistant", content: "Hello!" });
		expect(out.messages[3]).toEqual({ role: "user", content: "Bye" });
	});

	test("converts tool_use + tool_result into tool_calls + tool messages", () => {
		const req = {
			model: "claude",
			max_tokens: 100,
			messages: [
				{ role: "user", content: "Weather?" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check." },
						{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Sunny" }],
				},
			],
		};
		const out = anthropicRequestToOpenAIChat(req as any);
		// assistant message with text + tool_calls
		const assistant = out.messages.find((m) => m.role === "assistant")!;
		expect(assistant.content).toBe("Let me check.");
		expect(assistant.tool_calls).toEqual([
			{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) } },
		]);
		// tool_result -> tool role message
		const tool = out.messages.find((m) => m.role === "tool")!;
		expect(tool.tool_call_id).toBe("toolu_1");
		expect(tool.content).toBe("Sunny");
	});

	test("converts tools + tool_choice", () => {
		const req = {
			model: "claude",
			max_tokens: 100,
			messages: [{ role: "user", content: "Hi" }],
			tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
			tool_choice: { type: "tool", name: "get_weather" },
			stop_sequences: ["STOP"],
		};
		const out = anthropicRequestToOpenAIChat(req as any);
		expect(out.tools).toEqual([
			{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
		]);
		expect(out.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
		expect(out.stop).toEqual(["STOP"]);
	});

	test("tool_choice any -> required, auto -> auto", () => {
		const base = { model: "c", max_tokens: 1, messages: [{ role: "user", content: "x" }] };
		expect(anthropicRequestToOpenAIChat({ ...base, tool_choice: { type: "any" } } as any).tool_choice).toBe("required");
		expect(anthropicRequestToOpenAIChat({ ...base, tool_choice: { type: "auto" } } as any).tool_choice).toBe("auto");
	});

	test("system as text-block array", () => {
		const req = {
			model: "claude",
			max_tokens: 100,
			system: [{ type: "text", text: "Part A" }, { type: "text", text: "Part B" }],
			messages: [{ role: "user", content: "Hi" }],
		};
		const out = anthropicRequestToOpenAIChat(req as any);
		expect(out.messages[0]).toEqual({ role: "system", content: "Part A\n\nPart B" });
	});
});

/* ================================================================== */
/*  Unit: openAIChatResponseToAnthropic                                */
/* ================================================================== */

describe("openAIChatResponseToAnthropic", () => {
	test("converts a plain text response", () => {
		const chat = {
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 1700000000,
			model: "gpt-4",
			choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		};
		const out = openAIChatResponseToAnthropic(chat as any);
		expect(out.id).toBe("chatcmpl-1");
		expect(out.type).toBe("message");
		expect(out.content).toEqual([{ type: "text", text: "Hello!" }]);
		expect(out.stop_reason).toBe("end_turn");
		expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
	});

	test("converts tool_calls and maps finish_reason", () => {
		const chat = {
			id: "chatcmpl-2",
			object: "chat.completion",
			created: 1700000000,
			model: "gpt-4",
			choices: [{
				index: 0,
				message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
				finish_reason: "tool_calls",
			}],
			usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
		};
		const out = openAIChatResponseToAnthropic(chat as any);
		expect(out.stop_reason).toBe("tool_use");
		expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }]);
	});

	test("maps length finish_reason", () => {
		const chat = {
			id: "x", object: "chat.completion", created: 1, model: "m",
			choices: [{ index: 0, message: { role: "assistant", content: "..." }, finish_reason: "length" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
		expect(openAIChatResponseToAnthropic(chat as any).stop_reason).toBe("max_tokens");
	});
});

/* ================================================================== */
/*  Unit: openaiChatSseToAnthropicSse                                  */
/* ================================================================== */

describe("openaiChatSseToAnthropicSse", () => {
	test("converts a text stream into Anthropic events", async () => {
		const input = [
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
			"data: [DONE]",
		].join("\n\n") + "\n\n";

		const out = await runTransform(input, openaiChatSseToAnthropicSse("user/model"));

		expect(out).toContain("event: message_start");
		expect(out).toContain('"model":"user/model"');
		expect(out).toContain('"type":"text_delta","text":"Hello"');
		expect(out).toContain('"type":"text_delta","text":"!"');
		expect(out).toContain("event: content_block_stop");
		expect(out).toContain('"stop_reason":"end_turn"');
		expect(out).toContain("event: message_stop");
		expect(out).not.toContain("[DONE]");
	});

	test("converts tool-call deltas into tool_use blocks", async () => {
		const input = [
			'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"SF\\"}"}}]},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
			"data: [DONE]",
		].join("\n\n") + "\n\n";

		const out = await runTransform(input, openaiChatSseToAnthropicSse("user/model"));

		expect(out).toContain('"type":"tool_use"');
		expect(out).toContain('"name":"get_weather"');
		expect(out).toContain('"type":"input_json_delta"');
		expect(out).toContain('"partial_json":"{\\"city\\""');
		expect(out).toContain('"stop_reason":"tool_use"');
		expect(out).toContain("event: message_stop");
	});
});

/* ================================================================== */
/*  Unit: anthropicSseModelRewrite                                     */
/* ================================================================== */

describe("anthropicSseModelRewrite", () => {
	test("rewrites model in message_start and preserves other events", async () => {
		const input = [
			`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-bare", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}`,
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
		].join("\n\n") + "\n\n";

		const out = await runTransform(input, anthropicSseModelRewrite("alias/claude"));
		expect(out).toContain('"model":"alias/claude"');
		expect(out).not.toContain('"model":"claude-bare"');
		expect(out).toContain("event: content_block_delta");
		expect(out).toContain('"text":"Hi"');
		expect(out).toContain("event: message_stop");
	});
});

/* ================================================================== */
/*  Integration: /v1/messages — translation path                       */
/*  (provider does NOT support anthropic -> translated to chat)        */
/* ================================================================== */

describe("/v1/messages — translation to chat completions", () => {
	let fakeBackend: FakeOpenAICompatibleAPI;
	let app: Hono;
	const testApiKey = "sk-anthropic-translate";

	beforeAll(async () => {
		resetSingletons();
		fakeBackend = new FakeOpenAICompatibleAPI({ model: "gpt-4-fake" });
		await fakeBackend.start();

		(ApiKeysConfig as any).config = { [testApiKey]: {} };
		(GatewayConfig as any).config = {
			providers: [
				{ id: "openai-fake", name: "Fake OpenAI", backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }] },
			],
		};

		await ProviderManager.init(
			[{ id: "openai-fake", name: "Fake OpenAI", backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }] }],
			false,
		);
		const provider = ProviderManager.getProvider("openai-fake")!;
		await provider.models.refreshModelsList(provider.backends.map((b) => b.apiClient));

		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
		app.route("/v1", anthropicRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		resetSingletons();
	});

	test("non-streaming: returns an Anthropic message response with rewritten model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": testApiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "openai-fake/gpt-4-fake",
					max_tokens: 100,
					system: "Be nice.",
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.type).toBe("message");
		expect(json.role).toBe("assistant");
		expect(json.model).toBe("openai-fake/gpt-4-fake");
		expect(json.content).toEqual([{ type: "text", text: "Hello!" }]);
		expect(json.stop_reason).toBe("end_turn");
		expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 5 });

		// The backend must have received a chat-completions request with the
		// bare model and a system message.
		const chatReq = fakeBackend.requests.find((r) => r.pathname === "/v1/chat/completions");
		expect(chatReq).toBeDefined();
		const sentBody = JSON.parse(chatReq!.body!);
		expect(sentBody.model).toBe("gpt-4-fake");
		expect(sentBody.messages[0]).toEqual({ role: "system", content: "Be nice." });
		expect(sentBody.messages[1]).toEqual({ role: "user", content: "Hi" });
		expect(sentBody.max_tokens).toBe(100);
	});

	test("streaming: returns an Anthropic event stream with rewritten model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": testApiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "openai-fake/gpt-4-fake",
					max_tokens: 100,
					messages: [{ role: "user", content: "Hi" }],
					stream: true,
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);

		const text = await readStream(res);
		expect(text).toContain("event: message_start");
		expect(text).toContain('"model":"openai-fake/gpt-4-fake"');
		expect(text).toContain('"type":"text_delta","text":"Hello"');
		expect(text).toContain("event: message_stop");
		expect(text).not.toContain("[DONE]");
	});

	test("returns 400 when model is missing", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": testApiKey },
				body: JSON.stringify({ max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
			}),
		);
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.type).toBe("error");
	});

	test("returns 404 for an unknown model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": testApiKey },
				body: JSON.stringify({ model: "nope/missing", max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
			}),
		);
		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "openai-fake/gpt-4-fake", max_tokens: 1, messages: [] }),
			}),
		);
		expect(res.status).toBe(401);
	});
});

/* ================================================================== */
/*  Integration: /v1/messages — passthrough path                       */
/*  (provider supportsAnthropicLikeAPI -> forwarded natively)          */
/* ================================================================== */

describe("/v1/messages — native passthrough", () => {
	let fakeBackend: FakeAnthropicAPI;
	let app: Hono;
	const clientKey = "sk-anthropic-passthrough";
	const backendKey = "backend-secret";

	beforeAll(async () => {
		resetSingletons();
		fakeBackend = new FakeAnthropicAPI({ model: "claude-fake", apiKey: backendKey });
		await fakeBackend.start();

		(ApiKeysConfig as any).config = { [clientKey]: {} };
		(GatewayConfig as any).config = {
			providers: [
				{
					id: "anthropic-native",
					name: "Native Anthropic",
					supportsAnthropicLikeAPI: true,
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl, apiKey: backendKey }],
				},
			],
		};

		await ProviderManager.init(
			[{
				id: "anthropic-native",
				name: "Native Anthropic",
				supportsAnthropicLikeAPI: true,
				backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl, apiKey: backendKey }],
			}],
			false,
		);
		const provider = ProviderManager.getProvider("anthropic-native")!;
		await provider.models.refreshModelsList(provider.backends.map((b) => b.apiClient));

		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
		app.route("/v1", anthropicRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		resetSingletons();
	});

	test("non-streaming: forwards to /v1/messages with x-api-key and rewrites model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": clientKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "anthropic-native/claude-fake",
					max_tokens: 100,
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.type).toBe("message");
		// User-facing model name restored.
		expect(json.model).toBe("anthropic-native/claude-fake");
		expect(json.content).toEqual([{ type: "text", text: "Hello!" }]);

		// Backend received the native Anthropic request with the bare model,
		// the backend's key (not the client's), and the version header.
		const fwd = fakeBackend.requests.find((r) => r.pathname === "/v1/messages");
		expect(fwd).toBeDefined();
		expect(fwd!.headers["x-api-key"]).toBe(backendKey);
		expect(fwd!.headers["authorization"]).toBe("Bearer " + backendKey);
		expect(fwd!.headers["anthropic-version"]).toBe("2023-06-01");
		const sentBody = JSON.parse(fwd!.body!);
		expect(sentBody.model).toBe("claude-fake");
	});

	test("streaming: pipes the native Anthropic event stream with rewritten model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": clientKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "anthropic-native/claude-fake",
					max_tokens: 100,
					messages: [{ role: "user", content: "Hi" }],
					stream: true,
				}),
			}),
		);
		expect(res.status).toBe(200);
		const text = await readStream(res);
		expect(text).toContain("event: message_start");
		expect(text).toContain('"model":"anthropic-native/claude-fake"');
		expect(text).toContain('"type":"text_delta","text":"Hello"');
		expect(text).toContain("event: message_stop");
	});
});

/* ================================================================== */
/*  Integration: auth + /v1/models Anthropic envelope                  */
/* ================================================================== */

describe("auth + /v1/models Anthropic envelope", () => {
	let fakeBackend: FakeOpenAICompatibleAPI;
	let app: Hono;
	const testApiKey = "sk-models-test";

	beforeAll(async () => {
		resetSingletons();
		fakeBackend = new FakeOpenAICompatibleAPI({ model: "gpt-4-fake" });
		await fakeBackend.start();

		(ApiKeysConfig as any).config = { [testApiKey]: {} };
		(GatewayConfig as any).config = {
			providers: [
				{ id: "openai-fake", name: "Fake OpenAI", backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }] },
			],
		};

		await ProviderManager.init(
			[{ id: "openai-fake", name: "Fake OpenAI", backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }] }],
			false,
		);
		const provider = ProviderManager.getProvider("openai-fake")!;
		await provider.models.refreshModelsList(provider.backends.map((b) => b.apiClient));

		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
		app.route("/v1", anthropicRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		resetSingletons();
	});

	test("x-api-key auth works and /v1/models returns the Anthropic envelope", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { "x-api-key": testApiKey, "anthropic-version": "2023-06-01" },
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		// Anthropic envelope, not the OpenAI {object:"list"} one.
		expect(json.object).toBeUndefined();
		expect(Array.isArray(json.data)).toBe(true);
		expect(json.data[0].type).toBe("model");
		expect(json.data[0].display_name).toBeDefined();
		expect(json.has_more).toBe(false);
		expect(json.first_id).toBe(json.last_id);
	});

	test("Bearer auth still returns the OpenAI list envelope", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { Authorization: `Bearer ${testApiKey}` },
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("list");
	});

	test("x-api-key with wrong key returns 403", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { "x-api-key": "wrong-key", "anthropic-version": "2023-06-01" },
			}),
		);
		expect(res.status).toBe(403);
		const json = (await res.json()) as any;
		// Anthropic-style error shape.
		expect(json.type).toBe("error");
		expect(json.error.type).toBe("authentication_error");
	});
});