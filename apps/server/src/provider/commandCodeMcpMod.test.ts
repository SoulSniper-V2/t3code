// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";

import {
  COMMAND_CODE_MCP_AUTH_ENV,
  COMMAND_CODE_MCP_ENDPOINT_ENV,
  COMMAND_CODE_MCP_MOD_SOURCE,
} from "./commandCodeMcpMod.ts";

describe("Command Code T3 MCP mod", () => {
  it("initializes the scoped MCP session, exposes tools, calls them, and closes cleanly", async () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-command-code-mod-test-"),
    );
    const modulePath = NodePath.join(directory, "t3-code-mcp.mjs");
    NodeFS.writeFileSync(modulePath, COMMAND_CODE_MCP_MOD_SOURCE, { mode: 0o600 });

    const endpoint = "http://127.0.0.1:43123/mcp";
    const authorization = "Bearer synthetic-scoped-token";
    const previousEndpoint = process.env[COMMAND_CODE_MCP_ENDPOINT_ENV];
    const previousAuthorization = process.env[COMMAND_CODE_MCP_AUTH_ENV];
    const previousFetch = globalThis.fetch;
    const requests: Array<{ method: string; authorized: boolean; session: string | null }> = [];
    const eventHandlers = new Map<string, () => void>();
    const tools = new Map<
      string,
      {
        schema: Record<string, unknown>;
        readOnly?: boolean;
        run: (input: { input: unknown }) => Promise<unknown>;
      }
    >();

    const fakeFetch: typeof fetch = async (input, init) => {
      const requestHeaders = new Headers(init?.headers);
      const method =
        init?.method === "DELETE"
          ? "DELETE"
          : (JSON.parse(String(init?.body)) as { method: string }).method;
      requests.push({
        method,
        authorized: requestHeaders.get("authorization") === authorization,
        session: requestHeaders.get("Mcp-Session-Id"),
      });
      if (method === "DELETE") return new Response(null, { status: 200 });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "initialize") {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return Response.json(
          {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "T3 Code test", version: "0" },
            },
          },
          {
            headers: {
              "Mcp-Session-Id": "test-mcp-session",
              "MCP-Protocol-Version": "2025-06-18",
            },
          },
        );
      }
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        params?: { name?: string };
      };
      if (method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: [
              {
                name: "thread_list",
                description: "List T3 Code threads",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      }
      if (method === "tools/call" && request.params?.name === "thread_list") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "thread one" }] },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "unexpected test method" },
      });
    };

    try {
      process.env[COMMAND_CODE_MCP_ENDPOINT_ENV] = endpoint;
      process.env[COMMAND_CODE_MCP_AUTH_ENV] = authorization;
      globalThis.fetch = fakeFetch;
      const { default: factory } = await import(NodeURL.pathToFileURL(modulePath).href);
      await factory({
        addTool: (tool: {
          schema: Record<string, unknown>;
          readOnly?: boolean;
          run: (input: { input: unknown }) => Promise<unknown>;
        }) => tools.set(String(tool.schema.name), tool),
        on: (event: string, handler: () => void) => eventHandlers.set(event, handler),
      });

      expect([...tools.keys()]).toEqual(["t3_thread_list"]);
      expect(tools.get("t3_thread_list")?.readOnly).toBe(true);
      const result = await tools.get("t3_thread_list")?.run({ input: {} });
      expect(result).toEqual({ ok: true, content: [{ type: "text", text: "thread one" }] });

      eventHandlers.get("run_end")?.();
      expect(requests.map(({ method }) => method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
        "DELETE",
      ]);
      expect(requests.every(({ authorized }) => authorized)).toBe(true);
      expect(requests.slice(1).every(({ session }) => session === "test-mcp-session")).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEndpoint === undefined) delete process.env[COMMAND_CODE_MCP_ENDPOINT_ENV];
      else process.env[COMMAND_CODE_MCP_ENDPOINT_ENV] = previousEndpoint;
      if (previousAuthorization === undefined) delete process.env[COMMAND_CODE_MCP_AUTH_ENV];
      else process.env[COMMAND_CODE_MCP_AUTH_ENV] = previousAuthorization;
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
