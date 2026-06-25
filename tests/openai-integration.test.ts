import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { resolveModel, rewriteModelField, router as openaiRouter } from "../src/api/versions/v1/routes/openai";
import { authMiddlewareV1 } from "../src/api/versions/v1/auth";
import { ProviderManager } from "../src/loadBalancing/providerManager";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { ApiKeysConfig } from "../src/utils/config/apiKeysConfig";
import { FakeOpenAICompatibleAPI } from "./helpers/fakeOpenAICompatibleAPI";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { BodyInit, HeadersInit } from "bun";

/* ------------------------------------------------------------------ */
/*  resolveModel unit tests                                           */
/* ------------------------------------------------------------------ */

describe("resolveModel", () => {
	const testApiKey = "sk-test-unit";

	beforeAll(async () => {
		(ApiKeysConfig as any).config = { [testApiKey]: {} };
		(GatewayConfig as any).config = {
			providers: [],
			customModels: {
				mapping: { "fast-model": "provider-1/gpt-3.5" },
				ownerID: "test-owner",
			},
		};

		await ProviderManager.init(
			[
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: "http://localhost:18001/v1" }],
				},
				{
					id: "provider-2",
					name: "Provider Two",
					backends: [{ name: "b2", baseUrl: "http://localhost:18002/v1" }],
				},
			],
			false,
		);
	});

	afterAll(() => {
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;
	});

	test("should block direct provider/model access when custom mapping is active", () => {
		const result = resolveModel("provider-1/gpt-4");
		expect(result).toBeNull();
	});

	test("should block direct provider/model access even for known providers", () => {
		const result = resolveModel("provider-2/claude-3");
		expect(result).toBeNull();
	});

	test("should resolve custom model mapping alias", () => {
		const result = resolveModel("fast-model");
		expect(result).not.toBeNull();
		expect(result!.providerId).toBe("provider-1");
		expect(result!.bareModel).toBe("gpt-3.5");
	});

	test("should return null for unknown model", () => {
		const result = resolveModel("unknown-model-without-slash");
		expect(result).toBeNull();
	});

	test("should return null for unknown provider", () => {
		const result = resolveModel("nonexistent/gpt-4");
		expect(result).toBeNull();
	});

	test("should handle recursion for aliased aliases", () => {
		const config = (GatewayConfig as any).config;
		const originalMapping = { ...config.customModels.mapping };
		config.customModels.mapping["super-fast"] = "fast-model";

		const result = resolveModel("super-fast");
		expect(result).not.toBeNull();
		expect(result!.providerId).toBe("provider-1");
		expect(result!.bareModel).toBe("gpt-3.5");

		config.customModels.mapping = originalMapping;
	});
});

/* ------------------------------------------------------------------ */
/*  rewriteModelField unit tests                                      */
/* ------------------------------------------------------------------ */

describe("rewriteModelField", () => {
	test("should rewrite model field in JSON body", () => {
		const body = JSON.stringify({ model: "provider-1/gpt-4", messages: [] });
		const result = rewriteModelField(body, "gpt-4");
		const parsed = JSON.parse(result);
		expect(parsed.model).toBe("gpt-4");
		expect(parsed.messages).toEqual([]);
	});

	test("should not change model if already bare", () => {
		const body = JSON.stringify({ model: "gpt-4", messages: [] });
		const result = rewriteModelField(body, "gpt-4");
		const parsed = JSON.parse(result);
		expect(parsed.model).toBe("gpt-4");
	});

	test("should pass through non-JSON body unchanged", () => {
		const body = "not-json-at-all";
		const result = rewriteModelField(body, "gpt-4");
		expect(result).toBe("not-json-at-all");
	});

	test("should handle body without model field", () => {
		const body = JSON.stringify({ prompt: "hello" });
		const result = rewriteModelField(body, "gpt-4");
		const parsed = JSON.parse(result);
		expect(parsed.prompt).toBe("hello");
		expect(parsed.model).toBeUndefined();
	});

	test("should handle malformed JSON gracefully", () => {
		const body = "{model: broken}";
		const result = rewriteModelField(body, "gpt-4");
		expect(typeof result).toBe("string");
	});
});

/* ------------------------------------------------------------------ */
/*  v1 API Routes — full stack integration tests                       */
/* ------------------------------------------------------------------ */

describe("v1 API Routes", () => {
	let fakeBackend: FakeOpenAICompatibleAPI;
	let app: Hono;
	const testApiKey = "sk-v1-test-key";

	beforeAll(async () => {
		// Reset singletons
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;

		// Start fake backend — it responds at baseUrl/v1/... (no apiKey validation)
		fakeBackend = new FakeOpenAICompatibleAPI({ model: "gpt-4-fake" });
		await fakeBackend.start();

		// ApiKeysConfig: client keys the Hono auth middleware validates
		(ApiKeysConfig as any).config = {
			[testApiKey]: {},
			"sk-allowed": { allowedModels: ["provider-1/gpt-4"] },
			"sk-denied": { denyModels: ["provider-1/blocked-model"] },
		};

		// GatewayConfig: the upstream backend config used by ProviderManager
		(GatewayConfig as any).config = {
			providers: [
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }],
				},
			],
		};

		// Initialize ProviderManager (creates HealthMonitor + BackendAPIClient per backend)
		await ProviderManager.init(
			[
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }],
				},
			],
			false,
		);

		// Seed the model index by fetching /v1/models from the fake backend
		const provider = ProviderManager.getProvider("provider-1")!;
		await provider.models.refreshModelsList(
			provider.backends.map((b) => b.apiClient),
		);

		// Build the Hono test app (auth + v1 routes)
		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;
	});

	/* ---- Auth middleware ---- */

	test("should return 401 without Bearer token", async () => {
		const res = await app.fetch(new Request("http://test.local/v1/chat/completions", { method: "POST" }));
		expect(res.status).toBe(401);
		const body = (await res.json()) as any;
		expect(body.code).toBe(401);
	});

	test("should return 403 with invalid API key", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { Authorization: "Bearer sk-wrong-key" },
			}),
		);
		expect(res.status).toBe(403);
	});

	/* ---- GET /v1/models ---- */

	test("GET /v1/models should return model list", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { Authorization: `Bearer ${testApiKey}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.object).toBe("list");
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		const model = body.data.find((m: any) => m.id === "provider-1/gpt-4-fake");
		expect(model).toBeDefined();
	});

	test("GET /v1/models should filter by allowedModels", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { Authorization: "Bearer sk-allowed" },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.data.length).toBe(0);
	});

	/* ---- POST /v1/chat/completions ---- */

	test("POST /v1/chat/completions should forward request and return response", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${testApiKey}`,
				},
				body: JSON.stringify({
					model: "provider-1/gpt-4-fake",
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("chat.completion");
	});

	test("POST /v1/chat/completions should return 400 when model is missing", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${testApiKey}`,
				},
				body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
			}),
		);
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error?.message).toContain("Model is required");
	});

	test("POST /v1/chat/completions should return 404 for unknown model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${testApiKey}`,
				},
				body: JSON.stringify({
					model: "provider-999/nonexistent",
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(404);
		const json = (await res.json()) as any;
		expect(json.error?.message).toContain("not found");
	});

	test("POST /v1/chat/completions should return 403 for denied model", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer sk-denied",
				},
				body: JSON.stringify({
					model: "provider-1/blocked-model",
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(403);
		const json = (await res.json()) as any;
		expect(json.error?.message).toContain("not available");
	});

	test("POST /v1/chat/completions should return 403 when model not in allowed list", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer sk-allowed",
				},
				body: JSON.stringify({
					model: "provider-1/not-in-allowed",
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(403);
	});

	/* ---- POST /v1/completions ---- */

	test("POST /v1/completions should forward correctly", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${testApiKey}`,
				},
				body: JSON.stringify({
					model: "provider-1/gpt-4-fake",
					prompt: "Hello",
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("text_completion");
	});

	/* ---- POST /v1/embeddings ---- */

	test("POST /v1/embeddings should forward correctly", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/embeddings", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${testApiKey}`,
				},
				body: JSON.stringify({
					model: "provider-1/gpt-4-fake",
					input: "Hello",
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("list");
	});
});

/* ------------------------------------------------------------------ */
/*  v1 API with custom model mapping                                  */
/* ------------------------------------------------------------------ */

describe("v1 API Routes with custom model mapping", () => {
	let fakeBackend: FakeOpenAICompatibleAPI;
	let app: Hono;
	const testApiKey = "sk-custom-test";

	beforeAll(async () => {
		// Reset singletons
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;

		fakeBackend = new FakeOpenAICompatibleAPI({ model: "claude-3-opus" });
		await fakeBackend.start();

		(ApiKeysConfig as any).config = { [testApiKey]: {} };

		(GatewayConfig as any).config = {
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }],
				},
			],
			customModels: {
				mapping: {
					"claude-opus": "anthropic/claude-3-opus",
				},
				ownerID: "my-company",
			},
		};

		await ProviderManager.init(
			[
				{
					id: "anthropic",
					name: "Anthropic",
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }],
				},
			],
			false,
		);

		// Seed models
		const provider = ProviderManager.getProvider("anthropic")!;
		await provider.models.refreshModelsList(
			provider.backends.map((b) => b.apiClient),
		);

		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;
	});

	test("GET /v1/models should return custom model aliases", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/models", {
				headers: { Authorization: `Bearer ${testApiKey}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.object).toBe("list");

		const ids = body.data.map((m: any) => m.id);
		expect(ids).toContain("claude-opus");
		expect(ids).not.toContain("anthropic/claude-3-opus");

		const opus = body.data.find((m: any) => m.id === "claude-opus");
		expect(opus).toBeDefined();
		expect(opus.owned_by).toBe("my-company");
	});

	test("POST /v1/chat/completions with custom model alias should resolve and forward", async () => {
		const res = await app.fetch(
			new Request("http://test.local/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${testApiKey}`,
				},
				body: JSON.stringify({
					model: "claude-opus",
					messages: [{ role: "user", content: "Hi" }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("chat.completion");
	});
});

/* ------------------------------------------------------------------ */
/*  AI SDK integration — chat through createOpenAICompatible           */
/* ------------------------------------------------------------------ */

describe("AI SDK integration", () => {
	let fakeBackend: FakeOpenAICompatibleAPI;
	let app: Hono;
	const testApiKey = "sk-ai-sdk-key";

	beforeAll(async () => {
		// Reset singletons
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;

		// Start the fake upstream backend
		fakeBackend = new FakeOpenAICompatibleAPI({ model: "gpt-4-fake" });
		await fakeBackend.start();

		// ApiKeysConfig — the Hono auth middleware checks this
		(ApiKeysConfig as any).config = { [testApiKey]: {} };

		// GatewayConfig — tells ProviderManager where upstream backends live
		(GatewayConfig as any).config = {
			providers: [
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }],
				},
			],
		};

		// Init ProviderManager (creates HealthMonitor + BackendAPIClient)
		await ProviderManager.init(
			[
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: fakeBackend.baseUrl }],
				},
			],
			false,
		);

		// Build the Hono app (auth + v1 proxy routes)
		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
	});

	afterAll(async () => {
		await fakeBackend.stop();
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;
	});

	test("should generate a chat completion through the AI SDK", async () => {
		const provider = createOpenAICompatible({
			name: "leiai",
			baseURL: "http://leiai-gateway.local/v1",
			apiKey: testApiKey,
			// Route all SDK HTTP traffic through the Hono app
			fetch: (async (url, init) => {
				const urlStr = typeof url === "string" ? url : (url as Request).url;
				const reqUrl = new URL(urlStr);
				return app.fetch(
					new Request("http://leiai-gateway.local" + reqUrl.pathname + reqUrl.search, {
						method: init?.method ?? "POST",
						headers: init?.headers as HeadersInit,
						body: init?.body as BodyInit | undefined,
					}),
				);
			}) as typeof fetch,
		});

		const model = provider.chatModel("provider-1/gpt-4-fake");

		const result = await model.doGenerate({
			prompt: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "Hi" }],
				},
			],
			maxOutputTokens: 100,
		});

		const text = result.content.map((p: any) => p.text ?? "").join("");
		expect(text.length).toBeGreaterThan(0);
		expect(result.finishReason.unified).toBe("stop");

		// Verify the request actually went through the v1 API proxy
		expect(fakeBackend.requests.length).toBeGreaterThanOrEqual(1);
		const chatReq = fakeBackend.requests.find(
			(r) => r.pathname === "/v1/chat/completions",
		);
		expect(chatReq).toBeDefined();
	});

	test("should generate a streaming chat completion through the AI SDK", async () => {
		const provider = createOpenAICompatible({
			name: "leiai",
			baseURL: "http://leiai-gateway.local/v1",
			apiKey: testApiKey,
			fetch: (async (url, init) => {
				const urlStr = typeof url === "string" ? url : (url as Request).url;
				const reqUrl = new URL(urlStr);
				return app.fetch(
					new Request("http://leiai-gateway.local" + reqUrl.pathname + reqUrl.search, {
						method: init?.method ?? "POST",
						headers: init?.headers as HeadersInit,
						body: init?.body as BodyInit | undefined,
					}),
				);
			}) as typeof fetch,
		});

		const model = provider.chatModel("provider-1/gpt-4-fake");

		const result = await model.doStream({
			prompt: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "Hi" }],
				},
			],
			maxOutputTokens: 100,
		});

		// Collect all text from the stream
		const chunks: string[] = [];
		const reader = result.stream.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.type === "text-delta") {
				chunks.push((value as any).delta);
			}
		}

		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.join("")).toContain("Hello");
	});
});
