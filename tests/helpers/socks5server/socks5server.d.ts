import type { Server as TCPServer } from "net";

export interface Socks5ServerOptions {
    userPassAuthFn?: (username: string, password: string) => boolean;
    logger?: {
        debug: (...args: any[]) => void;
        info: (...args: any[]) => void;
        log: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
}

export declare function createSocks5Server(options: Socks5ServerOptions): TCPServer;


