import { Hono } from "hono";
import { ProviderManager } from "../../../../loadBalancing/providerManager";
import { Logger } from "../../../../utils/logger";
import { GatewayConfig } from "../../../../utils/config/gatewayConfig";
import type { AuthContext } from "../auth";

export const router = new Hono();

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve a model name to the owning provider and the bare model name
 * to send to the backend.
 *
 * **When custom model mapping is configured**, only mapping aliases are
 * accepted.  Direct `providerId/modelName` access is blocked so the
 * internal model structure is never exposed to end users.
 *
 * **When no custom model mapping** is configured, models are resolved
 * directly in `providerId/modelName` format (as surfaced by `/v1/models`).
 */
export function resolveModel(model: string): {
	providerId: string;
	providerName: string;
	bareModel: string;
} | null {
	const gatewayConfig = GatewayConfig.getConfig();
	const mapping = gatewayConfig?.customModels?.mapping;
	const hasCustomMapping = mapping && Object.keys(mapping).length > 0;

	if (hasCustomMapping) {
		// Custom model mapping is active:
		//   - Only aliases defined in the mapping are accepted
		//   - Direct providerId/modelName is blocked
		const realModel = mapping[model];
		if (!realModel) return null;
		return resolvePrefixedModel(realModel);
	}

	// No custom mapping: standard providerId/modelName resolution
	const slashIdx = model.indexOf("/");
	if (slashIdx !== -1) {
		const providerId = model.slice(0, slashIdx);
		const bareModel = model.slice(slashIdx + 1);
		const provider = ProviderManager.getProvider(providerId);
		if (provider) {
			return { providerId, providerName: provider.name, bareModel };
		}
	}

	return null;
}

/**
 * Resolve a model string in `"providerId/bareModel"` format from within
 * the custom model mapping.  Unlike {@link resolveModel}, this is an
 * internal-only helper that does **not** consult the mapping again for
 * `providerId/modelName` strings — it always treats them as direct
 * provider lookups.
 *
 * Values without a `/` are treated as alias chains and looked up
 * recursively in the mapping (supporting `alias → anotherAlias` setups).
 */
function resolvePrefixedModel(prefixed: string): {
	providerId: string;
	providerName: string;
	bareModel: string;
} | null {
	const slashIdx = prefixed.indexOf("/");
	if (slashIdx !== -1) {
		// Direct provider/model format — resolve immediately
		const providerId = prefixed.slice(0, slashIdx);
		const bareModel = prefixed.slice(slashIdx + 1);
		const provider = ProviderManager.getProvider(providerId);
		if (provider) {
			return { providerId, providerName: provider.name, bareModel };
		}
	}

	// No "/" — treat as another alias and follow the chain
	const gatewayConfig = GatewayConfig.getConfig();
	const mapping = gatewayConfig?.customModels?.mapping;
	if (mapping && mapping[prefixed]) {
		return resolvePrefixedModel(mapping[prefixed]);
	}

	return null;
}

/**
 * Rewrite the `model` field in a JSON request body so the backend
 * receives the bare model name (without provider prefix).
 */
export function rewriteModelField(body: string, bareModel: string): string {
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed?.model === "string" && parsed.model !== bareModel) {
			parsed.model = bareModel;
		}
		return JSON.stringify(parsed);
	} catch {
		// Not valid JSON — pass through unchanged
		return body;
	}
}

/* ------------------------------------------------------------------ */
/*  List models   GET /v1/models                                       */
/* ------------------------------------------------------------------ */

router.get("/models", (c) => {
	try {
		// @ts-ignore
		const authContext = c.get("auth") as AuthContext | undefined;

		const models: Array<{
			id: string;
			object: "model";
			created: number;
			owned_by: string;
		}> = [];

		if (!ProviderManager.isInitialized()) {
			Logger.warn("ProviderManager is not initialized. Returning empty models list.");
			return c.json({
				object: "list",
				data: models
			}, 500);
		}

		const gatewayConfig = GatewayConfig.getConfig();
		if (!gatewayConfig) {
			Logger.warn("GatewayConfig is not loaded. Returning empty models list.");
			return c.json({
				object: "list",
				data: models
			}, 500);
		}

		const allBackendsModels = ProviderManager.getAllModels();

		const customModelsMapping = Object.entries(gatewayConfig.customModels?.mapping ?? {});

		if (customModelsMapping.length > 0) {

			for (const [alias, realModel] of customModelsMapping) {

				if (!allBackendsModels.has(realModel)) {
					Logger.warn(
						`Custom model mapping for alias "${alias}" points to non-existent model "${realModel}". Skipping.`,
					);
					continue;
				}

				const modelData = allBackendsModels.get(realModel)!;
				models.push({
					id: alias,
					object: "model",
					created: modelData.created,
					owned_by: gatewayConfig.customModels?.ownerID || "custom",
				});
			}
		} else {

			for (const [modelId, modelData] of allBackendsModels) {

				models.push({
					id: modelId,
					object: "model",
					created: modelData.created,
					owned_by: modelId.split("/")[0] || "unknown",
				});
			}
		}

		// Filter by auth context
		if (authContext) {
			if (authContext.denyModels && authContext.denyModels.length > 0) {
				return c.json({
					object: "list",
					data: models.filter((m) => !authContext.denyModels!.includes(m.id)),
				}, 200);
			}

			if (authContext.allowedModels && authContext.allowedModels.length > 0) {
				return c.json({
					object: "list",
					data: models.filter((m) => authContext.allowedModels!.includes(m.id)),
				}, 200);
			}
		}

		return c.json({ object: "list", data: models }, 200);

	} catch (error) {
		
		Logger.error("Failed to list models:", error);
		return c.json({ 
			error: "Internal Server Error"
		}, 500);
	}
});

/* ------------------------------------------------------------------ */
/*  Proxy handler factory  —  used by all OpenAI POST endpoints        */
/* ------------------------------------------------------------------ */

function createProxyHandler(targetPath: string) {
	return async (c: any) => {
		try {
			const authContext = c.get("auth") as AuthContext | undefined;
			if (!authContext) {
				return c.json({
					error: { message: "Authentication required", type: "auth_error" },
				}, 401);
			}

			// Read the raw request body
			const bodyText = await c.req.text();
			let model: string | undefined;

			try {
				const parsed = JSON.parse(bodyText);
				model = parsed?.model;
			} catch {
				// Body is not JSON — pass it through as-is
			}

			if (!model) {
				return c.json({
					error: { message: "Model is required", type: "invalid_request_error" },
				}, 400);
			}

			// Resolve which provider handles this model
			const resolved = resolveModel(model);
			if (!resolved) {
				return c.json({
					error: {
						message: `Model "${model}" not found`,
						type: "invalid_request_error",
					},
				}, 404);
			}

			const provider = ProviderManager.getProvider(resolved.providerId);
			if (!provider) {
				return c.json({
					error: {
						message: `Provider "${resolved.providerId}" not available`,
						type: "server_error",
					},
				}, 503);
			}

			// Check model-level access (deny / allow lists)
			if (authContext) {
				if (authContext.denyModels?.includes(model)) {
					return c.json({
						error: {
							message: `Model "${model}" is not available for your API key`,
							type: "access_error",
						},
					}, 403);
				}
				if (authContext.allowedModels?.length && !authContext.allowedModels.includes(model)) {
					return c.json({
						error: {
							message: `Model "${model}" is not available for your API key`,
							type: "access_error",
						},
					}, 403);
				}
			}

			// Rewrite model field to bare name and forward
			const rewrittenBody = rewriteModelField(bodyText, resolved.bareModel);

			
			const rawRequest = c.req.raw as Request;
			const response = await provider.forwardRequest(
				targetPath,
				rawRequest.url.includes("?") ? "?" + rawRequest.url.split("?")[1] : "",
				rawRequest.method,
				rawRequest.headers,
				rewrittenBody,
			);

			// Convert Headers to a plain record for c.newResponse
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => { responseHeaders[key] = value; });

			return c.newResponse(response.body, response.status, responseHeaders);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(`Error proxying ${targetPath}:`, message);
			return c.json({
				error: { message: "Internal Server Error", type: "server_error" },
			}, 500);
		}
	};
}

/* ------------------------------------------------------------------ */
/*  Chat Completions   POST /v1/chat/completions                       */
/* ------------------------------------------------------------------ */

router.post("/chat/completions", createProxyHandler("/v1/chat/completions"));

/* ------------------------------------------------------------------ */
/*  Text Completions   POST /v1/completions                            */
/* ------------------------------------------------------------------ */

router.post("/completions", createProxyHandler("/v1/completions"));

/* ------------------------------------------------------------------ */
/*  Embeddings        POST /v1/embeddings                              */
/* ------------------------------------------------------------------ */

router.post("/embeddings", createProxyHandler("/v1/embeddings"));
