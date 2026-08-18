import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-worktree-reuse-test-"));
const repo = join(root, "repo");
const worktreeRoot = join(root, "managed-worktrees");
const stateDir = join(root, "state");
const configDir = join(root, "config");

await mkdir(repo, { recursive: true });
await git(["init"], repo);
await git(["config", "user.email", "devspace-test@example.com"], repo);
await git(["config", "user.name", "DevSpace Test"], repo);
await writeFile(join(repo, "README.md"), "# worktree reuse\n", "utf8");
await git(["add", "README.md"], repo);
await git(["commit", "-m", "initial"], repo);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_WORKTREE_ROOT: worktreeRoot,
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "worktree-reuse-test-owner-token-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:17677",
  HOST: "127.0.0.1",
  PORT: "17677",
  DEVSPACE_LOG_LEVEL: "error",
});
const store = createWorkspaceStore(stateDir);
const workspaces = new WorkspaceRegistry(config, store);

try {
  const first = await workspaces.openWorkspace(
    { path: repo, mode: "worktree" },
    { conversationScopeId: "conversation-a" },
  );
  assert.equal(first.workspaceReused, false);
  assert.equal(first.workspace.mode, "worktree");

  const second = await workspaces.openWorkspace(
    { path: repo, mode: "worktree" },
    { conversationScopeId: "conversation-a" },
  );
  assert.equal(second.workspaceReused, true);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(second.workspace.root, first.workspace.root);

  const [concurrentA, concurrentB] = await Promise.all([
    workspaces.openWorkspace(
      { path: repo, mode: "worktree", baseRef: "HEAD" },
      { conversationScopeId: "conversation-concurrent" },
    ),
    workspaces.openWorkspace(
      { path: repo, mode: "worktree", baseRef: "HEAD" },
      { conversationScopeId: "conversation-concurrent" },
    ),
  ]);
  assert.equal(concurrentA.workspace.id, concurrentB.workspace.id);
  assert.equal(concurrentA.workspace.root, concurrentB.workspace.root);
  assert.ok(concurrentA.workspaceReused !== concurrentB.workspaceReused);

  const otherConversation = await workspaces.openWorkspace(
    { path: repo, mode: "worktree" },
    { conversationScopeId: "conversation-b" },
  );
  assert.notEqual(otherConversation.workspace.id, first.workspace.id);
  assert.notEqual(otherConversation.workspace.root, first.workspace.root);

  const unscopedA = await workspaces.openWorkspace({ path: repo, mode: "worktree" });
  const unscopedB = await workspaces.openWorkspace({ path: repo, mode: "worktree" });
  assert.notEqual(unscopedA.workspace.id, unscopedB.workspace.id);
  assert.notEqual(unscopedA.workspace.root, unscopedB.workspace.root);

  const session = store.getSession(first.workspace.id);
  assert.equal(session?.status, "active");
  assert.equal(session?.managed, true);
  assert.equal(session?.mode, "worktree");

  console.log("worktree reuse tests passed");
} finally {
  store.close?.();
  await rm(root, { recursive: true, force: true });
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
