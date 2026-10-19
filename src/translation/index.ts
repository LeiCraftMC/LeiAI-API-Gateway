/**
 * Public surface of the API-format translation layer.
 *
 * Backends speak OpenAI chat-completions, or — for providers configured with
 * `supportsOpenAILikeAPI: false` — only the Anthropic Messages API.  This
 * module lets a client address the gateway in either dialect (or via the
 * OpenAI Responses API) by translating the request into the backend's
 * dialect and the response back.
 */

export type { OpenAIChat, Anthropic, Responses } from "./types";

export {
	ANTHROPIC_API_VERSION,
	DEFAULT_ANTHROPIC_MAX_TOKENS,
	JSON_RESPONSE_TOOL,
	TranslationError,
	anthropicRequestToOpenAIChat,
	openAIChatResponseToAnthropic,
	openAIFinishReasonToAnthropic,
	openAIChatRequestToAnthropic,
	wantsJsonResponse,
	anthropicResponseToOpenAIChat,
	anthropicStopReasonToOpenAI,
	anthropicErrorToOpenAI,
} from "./chatAnthropic";
export type { AnthropicToChatOptions } from "./chatAnthropic";

export {
	responsesRequestToOpenAIChat,
	openAIChatResponseToResponses,
} from "./responses";

export {
	openaiChatSseToAnthropicSse,
	anthropicSseToOpenaiChatSse,
	anthropicSseModelRewrite,
	openaiChatSseToResponsesSse,
} from "./sse";
