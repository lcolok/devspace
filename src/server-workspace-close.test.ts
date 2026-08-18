import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { createWorkspaceStore } from "./workspace-store.js";

const ACCESS_TOKEN = "workspace-close-test-access-token";
const OWNER_TOKEN = "workspace-close-test-owner-token-long-enough";
const root = await mkdtemp(join(tmpdir(), "devspace-server-workspace-close-"));
const stateDir = join(root, "state");
const configDir = join(root, "config");
const project = join(root, "project");
await mkdir(project, { recursive: true });
await writeFile(join(project, "hello.txt"), "hello\n", "utf8");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
  DEVSPACE_TOOL_MODE: "minimal",
  DEVSPACE_LOG_LEVEL: "error",
  HOST: "127.0.0.1",
  PORT: "17701",
});

{
  const store = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(store, config.oauth.allowedRedirectHosts);
  const client = clients.registerClient({
    redirect_uris: ["http://127.0.0.1/callback"],
    client_name: "workspace-close-test",
  });
  const resource = new URL("/mcp", config.publicBaseUrl).href;
  store.saveTokenPair({
    accessTokenHash: hashToken(ACCESS_TOKEN),
    accessToken: {
      clientId: client.client_id,
      scopes: config.oauth.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      resource,
    },
    refreshTokenHash: hashToken("workspace-close-refresh"),
    refreshToken: {
      clientId: client.client_id,
      scopes: config.oauth.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 7_200,
      resource,
    },
  });
  store.close();
}

const running = createServer(config);
const httpServer: Server = createHttpServer(running.app);
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

try {
  const initialized = await postMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "workspace-close-test", version: "1.0.0" },
    },
  });
  const mcpSessionId = initialized.sessionId;
  assert.ok(mcpSessionId, initialized.raw);
  await postMcp(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    mcpSessionId,
    [200, 202],
  );

  const listed = await postMcp(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    mcpSessionId,
  );
  const tools = ((listed.body?.result as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? []);
  assert.ok(tools.some((tool) => tool.name === "close_workspace"), listed.raw);

  const opened = await postMcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: project } },
    },
    mcpSessionId,
  );
  const workspaceId = (opened.body?.result as {
    structuredContent?: { workspaceId?: unknown };
    isError?: boolean;
  } | undefined)?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string", opened.raw);

  const closed = await postMcp(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "close_workspace", arguments: { workspaceId } },
    },
    mcpSessionId,
  );
  const closedResult = closed.body?.result as {
    structuredContent?: {
      workspaceId?: unknown;
      status?: unknown;
      worktreePreserved?: unknown;
    };
    isError?: boolean;
  } | undefined;
  assert.notEqual(closedResult?.isError, true, closed.raw);
  assert.equal(closedResult?.structuredContent?.workspaceId, workspaceId);
  assert.equal(closedResult?.structuredContent?.status, "released");
  assert.equal(closedResult?.structuredContent?.worktreePreserved, false);
  assert.equal((await stat(project)).isDirectory(), true);
  assert.equal((await stat(join(project, "hello.txt"))).isFile(), true);

  const workspaceStore = createWorkspaceStore(stateDir);
  try {
    assert.equal(workspaceStore.getSession(String(workspaceId))?.status, "released");
  } finally {
    workspaceStore.close?.();
  }

  const readAfterClose = await postMcp(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "read",
        arguments: { workspaceId, path: "hello.txt" },
      },
    },
    mcpSessionId,
  );
  const readResult = readAfterClose.body?.result as { isError?: boolean; content?: unknown } | undefined;
  assert.equal(readResult?.isError, true, readAfterClose.raw);
  assert.match(readAfterClose.raw, /Unknown workspaceId/);

  console.log("server close_workspace lifecycle test passed");
} finally {
  await running.close();
  await closeHttpServer(httpServer);
  await rm(root, { recursive: true, force: true });
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

async function postMcp(
  message: unknown,
  sessionId?: string,
  expectedStatuses: readonly number[] = [200],
) {
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
  assert.ok(
    expectedStatuses.includes(response.status),
    `Expected HTTP ${expectedStatuses.join(" or ")}, got ${response.status}: ${raw}`,
  );
  return {
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
    body: parseMcpBody(raw),
    raw,
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
