import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import {
	responsesRequestToOpenAIChat,
	openAIChatResponseToResponses,
	openaiChatSseToResponsesSse,
} from "../src/translation";
import { authMiddlewareV1 } from "../src/api/versions/v1/auth";
import { router as openaiRouter } from "../src/api/versions/v1/routes/openai";
import { router as responsesRouter } from "../src/api/versions/v1/routes/responses";
import { ProviderManager } from "../src/loadBalancing/providerManager";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { ApiKeysConfig } from "../src/utils/config/apiKeysConfig";
import { FakeOpenAICompatibleAPI } from "./helpers/fakeOpenAICompatibleAPI";

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

function resetSingletons() {
	(ProviderManager as any)._initialized = false;
	(ProviderManager as any).providers = new Map();
	(GatewayConfig as any).config = null;
	(ApiKeysConfig as any).config = null;
}

/* ================================================================== */
/*  Unit: responsesRequestToOpenAIChat                                 */
/* ================================================================== */

describe("responsesRequestToOpenAIChat", () => {
	test("string input -> a single user message", () => {
		const out = responsesRequestToOpenAIChat({ model: "gpt", input: "Hello" } as any);
		expect(out.messages).toEqual([{ role: "user", content: "Hello" }]);
		expect(out.stream).toBe(false);
	});

	test("array input with instructions, function_call and output", () => {
		const out = responsesRequestToOpenAIChat({
			model: "gpt",
			instructions: "Be helpful.",
			max_output_tokens: 50,
			input: [
				{ type: "message", role: "user", content: "Hi" },
				{ type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"SF"}' },
				{ type: "function_call_output", call_id: "c1", output: "Sunny" },
			],
			tools: [{ type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object" } }],
			tool_choice: { type: "function", name: "get_weather" },
		} as any);

		expect(out.messages[0]).toEqual({ role: "system", content: "Be helpful." });
		expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
		expect(out.messages[2]).toEqual({
			role: "assistant", content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
		});
		expect(out.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "Sunny" });
		expect(out.max_tokens).toBe(50);
		expect(out.tools).toEqual([
			{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } } },
		]);
		expect(out.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
	});

	test("developer/system role maps to system", () => {
		const out = responsesRequestToOpenAIChat({
			model: "gpt",
			input: [{ type: "message", role: "developer", content: "do thing" }],
		} as any);
		expect(out.messages[0]).toEqual({ role: "system", content: "do thing" });
	});
});

/* ================================================================== */
/*  Unit: openAIChatResponseToResponses                                */
/* ================================================================== */

describe("openAIChatResponseToResponses", () => {
	test("converts a plain text completion", () => {
		const out = openAIChatResponseToResponses({
			id: "chatcmpl-1", object: "chat.completion", created: 1700000000, model: "gpt-4",
			choices: [{ index: 0, message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
		} as any);
		expect(out.object).toBe("response");
		expect(out.status).toBe("completed");
		expect(out.output_text).toBe("Hi there");
		expect(out.output[0]).toEqual({
			type: "message", id: "msg_chatcmpl-1", role: "assistant", status: "completed",
			content: [{ type: "output_text", text: "Hi there", annotations: [] }],
		});
		expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 3, total_tokens: 8 });
	});

	test("converts tool_calls into function_call output items", () => {
		const out = openAIChatResponseToResponses({
			id: "c2", object: "chat.completion", created: 1, model: "m",
			choices: [{
				index: 0,
				message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
				finish_reason: "tool_calls",
			}],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		} as any);
		expect(out.status).toBe("completed");
		expect(out.output[0]).toEqual({
			type: "function_call", id: "fc_call_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}', status: "completed",
		});
	});

	test("maps length finish_reason to incomplete", () => {
		const out = openAIChatResponseToResponses({
			id: "c3", object: "chat.completion", created: 1, model: "m",
			choices: [{ index: 0, message: { role: "assistant", content: "..." }, finish_reason: "length" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		} as any);
		expect(out.status).toBe("incomplete");
		expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
	});
});

/* ================================================================== */
/*  Unit: openaiChatSseToResponsesSse                                  */
/* ================================================================== */

describe("openaiChatSseToResponsesSse", () => {
	test("converts a text stream into Responses events", async () => {
		const input = [
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
			"data: [DONE]",
		].join("\n\n") + "\n\n";

		const out = await runTransform(input, openaiChatSseToResponsesSse("user/model"));

		expect(out).toContain("event: response.created");
		expect(out).toContain('"model":"user/model"');
		expect(out).toContain("event: response.output_text.delta");
		expect(out).toContain('"delta":"Hello"');
		expect(out).toContain("event: response.output_text.done");
		expect(out).toContain("event: response.completed");
		expect(out).toContain('"object":"response"');
		expect(out).not.toContain("[DONE]");
	});

	test("converts tool-call deltas into function_call items", async () => {
		const input = [
			'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"SF\\"}"}}]},"finish_reason":null}]}',
			'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
			"data: [DONE]",
		].join("\n\n") + "\n\n";

		const out = await runTransform(input, openaiChatSseToResponsesSse("user/model"));

		expect(out).toContain("event: response.output_item.added");
		expect(out).toContain('"type":"function_call"');
		expect(out).toContain('"name":"get_weather"');
		expect(out).toContain("event: response.function_call_arguments.delta");
		expect(out).toContain("event: response.function_call_arguments.done");
		expect(out).toContain("event: response.completed");
		// The completed event reconstructs the function_call in output.
		expect(out).toContain('"call_id":"call_1"');
	});
});

/* ================================================================== */
/*  Integration: POST /v1/responses                                    */
/* ================================================================== */

describe("/v1/responses — integration", () => {
	let fakeBackend: FakeOpenAICompatibleAPI;
	let app: Hono;
	const testApiKey = "sk-responses-test";

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
		app.route("/v1", responsesRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		resetSingletons();
	});

	test("non-streaming: returns a Responses object translated from chat completions", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/responses", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
				body: JSON.stringify({
					model: "openai-fake/gpt-4-fake",
					instructions: "Be nice.",
					input: "Hi",
					max_output_tokens: 100,
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("response");
		expect(json.status).toBe("completed");
		expect(json.model).toBe("openai-fake/gpt-4-fake");
		expect(json.output_text).toBe("Hello!");
		expect(json.output[0].type).toBe("message");
		expect(json.output[0].content[0].type).toBe("output_text");
		expect(json.output[0].content[0].text).toBe("Hello!");
		expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });

		// The backend received a chat-completions request (bare model + system).
		const chatReq = fakeBackend.requests.find((r) => r.pathname === "/v1/chat/completions");
		expect(chatReq).toBeDefined();
		const sent = JSON.parse(chatReq!.body!);
		expect(sent.model).toBe("gpt-4-fake");
		expect(sent.messages[0]).toEqual({ role: "system", content: "Be nice." });
		expect(sent.messages[1]).toEqual({ role: "user", content: "Hi" });
		expect(sent.max_tokens).toBe(100);
	});

	test("streaming: returns a Responses event stream translated from chat chunks", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/responses", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
				body: JSON.stringify({
					model: "openai-fake/gpt-4-fake",
					input: "Hi",
					stream: true,
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);

		const text = await readStream(res);
		expect(text).toContain("event: response.created");
		expect(text).toContain('"model":"openai-fake/gpt-4-fake"');
		expect(text).toContain("event: response.output_text.delta");
		expect(text).toContain('"delta":"Hello"');
		expect(text).toContain("event: response.completed");
		expect(text).not.toContain("[DONE]");
	});

	test("returns 400 when model is missing", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/responses", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
				body: JSON.stringify({ input: "Hi" }),
			}),
		);
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error.message).toContain("Model is required");
	});

	test("returns 404 for an unknown model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/responses", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${testApiKey}` },
				body: JSON.stringify({ model: "nope/missing", input: "Hi" }),
			}),
		);
		expect(res.status).toBe(404);
	});
});