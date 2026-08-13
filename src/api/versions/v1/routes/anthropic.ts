import { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ProviderManager } from "../../../../loadBalancing/providerManager";
import { Logger } from "../../../../utils/logger";
import { ConfigHandler } from "../../../../utils/config";
import type { AuthContext } from "../auth";
import type { ReadableStreamReadResult } from "stream/web";
import { resolveModel, rewriteModelField, rewriteResponseModel } from "./openai";
import {
	anthropicRequestToOpenAIChat,
	openAIChatResponseToAnthropic,
	openaiChatSseToAnthropicSse,
	anthropicSseModelRewrite,
} from "../../../../translation";
import type { Anthropic } from "../../../../translation";

export const router = new Hono();

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function anthropicError(
	c: Context,
	status: ContentfulStatusCode,
	type: string,
	message: string,
) {
	return c.json({ type: "error", error: { type, message } }, status);
}

/**
 * Convert a non-streaming OpenAI chat-completions response body into an
 * Anthropic Messages response body, stamping the user-facing `model` name.
 * Falls back to passing the body through unchanged if it cannot be parsed.
 */
function convertChatResponseToAnthropic(text: string, modelName: string): string {
	try {
		const chatResp = JSON.parse(text);
		const anthropicResp = openAIChatResponseToAnthropic(chatResp);
		anthropicResp.model = modelName;
		return JSON.stringify(anthropicResp);
	} catch {
		return text;
	}
}

/**
 * Finalize and return a backend response to the Anthropic client.
 *
 * - On a forwarding error, map it to an Anthropic-style error.
 * - On a streaming response, pipe through `streamTransform` (which also
 *   stamps the user-facing model name) and return the stream.
 * - On a non-streaming response, apply `nonStreamBodyFn` to rewrite the
 *   body and return it.
 *
 * Debug logging mirrors the OpenAI proxy: in debug mode the stream is
 * tee'd and captured asynchronously without blocking the response.
 */
async function finalizeAnthropicResponse(
	c: Context,
	result: {
		response: Response | null;
		error: { status: number; message: string } | null;
	},
	model: string,
	debugPrefix: string,
	streamTransform: () => TransformStream<Uint8Array, Uint8Array>,
	nonStreamBodyFn: (text: string) => string,
) {
	const { response, error } = result;
	if (error || !response) {
		const status = (error?.status ?? 502) as ContentfulStatusCode;
		return anthropicError(c, status, "api_error", error?.message ?? "Bad Gateway");
	}

	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	const isStream =
		responseHeaders["content-type"]?.startsWith("text/event-stream");

	if (isStream) {
		let returnStream: ReadableStream<Uint8Array> = response.body!.pipeThrough(
			streamTransform(),
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
						`Full Streaming Anthropic Response ${debugPrefix} → model "${model}":\n` +
						`Body: ${fullResponse}`,
					);
				} else {
					Logger.debug(
						`Streaming Anthropic Response ${debugPrefix} → model "${model}":\n` +
						`Truncated Body: ${fullResponse.slice(0, 2000)}`,
					);
				}
			})().catch((err) => {
				Logger.error("Error reading transformed Anthropic SSE stream:", err);
			});
		}

		return c.newResponse(returnStream, response.status as any, responseHeaders);
	}

	// Non-streaming response.
	const responseText = await response.text();
	const rewritten = nonStreamBodyFn(responseText);

	if (ConfigHandler.getConfig()?.LAG_LOG_DEBUG_FULL_RESPONSE) {
		Logger.debug(
			`Full Non-Streaming Anthropic Response ${debugPrefix} → model "${model}":\n` +
			`Body: ${rewritten}`,
		);
	} else {
		Logger.debug(
			`Non-Streaming Anthropic Response ${debugPrefix} → model "${model}":\n` +
			`Truncated Body: ${rewritten.slice(0, 2000)}`,
		);
	}

	return c.newResponse(rewritten, response.status as any, responseHeaders);
}

/* ------------------------------------------------------------------ */
/*  Create Message   POST /v1/messages                                 */
/* ------------------------------------------------------------------ */

router.post("/messages", async (c: Context) => {
	try {
		const authContext = c.get("auth") as AuthContext | undefined;
		if (!authContext) {
			return anthropicError(c, 401, "authentication_error", "Authentication required");
		}

		const bodyText = await c.req.text();

		let parsed: Anthropic.Request;
		try {
			parsed = JSON.parse(bodyText);
		} catch {
			return anthropicError(c, 400, "invalid_request_error", "Request body must be valid JSON");
		}

		const model = parsed?.model;
		if (typeof model !== "string" || model.length === 0) {
			return anthropicError(c, 400, "invalid_request_error", "model: field is required");
		}

		// Resolve which provider handles this model.
		const resolved = resolveModel(model);
		if (!resolved) {
			return anthropicError(c, 404, "not_found_error", `Model "${model}" not found`);
		}

		const provider = ProviderManager.getProvider(resolved.providerId);
		if (!provider) {
			return anthropicError(c, 503, "api_error", `Provider "${resolved.providerId}" not available`);
		}

		// Model-level access (deny / allow lists).
		if (authContext.denyModels?.includes(model)) {
			return anthropicError(c, 403, "permission_error", `Model "${model}" is not available for your API key`);
		}
		if (authContext.allowedModels?.length && !authContext.allowedModels.includes(model)) {
			return anthropicError(c, 403, "permission_error", `Model "${model}" is not available for your API key`);
		}

		const rawRequest = c.req.raw as Request;
		const contentType = rawRequest.headers.get("content-type") ?? "application/json";
		const debugPrefix = `from ${resolved.providerId}/${resolved.bareModel}`;

		/* ---------------------------------------------------------- */
		/*  Path A — native Anthropic passthrough                     */
		/* ---------------------------------------------------------- */
		if (provider.supportsAnthropicLikeAPI) {
			const rewrittenBody = rewriteModelField(bodyText, resolved.bareModel);

			// Forward the client's anthropic-version / anthropic-beta headers
			// so the backend receives the right API version and betas.
			const fwdHeaders: Record<string, string> = { "content-type": contentType };
			const av = rawRequest.headers.get("anthropic-version");
			if (av) fwdHeaders["anthropic-version"] = av;
			const ab = rawRequest.headers.get("anthropic-beta");
			if (ab) fwdHeaders["anthropic-beta"] = ab;

			if (ConfigHandler.getConfig()?.LAG_LOG_DEBUG_FULL_REQUEST) {
				Logger.debug(`Anthropic passthrough request on "${model}" → ${debugPrefix}:\nBody: ${rewrittenBody}`);
			} else {
				Logger.debug(`Anthropic passthrough request on "${model}" → ${debugPrefix}:\nTruncated Body: ${rewrittenBody.slice(0, 2000)}`);
			}

			const result = await provider.loadBalancer.forwardRequest(
				"/messages",
				"POST",
				fwdHeaders,
				rewrittenBody
			);

			return finalizeAnthropicResponse(
				c, result, model, debugPrefix,
				() => anthropicSseModelRewrite(model),
				(text) => rewriteResponseModel(text, model),
			);
		}

		/* ---------------------------------------------------------- */
		/*  Path B — translate to OpenAI chat completions             */
		/* ---------------------------------------------------------- */
		// Stamp the bare model for the backend, then convert to a
		// chat-completions request.
		parsed.model = resolved.bareModel;
		const chatRequest = anthropicRequestToOpenAIChat(parsed);
		const chatBody = JSON.stringify(chatRequest);

		if (ConfigHandler.getConfig()?.LAG_LOG_DEBUG_FULL_REQUEST) {
			Logger.debug(`Anthropic→Chat request on "${model}" → ${debugPrefix}:\nBody: ${chatBody}`);
		} else {
			Logger.debug(`Anthropic→Chat request on "${model}" → ${debugPrefix}:\nTruncated Body: ${chatBody.slice(0, 2000)}`);
		}

		const fwdHeaders: Record<string, string> = { "content-type": contentType };

		const result = await provider.loadBalancer.forwardRequest(
			"/chat/completions",
			"POST",
			fwdHeaders,
			chatBody
		);

		return finalizeAnthropicResponse(
			c, result, model, debugPrefix,
			() => openaiChatSseToAnthropicSse(model),
			(text) => convertChatResponseToAnthropic(text, model),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		Logger.error(
			`Error proxying /v1/messages:`,
			message,
			(error as Error).stack ? (error as Error).stack : "<no stack trace>",
		);
		return anthropicError(c, 500, "api_error", "Internal Server Error");
	}
});