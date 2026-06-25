import { createMiddleware } from "hono/factory";
import { ApiKeysConfig } from "../../../utils/config/apiKeysConfig";
import { Logger } from "../../../utils/logger";

export type AuthContext = Omit<ApiKeysConfig.Types.ConfigSchema[string], "description">;

export const authMiddlewareV1 = createMiddleware(async (c, next) => {

    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, code: 401, message: "Unauthorized" }, 401);
    }

    const apiKeys = ApiKeysConfig.getConfig();
    if (!apiKeys) {
        Logger.error("API Keys configuration is not loaded.");
        return c.json({ success: false, code: 500, message: "Internal server error" }, 500);
    }

    const apiKey = authHeader.substring("Bearer ".length).trim();

    const apiKeyData = apiKeys[apiKey];

    if (typeof apiKeyData !== "object") {
        return c.json({ success: false, code: 403, message: "Forbidden" }, 403);
    }

    c.set("auth", apiKeyData);

    return await next();

});
