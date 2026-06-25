import type { GatewayConfig } from "../utils/config/gatewayConfig";
import { BackendAPIClient } from "./backendAPIClient";
import { HealthMonitor } from "./healthMonitor";
import { ProviderModelsIndex } from "./providerModelsIndex";


export class ProviderManager {

    private static readonly providers = new Map<string, ProviderManager.ProviderData>();
    private static needsModelFetching: boolean;

    private static _initialized: boolean = false;

    static isInitialized(): boolean {
        return this._initialized;
    }

    static async init(
        providers: GatewayConfig.Types.Provider[],
        needsModelFetching: boolean
    ) {
        if (this._initialized) return;
        this._initialized = true;

        this.needsModelFetching = needsModelFetching;

        for (const provider of providers) {
            const healthMonitor = new HealthMonitor(provider.backends);
            this.providers.set(provider.id, {
                id: provider.id,
                name: provider.name,
                backends: provider.backends.map((backend) => ({
                    name: backend.name,
                    apiClient: new BackendAPIClient({
                        baseUrl: backend.baseUrl,
                        apiKey: backend.apiKey,
                        proxyUrl: backend.proxyUrl,
                    }),
                })),
                healthMonitor,
                models: new ProviderModelsIndex(),
            });
        }
    }

    static async refreshHealthMonitorData() {
        for (const providerData of this.providers.values()) {
            await providerData.healthMonitor.updateHealthStatuses();
        }
    }

    static async refreshModelsData() {
        if (!this.needsModelFetching) return;
        for (const providerData of this.providers.values()) {
            await providerData.models.refreshModelsList(
                providerData.backends.map((backend) => backend.apiClient)
            );
        }
    }

    static getProviderData(providerId: string): ProviderManager.ProviderData | undefined {
        return this.providers.get(providerId);
    }

    static getAllProvidersData(): ProviderManager.ProviderData[] {
        return Array.from(this.providers.values());
    }

    static getAllModels(): Map<string, ProviderModelsIndex.ModelData> {
        const allModels = new Map<string, ProviderModelsIndex.ModelData>();

        for (const providerData of this.providers.values()) {
            for (const [modelId, modelData] of providerData.models.getModels()) {
                allModels.set(`${providerData.id}/${modelId}`, modelData);
            }
        }

        return allModels;
    }

}

export namespace ProviderManager {

    export interface ProviderData {
        id: string;
        name: string;
        backends: ProviderManager.ProviderBackend[];
        healthMonitor: HealthMonitor;
        models: ProviderModelsIndex
    }

    export interface ProviderBackend extends Omit<GatewayConfig.Types.ProviderBackend, 'baseUrl' | 'apiKey' | 'proxyUrl'> {
        apiClient: BackendAPIClient;
    }

}
