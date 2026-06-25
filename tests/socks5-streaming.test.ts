import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { BackendAPIClient } from "../src/loadBalancing/backendAPIClient";
import { FakeOpenAICompatibleAPI } from "./helpers/fakeOpenAICompatibleAPI";
import { Socks5Server } from "./helpers/socks5server";
import type { GatewayConfig } from "../src/utils/config/gatewayConfig";

async function drainText(response: Response): Promise<string> {
	return response.text();
}

describe("SOCKS5 Streaming with real servers", () => {
	let fakeApi: FakeOpenAICompatibleAPI;
	let socks5: Socks5Server;
	let backend: GatewayConfig.Types.ProviderBackend;

	beforeAll(async () => {
		socks5 = new Socks5Server();
		await socks5.start();
		const proxyUrl = socks5.getUrl();

		fakeApi = new FakeOpenAICompatibleAPI();
		const apiUrl = await fakeApi.start();

		backend = {
			name: "socks-proxied-backend",
			baseUrl: apiUrl,
			proxyUrl,
		};
	});

	afterAll(async () => {
		await fakeApi.stop();
		await socks5.stop();
	});

	test("should forward a non-streaming request through SOCKS5", async () => {
		const client = new BackendAPIClient(backend);

		const response = await client.request(`/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-4",
				messages: [{ role: "user", content: "Hi" }],
			}),
		});

		expect(response.status).toBe(200);
		// @ts-ignore
		const json = (await response.json()) as Record<string, unknown>;
		expect(json.object).toBe("chat.completion");
	});

	test("should forward a streaming request through SOCKS5", async () => {
		const client = new BackendAPIClient(backend);

		const response = await client.request(`/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-4",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");
		expect(response.body).toBeInstanceOf(ReadableStream);

		const text = await drainText(response as Response);
		expect(text).toContain('data: {"');
		expect(text).toContain("data: [DONE]");
	});

	// test("should forward a streaming request through SOCKS5 with 3rd-party proxy and 3rd-party API", async () => {
		
	// 	const response = await new BackendAPIClient({
	// 		proxyUrl: "socks5://vpn:unlimited@82.196.7.200:2434",
	// 	}).request(`https://opencode.ai/zen/v1/chat/completions`, {
	// 		method: "POST",
	// 		headers: { "Content-Type": "application/json" },
	// 		body: JSON.stringify({
	// 			model: "big-pickle",
	// 			messages: [{ role: "user", content: "Hi" }],
	// 			stream: true,
	// 		}),
	// 	});
		
	// 	expect(response.status).toBe(200);

	// 	for await (const value of (response?.body as any as ReadableStream<Buffer>)) {
	// 		// console.log("Response chunk:", value.toString());
	// 	}
	// }, {
	// 	timeout: 30000
	// });

	test("should forward a GET request through SOCKS5", async () => {
		const client = new BackendAPIClient(backend);

		const response = await client.request(`/models`, {
			method: "GET",
		});

		expect(response.status).toBe(200);
	});

	test("should apply API key when forwarding through SOCKS5", async () => {
		const backendWithKey: GatewayConfig.Types.ProviderBackend = {
			...backend,
			apiKey: "sk-test-key-12345",
		};
		const client = new BackendAPIClient(backendWithKey);

		const response = await client.request(`/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-4",
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		expect(response.status).toBe(200);
	});
});

describe("SOCKS5 with authentication", () => {
	let fakeApi: FakeOpenAICompatibleAPI;
	let socks5: Socks5Server;
	let backend: GatewayConfig.Types.ProviderBackend;

	beforeAll(async () => {
		socks5 = new Socks5Server("proxyuser", "proxypass");
		await socks5.start();
		const proxyUrl = socks5.getUrl();

		fakeApi = new FakeOpenAICompatibleAPI();
		const apiUrl = await fakeApi.start();

		backend = {
			name: "auth-socks-backend",
			baseUrl: apiUrl,
			proxyUrl,
		};
	});

	afterAll(async () => {
		await fakeApi.stop();
		await socks5.stop();
	});

	test("should forward requests through authenticated SOCKS5", async () => {
		const client = new BackendAPIClient(backend);

		const response = await client.request(`/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-4",
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		expect(response.status).toBe(200);
	});
});

describe("SOCKS5 connection failures", () => {
	test("should fail when SOCKS5 proxy is unreachable", async () => {
		const backend: GatewayConfig.Types.ProviderBackend = {
			name: "unreachable-proxy",
			baseUrl: "http://127.0.0.1:9999",
			proxyUrl: "socks5://127.0.0.1:1",
		};

		const client = new BackendAPIClient(backend);
		await expect(
			client.request("/v1/models", { method: "GET" })
		).rejects.toThrow();
	});
});
