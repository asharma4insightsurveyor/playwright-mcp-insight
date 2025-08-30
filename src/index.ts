// src/index.ts
import { env } from "cloudflare:workers";
import { createMcpAgent } from "@cloudflare/playwright-mcp";

export interface Env {
  AI: any;                          // AI binding
  BROWSER: any;                     // Browser Rendering binding
  MCP_OBJECT: DurableObjectNamespace;
}

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

async function readJson<T = any>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { return {} as T; }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- health check ---
    if (request.method === "GET" && pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // --- one-shot LLM stream (what you just tested) ---
    if (request.method === "POST" && pathname === "/sse") {
      const body: any = await readJson(request);
      const messages = body?.messages ?? [{ role: "user", content: body?.prompt ?? "" }];
      const model = body?.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      const stream = body?.stream ?? true;
      const max_tokens = body?.max_tokens ?? 2048;

      const s = await env.AI.run(model, { stream, max_tokens, messages });
      return new Response(s as ReadableStream, { headers: { "content-type": "text/event-stream" } });
    }

    // --- NEW: real Playwright scrape → JSON fields ---
    if (request.method === "POST" && pathname === "/extract") {
      const body: any = await readJson(request);
      const targetUrl: string = body?.url;
      if (!targetUrl) return new Response(JSON.stringify({ error: "Missing 'url'" }), { status: 400 });

      // Launch a headless browser session in Cloudflare’s Browser Rendering
      const browser = await env.BROWSER.launch();            // uses your [browser] binding
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Try to wait for common Lever application form content
      try { await page.waitForSelector('text=/Submit your application/i', { timeout: 8000 }); } catch {}

      // Extract inputs (label, type, required, name/placeholder) in the rendered DOM
      const fields = await page.evaluate(() => {
        // helper: get label text for an input by for= or closest label element
        function labelFor(el: HTMLElement): string {
          const id = (el as HTMLInputElement).id;
          let lab = id ? document.querySelector(`label[for="${id}"]`) : null;
          if (!lab) lab = el.closest("label");
          if (lab) return (lab.textContent || "").trim().replace(/\s+/g, " ");
          // fallback: nearest heading or preceding text
          const prev = el.closest("li, div, section")?.querySelector("h1,h2,h3,h4,h5,h6,legend") as HTMLElement | null;
          return prev ? (prev.textContent || "").trim() : "";
        }

        function isRequired(el: HTMLElement): boolean {
          // common patterns: aria-required, required attr, asterisk in label
          const input = el as HTMLInputElement;
          const aria = input.getAttribute("aria-required");
          if (aria === "true") return true;
          if (input.required) return true;
          const lbl = labelFor(el);
          return /[*✱]\s*$/.test(lbl);
        }

        const results: Array<any> = [];

        // inputs, selects, textareas
        const qs = 'input, select, textarea';
        document.querySelectorAll(qs).forEach((node) => {
          const el = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          // ignore hidden
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return;

          let type = (el as HTMLInputElement).type || el.tagName.toLowerCase();
          type = type.toLowerCase();

          // meaningful types only
          const name = (el.getAttribute("name") || "").trim();
          const placeholder = (el.getAttribute("placeholder") || "").trim();
          const label = labelFor(el as any);
          const required = isRequired(el as any);

          // guess control type
          let control: string = type;
          if (el.tagName === "TEXTAREA") control = "textarea";
          if (el.tagName === "SELECT") control = "select";

          // Skip obvious noise (search boxes etc.) if needed
          results.push({
            control,
            type,
            label,
            name,
            placeholder,
            required,
          });
        });

        // Radios / checkboxes grouped by name
        const groups: Record<string, any> = {};
        document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((n) => {
          const i = n as HTMLInputElement;
          const g = i.name || i.id || labelFor(i as any) || "ungrouped";
          if (!groups[g]) groups[g] = { control: i.type, group: g, label: labelFor(i as any), options: new Set<string>(), required: isRequired(i as any) };
          const optLabel = (i.closest("label")?.textContent || "").trim() || i.value || "";
          if (optLabel) groups[g].options.add(optLabel);
        });
        Object.values(groups).forEach((g: any) => {
          (g.options as Set<string>).size && (g.options = Array.from(g.options));
        });

        return { fields: results, groups: Object.values(groups) };
      });

      // Optional: screenshot to help analysts
      const png = await page.screenshot({ fullPage: true }).catch(() => undefined);
      await browser.close();

      return new Response(JSON.stringify({
        url: targetUrl,
        extracted_at: new Date().toISOString(),
        ...fields,
        screenshot_png_base64: png ? Buffer.from(png).toString("base64") : undefined,
      }), {
        headers: { "content-type": "application/json" },
      });
    }

    // --- MCP transports (unchanged) ---
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
