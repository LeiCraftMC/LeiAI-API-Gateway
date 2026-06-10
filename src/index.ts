import { loadConfig } from "./config";
import { LoadBalancer } from "./loadBalancer";
import { startHealthCheckInterval, initializeHealthStatus, getBackendStats } from "./healthCheck";

const configPath = process.env.CONFIG_PATH || "config.json";

async function main() {
  try {
    const config = await loadConfig(configPath);
    const lb = new LoadBalancer(config.backends);

    initializeHealthStatus(config.backends);
    await startHealthCheckInterval(
      config.backends,
      config.healthCheckInterval || 30000
    );

    const server = Bun.serve({
      host: config.host,
      port: config.port,
      async fetch(request: Request) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const searchParams = url.search;
        const method = request.method;
        const headers = request.headers;

        // Health check endpoint for load balancer itself
        if (pathname === "/_health" && method === "GET") {
          const stats = getBackendStats();
          const allHealthy = stats.every((s) => s.healthy);
          const status = allHealthy ? 200 : 503;

          return new Response(
            JSON.stringify({
              status: allHealthy ? "healthy" : "degraded",
              backends: stats.map((s) => ({
                name: s.backendName,
                healthy: s.healthy,
                lastCheck: s.lastCheck.toISOString(),
                consecutiveFailures: s.consecutiveFailures,
              })),
            }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Forward all other requests to backends
        let body: string | undefined;
        if (request.method !== "GET" && request.method !== "HEAD") {
          body = await request.text();
        }

        return lb.forwardRequest(pathname, searchParams, method, headers, body);
      },
    });

    console.log(`🚀 AI Load Balancer started on http://${config.host}:${config.port}`);
    console.log(`📋 Configuration loaded from: ${configPath}`);
    console.log(`🔄 Round-robin balancing across ${config.backends.length} backend(s):`);
    config.backends.forEach((backend, index) => {
      const proxy = backend.proxy ? ` (via SOCKS5: ${backend.proxy.host}:${backend.proxy.port})` : "";
      console.log(`   ${index + 1}. ${backend.name}: ${backend.url}${proxy}`);
    });
    console.log(`💚 Health check endpoint: http://${config.host}:${config.port}/_health`);
  } catch (error) {
    console.error("Failed to start load balancer:", error);
    process.exit(1);
  }
}

main();
