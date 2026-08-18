import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import type { ManagedWorktreeInspection } from "./git-worktrees.js";
import {
  applyWorkspaceGcPlan,
  planWorkspaceGc,
  type WorkspaceGcRuntime,
} from "./workspace-gc.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 7, 19, 0, 0, 0);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-gc-test-"));
const sourceRoot = join(root, "source");
const worktreeRoot = join(root, "worktrees");
const stateDir = join(root, "state");
const configDir = join(root, "config");
await mkdir(sourceRoot, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_WORKTREE_ROOT: worktreeRoot,
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "workspace-gc-test-owner-token-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:17676",
  HOST: "127.0.0.1",
  PORT: "17676",
  DEVSPACE_LOG_LEVEL: "error",
});

const inspections = new Map<string, Partial<ManagedWorktreeInspection>>();
const removed: string[] = [];
let serverRunning = false;
let openPaths: string[] = [];
let handleProbeAvailable = true;

const runtime: WorkspaceGcRuntime = {
  now: () => NOW,
  probeServerRunning: async () => serverRunning,
  snapshotOpenPaths: async () => ({
    available: handleProbeAvailable,
    paths: openPaths,
  }),
  measurePathBytes: async () => 1024,
  inspectWorktree: async ({ sourceRoot: inspectedSource, path }) => ({
    sourceRoot: inspectedSource,
    path,
    exists: true,
    recognizedByGit: true,
    locked: false,
    prunable: false,
    dirty: false,
    headSha: "base-sha",
    ...inspections.get(path),
  }),
  removeWorktree: async ({ path }) => {
    removed.push(path);
  },
};

try {
  const safePath = await createWorktreeSession("ws_safe", 10);
  let plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  let safe = candidate(plan, "ws_safe");
  assert.equal(plan.totalManagedWorktrees, 1);
  assert.equal(plan.reclaimableCount, 1);
  assert.equal(plan.reclaimableEstimatedBytes, 1024);
  assert.equal(safe.reclaimable, true);
  assert.deepEqual(safe.blockers, []);

  const result = await applyWorkspaceGcPlan(config, plan, runtime);
  assert.equal(result.reclaimedCount, 1);
  assert.deepEqual(removed, [safePath]);
  assert.equal(workspaceStatus("ws_safe"), "reclaimed");

  const dirtyPath = await createWorktreeSession("ws_dirty", 10);
  inspections.set(dirtyPath, { dirty: true });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.deepEqual(candidate(plan, "ws_dirty").blockers, ["dirty"]);

  const divergedPath = await createWorktreeSession("ws_diverged", 10);
  inspections.set(divergedPath, { headSha: "new-commit" });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.deepEqual(candidate(plan, "ws_diverged").blockers, ["head_diverged"]);

  await createWorktreeSession("ws_recent", 2);
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.ok(candidate(plan, "ws_recent").blockers.includes("recently_used"));

  await createWorktreeSession("ws_bound", 10);
  withDatabase((database) => {
    database.sqlite
      .prepare(
        `insert into workspace_conversation_bindings
         (conversation_scope_id, target_key, workspace_session_id, created_at, last_used_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run("conversation-1", "target-1", "ws_bound", oldIso(10), oldIso(10));
  });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.ok(candidate(plan, "ws_bound").blockers.includes("conversation_bound"));

  await createWorktreeSession("ws_agent", 10);
  withDatabase((database) => {
    database.sqlite
      .prepare(
        `insert into local_agent_sessions
         (id, workspace_id, workspace_root, profile_name, provider, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "agt_gc_test",
        "ws_agent",
        join(worktreeRoot, "ws_agent"),
        "test",
        "codex",
        "idle",
        oldIso(10),
        oldIso(10),
      );
  });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.ok(candidate(plan, "ws_agent").blockers.includes("agent_active"));

  const openPath = await createWorktreeSession("ws_open", 10);
  openPaths = [join(openPath, "held.txt")];
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.ok(candidate(plan, "ws_open").blockers.includes("open_handles"));
  assert.equal(candidate(plan, "ws_open").openHandleCount, 1);
  openPaths = [];

  await createWorktreeSession("ws_unknown_handles", 10);
  handleProbeAvailable = false;
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.ok(candidate(plan, "ws_unknown_handles").blockers.includes("handles_unknown"));
  assert.equal(plan.handleProbeAvailable, false);
  handleProbeAvailable = true;

  const changedPath = await createWorktreeSession("ws_changed", 10);
  inspections.set(changedPath, { headSha: "base-sha" });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  assert.equal(candidate(plan, "ws_changed").reclaimable, true);
  withDatabase((database) => {
    database.sqlite
      .prepare("update workspace_sessions set status = 'released' where id = ?")
      .run("ws_changed");
  });
  const changedResult = await applyWorkspaceGcPlan(config, plan, runtime);
  const changedItem = changedResult.items.find((item) => item.workspaceId === "ws_changed");
  assert.equal(changedItem?.outcome, "skipped_changed");
  assert.equal(workspaceStatus("ws_changed"), "released");

  const blockedDuringApplyPath = await createWorktreeSession("ws_apply_blocked", 10);
  inspections.set(blockedDuringApplyPath, { headSha: "base-sha" });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  inspections.set(blockedDuringApplyPath, { dirty: true, headSha: "base-sha" });
  const blockedResult = await applyWorkspaceGcPlan(config, plan, runtime);
  const blockedItem = blockedResult.items.find((item) => item.workspaceId === "ws_apply_blocked");
  assert.equal(blockedItem?.outcome, "skipped_blocked");
  assert.ok(blockedItem?.blockers?.includes("dirty"));
  assert.notEqual(workspaceStatus("ws_apply_blocked"), "reclaimed");

  const serverPath = await createWorktreeSession("ws_server_running", 10);
  inspections.set(serverPath, { headSha: "base-sha" });
  plan = await planWorkspaceGc(config, { retentionDays: 7 }, runtime);
  serverRunning = true;
  await assert.rejects(
    applyWorkspaceGcPlan(config, plan, runtime),
    /Refusing to apply workspace GC while the DevSpace server is running/,
  );
  serverRunning = false;

  console.log("workspace GC tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createWorktreeSession(id: string, ageDays: number): Promise<string> {
  const path = join(worktreeRoot, id);
  await mkdir(path, { recursive: true });
  withDatabase((database) => {
    database.sqlite
      .prepare(
        `insert into workspace_sessions
         (id, root, status, mode, source_root, base_ref, base_sha, managed, created_at, last_used_at)
         values (?, ?, 'active', 'worktree', ?, 'HEAD', 'base-sha', 'true', ?, ?)`,
      )
      .run(id, path, sourceRoot, oldIso(ageDays + 1), oldIso(ageDays));
  });
  return path;
}

function candidate(plan: Awaited<ReturnType<typeof planWorkspaceGc>>, id: string) {
  const found = plan.candidates.find((entry) => entry.workspaceId === id);
  assert.ok(found, `missing GC candidate ${id}`);
  return found;
}

function oldIso(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function workspaceStatus(id: string): string | undefined {
  let status: string | undefined;
  withDatabase((database) => {
    const row = database.sqlite
      .prepare("select status from workspace_sessions where id = ?")
      .get(id) as { status: string } | undefined;
    status = row?.status;
  });
  return status;
}

function withDatabase(run: (database: ReturnType<typeof openDatabase>) => void): void {
  const database = openDatabase(stateDir);
  try {
    run(database);
  } finally {
    database.close();
  }
}
