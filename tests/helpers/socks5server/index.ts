import type { Server as TCPServer } from "net";
import { createSocks5Server } from "./socks5server";

export class Socks5Server {

    private readonly server: TCPServer;

    constructor(
        private readonly username?: string,
        private readonly password?: string
    ) {
        this.server = createSocks5Server({
            userPassAuthFn: username && password ? (u, p) => u === username && p === password : undefined,
            logger: {
                debug: (msg) => console.debug(`[Socks5Server] ${msg.toString()}`),
                info: (msg) => console.info(`[Socks5Server] ${msg.toString()}`),
                log: (msg) => console.log(`[Socks5Server] ${msg.toString()}`),
                warn: (msg) => console.warn(`[Socks5Server] ${msg.toString()}`),
                error: (msg) => console.error(`[Socks5Server] ${msg.toString()}`),
            }
        });
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.listen(0, "127.0.0.1", () => {
                resolve();
            });
            this.server.on("error", (err) => {
                reject(err);
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    public getUrl(): string {
        const address = this.server.address();
        if (!address || typeof address === "string") {
            throw new Error("Socks5 server is not running");
        }
        if (this.username || this.password) {
            return `socks5://${this.username || ""}:${this.password || ""}@${address.address}:${address.port}`;
        }
        return `socks5://${address.address}:${address.port}`;
    }
}
