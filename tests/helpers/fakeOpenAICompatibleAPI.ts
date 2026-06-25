/* no external imports — fully self-contained using Bun.serve */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FakeBackendConfig {
	apiKey?: string;
	statusCode?: number;
	responseBody?: string;
	delayMs?: number;
	model?: string;
}

export interface FakeBackendRequest {
	method: string;
	pathname: string;
	headers: Record<string, string>;
	body?: string;
}

/* ------------------------------------------------------------------ */
/*  FakeOpenAICompatibleAPI  —  full Bun.serve-based fake backend      */
/* ------------------------------------------------------------------ */

/**
 * Lightweight fake OpenAI-compatible API server built on Bun.serve.
 *
 * Handles all common OpenAI paths:
 *  - POST /v1/chat/completions  (streaming + non-streaming)
 *  - POST /v1/completions
 *  - POST /v1/embeddings
 *  - GET  /v1/models
 *
 * Supports configurable errors, delays, and API key validation.
 * Tracks all received requests.
 */
export class FakeOpenAICompatibleAPI {
	private readonly config: FakeBackendConfig;
	private readonly _requests: FakeBackendRequest[] = [];
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(config?: FakeBackendConfig) {
		this.config = { model: "gpt-4-fake", ...config };
	}

	/* ---- Lifecycle ---- */

	/**
	 * Start the server and return the base URL **without** a `/v1` suffix.
	 * Use this when the paths you send already contain `/v1/`.
	 *
	 * For SOCKS5 / old-style tests that need a `/v1` suffix, call `getUrl()` instead.
	 */
	async start(): Promise<string> {
		if (this.server) return this.baseUrl;

		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (req: Request) => {
				const url = new URL(req.url);

				if (this.config.delayMs) {
					await new Promise((r) => setTimeout(r, this.config.delayMs));
				}

				// API key check
				if (this.config.apiKey) {
					const auth = req.headers.get("authorization");
					if (auth !== `Bearer ${this.config.apiKey}`) {
						this._track(req, url, undefined);
						return Response.json({ error: "Unauthorized" }, { status: 401 });
					}
				}

				const body = req.method !== "GET" ? await req.text() : undefined;
				this._track(req, url, body);

				// Configured error mode
				if (this.config.statusCode) {
					return new Response(
						this.config.responseBody ?? JSON.stringify({ error: "Backend error" }),
						{
							status: this.config.statusCode,
							headers: { "Content-Type": "application/json" },
						},
					);
				}

				const model = this.config.model ?? "gpt-4-fake";

				// ---- endpoints ----

				if (url.pathname === "/v1/chat/completions") {
					return this._handleChatCompletions(body, model);
				}

				if (url.pathname === "/v1/completions") {
					return this._handleCompletions(body, model);
				}

				if (url.pathname === "/v1/embeddings") {
					return this._handleEmbeddings(model);
				}

				if (url.pathname === "/v1/models") {
                    console.log("FakeOpenAICompatibleAPI: /v1/models request received");
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

		return this.baseUrl;
	}

	get baseUrl(): string {
		if (!this.server) throw new Error("Fake server not started. Call start() first.");
		return `http://${this.server.hostname}:${this.server.port}/v1`;
	}


	async stop(): Promise<void> {
		this.server?.stop();
		this.server = null;
		this._requests.length = 0;
	}

	/* ---- Request inspection ---- */

	get requests(): FakeBackendRequest[] {
		return [...this._requests];
	}

	clearRequests(): void {
		this._requests.length = 0;
	}

	setNextError(status: number, responseBody?: string): void {
		this.config.statusCode = status;
		this.config.responseBody = responseBody;
	}

	clearNextError(): void {
		this.config.statusCode = undefined;
		this.config.responseBody = undefined;
	}

	/* ---- Internal ---- */

	private _track(req: Request, url: URL, body?: string): void {
		this._requests.push({
			method: req.method,
			pathname: url.pathname,
			headers: Object.fromEntries(req.headers),
			body,
		});
	}

	private _handleChatCompletions(body: string | undefined, model: string): Response {
		const reqBody = body ? JSON.parse(body) : {};

		if (reqBody.stream) {
			const encoder = new TextEncoder();
			const stream = new ReadableStream({
				start(controller) {
					const chunks = [
						`data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"${model}","choices":[{"delta":{"role":"assistant"},"index":0}]}`,
						`data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","model":"${model}","choices":[{"delta":{"content":"Hello"},"index":0}]}`,
						"data: [DONE]",
					];
					for (const c of chunks) {
						controller.enqueue(encoder.encode(c + "\n\n"));
					}
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
			choices: [{
				message: { role: "assistant", content: "Hello!" },
				finish_reason: "stop",
				index: 0,
			}],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
	}

	private _handleCompletions(_body: string | undefined, model: string): Response {
		return Response.json({
			id: "cmpl-fake",
			object: "text_completion",
			model,
			choices: [{ text: "Hello world" }],
		});
	}

	private _handleEmbeddings(model: string): Response {
		return Response.json({
			object: "list",
			data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
			model,
		});
	}
}
