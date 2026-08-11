import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { ApiKeysConfig } from "../../../utils/config/apiKeysConfig";
import { Logger } from "../../../utils/logger";

export type AuthContext = Omit<ApiKeysConfig.Types.ConfigSchema[string], "description">;

/**
 * Whether a request is addressing the gateway in the Anthropic style
 * (carrying `x-api-key` and/or `anthropic-version`).  Used to pick the
 * appropriate error-response shape when authentication fails before the
 * route handler runs.
 */
function isAnthropicStyleRequest(c: Context): boolean {
	return c.req.header("x-api-key") !== undefined || c.req.header("anthropic-version") !== undefined;
}

/** An Anthropic-formatted error body. */
function anthropicErrorBody(type: string, message: string) {
	return { type: "error", error: { type, message } };
}

export const authMiddlewareV1 = createMiddleware(async (c, next) => {

	// Accept either OpenAI-style (`Authorization: Bearer`) or Anthropic-style
	// (`x-api-key`) credentials so both SDKs can talk to the gateway.
	const authHeader = c.req.header("Authorization");
	let apiKey: string | undefined;

	if (authHeader && authHeader.startsWith("Bearer ")) {
		apiKey = authHeader.substring("Bearer ".length).trim();
	} else {
		const xApiKey = c.req.header("x-api-key");
		if (xApiKey) {
			apiKey = xApiKey.trim();
		}
	}

	const anthropicStyle = isAnthropicStyleRequest(c);

	if (!apiKey) {
		if (anthropicStyle) {
			return c.json(anthropicErrorBody("authentication_error", "Missing API key. Expected an 'x-api-key' or 'Authorization: Bearer' header."), 401);
		}
		return c.json({ success: false, code: 401, message: "Unauthorized" }, 401);
	}

	const apiKeys = ApiKeysConfig.getConfig();
	if (!apiKeys) {
		Logger.error("API Keys configuration is not loaded.");
		if (anthropicStyle) {
			return c.json(anthropicErrorBody("api_error", "Internal server error"), 500);
		}
		return c.json({ success: false, code: 500, message: "Internal server error" }, 500);
	}

	const apiKeyData = apiKeys[apiKey];

	if (typeof apiKeyData !== "object") {
		if (anthropicStyle) {
			return c.json(anthropicErrorBody("authentication_error", "Invalid API key"), 403);
		}
		return c.json({ success: false, code: 403, message: "Forbidden" }, 403);
	}

	c.set("auth", apiKeyData);

	return await next();

});