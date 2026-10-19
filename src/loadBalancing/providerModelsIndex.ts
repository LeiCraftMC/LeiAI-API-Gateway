import type { GatewayConfig } from "../utils/config/gatewayConfig";
import { Logger } from "../utils/logger";
import { ANTHROPIC_API_VERSION } from "../translation";
import type { BackendAPIClient } from "./backendAPIClient";

export class ProviderModelsIndex {

    private readonly providerModels: Map<string, ProviderModelsIndex.ModelData> = new Map();

    /** @param apiFormat the dialect of the backends' `/models` endpoint. */
    constructor(private readonly apiFormat: ProviderModelsIndex.APIFormat = "openai") {}

    /**
     * Returns a snapshot of all currently tracked models for this provider.
     */
    public getModels(): Map<string, ProviderModelsIndex.ModelData> {
        return new Map(this.providerModels);
    }

    public async refreshModelsList(healthyBackendsAPIClients: BackendAPIClient[]): Promise<void> {

        const newModels = Array<Map<string, ProviderModelsIndex.ModelData>>();

        for (const apiClient of healthyBackendsAPIClients) {
            if (this.apiFormat === "anthropic") {
                const backendModels = await this.fetchAnthropicModels(apiClient);
                if (backendModels) newModels.push(backendModels);
                continue;
            }
            try {
                const response = await apiClient.get("/models");
                if (!response.ok) {
                    Logger.warn(`Failed to fetch models from backend (${apiClient.getBaseUrl()}/models): ${response.status},`);
                    continue;
                }
                const data = (await response.json()) as {
                    data: Array<{
                        id: string,
                        created?: number
                    }>
                };
                if (data && Array.isArray(data.data)) {

                    const newModelsforThisBackend = new Map<string, ProviderModelsIndex.ModelData>();

                    for (const model of data.data) {
                        if (typeof model.id !== "string") {
                            Logger.warn(`Invalid model data from backend:`, model);
                            continue;
                        }
                        newModelsforThisBackend.set(model.id, { id: model.id, created: model.created || Date.now() });
                    }
                    newModels.push(newModelsforThisBackend);
                }
            } catch (error) {
                Logger.error(`Error fetching models from backend (${apiClient.getBaseUrl()}/models):`, error);
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

    /**
     * Fetch the models of a backend that only speaks the Anthropic API:
     * `GET /models` needs an `anthropic-version` header and answers with
     * `{ data: [{ id, created_at }], has_more, last_id }`, paginated via
     * `after_id`.  Returns `null` when the backend cannot be queried.
     */
    private async fetchAnthropicModels(
        apiClient: BackendAPIClient,
    ): Promise<Map<string, ProviderModelsIndex.ModelData> | null> {
        const models = new Map<string, ProviderModelsIndex.ModelData>();
        // Cursors already requested, and a page cap: a backend that ignores
        // `after_id` must not keep this loop (and gateway startup) going.
        const seenCursors = new Set<string>();
        let afterId: string | null = null;
        try {
            for (let pages = 0; pages < ProviderModelsIndex.MAX_MODEL_PAGES; pages++) {
                const query = afterId ? `?after_id=${encodeURIComponent(afterId)}` : "";
                const response = await apiClient.request(`/models${query}`, {
                    method: "GET",
                    headers: { "anthropic-version": ANTHROPIC_API_VERSION },
                });
                if (!response.ok) {
                    Logger.warn(`Failed to fetch models from backend (${apiClient.getBaseUrl()}/models): ${response.status}`);
                    return null;
                }
                const page = (await response.json()) as {
                    data?: Array<{ id?: unknown, created_at?: unknown }>,
                    has_more?: boolean,
                    last_id?: string | null,
                };
                if (!page || !Array.isArray(page.data)) return null;

                for (const model of page.data) {
                    if (typeof model.id !== "string") {
                        Logger.warn(`Invalid model data from backend:`, model);
                        continue;
                    }
                    const createdMs = typeof model.created_at === "string" ? Date.parse(model.created_at) : NaN;
                    models.set(model.id, {
                        id: model.id,
                        // `created` is in seconds, like OpenAI's.
                        created: Math.floor((Number.isNaN(createdMs) ? Date.now() : createdMs) / 1000),
                    });
                }

                afterId = page.has_more && page.last_id && !seenCursors.has(page.last_id) ? page.last_id : null;
                if (!afterId) break;
                seenCursors.add(afterId);
            }
        } catch (error) {
            Logger.error(`Error fetching models from backend (${apiClient.getBaseUrl()}/models):`, error);
            return null;
        }
        return models;
    }

}

export namespace ProviderModelsIndex {

    /** `/models` dialect: OpenAI list envelope, or Anthropic (paginated). */
    export type APIFormat = "openai" | "anthropic";

    /** Most `/models` pages fetched from one Anthropic backend. */
    export const MAX_MODEL_PAGES = 50;

    export interface ModelData {
        id: string;
        created: number;
    }

}
