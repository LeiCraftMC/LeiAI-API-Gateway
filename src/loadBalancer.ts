import type { Backend, ProviderConfig } from "./utils/config";
import type { HealthMonitor, MonitoredBackend } from "./healthCheck";
import { createHttpClient } from "./httpClient";
import { Logger } from "./utils/logger";

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
]);

/** Build a backend-relative path by stripping the provider prefix. */
function stripPrefix(pathname: string, prefix: string): string {
	const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
	if (normalizedPrefix === "/") return pathname;
	return pathname.startsWith(`${normalizedPrefix}/`)
		? pathname.slice(normalizedPrefix.length)
		: pathname === normalizedPrefix
			? "/"
			: pathname;
}

export class LoadBalancer {
	private readonly backends: Backend[];
	private currentIndex = 0;

	constructor(
		private readonly providerName: string,
		private readonly prefix: string,
		backends: Backend[],
		private readonly healthMonitor: HealthMonitor
	) {
		this.backends = backends;
	}

	getNextBackend(): Backend | null {
		const healthyBackends = this.backends.filter((b) =>
			this.healthMonitor.isHealthy(this.providerName, b.name)
		);

		const pool = healthyBackends.length > 0 ? healthyBackends : this.backends;

		if (pool.length === 0) {
			return null;
		}

		if (healthyBackends.length === 0) {
			Logger.warn(
				`Provider "${this.providerName}": no healthy backends available, falling back to all backends`
			);
		}

		const backend = pool[this.currentIndex % pool.length] ?? null;
		this.currentIndex = (this.currentIndex + 1) % pool.length;
		return backend;
	}

	getAllBackends(): Backend[] {
		return this.backends;
	}

	async forwardRequest(
		pathname: string,
		searchParams: string,
		method: string,
		headers: Headers,
		body?: string
	): Promise<Response> {
		const backend = this.getNextBackend();

		if (!backend) {
			return new Response(JSON.stringify({ error: "No backends available" }), {
				status: 503,
				headers: { "Content-Type": "application/json" },
			});
		}

		const backendPath = stripPrefix(pathname, this.prefix);
		const backendUrl = new URL(backendPath + searchParams, backend.url).toString();

		const forwardHeaders = this.buildForwardHeaders(headers);
		const client = createHttpClient(backend);

		try {
			const backendResponse = await client.request(backendUrl, {
				method,
				headers: forwardHeaders,
				body,
			});

			if (!backendResponse.ok) {
				const errorBody =
					backendResponse instanceof Response
						? await backendResponse.text().catch(() => "<unreadable body>")
						: backendResponse.body;
				Logger.error(
					`Provider "${this.providerName}" backend "${backend.name}" returned error: ` +
					`status=${backendResponse.status}, body=${errorBody.slice(0, 500)}`
				);
				return this.errorResponse(500, "Internal Server Error");
			}

			if (backendResponse instanceof Response) {
				const newHeaders = new Headers(backendResponse.headers);
				newHeaders.set("X-Load-Balancer-Backend", backend.name);
				return new Response(backendResponse.body, {
					status: backendResponse.status,
					statusText: backendResponse.statusText,
					headers: newHeaders,
				});
			}

			return new Response(backendResponse.body, {
				status: backendResponse.status,
				headers: {
					"Content-Type": backendResponse.headers.get("Content-Type") || "application/json",
					"X-Load-Balancer-Backend": backend.name,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(
				`Provider "${this.providerName}" backend "${backend.name}" request failed: ${message}`
			);
			return this.errorResponse(500, "Internal Server Error");
		}
	}

	private buildForwardHeaders(headers: Headers): Headers {
		const forwardHeaders = new Headers();

		headers.forEach((value, key) => {
			if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
				forwardHeaders.set(key, value);
			}
		});

		// Let the HTTP client set the correct host for the selected backend.
		forwardHeaders.delete("host");

		return forwardHeaders;
	}

	private errorResponse(status: number, message: string): Response {
		return new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}
}

export class Provider {
	public readonly name: string;
	public readonly prefix: string;
	public readonly backends: Backend[];
	public readonly loadBalancer: LoadBalancer;

	constructor(config: ProviderConfig, healthMonitor: HealthMonitor) {
		this.name = config.name;
		this.prefix = config.prefix || `/${config.name}`;
		this.backends = config.backends;
		this.loadBalancer = new LoadBalancer(this.name, this.prefix, this.backends, healthMonitor);
	}

	matches(pathname: string): boolean {
		if (this.prefix === "/") return true;
		return pathname === this.prefix || pathname.startsWith(`${this.prefix}/`);
	}

	async forwardRequest(
		pathname: string,
		searchParams: string,
		method: string,
		headers: Headers,
		body?: string
	): Promise<Response> {
		return this.loadBalancer.forwardRequest(
			pathname,
			searchParams,
			method,
			headers,
			body
		);
	}
}
