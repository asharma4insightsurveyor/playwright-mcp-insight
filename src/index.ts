// src/index.ts
import { env } from "cloudflare:workers";
import { createMcpAgent } from "@cloudflare/playwright-mcp";

/**
 * This file adds a one-shot POST /sse endpoint that streams model output
 * exactly like the Cloudflare AI Playground, while keeping the existing
 * MCP transports at /sse, /sse/message, and /mcp intact.
 */

export interface Env {
  AI: any;                          // from wrangler.toml: [ai] binding = "AI"
  BROWSER: any;                     // from wrangler.toml: [browser] binding = "BROWSER"
  MCP_OBJECT: DurableObjectNamespace;
}

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

export default {
  /**
   * Router:
   *  - POST /sse            → one-shot streaming (Playground-style)
   *  - GET  /sse            → MCP SSE transport (for MCP clients)
   *  - GET  /sse/message    → MCP SSE continuation (for MCP clients)
   *  - ANY  /mcp            → MCP HTTP transport (for MCP clients)
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- NEW: One-shot streaming endpoint for curl / Vercel fetch (like Playground) ---
    if (request.method === "POST" && pathname === "/sse") {
      // Accept either {messages:[...]} or {prompt:"..."} bodies
      const body = await request.json().catch(() => ({} as any));
      const messages =
        body?.messages ?? [{ role: "user", content: body?.prompt ?? "" }];
      const model =
        body?.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      const stream = body?.stream ?? true;
      const max_tokens = body?.max_tokens ?? 2048;

      // Stream tokens directly back as Server-Sent Events
      const streamResp = await env.AI.run(model, { stream, max_tokens, messages });
      return new Response(streamResp as ReadableStream, {
        headers: { "content-type": "text/event-stream" },
      });
    }

    // --- Existing MCP transports (leave these as-is) ---
    switch (pathname) {
      case "/sse":
      case "/sse/message":
        // MCP over SSE (used by MCP clients like Inspector / mcp-remote)
        return PlaywrightMCP.serveSSE("/sse").fetch(request, env, ctx);

      case "/mcp":
        // MCP over HTTP transport
        return PlaywrightMCP.serve("/mcp").fetch(request, env, ctx);

      default:
        return new Response("Not Found", { status: 404 });
    }
  },
};
