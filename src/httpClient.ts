import type { Backend } from "./config";
import { SocksClient } from "socks";

interface HttpClientOptions {
  timeout?: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Headers;
}

export class HttpClient {
  private backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  async get(url: string, options?: HttpClientOptions): Promise<HttpResponse> {
    return this.request(url, { method: "GET", ...options });
  }

  async post(
    url: string,
    body: string,
    options?: HttpClientOptions
  ): Promise<HttpResponse> {
    return this.request(url, {
      method: "POST",
      body,
      ...options,
    });
  }

  async request(
    url: string,
    options?: RequestInit & HttpClientOptions
  ): Promise<HttpResponse> {
    const headers = new Headers(options?.headers || {});

    if (this.backend.apiKey) {
      headers.set("Authorization", `Bearer ${this.backend.apiKey}`);
    }

    headers.set("User-Agent", "AI-Load-Balancer/1.0");

    if (this.backend.proxy) {
      return this.requestViaSocks(url, headers, options);
    }

    return this.requestDirect(url, headers, options);
  }

  private async requestDirect(
    url: string,
    headers: Headers,
    options?: RequestInit & HttpClientOptions
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = options?.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      const body = await response.text();

      return {
        ok: response.ok,
        status: response.status,
        body,
        headers: response.headers,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async requestViaSocks(
    url: string,
    headers: Headers,
    options?: RequestInit & HttpClientOptions
  ): Promise<HttpResponse> {
    const proxy = this.backend.proxy!;
    const parsedUrl = new URL(url);
    const port = parseInt(parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80"));

    try {
      const socket = await SocksClient.createConnection({
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

      const method = options?.method || "GET";
      const path = parsedUrl.pathname + parsedUrl.search;
      const headersStr = Array.from(headers.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");

      let requestStr = `${method} ${path} HTTP/1.1\r\n`;
      requestStr += `Host: ${parsedUrl.hostname}\r\n`;
      requestStr += headersStr;
      if (options?.body) {
        const bodyStr = typeof options.body === "string" ? options.body : String(options.body);
        requestStr += `\r\nContent-Length: ${Buffer.byteLength(bodyStr)}\r\n\r\n${bodyStr}`;
      } else {
        requestStr += "\r\n\r\n";
      }

      const timeout = options?.timeout || 30000;
      const response = await this.readHttpResponse(socket.socket, timeout);
      socket.socket.destroy();

      return response;
    } catch (error) {
      throw new Error(`SOCKS proxy request failed: ${error}`);
    }
  }

  private async readHttpResponse(socket: any, timeout: number): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("HTTP response timeout"));
      }, timeout);

      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on("end", () => {
        clearTimeout(timeoutId);
        try {
          const [statusLine, ...rest] = data.split("\r\n");
          const status = parseInt(statusLine.split(" ")[1]);
          const headerEndIdx = rest.findIndex((line) => line === "");
          const headerLines = rest.slice(0, headerEndIdx);
          const body = rest.slice(headerEndIdx + 1).join("\r\n");

          const headers = new Headers();
          headerLines.forEach((line) => {
            const [key, value] = line.split(": ");
            if (key && value) headers.set(key, value);
          });

          resolve({
            ok: status >= 200 && status < 300,
            status,
            body,
            headers,
          });
        } catch (error) {
          reject(error);
        }
      });

      socket.on("error", (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }
}

export function createHttpClient(backend: Backend): HttpClient {
  return new HttpClient(backend);
}
