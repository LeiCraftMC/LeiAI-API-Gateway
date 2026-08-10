/**
 * Public surface of the API-format translation layer.
 *
 * Backends always speak OpenAI chat-completions.  This module lets a
 * client address the gateway using the Anthropic Messages API by
 * translating the request to chat-completions and the response back.
 */

export type { OpenAIChat, Anthropic, Responses } from "./types";

export {
	anthropicRequestToOpenAIChat,
	openAIChatResponseToAnthropic,
	openAIFinishReasonToAnthropic,
} from "./chatAnthropic";

export {
	responsesRequestToOpenAIChat,
	openAIChatResponseToResponses,
} from "./responses";

export {
	openaiChatSseToAnthropicSse,
	anthropicSseModelRewrite,
	openaiChatSseToResponsesSse,
} from "./sse";