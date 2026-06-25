import type { Backend } from "../src/utils/config";

export interface FakeBackendOptions {
	/** Optional API key the fake backend requires in the Authorization header. */
	apiKey?: string;
	/** Artificial delay in ms before responding (for timeout tests). */
	delayMs?: number;
	/** Forced HTTP status code; when set overrides success responses. */
	statusCode?: number;
	/** Forced response body; when set overrides success responses. */
	responseBody?: string;
	/** Default model name returned in chat completion responses. */
	model?: string;
}

export interface FakeBackend {
	/** The actual Bun server instance. */
	server: ReturnType<typeof Bun.serve>;
	/** Base URL of the fake backend, e.g. http://localhost:12345 */
	url: string;
	/** Builds a Backend config object for this fake server. */
	toBackendConfig(name: string, overrides?: Partial<Backend>): Backend;
	/** Recorded incoming request metadata for assertions. */
	requests: RequestRecord[];
	/** Currently configured behavior options; mutating this affects future requests. */
	options: FakeBackendOptions;
}

export interface RequestRecord {
	method: string;
	pathname: string;
	headers: Record<string, string>;
	body: unknown;
}

function createChatCompletionResponse(model: string, stream: boolean): unknown {
	if (stream) {
		return null;
	}

	return {
		id: "chatcmpl-fake",
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "Hello from fake backend" },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
	};
}

function createModelsResponse(): unknown {
	return {
		object: "list",
		data: [
			{
				id: "gpt-4",
				object: "model",
				created: 1678888888,
				owned_by: "fake",
			},
		],
	};
}

function createEmbeddingResponse(): unknown {
	return {
		object: "list",
		data: [
			{
				object: "embedding",
				embedding: [0.1, 0.2, 0.3],
				index: 0,
			},
		],
		model: "text-embedding-3-small",
		usage: { prompt_tokens: 5, total_tokens: 5 },
	};
}

function createCompletionResponse(model: string): unknown {
	return {
		id: "cmpl-fake",
		object: "text_completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ text: "Fake completion text", index: 0, finish_reason: "stop" }],
		usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
	};
}

function createStreamChunks(model: string): string {
	const chunks = [
		{ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ delta: { role: "assistant" }, index: 0 }] },
		{ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ delta: { content: "Hello" }, index: 0 }] },
		{ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ delta: { content: " world" }, index: 0 }] },
		{ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
	];

	let sse = "";
	for (const chunk of chunks) {
		sse += `data: ${JSON.stringify(chunk)}\n\n`;
	}
	sse += "data: [DONE]\n\n";
	return sse;
}

export function createFakeOpenAIBackend(options: FakeBackendOptions = {}): FakeBackend {
	const state: FakeBackend = {
		server: undefined as unknown as ReturnType<typeof Bun.serve>,
		url: "",
		requests: [],
		options,
		toBackendConfig(name, overrides = {}) {
			return {
				name,
				url: this.url,
				apiKey: options.apiKey,
				healthCheckPath: "/v1/models",
				...overrides,
			};
		},
	};

	state.server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const record: RequestRecord = {
				method: request.method,
				pathname: url.pathname,
				headers: {},
				body: null,
			};

			request.headers.forEach((value, key) => {
				record.headers[key.toLowerCase()] = value;
			});

			if (request.method !== "GET" && request.method !== "HEAD") {
				const text = await request.text();
				try {
					record.body = text ? JSON.parse(text) : null;
				} catch {
					record.body = text;
				}
			}

			state.requests.push(record);

			if (state.options.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, state.options.delayMs));
			}

			if (state.options.apiKey) {
				const auth = record.headers["authorization"] || "";
				const expected = `Bearer ${state.options.apiKey}`;
				if (auth !== expected) {
					return new Response(JSON.stringify({ error: "Invalid API key" }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					});
				}
			}

			if (state.options.statusCode) {
				return new Response(state.options.responseBody ?? JSON.stringify({ error: "Forced error" }), {
					status: state.options.statusCode,
					headers: { "Content-Type": "application/json" },
				});
			}

			const model = state.options.model ?? "gpt-4-fake";
			const body = (record.body as Record<string, unknown>) || {};
			const stream = body.stream === true;

			if (url.pathname === "/v1/models") {
				return Response.json(createModelsResponse());
			}

			if (url.pathname === "/v1/chat/completions") {
				if (stream) {
					const sse = createStreamChunks(model);
					return new Response(sse, {
						status: 200,
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
						},
					});
				}
				return Response.json(createChatCompletionResponse(model, stream));
			}

			if (url.pathname === "/v1/completions") {
				return Response.json(createCompletionResponse(model));
			}

			if (url.pathname === "/v1/embeddings") {
				return Response.json(createEmbeddingResponse());
			}

			return new Response(JSON.stringify({ error: "Not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		},
	});

	state.url = `http://${state.server.hostname}:${state.server.port}`;
	return state;
}

export function closeFakeBackend(fake: FakeBackend): void {
	fake.server.stop();
}
