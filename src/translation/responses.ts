/**
 * Translation between the **OpenAI Responses** client API
 * (`POST /v1/responses`) and the **OpenAI Chat Completions** backend API.
 *
 * Backends always speak chat-completions, so a Responses-style client request
 * is translated into a chat-completions request before forwarding, and the
 * chat-completions response is translated back into a Responses object.
 * Streaming is handled by {@link openaiChatSseToResponsesSse} in `sse.ts`.
 *
 * Key structural differences reconciled here:
 *
 *  - **Input**:  Responses uses a top-level `input` (a string or an array of
 *    items: messages, `function_call`s, `function_call_output`s) plus an
 *    optional `instructions` (system prompt).  These map to chat-completions
 *    `messages` (with `instructions` → a leading `system` message).
 *  - **Tools**:  Responses function tools put `name`/`description`/
 *    `parameters` at the top level; chat-completions nests them under
 *    `function`.
 *  - **max_output_tokens** → `max_tokens`.
 *  - **Response output**:  chat `choices[0].message` (text + `tool_calls`)
 *    → Responses `output` items (`message` with `output_text` parts and
 *    `function_call` items) plus the convenience `output_text` field.
 */

import type { OpenAIChat, Responses } from "./types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function safeParseJSON(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Extract a plain-text system prompt from a Responses `instructions` value. */
function instructionsToText(instructions: Responses.Request["instructions"]): string {
	if (instructions == null) return "";
	if (typeof instructions === "string") return instructions;
	// Array of input items — gather text from message items.
	let text = "";
	for (const item of instructions) {
		if (typeof item !== "object" || item === null) continue;
		const it = item as Responses.InputMessageItem;
		if (it.type === "message") {
			if (typeof it.content === "string") text += it.content;
			else if (Array.isArray(it.content)) {
				for (const part of it.content) {
					if (part.type === "input_text" || part.type === "output_text") text += part.text;
				}
			}
		}
	}
	return text;
}

/** Convert a Responses input content part into an OpenAI chat content part. */
function responsesContentPartToOpenAI(
	part: Responses.InputContentPart,
): OpenAIChat.ContentPart | null {
	// `InputContentPart` carries a permissive index-signature member; narrow
	// to a concrete shape once the `type` is known.
	const p = part as { type: string; text?: string; image_url?: string };
	if (p.type === "input_text" || p.type === "output_text") {
		return { type: "text", text: p.text ?? "" };
	}
	if (p.type === "input_image") {
		return { type: "image_url", image_url: { url: p.image_url ?? "" } };
	}
	return null;
}

export function openAIFinishReasonToResponseStatus(reason: string | null): string {
	if (reason === "length") return "incomplete";
	if (reason === "content_filter") return "incomplete";
	return "completed";
}

/* ------------------------------------------------------------------ */
/*  Tools / tool-choice                                               */
/* ------------------------------------------------------------------ */

function responsesToolsToOpenAI(
	tools: Responses.Request["tools"],
): OpenAIChat.Tool[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const out: OpenAIChat.Tool[] = [];
	for (const tool of tools) {
		if (typeof tool !== "object" || tool === null) continue;
		const t = tool as { type?: string; name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
		// Only function tools have a chat-completions equivalent; built-in
		// tools (web_search, file_search, code_interpreter, ...) are dropped.
		if (t.type === "function" && t.name) {
			out.push({
				type: "function",
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters ?? { type: "object", properties: {} },
					...(t.strict !== undefined ? { strict: t.strict } : {}),
				},
			});
		}
	}
	return out.length > 0 ? out : undefined;
}

function responsesToolChoiceToOpenAI(
	choice: Responses.Request["tool_choice"],
): OpenAIChat.Request["tool_choice"] {
	if (choice == null) return undefined;
	if (typeof choice === "string") {
		return choice === "auto" || choice === "none" || choice === "required" ? choice : undefined;
	}
	const c = choice as { type?: string; name?: string; function?: { name?: string } };
	if (c.type === "function") {
		const name = c.function?.name ?? c.name;
		return name ? { type: "function", function: { name } } : "auto";
	}
	if (c.type === "auto") return "auto";
	if (c.type === "none") return "none";
	if (c.type === "required") return "required";
	return undefined;
}

/* ================================================================== */
/*  REQUEST  —  Responses  ->  OpenAI Chat                             */
/* ================================================================== */

export function responsesRequestToOpenAIChat(
	req: Responses.Request,
): OpenAIChat.Request {
	const messages: OpenAIChat.Message[] = [];

	// 1. Instructions → system message.
	const systemText = instructionsToText(req.instructions);
	if (systemText.length > 0) {
		messages.push({ role: "system", content: systemText });
	}

	// 2. input → messages.
	if (typeof req.input === "string") {
		messages.push({ role: "user", content: req.input });
	} else if (Array.isArray(req.input)) {
		for (const raw of req.input) {
			if (typeof raw !== "object" || raw === null) continue;
			const item = raw as Responses.InputItem;

			if (item.type === "message") {
				const msg = item as Responses.InputMessageItem;
				const role = msg.role === "developer" || msg.role === "system" ? "system" : msg.role;
				let content: string | OpenAIChat.ContentPart[] | null;
				if (typeof msg.content === "string") {
					content = msg.content;
				} else if (Array.isArray(msg.content)) {
					const parts = (msg.content as Responses.InputContentPart[])
						.map(responsesContentPartToOpenAI)
						.filter((p): p is OpenAIChat.ContentPart => p !== null);
					content = parts.length > 0 ? parts : "";
				} else {
					content = "";
				}
				messages.push({ role: role as OpenAIChat.Message["role"], content });
			} else if (item.type === "function_call") {
				// An assistant tool call recorded in the conversation history.
				const fc = item as Responses.FunctionCallItem;
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [{
						id: fc.call_id,
						type: "function",
						function: { name: fc.name, arguments: fc.arguments ?? "" },
					}],
				});
			} else if (item.type === "function_call_output") {
				const fco = item as Responses.FunctionCallOutputItem;
				messages.push({
					role: "tool",
					tool_call_id: fco.call_id,
					content: typeof fco.output === "string" ? fco.output : JSON.stringify(fco.output ?? ""),
				});
			}
		}
	}

	const out: OpenAIChat.Request = {
		model: req.model,
		messages,
		stream: req.stream ?? false,
	};

	if (req.max_output_tokens !== undefined) out.max_tokens = req.max_output_tokens;
	if (req.temperature !== undefined) out.temperature = req.temperature;
	if (req.top_p !== undefined) out.top_p = req.top_p;

	const tools = responsesToolsToOpenAI(req.tools);
	if (tools) out.tools = tools;
	const toolChoice = responsesToolChoiceToOpenAI(req.tool_choice);
	if (toolChoice) out.tool_choice = toolChoice;

	return out;
}

/* ================================================================== */
/*  RESPONSE (non-streaming)  —  OpenAI Chat  ->  Responses            */
/* ================================================================== */

export function openAIChatResponseToResponses(
	resp: OpenAIChat.Response,
): Responses.Response {
	const choice = resp.choices?.[0];
	const output: Responses.OutputItem[] = [];
	let outputText = "";

	if (choice?.message?.content) {
		outputText = choice.message.content;
		output.push({
			type: "message",
			id: `msg_${resp.id}`,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: outputText, annotations: [] }],
		});
	}

	if (choice?.message?.tool_calls) {
		for (const call of choice.message.tool_calls) {
			output.push({
				type: "function_call",
				id: `fc_${call.id}`,
				call_id: call.id,
				name: call.function.name,
				arguments: call.function.arguments,
				status: "completed",
			});
		}
	}

	const status = openAIFinishReasonToResponseStatus(choice?.finish_reason ?? null);
	const response: Responses.Response = {
		id: resp.id,
		object: "response",
		created_at: resp.created ?? Math.floor(Date.now() / 1000),
		status,
		model: resp.model,
		output,
		output_text: outputText,
		usage: {
			input_tokens: resp.usage?.prompt_tokens ?? 0,
			output_tokens: resp.usage?.completion_tokens ?? 0,
			total_tokens: resp.usage?.total_tokens ?? (resp.usage?.prompt_tokens ?? 0) + (resp.usage?.completion_tokens ?? 0),
		},
	};

	if (status === "incomplete") {
		response.incomplete_details = { reason: "max_output_tokens" };
	}

	return response;
}

// re-export for the SSE converter to reuse
export { safeParseJSON };