import { Hono } from "hono";
import { ProviderManager } from "../../../../loadBalancing/providerManager";
import { Provider } from "../../../../loadBalancing/loadBalancer";
import { Logger } from "../../../../utils/logger";
import { GatewayConfig } from "../../../../utils/config/gatewayConfig";
import type { AuthContext } from "../auth";

export const router = new Hono();

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve a model name (possibly `providerId/modelName`) to the
 * owning provider and the bare model name to send to the backend.
 */
function resolveModel(model: string): {
	providerId: string;
	providerName: string;
	bareModel: string;
} | null {
	// Direct match: model contains a "/" — first segment is the provider ID
	const slashIdx = model.indexOf("/");
	if (slashIdx !== -1) {
		const providerId = model.slice(0, slashIdx);
		const bareModel = model.slice(slashIdx + 1);
		const providerData = ProviderManager.getProviderData(providerId);
		if (providerData) {
			return { providerId, providerName: providerData.name, bareModel };
		}
	}

	// Check custom models mapping for an alias → real model resolution
	const gatewayConfig = GatewayConfig.getConfig();
	if (gatewayConfig?.customModels?.mapping) {
		const realModel = gatewayConfig.customModels.mapping[model];
		if (realModel) {
			return resolveModel(realModel); // recurse — real model may have provider prefix
		}
	}

	// Could be a bare model name — search every provider's model list
	const allProviders = ProviderManager.getAllProvidersData();
	for (const providerData of allProviders) {
		if (providerData.models.getModels().has(model)) {
			return {
				providerId: providerData.id,
				providerName: providerData.name,
				bareModel: model,
			};
		}
	}

	return null;
}

/**
 * Rewrite the `model` field in a JSON request body so the backend
 * receives the bare model name (without provider prefix).
 */
function rewriteModelField(body: string, bareModel: string): string {
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

			const providerData = ProviderManager.getProviderData(resolved.providerId);
			if (!providerData) {
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

			const provider = new Provider(providerData);
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
