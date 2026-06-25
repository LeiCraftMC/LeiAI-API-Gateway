import type { Backend } from "./utils/config";
import { BackendAPIClient } from "./backendAPIClient";
import { Logger } from "./utils/logger";

export interface HealthStatus {
    providerName: string;
    backendName: string;
    healthy: boolean;
    lastCheck: Date;
    consecutiveFailures: number;
}

interface HealthCheckOptions {
    /** Interval in milliseconds between health check rounds. */
    interval?: number;
    /** Timeout in milliseconds for a single health check request. */
    timeout?: number;
    /** Number of consecutive failures before marking a backend unhealthy. */
    failureThreshold?: number;
}

export interface MonitoredBackend extends Backend {
    providerName: string;
}

export class HealthMonitor {
    private readonly statusMap = new Map<string, HealthStatus>();
    private readonly options: Required<HealthCheckOptions>;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(options: HealthCheckOptions = {}) {
        this.options = {
            interval: options.interval ?? 30000,
            timeout: options.timeout ?? 5000,
            failureThreshold: options.failureThreshold ?? 3,
        };
    }

    private key(providerName: string, backendName: string): string {
        return `${providerName}::${backendName}`;
    }

    initialize(backends: MonitoredBackend[]): void {
        for (const backend of backends) {
            this.statusMap.set(this.key(backend.providerName, backend.name), {
                providerName: backend.providerName,
                backendName: backend.name,
                healthy: true,
                lastCheck: new Date(),
                consecutiveFailures: 0,
            });
        }
    }

    isHealthy(providerName: string, backendName: string): boolean {
        return this.statusMap.get(this.key(providerName, backendName))?.healthy ?? true;
    }

    getStats(): HealthStatus[] {
        return Array.from(this.statusMap.values());
    }

    async checkBackend(backend: MonitoredBackend): Promise<boolean> {
        const key = this.key(backend.providerName, backend.name);
        const status = this.statusMap.get(key);
        const healthPath = backend.healthCheckPath || "/v1/models";
        const url = new URL(healthPath, backend.url).toString();
        const client = new BackendAPIClient(backend);

        try {
            const response = await client.request(url, {
                method: "GET",
                timeout: this.options.timeout,
            });

            const healthy = response instanceof Response ? response.ok : response.ok;

            if (status) {
                if (healthy) {
                    status.healthy = true;
                    status.consecutiveFailures = 0;
                } else {
                    status.consecutiveFailures++;
                    if (status.consecutiveFailures >= this.options.failureThreshold) {
                        status.healthy = false;
                    }
                }
                status.lastCheck = new Date();
            }

            return healthy;
        } catch (error) {
            if (status) {
                status.consecutiveFailures++;
                if (status.consecutiveFailures >= this.options.failureThreshold) {
                    status.healthy = false;
                }
                status.lastCheck = new Date();
            }
            return false;
        }
    }

    /**
     * Convenience helper to synchronously mark a backend healthy/unhealthy.
     * Useful in tests that want to force a state without running a real check.
     */
    setHealthy(providerName: string, backendName: string, healthy: boolean): void {
        const key = this.key(providerName, backendName);
        const status = this.statusMap.get(key);
        if (status) {
            status.healthy = healthy;
            if (healthy) {
                status.consecutiveFailures = 0;
            }
            status.lastCheck = new Date();
        }
    }

    async runChecks(backends: MonitoredBackend[]): Promise<void> {
        for (const backend of backends) {
            await this.checkBackend(backend);
        }
    }

    start(backends: MonitoredBackend[]): void {
        this.initialize(backends);

        // Initial round immediately, then interval.
        this.runChecks(backends).catch((error) => {
            Logger.error("Health check initial round failed:", error);
        });

        this.timer = setInterval(() => {
            this.runChecks(backends).catch((error) => {
                Logger.error("Health check interval round failed:", error);
            });
        }, this.options.interval);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
