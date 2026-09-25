/** Environment keys used only by the short-lived Command Code child process. */
export const COMMAND_CODE_MCP_ENDPOINT_ENV = "T3_CODE_MCP_ENDPOINT";
export const COMMAND_CODE_MCP_AUTH_ENV = "T3_CODE_MCP_AUTHORIZATION";

/**
 * A session-scoped Command Code mod. Its source contains no credential or
 * endpoint; both arrive through the child process environment and the mod is
 * written to a private temporary directory that the adapter removes after the
 * turn. `--mod` is an official Command Code per-session flag and loads in
 * headless print mode.
 */
export const COMMAND_CODE_MCP_MOD_SOURCE = String.raw`export default async function (cmd) {
  const endpoint = process.env.T3_CODE_MCP_ENDPOINT;
  const authorization = process.env.T3_CODE_MCP_AUTHORIZATION;
  if (!endpoint || !authorization) return;

  let nextId = 0;
  let sessionId;
  let protocolVersion = "2025-06-18";
  let closed = false;

  const responseMessage = async (response, expectedId) => {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return response.json();
    if (!contentType.includes("text/event-stream") || !response.body) {
      const text = await response.text();
      if (!text) return undefined;
      try { return JSON.parse(text); } catch { throw new Error("Invalid T3 MCP response."); }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines = [];
    const parseEvent = () => {
      if (dataLines.length === 0) return undefined;
      const data = dataLines.join("\n");
      dataLines = [];
      try {
        const message = JSON.parse(data);
        return message && message.id === expectedId ? message : undefined;
      } catch {
        return undefined;
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            const message = parseEvent();
            if (message) return message;
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          newline = buffer.indexOf("\n");
        }
        if (done) break;
      }
      if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
      return parseEvent();
    } finally {
      await reader.cancel().catch(() => {});
    }
  };

  const rpc = async (method, params = {}, signal) => {
    const id = method.startsWith("notifications/") ? undefined : ++nextId;
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization,
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
      headers["MCP-Protocol-Version"] = protocolVersion;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(id === undefined ? {} : { id }),
        method,
        params,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error("T3 MCP request failed (HTTP " + response.status + ").");
    const returnedSession = response.headers.get("Mcp-Session-Id");
    if (returnedSession) sessionId = returnedSession;
    const returnedProtocol = response.headers.get("MCP-Protocol-Version");
    if (returnedProtocol) protocolVersion = returnedProtocol;
    if (id === undefined) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const message = await responseMessage(response, id);
    if (!message) throw new Error("T3 MCP returned no response.");
    if (message.error) {
      throw new Error(typeof message.error.message === "string" ? message.error.message : "T3 MCP request failed.");
    }
    return message.result;
  };

  const close = async () => {
    if (closed || !sessionId) return;
    closed = true;
    try {
      await fetch(endpoint, {
        method: "DELETE",
        headers: {
          authorization,
          "Mcp-Session-Id": sessionId,
          "MCP-Protocol-Version": protocolVersion,
        },
      });
    } catch {}
  };

  cmd.on("run_end", () => { void close(); });
  cmd.on("session_shutdown", () => { void close(); });

  const registerUnavailable = () => {
    cmd.addTool({
      schema: {
        name: "t3_mcp_unavailable",
        description: "Report that T3 Code's session-scoped tools could not be reached for this turn.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      readOnly: true,
      run: async () => ({ ok: false, error: "T3 Code's session-scoped tools are temporarily unavailable." }),
    });
  };

  let listedTools;
  try {
    await rpc("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "t3-code-command-code-bridge", version: "1" },
    });
    await rpc("notifications/initialized");
    listedTools = [];
    let cursor;
    let pageCount = 0;
    do {
      pageCount += 1;
      const page = await rpc("tools/list", cursor ? { cursor } : {});
      if (Array.isArray(page?.tools)) listedTools.push(...page.tools);
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor && pageCount < 20 && listedTools.length < 500);
  } catch {
    await close();
    registerUnavailable();
    return;
  }

  const registeredNames = new Set();
  for (const tool of listedTools) {
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(tool.name)) continue;
    const remoteName = tool.name;
    if (registeredNames.has(remoteName)) continue;
    registeredNames.add(remoteName);
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : { type: "object", properties: {} };
    cmd.addTool({
      schema: {
        name: "t3_" + remoteName,
        description: "T3 Code tool " + remoteName + ". " + (typeof tool.description === "string" ? tool.description : ""),
        input_schema: inputSchema,
      },
      ...(tool.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
      run: async ({ input, signal }) => {
        try {
          const result = await rpc("tools/call", {
            name: remoteName,
            arguments: input && typeof input === "object" ? input : {},
          }, signal);
          const textContent = Array.isArray(result?.content)
            ? result.content.flatMap((block) => {
                if (block?.type === "text" && typeof block.text === "string") return [block.text];
                if (block?.type === "image") return ["[T3 returned an image; this Command Code tool bridge exposes text results only.]"];
                return [];
              })
            : [];
          if (textContent.length === 0 && result?.structuredContent !== undefined) {
            textContent.push(JSON.stringify(result.structuredContent));
          }
          const text = textContent.join("\n").trim() || "T3 tool completed without text output.";
          return result?.isError === true ? { ok: false, error: text } : { ok: true, content: [{ type: "text", text }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : "T3 MCP tool call failed.";
          return {
            ok: false,
            error: message.split(authorization).join("[redacted]").slice(0, 2000),
          };
        }
      },
    });
  }

}`;
