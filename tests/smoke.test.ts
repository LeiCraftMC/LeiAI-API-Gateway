import { describe, test, expect } from "bun:test";

// Smoke tests — quick validation that basic functionality works
describe("Smoke Tests", () => {
	describe("Imports", () => {
		test("should import config module", async () => {
			const config = await import("../src/utils/config/gatewayConfig");
			expect(config.GatewayConfig).toBeDefined();
		});

		test("should import load balancer module", async () => {
			const lb = await import("../src/loadBalancing/loadBalancer");
			expect(lb.LoadBalancer).toBeDefined();
			expect(lb.Provider).toBeDefined();
		});

		test("should import health check module", async () => {
			const health = await import("../src/loadBalancing/healthMonitor");
			expect(health.HealthMonitor).toBeDefined();
		});

		test("should import http client module", async () => {
			const client = await import("../src/loadBalancing/backendAPIClient");
			expect(client.BackendAPIClient).toBeDefined();
		});

		test("should import provider manager module", async () => {
			const pm = await import("../src/loadBalancing/providerManager");
			expect(pm.ProviderManager).toBeDefined();
		});
	});

	describe("Core Functionality", () => {
		test("should create LoadBalancer instance", async () => {
			const { LoadBalancer } = await import("../src/loadBalancing/loadBalancer");
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const { BackendAPIClient } = await import("../src/loadBalancing/backendAPIClient");

			const monitor = new HealthMonitor([
				{ name: "test", baseUrl: "http://localhost:8000" },
			]);
			const lb = new LoadBalancer(
				"provider-1",
				"/",
				[
					{
						name: "test",
						apiClient: new BackendAPIClient({ baseUrl: "http://localhost:8000" }),
					},
				],
				monitor,
			);
			expect(lb).toBeDefined();
			expect(lb.getNextBackendIndex()).toBe(0);
		});

		test("should create Provider instance", async () => {
			const { Provider } = await import("../src/loadBalancing/loadBalancer");
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const { BackendAPIClient } = await import("../src/loadBalancing/backendAPIClient");

			const healthMonitor = new HealthMonitor([
				{ name: "test", baseUrl: "http://localhost:8000" },
			]);
			const provider = new Provider({
				id: "provider-1",
				name: "My Provider",
				backends: [
					{
						name: "test",
						apiClient: new BackendAPIClient({ baseUrl: "http://localhost:8000" }),
					},
				],
				healthMonitor,
				models: new (await import("../src/loadBalancing/providerModelsIndex")).ProviderModelsIndex(),
			});
			expect(provider).toBeDefined();
			expect(provider.id).toBe("provider-1");
			expect(provider.name).toBe("My Provider");
		});

		test("should create HealthMonitor instance", async () => {
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const monitor = new HealthMonitor([
				{ name: "a", baseUrl: "http://a.com" },
				{ name: "b", baseUrl: "http://b.com" },
			]);
			expect(monitor.getAllStats()).toHaveLength(2);
			expect(monitor.isHealthy(0)).toBe(true);
			expect(monitor.isHealthy(1)).toBe(true);
		});

		test("should create HTTP client", async () => {
			const { BackendAPIClient } = await import("../src/loadBalancing/backendAPIClient");
			const client = new BackendAPIClient({ baseUrl: "http://localhost:8000" });
			expect(client).toBeDefined();
		});
	});
});
