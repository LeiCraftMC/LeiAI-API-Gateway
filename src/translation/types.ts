/**
 * Type definitions for the three API dialects the gateway translates between:
 *
 *  - **OpenAI Chat Completions**  (`POST /v1/chat/completions`)
 *  - **Anthropic Messages**      (`POST /v1/messages`)
 *  - **OpenAI Responses**        (`POST /v1/responses`)
 *
 * The shapes here are intentionally permissive: every interface carries an
 * index signature so that fields the gateway does not understand are
 * preserved verbatim through translation (passthrough-friendly).  Only the
 * fields the converters actually read or write are spelled out.
 */

/* =====================================================================
 *  OpenAI Chat Completions
 * ===================================================================== */

export namespace OpenAIChat {
	export interface Tool {
		type: "function";
		function: {
			name: string;
			description?: string;
			parameters?: Record<string, unknown>;
			strict?: boolean;
		};
	}

	export interface ToolCall {
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}

	/** Partial tool call as it appears in a streaming `delta`. */
	export interface ToolCallDelta {
		index: number;
		id?: string;
		type?: "function";
		function: { name?: string; arguments?: string };
	}

	export type ContentPart =
		| { type: "text"; text: string }
		| { type: "image_url"; image_url: { url: string; detail?: string } };

	export interface Message {
		role: "system" | "user" | "assistant" | "tool";
		/** `null` is valid for assistant messages that only contain tool calls. */
		content?: string | ContentPart[] | null;
		tool_calls?: ToolCall[];
		/** Set on `tool` role messages. */
		tool_call_id?: string;
		name?: string;
		[key: string]: unknown;
	}

	export interface Request {
		model: string;
		messages: Message[];
		max_tokens?: number;
		max_completion_tokens?: number;
		temperature?: number;
		top_p?: number;
		stream?: boolean;
		stream_options?: { include_usage?: boolean };
		stop?: string | string[];
		tools?: Tool[];
		tool_choice?:
			| "auto"
			| "none"
			| "required"
			| { type: "function"; function: { name: string } };
		user?: string;
		[key: string]: unknown;
	}

	export interface ResponseUsage {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	}

	export interface Choice {
		index: number;
		message: {
			role: "assistant";
			content: string | null;
			tool_calls?: ToolCall[];
			refusal?: string;
		};
		finish_reason: string | null;
	}

	export interface Response {
		id: string;
		object: "chat.completion";
		created: number;
		model: string;
		choices: Choice[];
		usage?: ResponseUsage;
		[key: string]: unknown;
	}

	/** A single streaming chunk. */
	export interface ChunkChoice {
		index: number;
		delta: {
			role?: string;
			content?: string;
			tool_calls?: ToolCallDelta[];
			refusal?: string;
		};
		finish_reason: string | null;
	}

	export interface Chunk {
		id: string;
		object: "chat.completion.chunk";
		created?: number;
		model: string;
		choices: ChunkChoice[];
		usage?: ResponseUsage;
		[key: string]: unknown;
	}
}

/* =====================================================================
 *  Anthropic Messages
 * ===================================================================== */

export namespace Anthropic {
	export interface TextBlock {
		type: "text";
		text: string;
	}

	export interface ImageBlock {
		type: "image";
		source: {
			type: "base64" | "url";
			media_type?: string;
			data?: string;
			url?: string;
		};
	}

	export interface ToolUseBlock {
		type: "tool_use";
		id: string;
		name: string;
		input: Record<string, unknown>;
	}

	export interface ToolResultBlock {
		type: "tool_result";
		tool_use_id: string;
		content?: string | ContentBlock[];
		is_error?: boolean;
	}

	export type ContentBlock =
		| TextBlock
		| ImageBlock
		| ToolUseBlock
		| ToolResultBlock;

	export interface Message {
		role: "user" | "assistant";
		content: string | ContentBlock[];
	}

	export interface Tool {
		name: string;
		description?: string;
		input_schema?: Record<string, unknown>;
	}

	export interface Request {
		model: string;
		messages: Message[];
		max_tokens: number;
		system?: string | TextBlock[];
		temperature?: number;
		top_p?: number;
		top_k?: number;
		stream?: boolean;
		stop_sequences?: string[];
		tools?: Tool[];
		tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
		thinking?: unknown;
		[key: string]: unknown;
	}

	export interface Usage {
		input_tokens: number;
		output_tokens: number;
		[key: string]: unknown;
	}

	export interface Response {
		id: string;
		type: "message";
		role: "assistant";
		model: string;
		content: ContentBlock[];
		stop_reason: string | null;
		stop_sequence: string | null;
		usage: Usage;
		[key: string]: unknown;
	}
}

/* =====================================================================
 *  OpenAI Responses
 * ===================================================================== */

export namespace Responses {
	export type InputContentPart =
		| { type: "input_text"; text: string }
		| { type: "output_text"; text: string }
		| { type: "input_image"; image_url: string }
		| { type: "input_file"; filename?: string; file_data: string }
		| { [k: string]: unknown };

	export interface InputMessageItem {
		type: "message";
		role: "user" | "assistant" | "system" | "developer";
		content: string | InputContentPart[];
	}

	export interface FunctionCallItem {
		type: "function_call";
		id?: string;
		call_id: string;
		name: string;
		arguments: string;
		[key: string]: unknown;
	}

	export interface FunctionCallOutputItem {
		type: "function_call_output";
		id?: string;
		call_id: string;
		output: string;
		[key: string]: unknown;
	}

	export type InputItem = InputMessageItem | FunctionCallItem | FunctionCallOutputItem | { [k: string]: unknown };

	export interface Request {
		model: string;
		input: string | InputItem[];
		instructions?: string | InputItem[];
		stream?: boolean;
		max_output_tokens?: number;
		temperature?: number;
		top_p?: number;
		tools?: unknown[];
		tool_choice?: unknown;
		previous_response_id?: string;
		reasoning?: unknown;
		[key: string]: unknown;
	}

	export interface OutputTextPart {
		type: "output_text";
		text: string;
		annotations?: unknown[];
	}

	export interface OutputMessageItem {
		type: "message";
		id: string;
		role: "assistant";
		status: string;
		content: OutputTextPart[];
		[key: string]: unknown;
	}

	export type OutputItem = OutputMessageItem | FunctionCallItem | { [k: string]: unknown };

	export interface ResponseUsage {
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
		[key: string]: unknown;
	}

	export interface Response {
		id: string;
		object: "response";
		created_at: number;
		status: string;
		model: string;
		output: OutputItem[];
		output_text?: string;
		usage?: ResponseUsage;
		instructions?: unknown;
		temperature?: number | null;
		top_p?: number | null;
		tools?: unknown[];
		[key: string]: unknown;
	}
}