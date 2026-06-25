import { describe, test, expect } from "bun:test";

// Smoke tests - quick validation that basic functionality works
describe("Smoke Tests", () => {
	describe("Imports", () => {
		test("should import config module", async () => {
			const config = await import("../src/utils/config/gatewayConfig");
			expect(config.loadConfig).toBeDefined();
		});

		test("should import load balancer module", async () => {
			const lb = await import("../src/loadBalancer");
			expect(lb.LoadBalancer).toBeDefined();
			expect(lb.Provider).toBeDefined();
		});

		test("should import health check module", async () => {
			const health = await import("../src/loadBalancing/healthMonitor");
			expect(health.HealthMonitor).toBeDefined();
		});

		test("should import http client module", async () => {
			const client = await import("../src/utils/backendAPIClient");
			expect(client.BackendAPIClient).toBeDefined();
		});
	});

	describe("Core Functionality", () => {
		test("should create Provider instance", async () => {
			const { Provider } = await import("../src/loadBalancer");
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const monitor = new HealthMonitor();
			const provider = new Provider(
				{
					name: "my-provider",
					backends: [{ name: "test", url: "http://localhost:8000" }],
				},
				monitor
			);
			expect(provider).toBeDefined();
			expect(provider.name).toBe("my-provider");
		});

		test("should match request paths", async () => {
			const { Provider } = await import("../src/loadBalancer");
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const monitor = new HealthMonitor();
			const provider = new Provider(
				{
					name: "my-provider",
					prefix: "/my-provider",
					backends: [{ name: "test", url: "http://localhost:8000" }],
				},
				monitor
			);
			expect(provider.matches("/my-provider")).toBe(true);
			expect(provider.matches("/my-provider/v1/models")).toBe(true);
			expect(provider.matches("/other-provider")).toBe(false);
		});

		test("should get next backend from provider", async () => {
			const { Provider } = await import("../src/loadBalancer");
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const monitor = new HealthMonitor();
			const provider = new Provider(
				{
					name: "my-provider",
					backends: [
						{ name: "backend-1", url: "http://localhost:8001" },
						{ name: "backend-2", url: "http://localhost:8002" },
					],
				},
				monitor
			);
			const next = provider.loadBalancer.getNextBackend();
			expect(next).toBeDefined();
			expect(next?.name).toMatch(/backend-/);
		});

		test("should initialize health monitor", async () => {
			const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
			const monitor = new HealthMonitor();
			monitor.initialize([
				{ name: "test-1", url: "http://localhost:8000", providerName: "p1" },
				{ name: "test-2", url: "http://localhost:8001", providerName: "p1" },
			]);
			const stats = monitor.getStats();
			expect(stats).toHaveLength(2);
		});
	});

	describe("HTTP Client", () => {
		test("should create HTTP client", async () => {
			const { BackendAPIClient } = await import("../src/utils/backendAPIClient");
			const backend = {
				name: "test",
				url: "http://localhost:8000",
			};
			const client = new BackendAPIClient(backend);
			expect(client).toBeDefined();
		});
	});
});
