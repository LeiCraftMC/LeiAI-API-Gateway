import { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ProviderManager } from "../../../../loadBalancing/providerManager";
import { Logger } from "../../../../utils/logger";
import { ConfigHandler } from "../../../../utils/config";
import type { AuthContext } from "../auth";
import type { ReadableStreamReadResult } from "stream/web";
import { resolveModel } from "./openai";
import {
	ANTHROPIC_API_VERSION,
	TranslationError,
	anthropicErrorToOpenAI,
	anthropicResponseToOpenAIChat,
	anthropicSseToOpenaiChatSse,
	openAIChatRequestToAnthropic,
	responsesRequestToOpenAIChat,
	openAIChatResponseToResponses,
	openaiChatSseToResponsesSse,
} from "../../../../translation";
import type { Responses } from "../../../../translation";

export const router = new Hono();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function openaiError(
	c: Context,
	status: ContentfulStatusCode,
	message: string,
	type = "invalid_request_error",
) {
	return c.json({ error: { message, type } }, status);
}

/** Convert a non-streaming chat-completions response body into a Responses
 *  object, stamping the user-facing `model` name.  Falls back to passing the
 *  body through unchanged if it cannot be parsed. */
function convertChatResponseToResponses(text: string, modelName: string): string {
	try {
		const chatResp = JSON.parse(text);
		const responsesResp = openAIChatResponseToResponses(chatResp);
		responsesResp.model = modelName;
		return JSON.stringify(responsesResp);
	} catch {
		return text;
	}
}

/** Convert a non-streaming Anthropic Messages response body into a
 *  Responses object (by way of chat-completions), stamping the user-facing
 *  `model` name.  Anything but a message, or a body that cannot be parsed,
 *  is passed through unchanged. */
function convertAnthropicResponseToResponses(text: string, modelName: string): string {
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed?.content)) return text;
		const responsesResp = openAIChatResponseToResponses(anthropicResponseToOpenAIChat(parsed));
		responsesResp.model = modelName;
		return JSON.stringify(responsesResp);
	} catch {
		return text;
	}
}

/* ------------------------------------------------------------------ */
/*  Create Response   POST /v1/responses                               */
/* ------------------------------------------------------------------ */

router.post("/responses", async (c: Context) => {
	try {
		const authContext = c.get("auth") as AuthContext | undefined;
		if (!authContext) {
			return openaiError(c, 401, "Authentication required", "auth_error");
		}

		const bodyText = await c.req.text();

		let parsed: Responses.Request;
		try {
			parsed = JSON.parse(bodyText);
		} catch {
			return openaiError(c, 400, "Request body must be valid JSON");
		}

		const model = parsed?.model;
		if (typeof model !== "string" || model.length === 0) {
			return openaiError(c, 400, "Model is required");
		}

		// Resolve which provider handles this model.
		const resolved = resolveModel(model);
		if (!resolved) {
			return openaiError(c, 404, `Model "${model}" not found`);
		}

		const provider = ProviderManager.getProvider(resolved.providerId);
		if (!provider) {
			return openaiError(c, 503, `Provider "${resolved.providerId}" not available`, "server_error");
		}

		// Model-level access (deny / allow lists).
		if (authContext.denyModels?.includes(model)) {
			return openaiError(c, 403, `Model "${model}" is not available for your API key`, "access_error");
		}
		if (authContext.allowedModels?.length && !authContext.allowedModels.includes(model)) {
			return openaiError(c, 403, `Model "${model}" is not available for your API key`, "access_error");
		}

		// Backends speak chat-completions: translate the Responses request,
		// stamping the bare model name for the backend.  Backends that only
		// speak the Anthropic Messages API get it translated one step further.
		parsed.model = resolved.bareModel;
		const chatRequest = responsesRequestToOpenAIChat(parsed);
		const viaAnthropic = !provider.supportsOpenAILikeAPI;
		const forwardPath = viaAnthropic ? "/messages" : "/chat/completions";
		const forwardBody = JSON.stringify(
			viaAnthropic ? openAIChatRequestToAnthropic(chatRequest) : chatRequest,
		);

		const debugPrefix = `from ${resolved.providerId}/${resolved.bareModel}`;
		const requestLabel = viaAnthropic ? "Responses→Anthropic request" : "Responses→Chat request";
		if (ConfigHandler.getConfig()?.LAG_LOG_DEBUG_FULL_REQUEST) {
			Logger.debug(`${requestLabel} on "${model}" → ${debugPrefix}:\nBody: ${forwardBody}`);
		} else {
			Logger.debug(`${requestLabel} on "${model}" → ${debugPrefix}:\nTruncated Body: ${forwardBody.slice(0, 2000)}`);
		}

		const fwdHeaders: Record<string, string> = {
			"content-type": c.req.raw.headers.get("content-type") ?? "application/json",
		};
		if (viaAnthropic) fwdHeaders["anthropic-version"] = ANTHROPIC_API_VERSION;

		const result = await provider.loadBalancer.forwardRequest(
			forwardPath,
			"POST",
			fwdHeaders,
			forwardBody
		);

		const { response, error } = result;
		if (error || !response) {
			const status = (error?.status ?? 502) as ContentfulStatusCode;
			if (viaAnthropic) {
				return c.json(anthropicErrorToOpenAI(error?.body, error?.message ?? "Bad Gateway"), status);
			}
			return openaiError(c, status, error?.message ?? "Bad Gateway", "server_error");
		}

		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		const isStream = responseHeaders["content-type"]?.startsWith("text/event-stream");

		if (isStream) {
			// An Anthropic event stream is first turned into chat chunks
			// (with usage, which the Responses events report).
			let chatStream: ReadableStream<Uint8Array> = response.body!;
			if (viaAnthropic) {
				chatStream = chatStream.pipeThrough(anthropicSseToOpenaiChatSse(model, { includeUsage: true }));
			}
			let returnStream: ReadableStream<Uint8Array> = chatStream.pipeThrough(
				openaiChatSseToResponsesSse(model),
			);

			if (Logger.getLogLevel() === "debug") {
				const [clientStream, logStream] = returnStream.tee();
				returnStream = clientStream;

				(async () => {
					const reader = logStream.getReader();
					let res: ReadableStreamReadResult<Uint8Array>;
					let fullResponse = "";
					while (!(res = await reader.read()).done) {
						fullResponse += new TextDecoder().decode(res.value);
					}
					if (ConfigHandler.getConfig()?.LAG_LOG_DEBUG_FULL_RESPONSE) {
						Logger.debug(
							`Full Streaming Responses Response ${debugPrefix} → model "${model}":\n` +
							`Body: ${fullResponse}`,
						);
					} else {
						Logger.debug(
							`Streaming Responses Response ${debugPrefix} → model "${model}":\n` +
							`Truncated Body: ${fullResponse.slice(0, 2000)}`,
						);
					}
				})().catch((err) => {
					Logger.error("Error reading transformed Responses SSE stream:", err);
				});
			}

			return c.newResponse(returnStream, response.status as any, responseHeaders);
		}

		// Non-streaming response.
		const responseText = await response.text();
		const rewritten = viaAnthropic
			? convertAnthropicResponseToResponses(responseText, model)
			: convertChatResponseToResponses(responseText, model);

		if (ConfigHandler.getConfig()?.LAG_LOG_DEBUG_FULL_RESPONSE) {
			Logger.debug(
				`Full Non-Streaming Responses Response ${debugPrefix} → model "${model}":\n` +
				`Body: ${rewritten}`,
			);
		} else {
			Logger.debug(
				`Non-Streaming Responses Response ${debugPrefix} → model "${model}":\n` +
				`Truncated Body: ${rewritten.slice(0, 2000)}`,
			);
		}

		return c.newResponse(rewritten, response.status as any, responseHeaders);
	} catch (error) {
		if (error instanceof TranslationError) {
			return openaiError(c, 400, error.message);
		}
		const message = error instanceof Error ? error.message : String(error);
		Logger.error(
			`Error proxying /v1/responses:`,
			message,
			(error as Error).stack ? (error as Error).stack : "<no stack trace>",
		);
		return openaiError(c, 500, "Internal Server Error", "server_error");
	}
});