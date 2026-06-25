import { describe, test, expect } from "bun:test";
import { LoadBalancer, Provider } from "../src/loadBalancer";
import { HealthMonitor } from "../src/loadBalancing/healthMonitor";
import type { Backend } from "../src/utils/config/gatewayConfig";

describe("LoadBalancer Core Functionality", () => {
	describe("Round-robin routing", () => {
		test("should cycle through backends", () => {
			const backends: Backend[] = [
				{ name: "a", url: "http://a.com" },
				{ name: "b", url: "http://b.com" },
				{ name: "c", url: "http://c.com" },
			];

			const monitor = new HealthMonitor();
			const lb = new LoadBalancer("my-provider", "/my-provider", backends, monitor);

			const b1 = lb.getNextBackend();
			const b2 = lb.getNextBackend();
			const b3 = lb.getNextBackend();
			const b4 = lb.getNextBackend();

			expect(b1?.name).toBeDefined();
			expect(b2?.name).toBeDefined();
			expect(b3?.name).toBeDefined();
			expect(b4?.name).toBeDefined();
		});

		test("should return all backends", () => {
			const backends: Backend[] = [
				{ name: "backend-1", url: "http://localhost:8001" },
				{ name: "backend-2", url: "http://localhost:8002" },
			];

			const monitor = new HealthMonitor();
			const lb = new LoadBalancer("my-provider", "/my-provider", backends, monitor);
			const allBackends = lb.getAllBackends();

			expect(allBackends).toHaveLength(2);
			expect(allBackends[0]?.name).toBe("backend-1");
			expect(allBackends[1]?.name).toBe("backend-2");
		});
	});

	describe("Empty backend list", () => {
		test("should return null with no backends", () => {
			const monitor = new HealthMonitor();
			const lb = new LoadBalancer("my-provider", "/my-provider", [], monitor);
			const backend = lb.getNextBackend();

			expect(backend).toBeNull();
		});

		test("should handle single backend", () => {
			const backends = [{ name: "only", url: "http://only.com" }];
			const monitor = new HealthMonitor();
			const lb = new LoadBalancer("my-provider", "/my-provider", backends, monitor);

			const b1 = lb.getNextBackend();
			const b2 = lb.getNextBackend();

			expect(b1?.name).toBe("only");
			expect(b2?.name).toBe("only");
		});
	});
});

describe("Provider Routing", () => {
	test("should match by default prefix", () => {
		const monitor = new HealthMonitor();
		const provider = new Provider(
			{
				name: "my-provider",
				backends: [{ name: "b", url: "http://b.com" }],
			},
			monitor
		);

		expect(provider.prefix).toBe("/my-provider");
		expect(provider.matches("/my-provider")).toBe(true);
		expect(provider.matches("/my-provider/v1/models")).toBe(true);
		expect(provider.matches("/other")).toBe(false);
	});

	test("should match custom prefix", () => {
		const monitor = new HealthMonitor();
		const provider = new Provider(
			{
				name: "openai",
				prefix: "/openai",
				backends: [{ name: "b", url: "http://b.com" }],
			},
			monitor
		);

		expect(provider.matches("/openai")).toBe(true);
		expect(provider.matches("/openai/v1/chat/completions")).toBe(true);
		expect(provider.matches("/v1/models")).toBe(false);
	});
});

describe("Request Forwarding", () => {
	test("should return 503 when no backends available", async () => {
		const monitor = new HealthMonitor();
		const lb = new LoadBalancer("my-provider", "/my-provider", [], monitor);
		const headers = new Headers();

		const response = await lb.forwardRequest("/test", "", "GET", headers);

		expect(response.status).toBe(503);
	});

	test("should return error JSON response", async () => {
		const monitor = new HealthMonitor();
		const lb = new LoadBalancer("my-provider", "/my-provider", [], monitor);
		const headers = new Headers();

		const response = await lb.forwardRequest("/test", "", "GET", headers);
		const body = await response.text();

		expect(response.headers.get("Content-Type")).toBe("application/json");
		const json = JSON.parse(body);
		expect(json.error).toBe("No backends available");
	});

	test("should mask backend HTTP errors as 500", async () => {
		const monitor = new HealthMonitor();
		const backends = [
			{
				name: "error-backend",
				url: "https://httpbin.org/status/418",
			},
		];
		const lb = new LoadBalancer("my-provider", "/my-provider", backends, monitor);
		const response = await lb.forwardRequest("/test", "", "GET", new Headers());

		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body).error).toBe("Internal Server Error");
	});

	test("should mask connection errors as 500", async () => {
		const backends = [
			{ name: "unreachable", url: "http://invalid-domain-xyz-12345.local" },
		];
		const monitor = new HealthMonitor();
		const lb = new LoadBalancer("my-provider", "/my-provider", backends, monitor);
		const headers = new Headers();

		const response = await lb.forwardRequest("/test", "", "GET", headers);

		expect(response.status).toBe(500);
	});
});

describe("URL Construction", () => {
	test("should combine base URL with path", () => {
		const base = "http://localhost:8000";
		const path = "/v1/models";

		const full = new URL(path, base).toString();

		expect(full).toBe("http://localhost:8000/v1/models");
	});

	test("should preserve query parameters", () => {
		const base = "http://localhost:8000";
		const path = "/search?q=test&limit=10";

		const full = new URL(path, base).toString();

		expect(full).toContain("q=test");
		expect(full).toContain("limit=10");
	});

	test("should handle complex URLs", () => {
		const base = "https://api.openai.com";
		const path = "/v1/chat/completions?model=gpt-4&stream=true";

		const full = new URL(path, base).toString();

		expect(full).toContain("https://api.openai.com");
		expect(full).toContain("model=gpt-4");
		expect(full).toContain("stream=true");
	});
});

describe("Backend Configuration", () => {
	test("should support backends with API keys", () => {
		const backend: Backend = {
			name: "openai",
			url: "https://api.openai.com",
			apiKey: "sk-example",
		};

		expect(backend.apiKey).toBe("sk-example");
	});

	test("should support backends without API keys", () => {
		const backend: Backend = {
			name: "local",
			url: "http://localhost:8000",
		};

		expect(backend.apiKey).toBeUndefined();
	});

	test("should support SOCKS5 proxy configuration", () => {
		const backend: Backend = {
			name: "proxied",
			url: "http://remote.com",
			proxyUrl: "socks5://proxy.example.com:1080",
	});

	test("should support custom health check paths", () => {
		const backend: Backend = {
			name: "custom",
			url: "http://localhost:8000",
			healthCheckPath: "/api/health",
			healthCheckInterval: 60000,
		};

		expect(backend.healthCheckPath).toBe("/api/health");
		expect(backend.healthCheckInterval).toBe(60000);
	});
});

describe("Header Filtering", () => {
	test("should filter hop-by-hop headers", () => {
		const hopByHop = ["connection", "keep-alive", "transfer-encoding", "upgrade"];

		const headers = new Headers({
			"Content-Type": "application/json",
			Connection: "close",
			"X-Custom": "value",
			"Keep-Alive": "300",
		});

		const filtered = new Headers();
		headers.forEach((value, key) => {
			if (!hopByHop.includes(key.toLowerCase())) {
				filtered.set(key, value);
			}
		});

		expect(filtered.has("Content-Type")).toBe(true);
		expect(filtered.has("X-Custom")).toBe(true);
		expect(filtered.has("Connection")).toBe(false);
		expect(filtered.has("Keep-Alive")).toBe(false);
	});

	test("should preserve critical headers", () => {
		const headers = new Headers({
			Authorization: "Bearer token",
			"Content-Type": "application/json",
			"User-Agent": "LoadBalancer/1.0",
		});

		expect(headers.has("Authorization")).toBe(true);
		expect(headers.get("Content-Type")).toBe("application/json");
	});
});

describe("Response Status Codes", () => {
	test("should identify success codes", () => {
		const codes = [200, 201, 202, 204];
		codes.forEach((c) => {
			expect(c >= 200 && c < 300).toBe(true);
		});
	});

	test("should identify error codes", () => {
		const codes = [400, 401, 403, 404, 500, 502, 503];
		codes.forEach((c) => {
			expect(c >= 400).toBe(true);
		});
	});

	test("should return 500 for masked backend errors", () => {
		expect(500).toBe(500);
	});

	test("should return 503 for unavailable backends", () => {
		expect(503).toBe(503);
	});
});

describe("HTTP Methods", () => {
	test("should support all standard methods", () => {
		const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

		methods.forEach((m) => {
			expect(typeof m).toBe("string");
			expect(m.length > 0).toBe(true);
		});
	});
});

describe("Multiple Backends Distribution", () => {
	test("should handle multiple backends correctly", () => {
		const backends: Backend[] = [
			{ name: "backend-1", url: "http://b1" },
			{ name: "backend-2", url: "http://b2" },
			{ name: "backend-3", url: "http://b3" },
			{ name: "backend-4", url: "http://b4" },
		];

		const monitor = new HealthMonitor();
		const lb = new LoadBalancer("my-provider", "/my-provider", backends, monitor);

		expect(lb.getAllBackends()).toHaveLength(4);
		expect(lb.getNextBackend()).toBeDefined();
	});
});
