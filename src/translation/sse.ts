/**
 * Server-Sent-Event (SSE) translation transforms.
 *
 * The transforms living here:
 *
 *  - {@link openaiChatSseToAnthropicSse} — converts an OpenAI
 *    chat-completions *streaming* response (a sequence of
 *    `chat.completion.chunk` `data:` lines terminated by `[DONE]`) into an
 *    Anthropic Messages event stream (`message_start`, `content_block_*`,
 *    `message_delta`, `message_stop`).  Used when an Anthropic-style client
 *    request is translated to a chat-completions backend and the response
 *    is streamed.
 *
 *  - {@link anthropicSseToOpenaiChatSse} — the reverse: converts an
 *    Anthropic Messages event stream into chat-completion chunks.  Used when
 *    an OpenAI-style client request is translated for a provider whose
 *    backends only speak the Anthropic Messages API.
 *
 *  - {@link openaiChatSseToResponsesSse} — converts chat-completion chunks
 *    into an OpenAI Responses event stream.
 *
 *  - {@link anthropicSseModelRewrite} — a passthrough transform that only
 *    rewrites the `model` field inside the `message_start` event to the
 *    user-facing model name.  Used when an Anthropic-style client request
 *    is forwarded natively (passthrough) to a
 *    `supportsAnthropicLikeAPI` backend.
 *
 * All are built on a small shared SSE event parser ({@link
 * createSSETransform}) that buffers raw bytes into complete SSE events
 * (an `event:` line plus one or more `data:` lines, terminated by a blank
 * line) and dispatches them to a handler.
 */

import type { Anthropic, OpenAIChat, Responses } from "./types";
import {
	JSON_RESPONSE_TOOL,
	anthropicStopReasonToOpenAI,
	anthropicUsageToOpenAI,
	openAIFinishReasonToAnthropic,
} from "./chatAnthropic";
import type { AnthropicToChatOptions } from "./chatAnthropic";
import {
	openAIFinishReasonToIncompleteReason,
	openAIFinishReasonToResponseStatus,
} from "./responses";

/* ------------------------------------------------------------------ */
/*  SSE parsing framework                                              */
/* ------------------------------------------------------------------ */

interface SSEEvent {
	/** The `event:` field value, or `null` if the event had no `event:` line. */
	event: string | null;
	/** The `data:` payload (multiple `data:` lines joined with `\n`). */
	data: string;
}

interface SSEHandlers {
	/** Called for each complete SSE event.  `emit` enqueues output text. */
	onEvent: (ev: SSEEvent, emit: (s: string) => void) => void;
	/** Called once before the first chunk. */
	onStart?: (emit: (s: string) => void) => void;
	/** Called when the input stream ends (after all events). */
	onEnd?: (emit: (s: string) => void) => void;
}

/**
 * Create a `TransformStream<Uint8Array, Uint8Array>` that parses raw SSE
 * bytes into events and dispatches them to {@link SSEHandlers}.  Output is
 * produced by the handler via the `emit` callback (text is UTF-8 encoded).
 */
function createSSETransform(handlers: SSEHandlers): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	let buffer = "";
	let currentEvent: string | null = null;
	let dataLines: string[] = [];
	let ctrl: TransformStreamDefaultController<Uint8Array> | null = null;

	const emit = (s: string) => {
		ctrl?.enqueue(encoder.encode(s));
	};

	const processLine = (line: string, out: SSEEvent[]): void => {
		if (line === "") {
			// Blank line = event boundary.
			if (currentEvent !== null || dataLines.length > 0) {
				out.push({ event: currentEvent, data: dataLines.join("\n") });
			}
			currentEvent = null;
			dataLines = [];
			return;
		}
		if (line.startsWith(":")) return; // SSE comment / keep-alive
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) return;
		const field = line.slice(0, colonIdx);
		let value = line.slice(colonIdx + 1);
		// SSE spec: strip a single leading space after the colon.
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") currentEvent = value;
		else if (field === "data") dataLines.push(value);
		// `id:` and `retry:` are ignored.
	};

	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			ctrl = controller;
			handlers.onStart?.(emit);
		},
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			const events: SSEEvent[] = [];
			let idx: number;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
				processLine(clean, events);
			}
			for (const ev of events) handlers.onEvent(ev, emit);
		},
		flush(controller) {
			// Process any trailing partial line that wasn't newline-terminated.
			if (buffer.length > 0) {
				const clean = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
				const events: SSEEvent[] = [];
				processLine(clean, events);
				for (const ev of events) handlers.onEvent(ev, emit);
			}
			// If the stream ended without a trailing blank line, flush the
			// pending event.
			if (currentEvent !== null || dataLines.length > 0) {
				handlers.onEvent({ event: currentEvent, data: dataLines.join("\n") }, emit);
			}
			handlers.onEnd?.(emit);
		},
	});
}

/** Helper: serialize an Anthropic SSE event (`event: <e>\ndata: <json>\n\n`). */
function anthropicSSE(event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/* ------------------------------------------------------------------ */
/*  OpenAI Chat SSE  ->  Anthropic SSE                                 */
/* ------------------------------------------------------------------ */

/**
 * Convert an OpenAI chat-completions streaming response into an Anthropic
 * Messages event stream.
 *
 * Stateful: tracks which content blocks (text / tool_use) are open so that
 * `content_block_start` / `content_block_stop` events are emitted in the
 * right order, and maps OpenAI `tool_calls[].index` to Anthropic content
 * block indices.  The final `message_delta` + `message_stop` are emitted
 * when the input stream ends.
 *
 * @param modelName the user-facing model name to place in `message_start`
 *   (the backend's bare model name is replaced).
 */
export function openaiChatSseToAnthropicSse(
	modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
	let started = false;
	let messageId = "msg_gateway";
	let textBlockOpen = false;
	let textBlockIndex = 0;
	let nextBlockIndex = 0;
	const toolCallToBlock = new Map<number, number>();
	const openToolBlocks: number[] = [];
	let finishReason: string | null = null;
	let outputTokens = 0;
	let doneSeen = false;

	const closeTextBlock = (emit: (s: string) => void) => {
		if (textBlockOpen) {
			emit(anthropicSSE("content_block_stop", { type: "content_block_stop", index: textBlockIndex }));
			textBlockOpen = false;
		}
	};

	const closeToolBlocks = (emit: (s: string) => void) => {
		for (const idx of openToolBlocks) {
			emit(anthropicSSE("content_block_stop", { type: "content_block_stop", index: idx }));
		}
		openToolBlocks.length = 0;
	};

	return createSSETransform({
		onEvent(ev, emit) {
			if (doneSeen) return;
			if (ev.data === "[DONE]") {
				doneSeen = true;
				return;
			}
			let chunk: OpenAIChat.Chunk;
			try {
				chunk = JSON.parse(ev.data);
			} catch {
				return; // drop malformed lines
			}

			if (!started) {
				messageId = chunk.id ?? messageId;
				emit(
					anthropicSSE("message_start", {
						type: "message_start",
						message: {
							id: messageId,
							type: "message",
							role: "assistant",
							content: [],
							model: modelName,
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 0, output_tokens: 0 },
						},
					}),
				);
				started = true;
			}

			// Usage-only chunk (empty `choices`, e.g. the final chunk when
			// `stream_options.include_usage` is set).
			if (!chunk.choices || chunk.choices.length === 0) {
				if (chunk.usage) outputTokens = chunk.usage.completion_tokens ?? outputTokens;
				return;
			}

			const choice = chunk.choices[0];
			if (!choice) return;
			const delta = choice.delta ?? {};

			// ---- text content ----
			if (typeof delta.content === "string" && delta.content.length > 0) {
				if (!textBlockOpen) {
					textBlockIndex = nextBlockIndex++;
					textBlockOpen = true;
					emit(
						anthropicSSE("content_block_start", {
							type: "content_block_start",
							index: textBlockIndex,
							content_block: { type: "text", text: "" },
						}),
					);
				}
				emit(
					anthropicSSE("content_block_delta", {
						type: "content_block_delta",
						index: textBlockIndex,
						delta: { type: "text_delta", text: delta.content },
					}),
				);
			}

			// ---- tool calls ----
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const oaiIdx = tc.index ?? 0;
					let blockIdx = toolCallToBlock.get(oaiIdx);
					if (blockIdx === undefined) {
						// A new tool call opens a new content block; close any
						// open text block first so block indices stay ordered.
						closeTextBlock(emit);
						blockIdx = nextBlockIndex++;
						toolCallToBlock.set(oaiIdx, blockIdx);
						openToolBlocks.push(blockIdx);
						emit(
							anthropicSSE("content_block_start", {
								type: "content_block_start",
								index: blockIdx,
								content_block: {
									type: "tool_use",
									id: tc.id ?? "",
									name: tc.function?.name ?? "",
									input: {},
								},
							}),
						);
					}
					if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
						emit(
							anthropicSSE("content_block_delta", {
								type: "content_block_delta",
								index: blockIdx,
								delta: { type: "input_json_delta", partial_json: tc.function.arguments },
							}),
						);
					}
				}
			}

			if (chunk.usage) outputTokens = chunk.usage.completion_tokens ?? outputTokens;

			// ---- finish ----
			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
				closeTextBlock(emit);
				closeToolBlocks(emit);
			}
		},
		onEnd(emit) {
			if (!started) return; // empty stream — nothing to emit
			closeTextBlock(emit);
			closeToolBlocks(emit);
			const stopReason = openAIFinishReasonToAnthropic(finishReason) ?? "end_turn";
			emit(
				anthropicSSE("message_delta", {
					type: "message_delta",
					delta: { stop_reason: stopReason, stop_sequence: null },
					usage: { output_tokens: outputTokens },
				}),
			);
			emit(anthropicSSE("message_stop", { type: "message_stop" }));
		},
	});
}

/* ------------------------------------------------------------------ */
/*  Anthropic SSE  ->  OpenAI Chat SSE                                 */
/* ------------------------------------------------------------------ */

/**
 * Convert an Anthropic Messages event stream into an OpenAI
 * chat-completions streaming response (`chat.completion.chunk` `data:`
 * lines terminated by `data: [DONE]`).
 *
 * Text deltas become `delta.content`, thinking deltas become
 * `delta.reasoning_content`, and each `tool_use` content block becomes a
 * `delta.tool_calls` entry (Anthropic block indices are remapped to 0-based
 * tool-call indices), except a {@link JSON_RESPONSE_TOOL} call answering a
 * JSON `response_format`, whose input is streamed as content.  The finish
 * chunk, the optional usage chunk and `[DONE]` are emitted on
 * `message_stop`, or at the end of the input once `message_delta` gave the
 * stop reason.  An `error` event, or an input that ends before the stop
 * reason, becomes an OpenAI-style `{ error }` chunk and no `[DONE]`.
 *
 * @param modelName the user-facing model name to place in every chunk.
 * @param options.includeUsage emit a final usage-only chunk (empty
 *   `choices`), as OpenAI does for `stream_options.include_usage`.
 * @param options.jsonResponse see {@link AnthropicToChatOptions}.
 */
export function anthropicSseToOpenaiChatSse(
	modelName: string,
	options: { includeUsage?: boolean } & AnthropicToChatOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
	let id = "chatcmpl-gateway";
	const created = Math.floor(Date.now() / 1000);
	let started = false;
	let ended = false;
	let stopReason: string | null = null;
	const usage: Partial<Anthropic.Usage> = {};
	// Per tool_use content block (by Anthropic block index): its OpenAI
	// tool-call index, or "json" for the JSON answer, and whether any of its
	// input JSON has been sent yet.
	const toolBlocks = new Map<number, { toolIndex: number | "json"; hasInput: boolean }>();
	let toolCallCount = 0;

	const chunkSSE = (choices: OpenAIChat.ChunkChoice[], extra?: object) =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelName, choices, ...extra })}\n\n`;

	const deltaSSE = (delta: OpenAIChat.ChunkChoice["delta"], finishReason: string | null = null) =>
		chunkSSE([{ index: 0, delta, finish_reason: finishReason }]);

	// The first chunk carries the assistant role, as in OpenAI streams.
	const ensureStarted = (emit: (s: string) => void) => {
		if (started) return;
		started = true;
		emit(deltaSSE({ role: "assistant", content: "" }));
	};

	// Usage counts are cumulative; keep the latest numeric value per field.
	const mergeUsage = (u: Partial<Anthropic.Usage> | undefined) => {
		for (const [key, value] of Object.entries(u ?? {})) {
			if (typeof value === "number") usage[key] = value;
		}
	};

	// A piece of a tool block's input JSON: tool-call arguments, or content
	// for the JSON answer.
	const emitInput = (
		emit: (s: string) => void,
		block: { toolIndex: number | "json"; hasInput: boolean },
		json: string,
	) => {
		block.hasInput = true;
		emit(block.toolIndex === "json"
			? deltaSSE({ content: json })
			: deltaSSE({ tool_calls: [{ index: block.toolIndex, function: { arguments: json } }] }));
	};

	const fail = (emit: (s: string) => void, error: { type?: string; message?: string } | undefined) => {
		ended = true;
		emit(`data: ${JSON.stringify({
			error: { message: error?.message ?? "Upstream error", type: error?.type ?? "api_error" },
		})}\n\n`);
	};

	const finish = (emit: (s: string) => void) => {
		ended = true;
		ensureStarted(emit);
		// A JSON answer arrives as a tool call but is reported as content.
		const finishReason = anthropicStopReasonToOpenAI(stopReason) ?? "stop";
		emit(deltaSSE({}, finishReason === "tool_calls" && toolCallCount === 0 ? "stop" : finishReason));
		if (options.includeUsage) {
			emit(chunkSSE([], { usage: anthropicUsageToOpenAI(usage) }));
		}
		emit("data: [DONE]\n\n");
	};

	return createSSETransform({
		onEvent(ev, emit) {
			if (ended) return;
			let event: Anthropic.StreamEvent;
			try {
				event = JSON.parse(ev.data);
			} catch {
				return; // drop malformed lines
			}

			// `?.` because a `data: null` keep-alive parses to null.
			switch (event?.type) {
				case "message_start":
					id = event.message?.id ?? id;
					mergeUsage(event.message?.usage);
					ensureStarted(emit);
					return;

				case "content_block_start": {
					const block = event.content_block;
					if (block?.type === "tool_use") {
						ensureStarted(emit);
						if (options.jsonResponse && block.name === JSON_RESPONSE_TOOL) {
							toolBlocks.set(event.index ?? 0, { toolIndex: "json", hasInput: false });
						} else {
							const toolIndex = toolCallCount++;
							toolBlocks.set(event.index ?? 0, { toolIndex, hasInput: false });
							emit(deltaSSE({
								tool_calls: [{
									index: toolIndex,
									id: block.id ?? "",
									type: "function",
									function: { name: block.name ?? "", arguments: "" },
								}],
							}));
						}
					} else if (block?.type === "text" && block.text) {
						ensureStarted(emit);
						emit(deltaSSE({ content: block.text }));
					}
					return;
				}

				case "content_block_delta": {
					const delta = event.delta;
					if (delta?.type === "text_delta" && delta.text) {
						ensureStarted(emit);
						emit(deltaSSE({ content: delta.text }));
					} else if (delta?.type === "thinking_delta" && delta.thinking) {
						ensureStarted(emit);
						emit(deltaSSE({ reasoning_content: delta.thinking }));
					} else if (delta?.type === "input_json_delta" && delta.partial_json) {
						const block = toolBlocks.get(event.index ?? 0);
						if (block) emitInput(emit, block, delta.partial_json);
					}
					return;
				}

				case "content_block_stop": {
					// A tool call without input streams no input JSON at all, but
					// OpenAI clients parse the arguments, so complete them as "{}".
					const block = toolBlocks.get(event.index ?? 0);
					if (block && !block.hasInput) emitInput(emit, block, "{}");
					return;
				}

				case "message_delta":
					stopReason = event.delta?.stop_reason ?? stopReason;
					mergeUsage(event.usage);
					return;

				case "message_stop":
					finish(emit);
					return;

				case "error":
					fail(emit, event.error);
					return;

				// `ping` carries nothing to forward.
			}
		},
		onEnd(emit) {
			if (ended) return;
			// Without a stop reason the upstream stream was cut off; report
			// that rather than a clean finish.
			if (stopReason === null) fail(emit, { message: "The upstream stream ended before the message was complete" });
			else finish(emit);
		},
	});
}

/* ------------------------------------------------------------------ */
/*  OpenAI Chat SSE  ->  OpenAI Responses SSE                         */
/* ------------------------------------------------------------------ */

/** Helper: serialize a Responses SSE event, stamping a `sequence_number`. */
function makeResponsesSSE(seq: () => number, event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number: seq() })}\n\n`;
}

/**
 * Convert an OpenAI chat-completions streaming response into an OpenAI
 * Responses API event stream.
 *
 * Emits the standard Responses event flow (`response.created`,
 * `response.in_progress`, `response.output_item.added`,
 * `response.content_part.added`, `response.output_text.delta`/`.done`,
 * `response.content_part.done`, `response.output_item.done`,
 * `response.function_call_arguments.delta`/`.done`, `response.completed`)
 * with monotonically increasing `sequence_number`s.  Tool calls become
 * `function_call` output items.  The final `response.completed` event
 * carries a fully reconstructed `Response` object.  An upstream `{ error }`
 * chunk ends the stream with `error` and `response.failed` events instead.
 *
 * @param modelName the user-facing model name to place in the response.
 */
export function openaiChatSseToResponsesSse(
	modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
	let started = false;
	let messageId = "resp_gateway";
	let seqNum = 0;
	const nextSeq = () => seqNum++;

	let nextOutputIndex = 0;
	let textOpen = false;
	let textOutputIndex = 0;
	let textItemId = "";
	let outputText = "";

	// tool-call tracking: openai tool index -> state.  Closed items are
	// moved to `completedFunctionCalls` so the final `response.completed`
	// event can reconstruct the full `output` array.
	const toolItems = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();
	const completedFunctionCalls: Responses.FunctionCallItem[] = [];

	let finishReason: string | null = null;
	let inputTokens = 0;
	let outputTokens = 0;
	let doneSeen = false;
	let failed = false;
	let createdAt = Math.floor(Date.now() / 1000);

	const closeText = (emit: (s: string) => void) => {
		if (!textOpen) return;
		emit(makeResponsesSSE(nextSeq, "response.output_text.done", {
			type: "response.output_text.done", output_index: textOutputIndex, content_index: 0, item_id: textItemId, text: outputText,
		}));
		emit(makeResponsesSSE(nextSeq, "response.content_part.done", {
			type: "response.content_part.done", output_index: textOutputIndex, content_index: 0, item_id: textItemId,
			part: { type: "output_text", text: outputText, annotations: [] },
		}));
		emit(makeResponsesSSE(nextSeq, "response.output_item.done", {
			type: "response.output_item.done", output_index: textOutputIndex,
			item: { type: "message", id: textItemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: outputText, annotations: [] }] },
		}));
		textOpen = false;
	};

	const closeToolItems = (emit: (s: string) => void) => {
		for (const [, ti] of toolItems) {
			emit(makeResponsesSSE(nextSeq, "response.function_call_arguments.done", {
				type: "response.function_call_arguments.done", output_index: ti.outputIndex, item_id: ti.itemId, name: ti.name, arguments: ti.args,
			}));
			emit(makeResponsesSSE(nextSeq, "response.output_item.done", {
				type: "response.output_item.done", output_index: ti.outputIndex,
				item: { type: "function_call", id: ti.itemId, call_id: ti.callId, name: ti.name, arguments: ti.args, status: "completed" },
			}));
			completedFunctionCalls.push({
				type: "function_call", id: ti.itemId, call_id: ti.callId, name: ti.name, arguments: ti.args, status: "completed",
			});
		}
		toolItems.clear();
	};

	const buildOutput = (): Responses.OutputItem[] => {
		const items: Responses.OutputItem[] = [];
		if (outputText.length > 0) {
			items.push({
				type: "message", id: textItemId, role: "assistant", status: "completed",
				content: [{ type: "output_text", text: outputText, annotations: [] }],
			});
		}
		for (const fc of completedFunctionCalls) items.push(fc);
		return items;
	};

	return createSSETransform({
		onEvent(ev, emit) {
			if (doneSeen || failed) return;
			if (ev.data === "[DONE]") {
				doneSeen = true;
				return;
			}
			let chunk: OpenAIChat.Chunk;
			try {
				chunk = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (!chunk || typeof chunk !== "object") return; // e.g. `data: null`

			if (!started) {
				messageId = chunk.id ?? messageId;
				if (chunk.created) createdAt = chunk.created;
				const baseResponse = {
					id: messageId, object: "response" as const, created_at: createdAt,
					status: "in_progress", model: modelName, output: [] as Responses.OutputItem[],
				};
				emit(makeResponsesSSE(nextSeq, "response.created", { type: "response.created", response: baseResponse }));
				emit(makeResponsesSSE(nextSeq, "response.in_progress", { type: "response.in_progress", response: baseResponse }));
				started = true;
			}

			// An upstream error fails the response instead of completing it.
			if (chunk.error) {
				failed = true;
				const error = typeof chunk.error === "string" ? { message: chunk.error } : chunk.error;
				const code = error.code ?? error.type ?? "server_error";
				const message = error.message ?? "Upstream error";
				emit(makeResponsesSSE(nextSeq, "error", { type: "error", code, message, param: null }));
				emit(makeResponsesSSE(nextSeq, "response.failed", {
					type: "response.failed",
					response: {
						id: messageId, object: "response", created_at: createdAt, status: "failed", model: modelName,
						output: [], error: { code, message },
						usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
					},
				}));
				return;
			}

			if (!chunk.choices || chunk.choices.length === 0) {
				if (chunk.usage) {
					inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
					outputTokens = chunk.usage.completion_tokens ?? outputTokens;
				}
				return;
			}

			const choice = chunk.choices[0];
			if (!choice) return;
			const delta = choice.delta ?? {};

			// ---- text content ----
			if (typeof delta.content === "string" && delta.content.length > 0) {
				if (!textOpen) {
					textOutputIndex = nextOutputIndex++;
					textItemId = `msg_${messageId}`;
					emit(makeResponsesSSE(nextSeq, "response.output_item.added", {
						type: "response.output_item.added", output_index: textOutputIndex,
						item: { type: "message", id: textItemId, role: "assistant", status: "in_progress", content: [] },
					}));
					emit(makeResponsesSSE(nextSeq, "response.content_part.added", {
						type: "response.content_part.added", output_index: textOutputIndex, content_index: 0, item_id: textItemId,
						part: { type: "output_text", text: "", annotations: [] },
					}));
					textOpen = true;
				}
				outputText += delta.content;
				emit(makeResponsesSSE(nextSeq, "response.output_text.delta", {
					type: "response.output_text.delta", output_index: textOutputIndex, content_index: 0, item_id: textItemId, delta: delta.content,
				}));
			}

			// ---- tool calls ----
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const oaiIdx = tc.index ?? 0;
					let ti = toolItems.get(oaiIdx);
					if (!ti) {
						closeText(emit);
						const outputIndex = nextOutputIndex++;
						const callId = tc.id ?? `call_${oaiIdx}`;
						const itemId = `fc_${callId}`;
						const name = tc.function?.name ?? "";
						ti = { outputIndex, itemId, callId, name, args: "" };
						toolItems.set(oaiIdx, ti);
						emit(makeResponsesSSE(nextSeq, "response.output_item.added", {
							type: "response.output_item.added", output_index: outputIndex,
							item: { type: "function_call", id: itemId, call_id: callId, name, arguments: "", status: "in_progress" },
						}));
					}
					if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
						ti.args += tc.function.arguments;
						emit(makeResponsesSSE(nextSeq, "response.function_call_arguments.delta", {
							type: "response.function_call_arguments.delta", output_index: ti.outputIndex, item_id: ti.itemId, delta: tc.function.arguments,
						}));
					}
				}
			}

			if (chunk.usage) {
				inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
				outputTokens = chunk.usage.completion_tokens ?? outputTokens;
			}

			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
				closeText(emit);
				closeToolItems(emit);
			}
		},
		onEnd(emit) {
			if (!started || failed) return;
			closeText(emit);
			closeToolItems(emit);

			const status = openAIFinishReasonToResponseStatus(finishReason);
			const completedResponse: Responses.Response = {
				id: messageId,
				object: "response",
				created_at: createdAt,
				status,
				model: modelName,
				output: buildOutput(),
				output_text: outputText,
				usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
				...(status === "incomplete"
					? { incomplete_details: { reason: openAIFinishReasonToIncompleteReason(finishReason) } }
					: {}),
			};
			emit(makeResponsesSSE(nextSeq, "response.completed", { type: "response.completed", response: completedResponse }));
		},
	});
}

/**
 * Passthrough transform for a native Anthropic SSE stream that only
 * rewrites the `model` field inside the `message_start` event (and any
 * other event carrying `message.model`) to the user-facing model name.
 *
 * All other events — including `ping`, `content_block_*`, `message_delta`,
 * `message_stop`, and `error` — are forwarded verbatim.
 */
export function anthropicSseModelRewrite(
	modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
	return createSSETransform({
		onEvent(ev, emit) {
			let outData = ev.data;
			if (ev.data && ev.data !== "[DONE]") {
				try {
					const parsed = JSON.parse(ev.data);
					if (parsed && parsed.message && typeof parsed.message.model === "string") {
						parsed.message.model = modelName;
						outData = JSON.stringify(parsed);
					}
				} catch {
					// Not JSON (e.g. a raw keep-alive payload) — pass through.
				}
			}
			let out = "";
			if (ev.event !== null) out += `event: ${ev.event}\n`;
			out += `data: ${outData}\n\n`;
			emit(out);
		},
	});
}