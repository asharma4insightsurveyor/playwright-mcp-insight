// src/index.ts
import { env } from "cloudflare:workers";
import { createMcpAgent } from "@cloudflare/playwright-mcp";

/**
 * Adds:
 *  - GET  /health          → quick 200 check
 *  - POST /sse             → single-call streaming (Playground-style)
 * Keeps:
 *  - GET  /sse, /sse/message → MCP SSE transport (for MCP clients)
 *  - ANY  /mcp               → MCP HTTP transport
 */

export interface Env {
  AI: any;                          // from [ai] binding
  BROWSER: any;                     // from [browser] binding
  MCP_OBJECT: DurableObjectNamespace;
}

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- health/version for sanity ---
    if (request.method === "GET" && pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // --- NEW: one-shot streaming like Playground (so curl works) ---
    if (request.method === "POST" && pathname === "/sse") {
      const body = await request.json().catch(() => ({} as any));
      const messages =
        body?.messages ?? [{ role: "user", content: body?.prompt ?? "" }];
      const model =
        body?.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      const stream = body?.stream ?? true;
      const max_tokens = body?.max_tokens ?? 2048;

      const s = await env.AI.run(model, { stream, max_tokens, messages });
      return new Response(s as ReadableStream, {
        headers: { "content-type": "text/event-stream" },
      });
    }

    // --- existing MCP endpoints (unchanged) ---
    switch (pathname) {
      case "/sse":
      case "/sse/message":
        return PlaywrightMCP.serveSSE("/sse").fetch(request, env, ctx);
      case "/mcp":
        return PlaywrightMCP.serve("/mcp").fetch(request, env, ctx);
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
};
