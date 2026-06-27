
export class LoadBalancingUtils {

    static getCleanProxyResponseHeaders(headers: Headers): Headers {
        const sanitizedHeaders = new Headers(headers);
        for (const header of ['Content-Encoding', 'Content-Length', 'Transfer-Encoding']) {
            sanitizedHeaders.delete(header);
        }
        return sanitizedHeaders;
    }

}
