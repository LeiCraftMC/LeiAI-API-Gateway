/**
 * Translation between the **Anthropic Messages** client API and the
 * **OpenAI Chat Completions** backend API.
 *
 * Per the gateway's design, backends always speak OpenAI chat-completions.
 * A client may, however, address the gateway using the Anthropic Messages
 * API (`POST /v1/messages`).  This module performs the translation needed
 * for that case — in both directions of a single request/response round
 * trip:
 *
 *  - {@link anthropicRequestToOpenAIChat}  — rewrite an Anthropic-style
 *    *request* body into an OpenAI chat-completions request body.
 *  - {@link openAIChatResponseToAnthropic} — rewrite an OpenAI
 *    chat-completions *response* body back into an Anthropic Messages
 *    response.
 *
 * Streaming responses are handled by the SSE converters in `sse/`.
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
 *    one OpenAI `tool` message per block.
 *  - **Tool calls**:  Anthropic `tool_use` blocks (with `input` as an
 *    *object*) ↔ OpenAI `tool_calls` (with `function.arguments` as a JSON
 *    *string*).
 *  - **max_tokens**:  Anthropic requires it; OpenAI accepts it.  Passed
 *    through unchanged.
 *  - **Tools schema**:  Anthropic `input_schema` ↔ OpenAI
 *    `function.parameters` (identical JSON-Schema shape, different key).
 */

import type { OpenAIChat, Anthropic } from "./types";

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