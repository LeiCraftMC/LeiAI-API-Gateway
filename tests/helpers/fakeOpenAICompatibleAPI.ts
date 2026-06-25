import { LLMock } from "@copilotkit/aimock";

export class FakeOpenAICompatibleAPI {

	private readonly mock: LLMock;

	constructor() {
		this.mock = new LLMock();

		// Register a chat-completion fixture that handles both streaming
		// and non-streaming POST /v1/chat/completions requests.
		this.mock.on({ endpoint: "chat" }, { content: "Hello! I'm an AI assistant." });

		// Register an embedding fixture for /v1/embeddings.
		this.mock.on({ endpoint: "embedding" }, { embedding: [0.1, 0.2, 0.3] });
	}

	async start() {
		await this.mock.start();
		return this.getUrl();
	}

	public getUrl(): string {
		return this.mock.url + "/v1";
	}

	async stop() {
		await this.mock.stop();
	}
}
