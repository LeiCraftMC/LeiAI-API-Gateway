import type { Backend } from "./config";
import { createHttpClient } from "./httpClient";

interface HealthStatus {
  backendName: string;
  healthy: boolean;
  lastCheck: Date;
  consecutiveFailures: number;
}

const healthStatusMap = new Map<string, HealthStatus>();

export function initializeHealthStatus(backends: Backend[]): void {
  backends.forEach((backend) => {
    healthStatusMap.set(backend.name, {
      backendName: backend.name,
      healthy: true,
      lastCheck: new Date(),
      consecutiveFailures: 0,
    });
  });
}

export function getHealthStatus(backendName: string): HealthStatus | undefined {
  return healthStatusMap.get(backendName);
}

export function isHealthy(backendName: string): boolean {
  const status = healthStatusMap.get(backendName);
  return status?.healthy ?? true;
}

export async function checkBackendHealth(backend: Backend): Promise<boolean> {
  try {
    const healthPath = backend.healthCheckPath || "/v1/models";
    const url = new URL(healthPath, backend.url).toString();
    const client = createHttpClient(backend);

    const response = await client.get(url, {
      timeout: 5000,
    });

    const healthy = response.ok;

    const status = healthStatusMap.get(backend.name);
    if (status) {
      if (healthy) {
        status.healthy = true;
        status.consecutiveFailures = 0;
      } else {
        status.consecutiveFailures++;
        if (status.consecutiveFailures >= 3) {
          status.healthy = false;
        }
      }
      status.lastCheck = new Date();
    }

    return healthy;
  } catch (error) {
    const status = healthStatusMap.get(backend.name);
    if (status) {
      status.consecutiveFailures++;
      if (status.consecutiveFailures >= 3) {
        status.healthy = false;
      }
      status.lastCheck = new Date();
    }
    return false;
  }
}

export async function startHealthCheckInterval(
  backends: Backend[],
  interval: number
): Promise<void> {
  setInterval(async () => {
    for (const backend of backends) {
      await checkBackendHealth(backend);
    }
  }, interval);

  // Initial check
  for (const backend of backends) {
    await checkBackendHealth(backend);
  }
}

export function getBackendStats(): HealthStatus[] {
  return Array.from(healthStatusMap.values());
}
