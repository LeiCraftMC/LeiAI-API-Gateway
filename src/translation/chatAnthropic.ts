/**
 * Translation between the **Anthropic Messages** API and the **OpenAI Chat
 * Completions** API, for both ways a client and a backend can disagree:
 *
 *  - An Anthropic-style client (`POST /v1/messages`) on a provider whose
 *    backends only speak chat-completions:
 *    - {@link anthropicRequestToOpenAIChat}  — rewrite an Anthropic-style
 *      *request* body into an OpenAI chat-completions request body.
 *    - {@link openAIChatResponseToAnthropic} — rewrite an OpenAI
 *      chat-completions *response* body back into an Anthropic Messages
 *      response.
 *
 *  - An OpenAI-style client (`POST /v1/chat/completions`, and
 *    `/v1/responses` by way of chat-completions) on a provider whose
 *    backends only speak the Anthropic Messages API
 *    (`supportsOpenAILikeAPI: false`):
 *    - {@link openAIChatRequestToAnthropic}  — the reverse request rewrite.
 *    - {@link anthropicResponseToOpenAIChat} — the reverse response rewrite.
 *
 * Streaming responses are handled by the SSE converters in `sse.ts`.
 *
 * The two dialects differ in a handful of structural ways this module
 * reconciles:
 *
 *  - **System prompt**:  Anthropic puts it in the top-level `system` field;
 *    OpenAI puts it in a `system` role *message* (prepended to `messages`).
 *  - **Tool results**:  Anthropic models them as `tool_result` content
 *    blocks inside a `user` message; OpenAI models them as `role: "tool"`
 *    messages (one per call, carrying `tool_call_id`).  A single Anthropic
 *    `user` turn containing `tool_result` blocks is therefore expanded into
 *    one OpenAI `tool` message per block — and, in the other direction,
 *    consecutive `tool` messages are merged into one `user` turn.
 *  - **Tool calls**:  Anthropic `tool_use` blocks (with `input` as an
 *    *object*) ↔ OpenAI `tool_calls` (with `function.arguments` as a JSON
 *    *string*).
 *  - **max_tokens**:  Anthropic requires it; OpenAI treats it as optional,
 *    so an OpenAI request without a limit gets
 *    {@link DEFAULT_ANTHROPIC_MAX_TOKENS}.
 *  - **Tools schema**:  Anthropic `input_schema` ↔ OpenAI
 *    `function.parameters` (identical JSON-Schema shape, different key).
 */

import type { OpenAIChat, Anthropic } from "./types";

/** The Anthropic API version the gateway speaks to Anthropic backends, sent
 *  as the `anthropic-version` header whenever the client did not pick one. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** `max_tokens` for translated requests that set no limit: Anthropic
 *  requires the field, OpenAI treats it as optional.  4096 is within the
 *  output limit of every Claude model. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function safeParseJSON(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: { value: parsed };
	} catch {
		return {};
	}
}

/** Convert an Anthropic image block into an OpenAI `image_url` content part. */
function anthropicImageToOpenAI(
	source: Anthropic.ImageBlock["source"],
): OpenAIChat.ContentPart {
	if (source.type === "base64") {
		const data = source.data ?? "";
		const mediaType = source.media_type ?? "image/png";
		return {
			type: "image_url",
			image_url: { url: `data:${mediaType};base64,${data}` },
		};
	}
	return { type: "image_url", image_url: { url: source.url ?? "" } };
}

function anthropicToolsToOpenAI(
	tools: Anthropic.Tool[] | undefined,
): OpenAIChat.Tool[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((t) => ({
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: t.input_schema ?? { type: "object", properties: {} },
		},
	}));
}

function anthropicToolChoiceToOpenAI(
	choice: Anthropic.Request["tool_choice"],
): OpenAIChat.Request["tool_choice"] {
	if (!choice) return undefined;
	switch (choice.type) {
		case "auto":
			return "auto";
		case "none":
			return "none";
		case "any":
			return "required";
		case "tool":
			return choice.name ? { type: "function", function: { name: choice.name } } : "auto";
		default:
			return undefined;
	}
}

export function openAIFinishReasonToAnthropic(reason: string | null): string | null {
	if (!reason) return null;
	switch (reason) {
		case "stop":
			return "end_turn";
		case "tool_calls":
		case "function_call":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "content_filter":
			return "end_turn";
		default:
			return "end_turn";
	}
}

/* ================================================================== */
/*  REQUEST  —  Anthropic Messages  ->  OpenAI Chat                    */
/* ================================================================== */

export function anthropicRequestToOpenAIChat(
	req: Anthropic.Request,
): OpenAIChat.Request {
	const messages: OpenAIChat.Message[] = [];

	// 1. System prompt → a leading system message.
	if (req.system !== undefined) {
		const systemText = typeof req.system === "string"
			? req.system
			: req.system.map((b) => b.text).join("\n\n");
		if (systemText.length > 0) {
			messages.push({ role: "system", content: systemText });
		}
	}

	// 2. Convert each Anthropic message.
	for (const msg of req.messages) {
		const blocks: Anthropic.ContentBlock[] = Array.isArray(msg.content)
			? msg.content
			: [{ type: "text", text: msg.content }];

		if (msg.role === "assistant") {
			messages.push(anthropicAssistantToOpenAI(blocks));
		} else {
			// User message: split tool_result blocks (→ tool messages) from
			// the rest (→ a user message).
			anthropicUserToOpenAI(blocks, messages);
		}
	}

	const out: OpenAIChat.Request = {
		model: req.model,
		messages,
		stream: req.stream ?? false,
	};

	if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
	if (req.temperature !== undefined) out.temperature = req.temperature;
	if (req.top_p !== undefined) out.top_p = req.top_p;
	if (req.stop_sequences && req.stop_sequences.length > 0) out.stop = req.stop_sequences;

	const tools = anthropicToolsToOpenAI(req.tools);
	if (tools) out.tools = tools;
	const toolChoice = anthropicToolChoiceToOpenAI(req.tool_choice);
	if (toolChoice) out.tool_choice = toolChoice;

	return out;
}

function anthropicAssistantToOpenAI(
	blocks: Anthropic.ContentBlock[],
): OpenAIChat.Message {
	let text = "";
	const toolCalls: OpenAIChat.ToolCall[] = [];

	for (const block of blocks) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "tool_use") {
			toolCalls.push({
				id: block.id,
				type: "function",
				function: {
					name: block.name,
					arguments: JSON.stringify(block.input ?? {}),
				},
			});
		}
	}

	const message: OpenAIChat.Message = {
		role: "assistant",
		content: text.length > 0 ? text : null,
	};
	if (toolCalls.length > 0) message.tool_calls = toolCalls;
	return message;
}

function anthropicUserToOpenAI(
	blocks: Anthropic.ContentBlock[],
	messages: OpenAIChat.Message[],
): void {
	const toolResults: OpenAIChat.Message[] = [];
	const contentParts: OpenAIChat.ContentPart[] = [];
	let hasText = false;
	let textAccumulator = "";

	for (const block of blocks) {
		if (block.type === "tool_result") {
			const resultText =
				typeof block.content === "string"
					? block.content
					: Array.isArray(block.content)
						? block.content
								.filter((b) => b.type === "text")
								.map((b) => (b as Anthropic.TextBlock).text)
								.join("")
						: "";
			toolResults.push({
				role: "tool",
				tool_call_id: block.tool_use_id,
				content: resultText,
			});
		} else if (block.type === "text") {
			textAccumulator += block.text;
			hasText = true;
		} else if (block.type === "image") {
			contentParts.push(anthropicImageToOpenAI(block.source));
		}
	}

	// Emit tool-result messages first (they follow the assistant tool_use).
	messages.push(...toolResults);

	if (contentParts.length > 0) {
		// Combine any accumulated text with the image parts.
		if (hasText) {
			contentParts.unshift({ type: "text", text: textAccumulator });
		}
		messages.push({ role: "user", content: contentParts });
	} else if (hasText) {
		messages.push({ role: "user", content: textAccumulator });
	}
}

/* ================================================================== */
/*  RESPONSE (non-streaming)  —  OpenAI Chat  ->  Anthropic            */
/* ================================================================== */

export function openAIChatResponseToAnthropic(
	resp: OpenAIChat.Response,
): Anthropic.Response {
	const choice = resp.choices?.[0];
	const content: Anthropic.ContentBlock[] = [];

	const text = choice?.message?.content;
	if (typeof text === "string" && text.length > 0) {
		content.push({ type: "text", text });
	}

	if (choice?.message?.tool_calls) {
		for (const call of choice.message.tool_calls) {
			content.push({
				type: "tool_use",
				id: call.id,
				name: call.function.name,
				input: safeParseJSON(call.function.arguments ?? ""),
			});
		}
	}

	const promptTokens = resp.usage?.prompt_tokens ?? 0;
	const completionTokens = resp.usage?.completion_tokens ?? 0;

	return {
		id: resp.id,
		type: "message",
		role: "assistant",
		model: resp.model,
		content,
		stop_reason: openAIFinishReasonToAnthropic(choice?.finish_reason ?? null),
		stop_sequence: null,
		usage: {
			input_tokens: promptTokens,
			output_tokens: completionTokens,
		},
	};
}

/* ================================================================== */
/*  REQUEST  —  OpenAI Chat  ->  Anthropic Messages                    */
/* ================================================================== */

/**
 * A client request that cannot be translated for an Anthropic backend
 * without changing its meaning (e.g. `n > 1`, audio input).  The routes
 * answer it with a 400 instead of forwarding a silently altered request.
 */
export class TranslationError extends Error {}

/** Name of the tool through which a JSON answer (OpenAI `response_format`)
 *  is requested, since Anthropic has no response-format option. */
export const JSON_RESPONSE_TOOL = "json_response";

/** Anthropic rejects text blocks that are empty or whitespace-only. */
function hasText(text: string | undefined): text is string {
	return typeof text === "string" && text.trim().length > 0;
}

/** Flatten OpenAI message content (a string or content parts) to text. */
function openAIContentToText(content: OpenAIChat.Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

/** Split a base64 `data:` URL into its lower-cased media type (parameters
 *  dropped) and its payload; `null` for anything else. */
function parseBase64DataUrl(url: string): { mediaType: string; data: string } | null {
	const comma = url.indexOf(",");
	if (!/^data:/i.test(url) || comma === -1) return null;
	const [mediaType = "", ...params] = url.slice("data:".length, comma).split(";");
	if (!params.some((p) => p.trim().toLowerCase() === "base64")) return null;
	return { mediaType: mediaType.trim().toLowerCase(), data: url.slice(comma + 1) };
}

/** Convert an OpenAI `image_url` (a remote URL or a base64 `data:` URL)
 *  into an Anthropic image block. */
function openAIImageToAnthropic(url: string): Anthropic.ImageBlock {
	if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
	const dataUrl = parseBase64DataUrl(url);
	if (!dataUrl) throw new TranslationError("Images must be http(s) URLs or base64 data URLs");
	return {
		type: "image",
		source: {
			type: "base64",
			// `image/jpg` is a common spelling Anthropic does not accept.
			media_type: dataUrl.mediaType === "image/jpg" ? "image/jpeg" : dataUrl.mediaType,
			data: dataUrl.data,
		},
	};
}

/** Convert an OpenAI `file` part into an Anthropic document block; only
 *  inline (base64) PDFs have an equivalent. */
function openAIFileToAnthropic(file: { file_data?: string } | undefined): Anthropic.DocumentBlock {
	const dataUrl = parseBase64DataUrl(file?.file_data ?? "");
	if (dataUrl?.mediaType !== "application/pdf") {
		throw new TranslationError("Only files given inline as base64 PDFs are supported for this model");
	}
	return { type: "document", source: { type: "base64", media_type: "application/pdf", data: dataUrl.data } };
}

/** Anthropic requires tool-use ids to match `^[a-zA-Z0-9_-]+$`, OpenAI ids
 *  are free-form.  Applied to both `tool_use` ids and `tool_result`
 *  references so the pairs keep matching. */
function toAnthropicToolUseId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function openAIUserContentToAnthropic(
	content: OpenAIChat.Message["content"],
): Anthropic.ContentBlock[] {
	if (typeof content === "string") {
		return hasText(content) ? [{ type: "text", text: content }] : [];
	}
	const blocks: Anthropic.ContentBlock[] = [];
	for (const part of Array.isArray(content) ? content : []) {
		if (part.type === "text") {
			if (hasText(part.text)) blocks.push({ type: "text", text: part.text });
		} else if (part.type === "image_url") {
			blocks.push(openAIImageToAnthropic(part.image_url?.url ?? ""));
		} else if (part.type === "file") {
			blocks.push(openAIFileToAnthropic(part.file));
		} else {
			// e.g. `input_audio`, which Anthropic cannot take.
			const type = (part as { type?: unknown }).type;
			throw new TranslationError(`Content parts of type "${String(type)}" are not supported for this model`);
		}
	}
	return blocks;
}

function openAIAssistantToAnthropic(msg: OpenAIChat.Message): Anthropic.ContentBlock[] {
	const blocks: Anthropic.ContentBlock[] = [];
	const text = openAIContentToText(msg.content);
	if (hasText(text)) blocks.push({ type: "text", text });
	for (const call of msg.tool_calls ?? []) {
		blocks.push({
			type: "tool_use",
			id: toAnthropicToolUseId(call.id ?? ""),
			name: call.function.name,
			input: safeParseJSON(call.function.arguments ?? ""),
		});
	}
	return blocks;
}

function openAIToolsToAnthropic(
	tools: OpenAIChat.Request["tools"],
): Anthropic.Tool[] | undefined {
	if (!Array.isArray(tools)) return undefined;
	const out: Anthropic.Tool[] = [];
	for (const tool of tools) {
		// Only function tools have an Anthropic equivalent.
		if (tool?.type !== "function" || !tool.function?.name) continue;
		out.push({
			name: tool.function.name,
			description: tool.function.description,
			input_schema: tool.function.parameters ?? { type: "object", properties: {} },
		});
	}
	return out.length > 0 ? out : undefined;
}

function openAIToolChoiceToAnthropic(
	choice: OpenAIChat.Request["tool_choice"],
	parallelToolCalls: boolean | undefined,
): Anthropic.Request["tool_choice"] {
	let out: Anthropic.Request["tool_choice"];
	if (choice === "none") out = { type: "none" };
	else if (choice === "required") out = { type: "any" };
	else if (typeof choice === "object" && choice?.function?.name) out = { type: "tool", name: choice.function.name };
	else if (choice === "auto" || parallelToolCalls === false) out = { type: "auto" };

	// Anthropic has no top-level `parallel_tool_calls`; it is a flag on the
	// tool choice (which `none` does not take).
	if (out && out.type !== "none" && parallelToolCalls === false) {
		out.disable_parallel_tool_use = true;
	}
	return out;
}

/** The JSON schema of the answer an OpenAI `response_format` asks for, or
 *  `undefined` for free text. */
function responseFormatSchema(
	format: OpenAIChat.Request["response_format"],
): Record<string, unknown> | undefined {
	if (format?.type === "json_schema") return format.json_schema?.schema ?? { type: "object" };
	if (format?.type === "json_object") return { type: "object" };
	return undefined;
}

/** Whether the request asks for a JSON answer.  The Anthropic request then
 *  obtains it as a {@link JSON_RESPONSE_TOOL} call, which the response
 *  converters must turn back into message content. */
export function wantsJsonResponse(req: OpenAIChat.Request): boolean {
	return responseFormatSchema(req.response_format) !== undefined;
}

/**
 * Rewrite an OpenAI chat-completions request into an Anthropic Messages
 * request.  Anthropic rejects unknown fields, so parameters without an
 * equivalent that only tune generation (`seed`, penalties, `user`, ...) are
 * dropped.  Ones that shape the result are emulated (`response_format`,
 * via {@link JSON_RESPONSE_TOOL}) or, where that is impossible, rejected
 * with a {@link TranslationError} (`n > 1`, `logprobs`, whitespace-only
 * stop sequences, unsupported content parts).
 */
export function openAIChatRequestToAnthropic(
	req: OpenAIChat.Request,
): Anthropic.Request {
	if (typeof req.n === "number" && req.n > 1) {
		throw new TranslationError("`n` greater than 1 is not supported for this model");
	}
	if (req.logprobs === true || (typeof req.top_logprobs === "number" && req.top_logprobs > 0)) {
		throw new TranslationError("`logprobs` are not supported for this model");
	}

	const systemParts: string[] = [];
	const messages: Array<{ role: "user" | "assistant"; content: Anthropic.ContentBlock[] }> = [];

	// Anthropic expects alternating turns, with all tool results for an
	// assistant turn in the next user turn, so consecutive messages mapping
	// to the same role are merged (e.g. one OpenAI `tool` message per call).
	const push = (role: "user" | "assistant", blocks: Anthropic.ContentBlock[]) => {
		if (blocks.length === 0) return;
		const last = messages[messages.length - 1];
		if (last?.role === role) last.content.push(...blocks);
		else messages.push({ role, content: blocks });
	};

	for (const msg of req.messages ?? []) {
		switch (msg.role) {
			// Anthropic has no system role: system/developer messages are
			// hoisted into the top-level `system` prompt.
			case "system":
			case "developer": {
				const text = openAIContentToText(msg.content);
				if (hasText(text)) systemParts.push(text);
				break;
			}
			case "user":
				push("user", openAIUserContentToAnthropic(msg.content));
				break;
			case "assistant":
				push("assistant", openAIAssistantToAnthropic(msg));
				break;
			case "tool": {
				const text = openAIContentToText(msg.content);
				push("user", [{
					type: "tool_result",
					tool_use_id: toAnthropicToolUseId(msg.tool_call_id ?? ""),
					...(hasText(text) ? { content: text } : {}),
				}]);
				break;
			}
		}
	}

	// Anthropic needs at least one turn: a system-only OpenAI request is sent
	// as a single user turn instead.
	if (messages.length === 0) {
		if (systemParts.length === 0) throw new TranslationError("At least one message with content is required");
		messages.push({ role: "user", content: [{ type: "text", text: systemParts.join("\n\n") }] });
		systemParts.length = 0;
	}

	const out: Anthropic.Request = {
		model: req.model,
		// A lone text block is sent as a plain string, the simplest form.
		messages: messages.map(({ role, content }) => {
			const [only] = content;
			return { role, content: content.length === 1 && only?.type === "text" ? only.text : content };
		}),
		max_tokens: req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
		stream: req.stream ?? false,
	};

	if (systemParts.length > 0) out.system = systemParts.join("\n\n");
	// OpenAI accepts temperatures up to 2, Anthropic only up to 1.  Newer
	// Claude models reject requests that set both temperature and top_p, so
	// top_p is only sent on its own.
	if (typeof req.temperature === "number") out.temperature = Math.min(Math.max(req.temperature, 0), 1);
	else if (typeof req.top_p === "number") out.top_p = req.top_p;

	// Anthropic rejects whitespace-only stop sequences, and dropping them
	// would change where the output ends.
	const stops = typeof req.stop === "string" ? [req.stop] : Array.isArray(req.stop) ? req.stop : [];
	if (stops.some((s) => !hasText(s))) {
		throw new TranslationError("Whitespace-only stop sequences are not supported for this model");
	}
	if (stops.length > 0) out.stop_sequences = stops;

	// Anthropic only accepts a tool choice alongside tools.
	const tools = openAIToolsToAnthropic(req.tools);
	let toolChoice = tools ? openAIToolChoiceToAnthropic(req.tool_choice, req.parallel_tool_calls) : undefined;

	// A JSON answer is requested as the input of a dedicated tool.  It must
	// come through that tool unless the client forces one of its own; with
	// client tools on offer, the model may call one of those instead.
	const jsonSchema = responseFormatSchema(req.response_format);
	if (jsonSchema) {
		out.tools = [
			...(tools ?? []),
			{ name: JSON_RESPONSE_TOOL, description: "Give the final answer as JSON.", input_schema: jsonSchema },
		];
		if (toolChoice?.type !== "tool") {
			toolChoice = tools && toolChoice?.type !== "none"
				? { type: "any" }
				: { type: "tool", name: JSON_RESPONSE_TOOL };
			if (req.parallel_tool_calls === false) toolChoice.disable_parallel_tool_use = true;
		}
	} else if (tools) {
		out.tools = tools;
	}
	if (toolChoice) out.tool_choice = toolChoice;

	return out;
}

/* ================================================================== */
/*  RESPONSE (non-streaming)  —  Anthropic  ->  OpenAI Chat            */
/* ================================================================== */

export function anthropicStopReasonToOpenAI(reason: string | null | undefined): string | null {
	if (!reason) return null;
	switch (reason) {
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "tool_calls";
		case "refusal":
			return "content_filter";
		default: // end_turn, stop_sequence, pause_turn
			return "stop";
	}
}

/** Anthropic reports prompt-cache reads/writes separately from
 *  `input_tokens`; OpenAI's `prompt_tokens` includes cached tokens. */
export function anthropicUsageToOpenAI(
	usage: Partial<Anthropic.Usage> | undefined,
): OpenAIChat.ResponseUsage {
	const cacheRead = usage?.cache_read_input_tokens ?? 0;
	const promptTokens = (usage?.input_tokens ?? 0) + cacheRead + (usage?.cache_creation_input_tokens ?? 0);
	const completionTokens = usage?.output_tokens ?? 0;
	const out: OpenAIChat.ResponseUsage = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
	};
	if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
	return out;
}

/** Options for turning Anthropic responses back into chat-completions. */
export interface AnthropicToChatOptions {
	/** The request asked for a JSON answer ({@link wantsJsonResponse}), so a
	 *  {@link JSON_RESPONSE_TOOL} call is message content, not a tool call. */
	jsonResponse?: boolean;
}

export function anthropicResponseToOpenAIChat(
	resp: Anthropic.Response,
	options: AnthropicToChatOptions = {},
): OpenAIChat.Response {
	let text = "";
	let reasoning = "";
	const toolCalls: OpenAIChat.ToolCall[] = [];

	for (const block of resp.content ?? []) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "thinking") {
			reasoning += block.thinking;
		} else if (block.type === "tool_use" && options.jsonResponse && block.name === JSON_RESPONSE_TOOL) {
			text += JSON.stringify(block.input ?? {});
		} else if (block.type === "tool_use") {
			toolCalls.push({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
			});
		}
	}

	const message: OpenAIChat.Choice["message"] = {
		role: "assistant",
		// OpenAI uses `null` content for tool-call-only replies.
		content: text.length > 0 || toolCalls.length === 0 ? text : null,
	};
	if (reasoning.length > 0) message.reasoning_content = reasoning;
	if (toolCalls.length > 0) message.tool_calls = toolCalls;

	// A JSON answer arrives as a tool call but is reported as content.
	const finishReason = anthropicStopReasonToOpenAI(resp.stop_reason) ?? "stop";

	return {
		id: resp.id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: resp.model,
		choices: [{
			index: 0,
			message,
			finish_reason: finishReason === "tool_calls" && toolCalls.length === 0 ? "stop" : finishReason,
		}],
		usage: anthropicUsageToOpenAI(resp.usage),
	};
}

/** Rewrite an Anthropic error body (`{ type: "error", error: { type,
 *  message } }`) into the OpenAI error shape, or use `fallbackMessage`. */
export function anthropicErrorToOpenAI(
	body: string | undefined,
	fallbackMessage: string,
): { error: { message: string; type: string } } {
	try {
		const error = JSON.parse(body ?? "")?.error;
		if (typeof error?.message === "string") {
			return { error: { message: error.message, type: typeof error.type === "string" ? error.type : "api_error" } };
		}
	} catch {
		// Not JSON — fall back below.
	}
	return { error: { message: fallbackMessage, type: "api_error" } };
}