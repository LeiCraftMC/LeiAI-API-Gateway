import { loadConfig } from "./config";
import { HealthMonitor } from "./healthCheck";
import type { MonitoredBackend } from "./healthCheck";
import { Provider } from "./loadBalancer";

const configPath = process.env.CONFIG_PATH || "config.json";

function selectProvider(providers: Provider[], pathname: string): Provider | undefined {
  // Prefer the longest (most specific) matching prefix.
  let matched: Provider | undefined;
  for (const provider of providers) {
    if (provider.matches(pathname)) {
      if (!matched || provider.prefix.length > matched.prefix.length) {
        matched = provider;
      }
    }
  }
  return matched;
}

function createNotFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "Provider not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

async function main() {
  try {
    const config = await loadConfig(configPath);
    const healthMonitor = new HealthMonitor({
      interval: config.healthCheckInterval,
    });

    const providers = config.providers.map((providerConfig) =>
      new Provider(providerConfig, healthMonitor)
    );

    const monitoredBackends: MonitoredBackend[] = providers.flatMap((provider) =>
      provider.backends.map((backend) => ({
        ...backend,
        providerName: provider.name,
      }))
    );

    healthMonitor.start(monitoredBackends);

    const server = Bun.serve({
      hostname: config.host,
      port: config.port,
      async fetch(request: Request) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const method = request.method;

        if (pathname === "/_health" && method === "GET") {
          const stats = healthMonitor.getStats();
          const allHealthy = stats.every((s) => s.healthy);
          const status = allHealthy ? 200 : 503;

          return new Response(
            JSON.stringify({
              status: allHealthy ? "healthy" : "degraded",
              providers: config.providers.map((providerConfig) => ({
                name: providerConfig.name,
                prefix: providerConfig.prefix || `/${providerConfig.name}`,
                backends: stats
                  .filter((s) => s.providerName === providerConfig.name)
                  .map((s) => ({
                    name: s.backendName,
                    healthy: s.healthy,
                    lastCheck: s.lastCheck.toISOString(),
                    consecutiveFailures: s.consecutiveFailures,
                  })),
              })),
            }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const provider = selectProvider(providers, pathname);

        if (!provider) {
          return createNotFoundResponse();
        }

        let body: string | undefined;
        if (method !== "GET" && method !== "HEAD") {
          body = await request.text();
        }

        return provider.forwardRequest(
          pathname,
          url.search,
          method,
          request.headers,
          body
        );
      },
    });

    console.log(`🚀 AI Load Balancer started on http://${config.host}:${config.port}`);
    console.log(`📋 Configuration loaded from: ${configPath}`);
    console.log(`🔄 Providers:`);
    providers.forEach((provider, index) => {
      const proxySummary = provider.backends
        .map((b) => (b.proxy ? ` (via SOCKS5: ${b.proxy.host}:${b.proxy.port})` : ""))
        .join(", ");
      console.log(
        `   ${index + 1}. ${provider.name} [${provider.prefix}] -> ${provider.backends.length} backend(s)${proxySummary}`
      );
    });
    console.log(`💚 Health check endpoint: http://${config.host}:${config.port}/_health`);

    // Clean shutdown
    process.on("SIGINT", () => {
      console.log("\n🛑 Shutting down...");
      healthMonitor.stop();
      server.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start load balancer:", error);
    process.exit(1);
  }
}

main();
