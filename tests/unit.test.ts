import { describe, test, expect } from "bun:test";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { HealthMonitor } from "../src/loadBalancing/healthMonitor";
import { LoadBalancer } from "../src/loadBalancing/loadBalancer";
import { BackendAPIClient } from "../src/loadBalancing/backendAPIClient";

describe("GatewayConfig Types — ProviderBackend schema", () => {
	test("should accept valid minimal config", () => {
		const result = GatewayConfig.Types.ProviderBackend.safeParse({
			name: "test-backend",
			baseUrl: "http://localhost:8000",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.name).toBe("test-backend");
			expect(result.data.baseUrl).toBe("http://localhost:8000");
			expect(result.data.apiKey).toBeUndefined();
			expect(result.data.proxyUrl).toBeUndefined();
		}
	});

	test("should accept config with API key", () => {
		const result = GatewayConfig.Types.ProviderBackend.safeParse({
			name: "openai",
			baseUrl: "https://api.openai.com",
			apiKey: "sk-1234567890",
		});
		expect(result.success).toBe(true);
	});

	test("should accept config with SOCKS5 proxy", () => {
		const result = GatewayConfig.Types.ProviderBackend.safeParse({
			name: "proxied",
			baseUrl: "http://remote.api.com",
			proxyUrl: "socks5://proxy.example.com:1080",
		});
		expect(result.success).toBe(true);
	});

	test("should reject empty name", () => {
		const result = GatewayConfig.Types.ProviderBackend.safeParse({
			name: "",
			baseUrl: "http://localhost:8000",
		});
		expect(result.success).toBe(false);
	});

	test("should reject invalid URL", () => {
		const result = GatewayConfig.Types.ProviderBackend.safeParse({
			name: "bad-url",
			baseUrl: "not-a-url",
		});
		expect(result.success).toBe(false);
	});

	test("should reject missing baseUrl", () => {
		const result = GatewayConfig.Types.ProviderBackend.safeParse({
			name: "no-url",
		});
		expect(result.success).toBe(false);
	});
});

describe("HealthMonitor", () => {
	test("should mark all backends healthy on creation", () => {
		const backends = [
			{ name: "a", baseUrl: "http://a.com" },
			{ name: "b", baseUrl: "http://b.com" },
		];
		const monitor = new HealthMonitor(backends);
		expect(monitor.isHealthy(0)).toBe(true);
		expect(monitor.isHealthy(1)).toBe(true);
	});

	test("isHealthy should return true for unknown index", () => {
		const monitor = new HealthMonitor([]);
		expect(monitor.isHealthy(99)).toBe(true);
	});

	test("setHealthyness should mark backend unhealthy", () => {
		const backends = [{ name: "a", baseUrl: "http://a.com" }];
		const monitor = new HealthMonitor(backends);

		monitor.setHealthyness(0, false);
		expect(monitor.isHealthy(0)).toBe(false);
	});

	test("setHealthyness should recover backend", () => {
		const backends = [{ name: "a", baseUrl: "http://a.com" }];
		const monitor = new HealthMonitor(backends);

		monitor.setHealthyness(0, false);
		expect(monitor.isHealthy(0)).toBe(false);

		monitor.setHealthyness(0, true);
		expect(monitor.isHealthy(0)).toBe(true);
	});

	test("getHealthyBackends should return only healthy indices", () => {
		const backends = [
			{ name: "a", baseUrl: "http://a.com" },
			{ name: "b", baseUrl: "http://b.com" },
			{ name: "c", baseUrl: "http://c.com" },
		];
		const monitor = new HealthMonitor(backends);

		monitor.setHealthyness(1, false);
		const healthy = monitor.getHealthyBackends();
		expect(healthy).toEqual([0, 2]);
	});

	test("getAllStats should return all statuses", () => {
		const backends = [
			{ name: "a", baseUrl: "http://a.com" },
			{ name: "b", baseUrl: "http://b.com" },
		];
		const monitor = new HealthMonitor(backends);
		const stats = monitor.getAllStats();

		expect(stats).toHaveLength(2);
		expect(stats[0]?.healthy).toBe(true);
		expect(stats[1]?.healthy).toBe(true);
	});

	test("consecutive failures should increase timeout", () => {
		const backends = [{ name: "a", baseUrl: "http://a.com" }];
		const monitor = new HealthMonitor(backends);

		monitor.setHealthyness(0, false);
		const firstStatus = monitor.getAllStats()[0]!;
		const firstTimeout = firstStatus.healthy ? 0 : firstStatus.timeoutEnds;

		monitor.setHealthyness(0, false);
		const secondStatus = monitor.getAllStats()[0]!;
		const secondTimeout = secondStatus.healthy ? 0 : secondStatus.timeoutEnds;

		if (!firstStatus.healthy && !secondStatus.healthy) {
			// Second timeout should be larger (exponential backoff: 1s → 2s)
			expect(secondTimeout - firstTimeout).toBeGreaterThanOrEqual(900);
		}
	});
});

describe("LoadBalancer — getNextBackendIndex", () => {
	function makeLB(backendCount: number): LoadBalancer {
		const configs = Array.from({ length: backendCount }, (_, i) => ({
			name: `b${i}`,
			baseUrl: `http://b${i}.com`,
		}));
		const monitor = new HealthMonitor(configs);
		const backends: LoadBalancer.Backend[] = configs.map((c) => ({
			name: c.name,
			apiClient: new BackendAPIClient(c),
		}));
		return new LoadBalancer("test", backends, monitor);
	}

	test("should cycle through backends round-robin", () => {
		const lb = makeLB(3);
		const results: (number | null)[] = [];

		for (let i = 0; i < 6; i++) {
			results.push(lb.getNextBackendIndex());
		}

		// First three are 0, 1, 2; then wrap to 0, 1, 2
		expect(results).toEqual([0, 1, 2, 0, 1, 2]);
	});

	test("should return null for empty backends", () => {
		const lb = makeLB(0);
		expect(lb.getNextBackendIndex()).toBeNull();
	});

	test("should always return 0 for single backend", () => {
		const lb = makeLB(1);
		for (let i = 0; i < 5; i++) {
			expect(lb.getNextBackendIndex()).toBe(0);
		}
	});

	test("should skip unhealthy backends", () => {
		const configs = [
			{ name: "healthy", baseUrl: "http://h.com" },
			{ name: "sick", baseUrl: "http://s.com" },
			{ name: "healthy2", baseUrl: "http://h2.com" },
		];
		const monitor = new HealthMonitor(configs);
		const backends: LoadBalancer.Backend[] = configs.map((c) => ({
			name: c.name,
			apiClient: new BackendAPIClient(c),
		}));
		const lb = new LoadBalancer("test", backends, monitor);

		monitor.setHealthyness(1, false);

		const results: (number | null)[] = [];
		for (let i = 0; i < 4; i++) {
			results.push(lb.getNextBackendIndex());
		}

		// Should only return 0 and 2 (skip index 1)
		expect(results).toEqual([0, 2, 0, 2]);
	});

	test("getAllBackends should return all backends", () => {
		const lb = makeLB(2);
		const all = lb.getAllBackends();
		expect(all).toHaveLength(2);
		expect(all[0]?.name).toBe("b0");
		expect(all[1]?.name).toBe("b1");
	});
});

describe("URL Construction", () => {
	test("should combine base URL with path", () => {
		const full = new URL("/v1/models", "http://localhost:8000").toString();
		expect(full).toBe("http://localhost:8000/v1/models");
	});

	test("should preserve query parameters", () => {
		const full = new URL("/search?q=test&limit=10", "http://localhost:8000").toString();
		expect(full).toContain("q=test");
		expect(full).toContain("limit=10");
	});

	test("should handle complex URLs", () => {
		const full = new URL(
			"/v1/chat/completions?model=gpt-4&stream=true",
			"https://api.openai.com",
		).toString();
		expect(full).toContain("model=gpt-4");
		expect(full).toContain("stream=true");
	});
});
