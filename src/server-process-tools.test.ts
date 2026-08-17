import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig, type ToolMode } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const ACCESS_TOKEN = "process-tools-test-access-token";
const OWNER_TOKEN = "process-tools-owner-token-long-enough";
const PORT = 7676;

interface McpResponse {
  status: number;
  sessionId: string | undefined;
  body: Record<string, unknown> | undefined;
  raw: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function parseMcpBody(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;

  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  const last = dataLines[dataLines.length - 1];
  return last ? (JSON.parse(last) as Record<string, unknown>) : undefined;
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runMode(mode: ToolMode): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `devspace-process-tools-${mode}-`));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    DEVSPACE_TOOL_MODE: mode,
    DEVSPACE_LOG_LEVEL: "error",
    HOST: "127.0.0.1",
    PORT: String(PORT),
  });

  {
    const store = new SqliteOAuthStore(stateDir);
    const clients = new SqliteOAuthClientsStore(store, config.oauth.allowedRedirectHosts);
    const client = clients.registerClient({
      redirect_uris: ["http://127.0.0.1/callback"],
      client_name: `process-tools-${mode}`,
    });
    const resource = new URL("/mcp", config.publicBaseUrl).href;
    store.saveTokenPair({
      accessTokenHash: hashToken(ACCESS_TOKEN),
      accessToken: {
        clientId: client.client_id,
        scopes: config.oauth.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource,
      },
      refreshTokenHash: hashToken(`refresh-${mode}`),
      refreshToken: {
        clientId: client.client_id,
        scopes: config.oauth.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 7200,
        resource,
      },
    });
    store.close();
  }

  const running = createServer(config);
  const httpServer = createHttpServer(running.app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const postMcp = async (
    message: unknown,
    sessionId?: string,
  ): Promise<McpResponse> => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ACCESS_TOKEN}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    const raw = await response.text();
    return {
      status: response.status,
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
      body: parseMcpBody(raw),
      raw,
    };
  };

  try {
    const initialized = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: `process-tools-${mode}`, version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200, initialized.raw);
    const sessionId = initialized.sessionId;
    assert.ok(sessionId, `${mode}: initialize must return an MCP session ID`);

    await postMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    );

    const listed = await postMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );
    assert.equal(listed.status, 200, listed.raw);
    const listResult = listed.body?.result as
      | { tools?: Array<{ name?: unknown; inputSchema?: unknown }> }
      | undefined;
    const tools = listResult?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("exec_command"), `${mode}: exec_command missing from tools/list`);
    assert.ok(names.includes("write_stdin"), `${mode}: write_stdin missing from tools/list`);

    if (mode !== "codex") {
      const bash = tools.find((tool) => tool.name === "bash");
      assert.ok(bash, `${mode}: bash missing from tools/list`);
      const bashSchema = bash.inputSchema as
        | { properties?: { timeout?: { maximum?: unknown } } }
        | undefined;
      assert.equal(
        bashSchema?.properties?.timeout?.maximum,
        300,
        `${mode}: bash timeout hard max must remain 300 seconds`,
      );
    }

    const opened = await postMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "open_workspace", arguments: { path: root } },
      },
      sessionId,
    );
    assert.equal(opened.status, 200, opened.raw);
    const openedResult = opened.body?.result as
      | { structuredContent?: { workspaceId?: unknown }; isError?: boolean }
      | undefined;
    assert.notEqual(openedResult?.isError, true, opened.raw);
    const workspaceId = openedResult?.structuredContent?.workspaceId;
    assert.ok(typeof workspaceId === "string", `${mode}: open_workspace did not return workspaceId`);

    const node = process.platform === "win32"
      ? `"${process.execPath}"`
      : JSON.stringify(process.execPath);
    const started = await postMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: {
            workspaceId,
            cmd: `${node} -e "setTimeout(() => console.log('process-session-ok'), 100)"`,
            yieldTimeMs: 1,
          },
        },
      },
      sessionId,
    );
    assert.equal(started.status, 200, started.raw);
    const startedResult = started.body?.result as
      | { structuredContent?: { sessionId?: unknown; running?: unknown }; isError?: boolean }
      | undefined;
    assert.notEqual(startedResult?.isError, true, started.raw);
    assert.equal(startedResult?.structuredContent?.running, true, started.raw);
    const processSessionId = startedResult?.structuredContent?.sessionId;
    assert.ok(typeof processSessionId === "number", `${mode}: exec_command did not return sessionId`);

    const polled = await postMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "write_stdin",
          arguments: {
            workspaceId,
            sessionId: processSessionId,
            yieldTimeMs: 2_000,
          },
        },
      },
      sessionId,
    );
    assert.equal(polled.status, 200, polled.raw);
    const polledResult = polled.body?.result as
      | {
          structuredContent?: {
            result?: unknown;
            running?: unknown;
            exitCode?: unknown;
          };
          isError?: boolean;
        }
      | undefined;
    assert.notEqual(polledResult?.isError, true, polled.raw);
    assert.equal(polledResult?.structuredContent?.running, false, polled.raw);
    assert.equal(polledResult?.structuredContent?.exitCode, 0, polled.raw);
    assert.match(String(polledResult?.structuredContent?.result), /process-session-ok/);
  } finally {
    await running.close();
    await closeHttpServer(httpServer);
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["minimal", "full", "codex"] as const) {
  await runMode(mode);
}
