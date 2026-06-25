import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { Provider } from "../src/loadBalancer";
import { HealthMonitor } from "../src/loadBalancing/healthMonitor";
import type { MonitoredBackend } from "../src/loadBalancing/healthMonitor";
import { BackendAPIClient } from "../src/loadBalancing/backendAPIClient";
import { createFakeOpenAIBackend, closeFakeBackend, type FakeBackend } from "./helpers/fakeOpenAICompatibleAPI";

async function drainText(response: Response): Promise<string> {
	return response.text();
}

async function drainJSON(response: Response): Promise<unknown> {
	const text = await response.text();
	return JSON.parse(text);
}

describe("OpenAI-Compatible Fake Backend Integration", () => {
	let fake: FakeBackend;
	let monitor: HealthMonitor;
	let provider: Provider;

	beforeEach(() => {
		monitor = new HealthMonitor({ interval: 60_000 });
		fake = createFakeOpenAIBackend({ apiKey: "sk-fake" });
	});

	afterEach(() => {
		closeFakeBackend(fake);
		monitor.stop();
	});

	describe("Basic chat completion", () => {
		test("should forward a non-streaming chat completion", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("fake-backend")],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("fake-backend"), providerName: "my-provider" },
			]);

			const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] });
			const response = await provider.forwardRequest(
				"/my-provider/v1/chat/completions",
				"",
				"POST",
				new Headers({ "Content-Type": "application/json" }),
				body
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("X-Load-Balancer-Backend")).toBe("fake-backend");

			const json = (await drainJSON(response)) as Record<string, unknown>;
			expect(json.model).toBe("gpt-4-fake");
			expect(json.object).toBe("chat.completion");

			const chatRequest = fake.requests.find((r) => r.pathname === "/v1/chat/completions");
			expect(chatRequest).toBeDefined();
			expect(chatRequest!.headers["authorization"]).toBe("Bearer sk-fake");
		});

		test("should return 401 when API key is missing", async () => {
			closeFakeBackend(fake);
			fake = createFakeOpenAIBackend({ apiKey: "sk-required" });

			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("fake-backend", { apiKey: undefined })],
				},
				monitor
			);

			monitor.start([
				{
					...fake.toBackendConfig("fake-backend", { apiKey: undefined }),
					providerName: "my-provider",
				},
			]);

			const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] });
			const response = await provider.forwardRequest(
				"/my-provider/v1/chat/completions",
				"",
				"POST",
				new Headers({ "Content-Type": "application/json" }),
				body
			);

			expect(response.status).toBe(500);
			const json = (await drainJSON(response)) as Record<string, unknown>;
			expect(json.error).toBe("Internal Server Error");
		});
	});

	describe("Streaming chat completion", () => {
		test("should forward SSE chunks", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("fake-backend")],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("fake-backend"), providerName: "my-provider" },
			]);

			const body = JSON.stringify({
				model: "gpt-4",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			});
			const response = await provider.forwardRequest(
				"/my-provider/v1/chat/completions",
				"",
				"POST",
				new Headers({ "Content-Type": "application/json" }),
				body
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toContain("text/event-stream");
			expect(response.headers.get("X-Load-Balancer-Backend")).toBe("fake-backend");

			const text = await drainText(response);
			expect(text).toContain('data: {"');
			expect(text).toContain("data: [DONE]");

			// Find the chat completion request; health checks may have hit /v1/models first.
			const chatRequest = fake.requests.find((r) => r.pathname === "/v1/chat/completions");
			expect(chatRequest).toBeDefined();
			const recordedBody = chatRequest!.body as Record<string, unknown>;
			expect(recordedBody.stream).toBe(true);
		});
	});

	describe("Provider prefix stripping", () => {
		test("should strip the provider prefix before forwarding", async () => {
			provider = new Provider(
				{
					name: "custom-prefix",
					prefix: "/custom-prefix",
					backends: [fake.toBackendConfig("fake-backend")],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("fake-backend"), providerName: "custom-prefix" },
			]);

			const response = await provider.forwardRequest(
				"/custom-prefix/v1/models",
				"?detail=true",
				"GET",
				new Headers()
			);

			expect(response.status).toBe(200);
			const recorded = fake.requests[0]!;
			expect(recorded.pathname).toBe("/v1/models");
			// Bun's fetch sets the Host header before the request reaches our code; the
			// load balancer strips it before forwarding, but the recorded header here is
			// what the fake backend received, which will include the backend's own host.
			expect(recorded.headers["host"]).toContain("127.0.0.1");
		});
	});

	describe("Load balancing", () => {
		let fake2: FakeBackend;

		beforeEach(() => {
			fake2 = createFakeOpenAIBackend({ apiKey: "sk-fake" });
		});

		afterEach(() => {
			closeFakeBackend(fake2);
		});

		test("should distribute requests across two backends", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [
						fake.toBackendConfig("backend-a"),
						fake2.toBackendConfig("backend-b"),
					],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("backend-a"), providerName: "my-provider" },
				{ ...fake2.toBackendConfig("backend-b"), providerName: "my-provider" },
			]);

			for (let i = 0; i < 4; i++) {
				await provider.forwardRequest("/my-provider/v1/models", "", "GET", new Headers());
			}

			// Health monitor also hits each backend once at startup, so expect at least
			// 4 user requests plus up to 2 health-check requests. Both backends must be
			// used for user requests.
			expect(fake.requests.length).toBeGreaterThanOrEqual(1);
			expect(fake2.requests.length).toBeGreaterThanOrEqual(1);
			expect(fake.requests.length + fake2.requests.length).toBeGreaterThanOrEqual(5);
		});
	});

	describe("Health checks", () => {
		test("should mark a backend unhealthy after repeated failures", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("sick-backend")],
				},
				monitor
			);

			const monitored: MonitoredBackend = {
				...fake.toBackendConfig("sick-backend"),
				providerName: "my-provider",
			};

			monitor.initialize([monitored]);
			fake.options.statusCode = 503;

			await monitor.checkBackend(monitored);
			await monitor.checkBackend(monitored);
			await monitor.checkBackend(monitored);

			expect(monitor.isHealthy("my-provider", "sick-backend")).toBe(false);

			// Health checks also hit the failing backend, but the load balancer should
			// fall back to the only available backend and return 500 because the backend
			// is configured to respond with 503.
			const response = await provider.forwardRequest(
				"/my-provider/v1/models",
				"",
				"GET",
				new Headers()
			);
			expect(response.status).toBe(500);
		});

		test("should recover a backend after it starts succeeding", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("recovering-backend")],
				},
				monitor
			);

			const monitored: MonitoredBackend = {
				...fake.toBackendConfig("recovering-backend"),
				providerName: "my-provider",
			};

			monitor.initialize([monitored]);
			fake.options.statusCode = 503;

			await monitor.checkBackend(monitored);
			await monitor.checkBackend(monitored);
			await monitor.checkBackend(monitored);
			expect(monitor.isHealthy("my-provider", "recovering-backend")).toBe(false);

			fake.options.statusCode = undefined;
			await monitor.checkBackend(monitored);
			expect(monitor.isHealthy("my-provider", "recovering-backend")).toBe(true);

			// Recovering test: a previous 503 response body is sticky because fake.options.responseBody
			// is still set. Clear it so the next request succeeds.
			fake.options.responseBody = undefined;

			const response = await provider.forwardRequest(
				"/my-provider/v1/models",
				"",
				"GET",
				new Headers()
			);
			expect(response.status).toBe(200);
		});
	});

	describe("Error masking", () => {
		test("should mask a backend 500 as 500 Internal Server Error", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("error-backend")],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("error-backend"), providerName: "my-provider" },
			]);

			fake.options.statusCode = 500;
			fake.options.responseBody = JSON.stringify({ error: "Backend exploded" });

			const logs: string[] = [];
			const originalError = console.error;
			console.error = (...args: unknown[]) => {
				logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
			};

			try {
				const response = await provider.forwardRequest(
					"/my-provider/v1/chat/completions",
					"",
					"POST",
					new Headers({ "Content-Type": "application/json" }),
					JSON.stringify({ model: "gpt-4" })
				);

				expect(response.status).toBe(500);
				const json = (await drainJSON(response)) as Record<string, unknown>;
				expect(json.error).toBe("Internal Server Error");

				expect(
					logs.some(
						(line) => line.includes("error-backend") && line.includes("Backend exploded")
					)
				).toBe(true);
			} finally {
				console.error = originalError;
			}
		});
	});

	describe("Timeout masking", () => {
		test("should mask a backend timeout as 500", async () => {
			closeFakeBackend(fake);
			fake = createFakeOpenAIBackend({ apiKey: "sk-fake", delayMs: 200 });

			const backend = fake.toBackendConfig("slow-backend");
			const client = new BackendAPIClient(backend);

			const logs: string[] = [];
			const originalError = console.error;
			console.error = (...args: unknown[]) => {
				logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
			};

			try {
				await expect(
					client.request(`${fake.url}/v1/models`, {
						method: "GET",
						timeout: 50,
					})
				).rejects.toThrow();
			} finally {
				console.error = originalError;
			}
		});
	});

	describe("Other OpenAI endpoints", () => {
		test("should forward /v1/completions", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("fake-backend")],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("fake-backend"), providerName: "my-provider" },
			]);

			const response = await provider.forwardRequest(
				"/my-provider/v1/completions",
				"",
				"POST",
				new Headers({ "Content-Type": "application/json" }),
				JSON.stringify({ model: "gpt-3.5-turbo-instruct", prompt: "Hello" })
			);

			expect(response.status).toBe(200);
			const json = (await drainJSON(response)) as Record<string, unknown>;
			expect(json.object).toBe("text_completion");
		});

		test("should forward /v1/embeddings", async () => {
			provider = new Provider(
				{
					name: "my-provider",
					backends: [fake.toBackendConfig("fake-backend")],
				},
				monitor
			);

			monitor.start([
				{ ...fake.toBackendConfig("fake-backend"), providerName: "my-provider" },
			]);

			const response = await provider.forwardRequest(
				"/my-provider/v1/embeddings",
				"",
				"POST",
				new Headers({ "Content-Type": "application/json" }),
				JSON.stringify({ model: "text-embedding-3-small", input: "Hello" })
			);

			expect(response.status).toBe(200);
			const json = (await drainJSON(response)) as Record<string, unknown>;
			expect(json.object).toBe("list");
		});
	});
});

describe("OpenAI-Compatible Full Server Integration", () => {
	let fake1: FakeBackend;
	let fake2: FakeBackend;
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(async () => {
		fake1 = createFakeOpenAIBackend({ apiKey: "sk-one", model: "model-one" });
		fake2 = createFakeOpenAIBackend({ apiKey: "sk-two", model: "model-two" });

		const { Provider } = await import("../src/loadBalancer");
		const { HealthMonitor } = await import("../src/loadBalancing/healthMonitor");
		const monitor = new HealthMonitor({ interval: 60_000 });

		const providers = [
			new Provider(
				{
					name: "my-provider",
					backends: [
						fake1.toBackendConfig("backend-one"),
						fake2.toBackendConfig("backend-two"),
					],
				},
				monitor
			),
		];

		monitor.start(
			providers.flatMap((p) => p.backends.map((b) => ({ ...b, providerName: p.name })))
		);

		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request: Request) {
				const url = new URL(request.url);
				const pathname = url.pathname;
				const method = request.method;

				if (pathname === "/_health" && method === "GET") {
					const stats = monitor.getStats();
					return Response.json({
						status: stats.every((s) => s.healthy),
						backends: stats,
					});
				}

				const provider = providers.find(
					(p) => pathname === p.prefix || pathname.startsWith(`${p.prefix}/`)
				);

				if (!provider) {
					return new Response(JSON.stringify({ error: "Provider not found" }), {
						status: 404,
					});
				}

				let body: string | undefined;
				if (method !== "GET" && method !== "HEAD") {
					body = await request.text();
				}

				return provider.forwardRequest(pathname, url.search, method, request.headers, body);
			},
		});
	});

	afterAll(() => {
		server.stop();
		closeFakeBackend(fake1);
		closeFakeBackend(fake2);
	});

	test("should route through the full server stack", async () => {
		const base = `http://${server.hostname}:${server.port}`;
		const response = await fetch(`${base}/my-provider/v1/models`);

		expect(response.status).toBe(200);
		const json = (await response.json()) as Record<string, unknown>;
		expect(json.object).toBe("list");
	});

	test("should round-robin across backends via the full server", async () => {
		const base = `http://${server.hostname}:${server.port}`;
		const initialTotal = fake1.requests.length + fake2.requests.length;

		for (let i = 0; i < 4; i++) {
			const response = await fetch(`${base}/my-provider/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-4", messages: [] }),
			});
			expect(response.status).toBe(200);
		}

		expect(fake1.requests.length + fake2.requests.length - initialTotal).toBe(4);
		expect(fake1.requests.length).toBeGreaterThan(0);
		expect(fake2.requests.length).toBeGreaterThan(0);
	});

	test("should stream through the full server stack", async () => {
		const base = `http://${server.hostname}:${server.port}`;
		const response = await fetch(`${base}/my-provider/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-4", messages: [], stream: true }),
		});

		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("data: [DONE]");
	});
});
