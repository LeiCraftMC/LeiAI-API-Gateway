/* no external imports — fully self-contained using Bun.serve */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FakeAnthropicConfig {
	apiKey?: string;
	statusCode?: number;
	responseBody?: string;
	delayMs?: number;
	model?: string;
	/** Model ids listed by `GET /v1/models` (default: just `model`). */
	models?: string[];
	/** Page size of `GET /v1/models` (default: everything on one page). */
	modelsPageSize?: number;
}

export interface FakeAnthropicRequest {
	method: string;
	pathname: string;
	/** Query string, including the leading `?` (empty when absent). */
	search: string;
	headers: Record<string, string>;
	body?: string;
}

/* ------------------------------------------------------------------ */
/*  FakeAnthropicAPI  —  native Anthropic Messages-API fake backend    */
/* ------------------------------------------------------------------ */

/**
 * Lightweight fake backend that speaks the Anthropic Messages API natively
 * (used to test the `supportsAnthropicLikeAPI` passthrough path and
 * Anthropic-only providers).
 *
 * Handles:
 *  - POST /v1/messages  (streaming + non-streaming)
 *  - GET  /v1/models    (Anthropic envelope, paginated via `after_id`)
 *
 * Authenticates with `x-api-key` + `anthropic-version` and tracks all
 * received requests.
 */
export class FakeAnthropicAPI {
	private readonly config: FakeAnthropicConfig;
	private readonly _requests: FakeAnthropicRequest[] = [];
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(config?: FakeAnthropicConfig) {
		this.config = { model: "claude-fake", ...config };
	}

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

				// Auth check: a `supportsAnthropicLikeAPI` backend accepts BOTH
				// the OpenAI-style `Authorization: Bearer` (used for /models and
				// chat-completions) and the Anthropic-style `x-api-key` (used for
				// /messages passthrough).
				if (this.config.apiKey) {
					const bearerOk = req.headers.get("authorization") === `Bearer ${this.config.apiKey}`;
					const xKeyOk = req.headers.get("x-api-key") === this.config.apiKey;
					if (!bearerOk && !xKeyOk) {
						this._track(req, url, undefined);
						return Response.json(
							{ type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
							{ status: 401 },
						);
					}
				}

				const body = req.method !== "GET" ? await req.text() : undefined;
				this._track(req, url, body);

				if (this.config.statusCode) {
					return new Response(
						this.config.responseBody ?? JSON.stringify({ type: "error", error: { type: "api_error", message: "Backend error" } }),
						{ status: this.config.statusCode, headers: { "Content-Type": "application/json" } },
					);
				}

				const model = this.config.model ?? "claude-fake";

				if (url.pathname === "/v1/messages") {
					return this._handleMessages(body, model);
				}

				if (url.pathname === "/v1/models") {
					return this._handleModels(url, model);
				}

				return Response.json({ type: "error", error: { type: "not_found_error", message: "Not found" } }, { status: 404 });
			},
		});

		return this.baseUrl;
	}

	get baseUrl(): string {
		if (!this.server) throw new Error("Fake server not started. Call start() first.");
		// baseUrl already includes /v1 so the gateway forwards to /v1/messages.
		return `http://${this.server.hostname}:${this.server.port}/v1`;
	}

	async stop(): Promise<void> {
		this.server?.stop();
		this.server = null;
		this._requests.length = 0;
	}

	get requests(): FakeAnthropicRequest[] {
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
			search: url.search,
			headers: Object.fromEntries(req.headers),
			body,
		});
	}

	private _handleModels(url: URL, model: string): Response {
		const ids = this.config.models ?? [model];
		const afterId = url.searchParams.get("after_id");
		const start = afterId ? ids.indexOf(afterId) + 1 : 0;
		const page = ids.slice(start, start + (this.config.modelsPageSize ?? ids.length));
		return Response.json({
			data: page.map((id) => ({ id, display_name: id, created_at: "2024-01-01T00:00:00Z", type: "model" })),
			has_more: start + page.length < ids.length,
			first_id: page[0] ?? null,
			last_id: page[page.length - 1] ?? null,
		});
	}

	private _handleMessages(body: string | undefined, model: string): Response {
		const reqBody = body ? JSON.parse(body) : {};

		if (reqBody.stream) {
			const encoder = new TextEncoder();
			const messageStart = {
				type: "message_start",
				message: {
					id: "msg_fake", type: "message", role: "assistant", content: [], model,
					stop_reason: null, stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			};
			const events: string[] = [
				`event: message_start\ndata: ${JSON.stringify(messageStart)}`,
				`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
				`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
				`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
				`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
			];
			const stream = new ReadableStream({
				start(controller) {
					for (const e of events) {
						controller.enqueue(encoder.encode(e + "\n\n"));
					}
					controller.close();
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
			});
		}

		return Response.json({
			id: "msg_fake",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: "Hello!" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		});
	}
}