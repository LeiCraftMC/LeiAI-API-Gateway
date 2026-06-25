import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { resolveModel, rewriteModelField, router as openaiRouter } from "../src/api/versions/v1/routes/openai";
import { authMiddlewareV1 } from "../src/api/versions/v1/auth";
import { ProviderManager } from "../src/loadBalancing/providerManager";
import { GatewayConfig } from "../src/utils/config/gatewayConfig";
import { ApiKeysConfig } from "../src/utils/config/apiKeysConfig";
import { createFakeBackend } from "./helpers/fakeOpenAICompatibleAPI";

/* ------------------------------------------------------------------ */
/*  resolveModel unit tests                                           */
/* ------------------------------------------------------------------ */

describe("resolveModel", () => {
	const testApiKey = "sk-test-unit";

	beforeAll(async () => {
		// Set up ApiKeysConfig
		(ApiKeysConfig as any).config = { [testApiKey]: {} };

		// Set up GatewayConfig with custom model mapping
		(GatewayConfig as any).config = {
			providers: [],
			customModels: {
				mapping: { "fast-model": "provider-1/gpt-3.5" },
				ownerID: "test-owner",
			},
		};

		// Initialize ProviderManager (needs at least one provider for resolveModel to find)
		await ProviderManager.init(
			[
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: "http://localhost:18001" }],
				},
				{
					id: "provider-2",
					name: "Provider Two",
					backends: [{ name: "b2", baseUrl: "http://localhost:18002" }],
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

	test("should resolve a model with provider prefix", () => {
		const result = resolveModel("provider-1/gpt-4");
		expect(result).not.toBeNull();
		expect(result!.providerId).toBe("provider-1");
		expect(result!.providerName).toBe("Provider One");
		expect(result!.bareModel).toBe("gpt-4");
	});

	test("should resolve a model with a different provider", () => {
		const result = resolveModel("provider-2/claude-3");
		expect(result).not.toBeNull();
		expect(result!.providerId).toBe("provider-2");
		expect(result!.bareModel).toBe("claude-3");
	});

	test("should resolve custom model mapping alias", () => {
		// "fast-model" is mapped to "provider-1/gpt-3.5" in the config
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
		// Temporarily add a chained alias: "super-fast" -> "fast-model" -> "provider-1/gpt-3.5"
		const config = (GatewayConfig as any).config;
		const originalMapping = { ...config.customModels.mapping };
		config.customModels.mapping["super-fast"] = "fast-model";

		const result = resolveModel("super-fast");
		expect(result).not.toBeNull();
		expect(result!.providerId).toBe("provider-1");
		expect(result!.bareModel).toBe("gpt-3.5");

		// Restore
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
		// Undefined behavior for malformed JSON — either passes through or throws
		// The implementation catches and returns the original body
		expect(typeof result).toBe("string");
	});
});

/* ------------------------------------------------------------------ */
/*  v1 API Routes — full stack integration tests                       */
/* ------------------------------------------------------------------ */

describe("v1 API Routes", () => {
	let fakeBackend: ReturnType<typeof createFakeBackend>;
	let app: Hono;
	const testApiKey = "sk-v1-test-key";
	const testUrlBase = "http://test.local";

	beforeAll(async () => {
		// Reset singletons left by resolveModel tests
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;

		// 1. Start fake backend
		fakeBackend = createFakeBackend({ apiKey: "sk-fake-backend", model: "gpt-4-fake" });

		// 2. Initialize ApiKeysConfig with test keys
		(ApiKeysConfig as any).config = {
			[testApiKey]: {},
			"sk-allowed": { allowedModels: ["provider-1/gpt-4"] },
			"sk-denied": { denyModels: ["provider-1/blocked-model"] },
		};

		// 3. Initialize GatewayConfig (no custom models for basic route tests)
		(GatewayConfig as any).config = {
			providers: [
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: fakeBackend.url, apiKey: "sk-fake-backend" }],
				},
			],
		};

		// 4. Initialize ProviderManager
		await ProviderManager.init(
			[
				{
					id: "provider-1",
					name: "Provider One",
					backends: [{ name: "b1", baseUrl: fakeBackend.url, apiKey: "sk-fake-backend" }],
				},
			],
			false,
		);

		// 5. Seed the model index with data from the fake backend
		const providerData = ProviderManager.getProviderData("provider-1")!;
		await providerData.models.refreshModelsList(
			providerData.backends.map((b) => b.apiClient),
		);

		// 6. Build the test Hono app (v1 router + auth middleware)
		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
	});

	afterAll(() => {
		fakeBackend.close();
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;
	});

	/* ---- Auth middleware ---- */

	test("should return 401 without Bearer token", async () => {
		const res = await app.fetch(new Request(`${testUrlBase}/v1/chat/completions`, { method: "POST" }));
		expect(res.status).toBe(401);
		const body = (await res.json()) as any;
		expect(body.code).toBe(401);
	});

	test("should return 403 with invalid API key", async () => {
		const res = await app.fetch(
			new Request(`${testUrlBase}/v1/models`, {
				headers: { Authorization: "Bearer sk-wrong-key" },
			}),
		);
		expect(res.status).toBe(403);
	});

	/* ---- GET /v1/models ---- */

	test("GET /v1/models should return model list", async () => {
		const res = await app.fetch(
			new Request(`${testUrlBase}/v1/models`, {
				headers: { Authorization: `Bearer ${testApiKey}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.object).toBe("list");
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		// Should contain the seeded model "gpt-4-fake"
		const model = body.data.find((m: any) => m.id === "provider-1/gpt-4-fake");
		expect(model).toBeDefined();
	});

	test("GET /v1/models should filter by allowedModels", async () => {
		const res = await app.fetch(
			new Request(`${testUrlBase}/v1/models`, {
				headers: { Authorization: "Bearer sk-allowed" },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		// As the allowedModels config has "provider-1/gpt-4" but the fake backend
		// returns "gpt-4-fake" which appears as "provider-1/gpt-4-fake", no model
		// matches the filter. Expect an empty data array.
		expect(body.data.length).toBe(0);
	});

	/* ---- POST /v1/chat/completions ---- */

	test("POST /v1/chat/completions should forward request and return response", async () => {
		const res = await app.fetch(
			new Request(`${testUrlBase}/v1/chat/completions`, {
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
			new Request(`${testUrlBase}/v1/chat/completions`, {
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
			new Request(`${testUrlBase}/v1/chat/completions`, {
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
			new Request(`${testUrlBase}/v1/chat/completions`, {
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
			new Request(`${testUrlBase}/v1/chat/completions`, {
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
			new Request(`${testUrlBase}/v1/completions`, {
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
			new Request(`${testUrlBase}/v1/embeddings`, {
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
	let fakeBackend: ReturnType<typeof createFakeBackend>;
	let app: Hono;
	const testApiKey = "sk-custom-test";

	beforeAll(async () => {
		// Reset singletons
		(ProviderManager as any)._initialized = false;
		(ProviderManager as any).providers = new Map();
		(GatewayConfig as any).config = null;
		(ApiKeysConfig as any).config = null;

		fakeBackend = createFakeBackend({ apiKey: "sk-fake-backend", model: "claude-3-opus" });

		(ApiKeysConfig as any).config = { [testApiKey]: {} };

		// GatewayConfig with custom models and a custom owner ID
		(GatewayConfig as any).config = {
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					backends: [{ name: "b1", baseUrl: fakeBackend.url, apiKey: "sk-fake-backend" }],
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
					backends: [{ name: "b1", baseUrl: fakeBackend.url, apiKey: "sk-fake-backend" }],
				},
			],
			false, // needsModelFetching=false because customModels.mapping is defined
		);

		// Seed models
		const providerData = ProviderManager.getProviderData("anthropic")!;
		await providerData.models.refreshModelsList(
			providerData.backends.map((b) => b.apiClient),
		);

		app = new Hono();
		app.use("*", authMiddlewareV1);
		app.route("/v1", openaiRouter);
	});

	afterAll(() => {
		fakeBackend.close();
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

		// Should return the aliases, not the raw model IDs
		const ids = body.data.map((m: any) => m.id);
		expect(ids).toContain("claude-opus");
		expect(ids).not.toContain("anthropic/claude-3-opus");

		// Owner should be the custom owner ID
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
