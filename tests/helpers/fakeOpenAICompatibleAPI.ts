import { LLMock } from "@copilotkit/aimock";

export class FakeOpenAICompatibleAPI {

	private readonly mock: LLMock;

	constructor() {
		this.mock = new LLMock();

		// Register a chat-completion fixture that handles both streaming
		// and non-streaming POST /v1/chat/completions requests.
		this.mock.on({ endpoint: "chat" }, { content: "Hello! I'm an AI assistant." });

		// Register an embedding fixture for /v1/embeddings.
		this.mock.on({ endpoint: "embedding" }, { embedding: [0.1, 0.2, 0.3] });
	}

	async start() {
		await this.mock.start();
		return this.getUrl();
	}

	public getUrl(): string {
		return this.mock.url + "/v1";
	}

	async stop() {
		await this.mock.stop();
	}
}

/* ------------------------------------------------------------------ */
/*  Lightweight fake backend for integration tests                     */
/* ------------------------------------------------------------------ */

export interface FakeBackendConfig {
	apiKey?: string;
	statusCode?: number;
	responseBody?: string;
	delayMs?: number;
	model?: string;
}

export interface FakeBackendInstance {
	url: string;
	close: () => void;
	requests: Array<{
		method: string;
		pathname: string;
		headers: Record<string, string>;
		body?: string;
	}>;
	config: FakeBackendConfig;
}

/**
 * Create a lightweight fake OpenAI-compatible backend using Bun.serve.
 * Tracks all received requests and supports configurable error states.
 */
export function createFakeBackend(initialConfig?: FakeBackendConfig): FakeBackendInstance {
	const requests: FakeBackendInstance["requests"] = [];
	const config: FakeBackendConfig = { model: "gpt-4-fake", ...initialConfig };

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req: Request) {
			const url = new URL(req.url);

			if (config.delayMs) {
				await new Promise((r) => setTimeout(r, config.delayMs));
			}

			// Check API key if configured
			if (config.apiKey) {
				const auth = req.headers.get("authorization");
				if (auth !== `Bearer ${config.apiKey}`) {
					requests.push({
						method: req.method,
						pathname: url.pathname,
						headers: Object.fromEntries(req.headers),
					});
					return Response.json({ error: "Unauthorized" }, { status: 401 });
				}
			}

			// Track the request
			const body = req.method !== "GET" ? await req.text() : undefined;
			requests.push({
				method: req.method,
				pathname: url.pathname,
				headers: Object.fromEntries(req.headers),
				body,
			});

			// Return configured status code / body if set
			if (config.statusCode) {
				return new Response(
					config.responseBody ?? JSON.stringify({ error: "Backend error" }),
					{
						status: config.statusCode,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// Default OpenAI-compatible responses
			const model = config.model ?? "gpt-4-fake";

			if (url.pathname === "/v1/chat/completions") {
				const reqBody = body ? JSON.parse(body) : {};
				if (reqBody.stream) {
					// Streaming response
					const encoder = new TextEncoder();
					const stream = new ReadableStream({
						start(controller) {
							const chunks = [
								`data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"${model}","choices":[{"delta":{"role":"assistant"},"index":0}]}`,
								`data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"${model}","choices":[{"delta":{"content":"Hello"},"index":0}]}`,
								"data: [DONE]",
							];
							chunks.forEach((c) => controller.enqueue(encoder.encode(c + "\n\n")));
							controller.close();
						},
					});
					return new Response(stream, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
						},
					});
				}

				return Response.json({
					id: "chatcmpl-fake",
					object: "chat.completion",
					model,
					choices: [{ message: { role: "assistant", content: "Hello!" }, index: 0 }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				});
			}

			if (url.pathname === "/v1/completions") {
				return Response.json({
					id: "cmpl-fake",
					object: "text_completion",
					model,
					choices: [{ text: "Hello world" }],
				});
			}

			if (url.pathname === "/v1/embeddings") {
				return Response.json({
					object: "list",
					data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
					model,
				});
			}

			if (url.pathname === "/v1/models") {
				return Response.json({
					object: "list",
					data: [
						{ id: model, object: "model", created: 1700000000, owned_by: "fake-org" },
					],
				});
			}

			return Response.json({ error: "Not found" }, { status: 404 });
		},
	});

	return {
		url: `http://${server.hostname}:${server.port}`,
		close: () => server.stop(),
		requests,
		config,
	};
}
