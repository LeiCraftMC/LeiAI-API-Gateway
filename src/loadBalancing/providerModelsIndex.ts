import type { GatewayConfig } from "../utils/config/gatewayConfig";
import { Logger } from "../utils/logger";
import type { BackendAPIClient } from "./backendAPIClient";

export class ProviderModelsIndex {

    private readonly providerModels: Map<string, ProviderModelsIndex.ModelData> = new Map();

    constructor() {}



    public async refreshModelsList(healthyBackendsAPIClients: BackendAPIClient[]): Promise<void> {

        const newModels = Array<Map<string, ProviderModelsIndex.ModelData>>();

        for (const apiClient of healthyBackendsAPIClients) {
            try {
                const response = await apiClient.get("/v1/models");
                if (!response.ok) {
                    Logger.warn(`Failed to fetch models from backend: ${response.status}`);
                    continue;
                }
                const data = (await response.json()) as {
                    data: Array<{
                        id: string,
                        created: number
                    }>
                };
                if (data && Array.isArray(data.data)) {

                    const newModelsforThisBackend = new Map<string, ProviderModelsIndex.ModelData>();

                    for (const model of data.data) {
                        if (typeof model.id !== "string" || typeof model.created !== "number") {
                            Logger.warn(`Invalid model data from backend:`, model);
                            continue;
                        }
                        newModelsforThisBackend.set(model.id, { id: model.id, created: model.created });
                    }
                    newModels.push(newModelsforThisBackend);
                }
            } catch (error) {
                Logger.error(`Error fetching models from backend:`, error);
            }
        }

        // merge only the models that are present in all healthy backends
        const mergedModels = new Map<string, ProviderModelsIndex.ModelData>();
        for (const modelMap of newModels) {
            for (const [modelId, modelData] of modelMap) {
                if (!mergedModels.has(modelId)) {
                    // Check if this model exists in all other maps
                    const existsInAll = newModels.every((m) => m.has(modelId));
                    if (existsInAll) {
                        mergedModels.set(modelId, modelData);
                    }
                }
            }
        }

        this.providerModels.clear();
        for (const [modelId, modelData] of mergedModels) {
            this.providerModels.set(modelId, modelData);
        }

    }

}

export namespace ProviderModelsIndex {

    export interface ModelData {
        id: string;
        created: number;
    }

}