import type { GatewayConfig } from "../utils/config/gatewayConfig";

export type HealthStatus = HealthStatus.Healthy | HealthStatus.Unhealthy;

export namespace HealthStatus {
    
    export interface Healthy {
        healthy: true;
        timeoutEnds: null;
        consecutiveFailures: 0;
    }

    export interface Unhealthy {
        healthy: false;
        timeoutEnds: number;
        consecutiveFailures: number;
    }
}


export class HealthMonitor {
    
    private readonly statusMap = new Map<number, HealthStatus>();
    private readonly baseTimeoutMs = 1000;
    private readonly maxTimeoutMs = 30000;

    constructor(
        private readonly backends: GatewayConfig.Types.ProviderBackend[]
    ) {

        for (const [backendID] of backends.entries()) {
            this.statusMap.set(backendID, {
                healthy: true,
                timeoutEnds: null,
                consecutiveFailures: 0,
            });
        }

    }

    public isHealthy(backendID: number): boolean {
        return this.statusMap.get(backendID)?.healthy ?? true;
    }

    public getAllStats(): HealthStatus[] {
        return this.backends.map((_, index) => this.statusMap.get(index) ?? {
            healthy: true,
            timeoutEnds: null,
            consecutiveFailures: 0,
        });
    }

    public getHealthyBackends(): number[] {
        const healthyBackends: number[] = [];
        for (const [backendID, status] of this.statusMap.entries()) {
            if (status.healthy) {
                healthyBackends.push(backendID);
            }
        }
        return healthyBackends;
    }

    public setHealthyness(backendID: number, healthy: boolean) {
        if (healthy) {
            this.statusMap.set(backendID, {
                healthy: true,
                timeoutEnds: null,
                consecutiveFailures: 0,
            });
            return;
        }

        const current = this.statusMap.get(backendID);
        const consecutiveFailures = current?.healthy === false ? current.consecutiveFailures + 1 : 1;
        const timeoutEnds = Date.now() + Math.min(
            this.maxTimeoutMs,
            this.baseTimeoutMs * 2 ** (consecutiveFailures - 1),
        );

        this.statusMap.set(backendID, {
            healthy: false,
            consecutiveFailures,
            timeoutEnds,
        });
    }

    public updateHealthStatuses() {
        const now = Date.now();
        for (const [backendID, status] of this.statusMap.entries()) {
            if (!status.healthy && status.timeoutEnds !== null && now >= status.timeoutEnds) {
                this.statusMap.set(backendID, {
                    healthy: true,
                    timeoutEnds: null,
                    consecutiveFailures: 0,
                });
            }
        }
    }
}
