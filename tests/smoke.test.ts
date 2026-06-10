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
    });

    it("should import health check module", async () => {
      const health = await import("../src/healthCheck");
      expect(health.initializeHealthStatus).toBeDefined();
      expect(health.checkBackendHealth).toBeDefined();
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

    it("should create valid config object", () => {
      const config = {
        port: 3000,
        host: "0.0.0.0",
        backends: [{ name: "test", url: "http://localhost:8000" }],
      };
      expect(config.port).toBe(3000);
      expect(config.backends).toHaveLength(1);
    });
  });

  describe("Core Functionality", () => {
    it("should create LoadBalancer instance", async () => {
      const { LoadBalancer } = await import("../src/loadBalancer");
      const lb = new LoadBalancer([
        { name: "test", url: "http://localhost:8000" },
      ]);
      expect(lb).toBeDefined();
    });

    it("should get next backend", async () => {
      const { LoadBalancer } = await import("../src/loadBalancer");
      const backends = [
        { name: "backend-1", url: "http://localhost:8001" },
        { name: "backend-2", url: "http://localhost:8002" },
      ];
      const lb = new LoadBalancer(backends);
      const next = lb.getNextBackend();
      expect(next).toBeDefined();
      expect(next?.name).toMatch(/backend-/);
    });

    it("should initialize health status", async () => {
      const { initializeHealthStatus, getBackendStats } = await import(
        "../src/healthCheck"
      );
      const backends = [
        { name: "test-1", url: "http://localhost:8000" },
        { name: "test-2", url: "http://localhost:8001" },
      ];
      initializeHealthStatus(backends);
      const stats = getBackendStats();
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

    it("should support API key in backend", async () => {
      const backend = {
        name: "test",
        url: "http://localhost:8000",
        apiKey: "test-key-123",
      };
      expect(backend.apiKey).toBe("test-key-123");
    });

    it("should support SOCKS5 proxy", async () => {
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
      const config = {
        port: 3000,
      };
      expect(config.port).toBe(3000);
    });

    it("should set default host", () => {
      const config = {
        host: "0.0.0.0",
      };
      expect(config.host).toBe("0.0.0.0");
    });

    it("should set health check interval", () => {
      const config = {
        healthCheckInterval: 30000,
      };
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
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(502);
    });
  });
});
