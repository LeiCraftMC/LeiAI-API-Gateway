import { Hono } from "hono";
import { ProviderManager } from "../../../../loadBalancing/providerManager";
import { Logger } from "../../../../utils/logger";
import { GatewayConfig } from "../../../../utils/config/gatewayConfig";
import type { AuthContext } from "../auth";

export const router = new Hono();

/**
 * GET /v1/models
 *
 * Returns a list of all available models aggregated across all providers.
 * Follows the OpenAI List Models API format.
 */
router.get("/models", (c) => {
    try {
		// @ts-ignore
		const authContext = c.get("authContext") as AuthContext

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
				data: models,
			}, 500);
		}

		const gatewayConfig = GatewayConfig.getConfig();
		if (!gatewayConfig) {
			Logger.warn("GatewayConfig is not loaded. Returning empty models list.");
			return c.json({
				object: "list",
				data: models,
			}, 500);
		}

		const allBackendsModels = ProviderManager.getAllModels();

		const customModelsMapping = Object.entries(gatewayConfig.customModels?.mapping ?? {})
		if (customModelsMapping.length > 0) {

			for (const [alias, realModel] of customModelsMapping) {

				if (!allBackendsModels.has(realModel)) {
					Logger.warn(`Custom model mapping for alias "${alias}" points to a non-existent model "${realModel}". Skipping.`);
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

        Logger.debug(`GET /v1/models — returning ${models.length} models`);

		if (authContext.denyModels && authContext.denyModels.length > 0) {

			return c.json({
				object: "list",
				data: models.filter(model => !authContext.denyModels!.includes(model.id)),
			}, 200);

		}
		
		if (authContext.allowedModels && authContext.allowedModels.length > 0) {

			return c.json({
				object: "list",
				data: models.filter(model => authContext.allowedModels!.includes(model.id)),
			}, 200);

		}

        return c.json({
            object: "list",
            data: models,
        }, 200);
    } catch (error) {
        Logger.error("Failed to list models:", error);
        return c.json(
            { error: "Internal Server Error" },
            500,
        );
    }
});	