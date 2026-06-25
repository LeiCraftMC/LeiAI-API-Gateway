import { SocksClient } from "socks";
import { Socket } from "net";
import * as tls from "tls";
import { Utils } from ".";

interface HttpClientOptions {
	timeout?: number;
}

export interface HttpResponse {
	ok: boolean;
	status: number;
	body: string;
	headers: Headers;
}

export class BackendAPIClient {
	private settings: {
		apiKey?: string;
		proxy?: {
			host: string;
			port: number;
			username?: string;
			password?: string;
		};
	}

	constructor(backend: { apiKey?: string; proxyUrl?: string }) {
		this.settings = {
			apiKey: backend.apiKey,
			proxy: backend.proxyUrl ? Utils.parseSocks5Url(backend.proxyUrl) : undefined,
		};
	}

	async get(url: string, options?: HttpClientOptions): Promise<HttpResponse | Response> {
		return this.request(url, { method: "GET", ...options });
	}

	async post(
		url: string,
		body: string,
		options?: HttpClientOptions
	): Promise<HttpResponse | Response> {
		return this.request(url, {
			method: "POST",
			body,
			...options,
		});
	}

	async request(
		url: string,
		options?: RequestInit & HttpClientOptions
	): Promise<HttpResponse | Response> {
		const headers = new Headers(options?.headers || {});

		if (this.settings.apiKey) {
			headers.set("Authorization", `Bearer ${this.settings.apiKey}`);
		}

		headers.set("User-Agent", "AI-Load-Balancer/1.0");

		if (this.settings.proxy) {
			return this.requestViaSocks(url, headers, options);
		}

		return this.requestDirect(url, headers, options);
	}

	private async requestDirect(
		url: string,
		headers: Headers,
		options?: RequestInit & HttpClientOptions
	): Promise<Response> {
		const controller = new AbortController();
		const timeout = options?.timeout || 30000;
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				...options,
				headers,
				signal: controller.signal,
			});

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async requestViaSocks(
		url: string,
		headers: Headers,
		options?: RequestInit & HttpClientOptions
	): Promise<Response> {
		const proxy = this.settings.proxy!;
		const parsedUrl = new URL(url);
		const isHttps = parsedUrl.protocol === "https:";
		const port = parseInt(parsedUrl.port || (isHttps ? "443" : "80"));

		try {
			const socket = await SocksClient.createConnection({
				command: "connect",
				proxy: {
					type: 5,
					host: proxy.host,
					port: proxy.port,
					userId: proxy.username,
					password: proxy.password,
				},
				destination: {
					host: parsedUrl.hostname!,
					port,
				},
			});

			// For HTTPS through SOCKS5, we need to establish a TLS tunnel
			if (isHttps) {
				return this.requestViaSocksHTTPS(socket.socket, url, headers, options, parsedUrl);
			}

			return this.requestViaSocksHTTP(socket.socket, url, headers, options, parsedUrl);
		} catch (error) {
			throw new Error(`SOCKS proxy request failed: ${error}`);
		}
	}

	private async requestViaSocksHTTP(
		socket: Socket,
		url: string,
		headers: Headers,
		options?: RequestInit & HttpClientOptions,
		parsedUrl?: URL
	): Promise<Response> {
		parsedUrl = parsedUrl || new URL(url);
		const method = options?.method || "GET";
		const path = parsedUrl.pathname + parsedUrl.search;

		// Build HTTP request
		let requestStr = `${method} ${path} HTTP/1.1\r\n`;
		requestStr += `Host: ${parsedUrl.hostname}\r\n`;

		headers.forEach((value, key) => {
			requestStr += `${key}: ${value}\r\n`;
		});

		let bodyBuffer: Buffer | null = null;
		if (options?.body) {
			const bodyStr = typeof options.body === "string" ? options.body : String(options.body);
			bodyBuffer = Buffer.from(bodyStr);
			requestStr += `Content-Length: ${bodyBuffer.length}\r\n`;
		}

		requestStr += "Connection: close\r\n\r\n";

		// Write request
		socket.write(requestStr);
		if (bodyBuffer) {
			socket.write(bodyBuffer);
		}

		// Stream response back
		return new Promise((resolve, reject) => {
			let responseStarted = false;
			let statusCode = 200;
			let responseHeaders: Headers = new Headers();
			const chunks: Buffer[] = [];

			socket.on("data", (chunk: Buffer) => {
				if (!responseStarted) {
					chunks.push(chunk);
					const data = Buffer.concat(chunks).toString();
					const headerEndIdx = data.indexOf("\r\n\r\n");

					if (headerEndIdx !== -1) {
						responseStarted = true;
						const headerSection = data.substring(0, headerEndIdx);
						const lines = headerSection.split("\r\n");
						const statusLine = lines[0];
						if (!statusLine) {
							reject(new Error("Invalid HTTP response"));
							return;
						}
						const statusParts = statusLine.split(" ");
						statusCode = parseInt(statusParts[1] || "500");

						for (let i = 1; i < lines.length; i++) {
							const lineParts = lines[i]?.split(": ");
							if (lineParts && lineParts[0] && lineParts[1]) {
								responseHeaders.set(lineParts[0], lineParts[1]);
							}
						}

						const bodyStart = headerEndIdx + 4;
						const bodyData = data.substring(bodyStart);

						// Create a new readable stream from remaining data
						const bodyStream = new ReadableStream({
							start(controller) {
								if (bodyData.length > 0) {
									controller.enqueue(Buffer.from(bodyData));
								}

								socket.on("data", (newChunk: Buffer) => {
									controller.enqueue(newChunk);
								});

								socket.on("end", () => {
									controller.close();
								});

								socket.on("error", (error: Error) => {
									controller.error(error);
								});
							},
						});

						resolve(
							new Response(bodyStream, {
								status: statusCode,
								headers: responseHeaders,
							})
						);
					}
				}
			});

			socket.on("error", (error: Error) => {
				reject(error);
			});

			socket.on("end", () => {
				if (!responseStarted) {
					reject(new Error("Socket closed before response received"));
				}
			});
		});
	}

	private async requestViaSocksHTTPS(
		socket: Socket,
		url: string,
		headers: Headers,
		options?: RequestInit & HttpClientOptions,
		parsedUrl?: URL
	): Promise<Response> {
		// For HTTPS through SOCKS5, establish TLS tunnel
		parsedUrl = parsedUrl || new URL(url);

		return new Promise((resolve, reject) => {
			const tlsSocket = tls.connect(
				{
					socket,
					servername: parsedUrl.hostname,
					rejectUnauthorized: true,
				},
				() => {
					const method = options?.method || "GET";
					const path = parsedUrl.pathname + parsedUrl.search;

					let requestStr = `${method} ${path} HTTP/1.1\r\n`;
					requestStr += `Host: ${parsedUrl.hostname}\r\n`;

					headers.forEach((value, key) => {
						requestStr += `${key}: ${value}\r\n`;
					});

					let bodyBuffer: Buffer | null = null;
					if (options?.body) {
						const bodyStr = typeof options.body === "string" ? options.body : String(options.body);
						bodyBuffer = Buffer.from(bodyStr);
						requestStr += `Content-Length: ${bodyBuffer.length}\r\n`;
					}

					requestStr += "Connection: close\r\n\r\n";

					tlsSocket.write(requestStr);
					if (bodyBuffer) {
						tlsSocket.write(bodyBuffer);
					}

					let responseStarted = false;
					let statusCode = 200;
					let responseHeaders: Headers = new Headers();
					const chunks: Buffer[] = [];

					tlsSocket.on("data", (chunk: Buffer) => {
						if (!responseStarted) {
							chunks.push(chunk);
							const data = Buffer.concat(chunks).toString("binary");
							const headerEndIdx = data.indexOf("\r\n\r\n");

							if (headerEndIdx !== -1) {
								responseStarted = true;
								const headerSection = data.substring(0, headerEndIdx);
								const lines = headerSection.split("\r\n");
								const statusLine = lines[0];
								if (!statusLine) {
									reject(new Error("Invalid HTTP response"));
									return;
								}
								const statusParts = statusLine.split(" ");
								statusCode = parseInt(statusParts[1] || "500");

								for (let i = 1; i < lines.length; i++) {
									const lineParts = lines[i]?.split(": ");
									if (lineParts && lineParts[0] && lineParts[1]) {
										responseHeaders.set(lineParts[0], lineParts[1]);
									}
								}

								const bodyStart = headerEndIdx + 4;
								const bodyData = data.substring(bodyStart, data.length);

								const bodyStream = new ReadableStream({
									start(controller) {
										if (bodyData.length > 0) {
											controller.enqueue(Buffer.from(bodyData, "binary"));
										}

										tlsSocket.on("data", (newChunk: Buffer) => {
											controller.enqueue(newChunk);
										});

										tlsSocket.on("end", () => {
											controller.close();
										});

										tlsSocket.on("error", (error: Error) => {
											controller.error(error);
										});
									},
								});

								resolve(
									new Response(bodyStream, {
										status: statusCode,
										headers: responseHeaders,
									})
								);
							}
						}
					});

					tlsSocket.on("error", (error: Error) => {
						reject(error);
					});
				}
			);

			tlsSocket.on("error", (error: Error) => {
				reject(error);
			});
		});
	}
}