import { SocksClient } from "socks";
import { Socket } from "net";
import * as tls from "tls";
import { Utils } from "../utils";
import { Logger } from "../utils/logger";
import { LoadBalancingUtils } from "./utils";

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
		baseUrl: string;
		apiKey?: string;
		proxy?: {
			host: string;
			port: number;
			username?: string;
			password?: string;
		};
	}

	constructor(backend: { apiKey?: string; proxyUrl?: string; baseUrl: string }) {
		this.settings = {
			baseUrl: backend.baseUrl,
			apiKey: backend.apiKey,
			proxy: backend.proxyUrl ? Utils.parseSocks5Url(backend.proxyUrl) : undefined,
		};
	}

	public getBaseUrl(): string {
		return this.settings.baseUrl
	}

	async get(path: string, options?: HttpClientOptions): Promise<Response> {
		return this.request(path, { method: "GET", ...options });
	}

	async post(
		path: string,
		body: string,
		options?: HttpClientOptions
	): Promise<Response> {
		return this.request(path, {
			method: "POST",
			body,
			...options,
		});
	}

	async request(
		path: string,
		options?: RequestInit & HttpClientOptions
	): Promise<Response> {

		const url = path.startsWith("http") ? path : `${this.settings.baseUrl}${path}`;

		const headers = new Headers(options?.headers || {});

		if (this.settings.apiKey) {
			headers.set("Authorization", `Bearer ${this.settings.apiKey}`);
		} else {
			headers.delete("Authorization");
		}

		// log request to backend details
		Logger.debug(
			`Sending request to backend: ${options?.method || "GET"} ${url}\n` + 
			`Body: ${options?.body ? (typeof options.body === "string" ? options.body : String(options.body)).slice(0, 2000) + (typeof options.body === "string" && options.body.length > 2000 ? "… [truncated]" : "") : "<no body>"}`
		);

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
				headers: LoadBalancingUtils.getCleanProxyResponseHeaders(response.headers),
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
		requestStr += `Host: ${parsedUrl.host}\r\n`;

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

		socket.write(requestStr);
		if (bodyBuffer) {
			socket.write(bodyBuffer);
		}

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

						let bodyStream: ReadableStream<Uint8Array> = new ReadableStream({
							start(controller) {
								let closed = false;
								const close = () => {
									if (closed) return;
									closed = true;
									try {
										controller.close();
									} catch {
										// Already closed by the consumer or a pipe; safe to ignore
									}
								};
								const error = (err: Error) => {
									if (closed) return;
									closed = true;
									try {
										controller.error(err);
									} catch {
										// Already closed; drop the error
									}
								};

								if (bodyData.length > 0) {
									controller.enqueue(Buffer.from(bodyData));
								}

								socket.on("data", (newChunk: Buffer) => {
									controller.enqueue(newChunk);
								});

								socket.on("end", close);

								socket.on("error", error);
							},
						});

						const transferEncoding = responseHeaders.get("transfer-encoding");
						if (transferEncoding?.toLowerCase().includes("chunked")) {
							bodyStream = bodyStream.pipeThrough(this.createChunkedDecodeStream());
						}

						resolve(
							new Response(bodyStream, {
								status: statusCode,
								headers: LoadBalancingUtils.getCleanProxyResponseHeaders(responseHeaders),
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
					requestStr += `Host: ${parsedUrl.host}\r\n`;

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

								let bodyStream: ReadableStream<Uint8Array> = new ReadableStream({
									start(controller) {
										let closed = false;
										const close = () => {
											if (closed) return;
											closed = true;
											try {
												controller.close();
											} catch {
												// Already closed by the consumer or a pipe; safe to ignore
											}
										};
										const error = (err: Error) => {
											if (closed) return;
											closed = true;
											try {
												controller.error(err);
											} catch {
												// Already closed; drop the error
											}
										};

										if (bodyData.length > 0) {
											controller.enqueue(Buffer.from(bodyData, "binary"));
										}

										tlsSocket.on("data", (newChunk: Buffer) => {
											controller.enqueue(newChunk);
										});

										tlsSocket.on("end", close);

										tlsSocket.on("error", error);
									},
								});

								const transferEncoding = responseHeaders.get("transfer-encoding");
								if (transferEncoding?.toLowerCase().includes("chunked")) {
									bodyStream = bodyStream.pipeThrough(this.createChunkedDecodeStream());
								}

								resolve(
									new Response(bodyStream, {
										status: statusCode,
										headers: LoadBalancingUtils.getCleanProxyResponseHeaders(responseHeaders),
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

	/**
	 * Create a TransformStream that decodes an HTTP/1.1 chunked-transfer
	 * encoded body into plain bytes.
	 *
	 * The chunked format is:
	 *   <hex-size>[;ext]*\r\n
	 *   <size bytes>\r\n
	 *   ...
	 *   0[;ext]*\r\n
	 *   <trailers>\r\n
	 *   \r\n
	 */
	private createChunkedDecodeStream(): TransformStream<Uint8Array, Uint8Array> {
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		let buffer: Uint8Array = new Uint8Array(0);
		let state: "size" | "body" = "size";
		let remainingBody = 0;
		let trailersSeen = false;

		const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
			const result = new Uint8Array(a.length + b.length);
			result.set(a);
			result.set(b, a.length);
			return result;
		};

		const findCRLF = (data: Uint8Array, start = 0): number => {
			for (let i = start; i < data.length - 1; i++) {
				if (data[i] === 0x0d && data[i + 1] === 0x0a) {
					return i;
				}
			}
			return -1;
		};

		return new TransformStream({
			transform(chunk: Uint8Array, controller) {
				buffer = concat(buffer, chunk);

				while (true) {
					if (state === "size") {
						const crlfIdx = findCRLF(buffer);
						if (crlfIdx === -1) {
							// Need more data to read the chunk-size line
							// If the buffer is huge without CRLF, prevent unbounded growth by waiting
							return;
						}

						const sizeLine = decoder.decode(buffer.subarray(0, crlfIdx));
						const sizeHex = (sizeLine.split(";")[0] ?? "").trim();
						const size = parseInt(sizeHex, 16);

						if (Number.isNaN(size)) {
							controller.error(new Error(`Invalid chunked encoding size: "${sizeHex}"`));
							return;
						}

						// Remove the size line (including CRLF) from the buffer
						buffer = buffer.slice(crlfIdx + 2);

						if (size === 0) {
							// Last-chunk.  We use Connection: close, so trailers are not
							// meaningful; skip everything until the final CRLF.
							state = "body";
							remainingBody = 0;
							trailersSeen = true;
							// Fall through to the body state to consume the trailing CRLF below
						} else {
							state = "body";
							remainingBody = size;
						}
					}

					if (state === "body") {
						if (trailersSeen) {
							// We are after the last-chunk; wait for a single CRLF to end
							const crlfIdx = findCRLF(buffer);
							if (crlfIdx !== -1) {
								buffer = buffer.slice(crlfIdx + 2);
								controller.terminate();
							}
							return;
						}

						const emitLen = Math.min(remainingBody, buffer.length);
						if (emitLen > 0) {
							controller.enqueue(buffer.slice(0, emitLen));
							buffer = buffer.slice(emitLen);
							remainingBody -= emitLen;
						}

						if (remainingBody === 0) {
							// Body emitted; now consume the trailing CRLF
							const crlfIdx = findCRLF(buffer);
							if (crlfIdx === -1) {
								// Wait for the CRLF to arrive
								state = "size";
								return;
							}
							buffer = buffer.slice(crlfIdx + 2);
							state = "size";
						} else {
							// Need more body bytes
							return;
						}
					}
				}
			},
			flush(controller) {
				if (buffer.length > 0) {
					// If we buffered trailing bytes, flush them as a best-effort
					// (e.g. when the upstream closes immediately after the last chunk)
					controller.enqueue(buffer);
				}
				controller.terminate();
			},
		});
	}
}