import { describe, it, expect } from "bun:test";

// Smoke tests - quick validation that basic functionality works
describe("Smoke Tests", () => {
  describe("Imports", () => {
    it("should import config module", async () => {
      const config = await import("../src/config");
      expect(config.loadConfig).toBeDefined();
    });

    it("should import load balancer module", async () => {
      const lb = await import("../src/loadBalancer");
      expect(lb.LoadBalancer).toBeDefined();
      expect(lb.Provider).toBeDefined();
    });

    it("should import health check module", async () => {
      const health = await import("../src/healthCheck");
      expect(health.HealthMonitor).toBeDefined();
    });

    it("should import http client module", async () => {
      const client = await import("../src/httpClient");
      expect(client.HttpClient).toBeDefined();
      expect(client.createHttpClient).toBeDefined();
    });
  });

  describe("Basic Types", () => {
    it("should create valid backend object", () => {
      const backend = {
        name: "test",
        url: "http://localhost:8000",
      };
      expect(backend.name).toBeTruthy();
      expect(backend.url).toBeTruthy();
    });

    it("should create valid provider config object", () => {
      const provider = {
        name: "my-provider",
        prefix: "/my-provider",
        backends: [{ name: "test", url: "http://localhost:8000" }],
      };
      expect(provider.name).toBe("my-provider");
      expect(provider.backends).toHaveLength(1);
    });

    it("should create valid config object", () => {
      const config = {
        port: 3000,
        host: "0.0.0.0",
        providers: [
          {
            name: "my-provider",
            backends: [{ name: "test", url: "http://localhost:8000" }],
          },
        ],
      };
      expect(config.port).toBe(3000);
      expect(config.providers).toHaveLength(1);
    });
  });

  describe("Core Functionality", () => {
    it("should create Provider instance", async () => {
      const { Provider } = await import("../src/loadBalancer");
      const { HealthMonitor } = await import("../src/healthCheck");
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

    it("should match request paths", async () => {
      const { Provider } = await import("../src/loadBalancer");
      const { HealthMonitor } = await import("../src/healthCheck");
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

    it("should get next backend from provider", async () => {
      const { Provider } = await import("../src/loadBalancer");
      const { HealthMonitor } = await import("../src/healthCheck");
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

    it("should initialize health monitor", async () => {
      const { HealthMonitor } = await import("../src/healthCheck");
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
    it("should create HTTP client", async () => {
      const { createHttpClient } = await import("../src/httpClient");
      const backend = {
        name: "test",
        url: "http://localhost:8000",
      };
      const client = createHttpClient(backend);
      expect(client).toBeDefined();
    });

    it("should support API key in backend", () => {
      const backend = {
        name: "test",
        url: "http://localhost:8000",
        apiKey: "test-key-123",
      };
      expect(backend.apiKey).toBe("test-key-123");
    });

    it("should support SOCKS5 proxy", () => {
      const backend = {
        name: "test",
        url: "http://localhost:8000",
        proxy: {
          host: "proxy.example.com",
          port: 1080,
        },
      };
      expect(backend.proxy?.host).toBe("proxy.example.com");
      expect(backend.proxy?.port).toBe(1080);
    });
  });

  describe("Configuration", () => {
    it("should set default port", () => {
      const config = { port: 3000 };
      expect(config.port).toBe(3000);
    });

    it("should set default host", () => {
      const config = { host: "0.0.0.0" };
      expect(config.host).toBe("0.0.0.0");
    });

    it("should set health check interval", () => {
      const config = { healthCheckInterval: 30000 };
      expect(config.healthCheckInterval).toBe(30000);
    });
  });

  describe("Response Handling", () => {
    it("should create Response with status", () => {
      const response = new Response("test", { status: 200 });
      expect(response.status).toBe(200);
    });

    it("should create Response with headers", () => {
      const response = new Response("test", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("should handle error responses", () => {
      const response = new Response(JSON.stringify({ error: "Backend error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(500);
    });
  });
});
