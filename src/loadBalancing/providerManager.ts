import type { GatewayConfig } from "../utils/config/gatewayConfig";
import { BackendAPIClient } from "./backendAPIClient";
import { HealthMonitor } from "./healthMonitor";
import { ProviderModelsIndex } from "./providerModelsIndex";
import { LoadBalancer } from "./loadBalancer";


export class ProviderManager {

    private static readonly providers = new Map<string, Provider>();
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
            this.providers.set(provider.id, new Provider(provider));
            await this.providers.get(provider.id)?.healthMonitor.updateHealthStatuses();
            await this.providers.get(provider.id)?.models.refreshModelsList(
                this.providers.get(provider.id)?.backends.map((backend) => backend.apiClient) ?? []
            );
        }
    }

    static async refreshHealthMonitorData() {
        for (const provider of this.providers.values()) {
            await provider.healthMonitor.updateHealthStatuses();
        }
    }

    static async refreshModelsData() {
        if (!this.needsModelFetching) return;
        for (const provider of this.providers.values()) {
            await provider.models.refreshModelsList(
                provider.backends.map((backend) => backend.apiClient)
            );
        }
    }

    /** Return a cached provider instance (with round-robin state). */
    static getProvider(providerId: string): Provider | undefined {
        return this.providers.get(providerId);
    }

    /** Return all provider instances. */
    static getAllProviders(): Provider[] {
        return Array.from(this.providers.values());
    }

    static getAllModels(): Map<string, ProviderModelsIndex.ModelData> {
        const allModels = new Map<string, ProviderModelsIndex.ModelData>();

        for (const provider of this.providers.values()) {
            for (const [modelId, modelData] of provider.models.getModels()) {
                allModels.set(`${provider.id}/${modelId}`, modelData);
            }
        }

        return allModels;
    }

}

    /**
     * A provider instance with its backends, health monitor, model index,
     * and round-robin LoadBalancer.  Created once in {@link ProviderManager.init}
     * and reused across requests so load-balancing state persists.
     */
    export class Provider {
        public readonly id: string;
        public readonly name: string;
        public readonly backends: Provider.Backend[];
        public readonly healthMonitor: HealthMonitor;
        public readonly models: ProviderModelsIndex;
        public readonly loadBalancer: LoadBalancer;

        constructor(config: GatewayConfig.Types.Provider) {
            this.id = config.id;
            this.name = config.name;
            this.healthMonitor = new HealthMonitor(config.backends);
            this.backends = config.backends.map((backend) => ({
                name: backend.name,
                apiClient: new BackendAPIClient({
                    baseUrl: backend.baseUrl,
                    apiKey: backend.apiKey,
                    proxyUrl: backend.proxyUrl,
                }),
            }));
            this.models = new ProviderModelsIndex();
            this.loadBalancer = new LoadBalancer(
                this.id,
                this.backends.map((b) => ({ name: b.name, apiClient: b.apiClient })),
                this.healthMonitor,
            );
        }

    }

export namespace Provider {

    export interface Backend extends Omit<GatewayConfig.Types.ProviderBackend, 'baseUrl' | 'apiKey' | 'proxyUrl'> {
        name: string;
        apiClient: BackendAPIClient;
    }

}
