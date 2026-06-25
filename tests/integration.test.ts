import { describe, test, expect } from "bun:test";
import { LoadBalancer, type LoadBalancerBackend } from "../src/loadBalancing/loadBalancer";
import { Provider, ProviderManager } from "../src/loadBalancing/providerManager";
import { HealthMonitor } from "../src/loadBalancing/healthMonitor";
import { BackendAPIClient } from "../src/loadBalancing/backendAPIClient";
import { ProviderModelsIndex } from "../src/loadBalancing/providerModelsIndex";
import { FakeOpenAICompatibleAPI } from "./helpers/fakeOpenAICompatibleAPI";

describe("LoadBalancer — forwardRequest", () => {
	test("should return 503 when no backends available", async () => {
		const monitor = new HealthMonitor([]);
		const lb = new LoadBalancer("test", "/", [], monitor);
		const response = await lb.forwardRequest("/test", "", "GET", new Headers());

		expect(response.status).toBe(503);
		const body = (await response.json()) as any;
		expect(body.error?.message).toBe("No backends available");
	});

	test("should return 502 on connection error", async () => {
		const backend = { name: "unreachable", baseUrl: "http://127.0.0.1:1" };
		const monitor = new HealthMonitor([backend]);
		const backends: LoadBalancerBackend[] = [
			{
				name: backend.name,
				apiClient: new BackendAPIClient(backend),
			},
		];
		const lb = new LoadBalancer("test", "/", backends, monitor);
		const response = await lb.forwardRequest("/v1/models", "", "GET", new Headers());

		expect(response.status).toBe(502);
		const body = (await response.json()) as any;
		expect(body.error?.message).toBe("Bad Gateway");
	});

	test("should forward request to a real backend and return response", async () => {
		const fake = new FakeOpenAICompatibleAPI();
		await fake.start();

		const backend = { name: "fake-backend", baseUrl: fake.baseUrl };
		const monitor = new HealthMonitor([backend]);
		const backends: LoadBalancerBackend[] = [
			{
				name: backend.name,
				apiClient: new BackendAPIClient(backend),
			},
		];
		const lb = new LoadBalancer("test", "/", backends, monitor);
		const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] });

		const response = await lb.forwardRequest(
			"/chat/completions",
			"",
			"POST",
			new Headers({ "Content-Type": "application/json" }),
			body,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Load-Balancer-Backend")).toBe("fake-backend");
		const json = (await response.json()) as Record<string, unknown>;
		expect(json.object).toBe("chat.completion");
		expect(fake.requests.length).toBeGreaterThanOrEqual(1);

		await fake.stop();
	});

	test("should mark backend unhealthy after error response", async () => {
		const fake = new FakeOpenAICompatibleAPI();
		await fake.start();
		fake.setNextError(500, JSON.stringify({ error: "Backend error" }));

		const backend = { name: "sick-backend", baseUrl: fake.baseUrl };
		const monitor = new HealthMonitor([backend]);
		const backends: LoadBalancerBackend[] = [
			{
				name: backend.name,
				apiClient: new BackendAPIClient(backend),
			},
		];
		const lb = new LoadBalancer("test", "/", backends, monitor);

		await lb.forwardRequest("/v1/models", "", "GET", new Headers());
		expect(monitor.isHealthy(0)).toBe(false);

		await fake.stop();
	});

	test("should mark backend unhealthy after connection error", async () => {
		const backend = { name: "die", baseUrl: "http://127.0.0.1:1" };
		const monitor = new HealthMonitor([backend]);
		const backends: LoadBalancerBackend[] = [
			{
				name: backend.name,
				apiClient: new BackendAPIClient(backend),
			},
		];
		const lb = new LoadBalancer("test", "/", backends, monitor);

		await lb.forwardRequest("/models", "", "GET", new Headers());
		expect(monitor.isHealthy(0)).toBe(false);
	});

	test("should strip prefix before forwarding", async () => {
		const fake = new FakeOpenAICompatibleAPI();
		await fake.start();

		const backend = { name: "fake", baseUrl: fake.baseUrl };
		const monitor = new HealthMonitor([backend]);
		const backends: LoadBalancerBackend[] = [
			{
				name: backend.name,
				apiClient: new BackendAPIClient(backend),
			},
		];
		const lb = new LoadBalancer("test", "/custom-prefix", backends, monitor);

		await lb.forwardRequest("/custom-prefix/models", "?detail=true", "GET", new Headers());

		const recorded = fake.requests.find((r) => r.method === "GET");
		expect(recorded).toBeDefined();
		expect(recorded!.pathname).toBe("/v1/models");

		await fake.stop();
	});
});

describe("Provider — forwardRequest", () => {
	test("should delegate to LoadBalancer and return response", async () => {
		const fake = new FakeOpenAICompatibleAPI();
		await fake.start();

		const provider = new Provider({
			id: "test-provider",
			name: "Test Provider",
			backends: [{ name: "fake-backend", baseUrl: fake.baseUrl }],
		});

		const body = JSON.stringify({ model: "gpt-4", messages: [] });
		const response = await provider.forwardRequest(
			"/chat/completions",
			"",
			"POST",
			new Headers({ "Content-Type": "application/json" }),
			body,
		);

		expect(response.status).toBe(200);
		const json = (await response.json()) as Record<string, unknown>;
		expect(json.object).toBe("chat.completion");

		await fake.stop();
	});
});

describe("HealthMonitor — integration", () => {
	test("should track health across multiple backends", () => {
		const backends = [
			{ name: "a", baseUrl: "http://a.com" },
			{ name: "b", baseUrl: "http://b.com" },
			{ name: "c", baseUrl: "http://c.com" },
		];
		const monitor = new HealthMonitor(backends);

		expect(monitor.getHealthyBackends()).toEqual([0, 1, 2]);

		monitor.setHealthyness(0, false);
		monitor.setHealthyness(2, false);

		expect(monitor.getHealthyBackends()).toEqual([1]);
		expect(monitor.isHealthy(0)).toBe(false);
		expect(monitor.isHealthy(1)).toBe(true);
		expect(monitor.isHealthy(2)).toBe(false);

		monitor.setHealthyness(0, true);
		expect(monitor.getHealthyBackends()).toEqual([0, 1]);
	});

	test("getAllStats should reflect current state", () => {
		const backends = [
			{ name: "a", baseUrl: "http://a.com" },
			{ name: "b", baseUrl: "http://b.com" },
		];
		const monitor = new HealthMonitor(backends);

		monitor.setHealthyness(1, false);
		const stats = monitor.getAllStats();

		expect(stats[0]?.healthy).toBe(true);
		expect(stats[1]?.healthy).toBe(false);

		const unhealthy = stats[1];
		if (!unhealthy) throw new Error("expected stat");
		if (unhealthy.healthy === false) {
			expect(unhealthy.timeoutEnds).toBeGreaterThan(Date.now() - 100);
			expect(unhealthy.consecutiveFailures).toBeGreaterThanOrEqual(1);
		} else {
			throw new Error("expected unhealthy");
		}
	});
});
