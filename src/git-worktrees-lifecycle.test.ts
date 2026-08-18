import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  GitWorktreeError,
  createManagedWorktree,
  inspectManagedWorktree,
  parseGitWorktreeList,
  removeManagedWorktree,
} from "./git-worktrees.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-git-worktree-lifecycle-"));
const repo = join(root, "repo");
const worktreeRoot = join(root, "managed-worktrees");
const configDir = join(root, "config");

try {
  await git(["init", repo], root);
  await git(["config", "user.email", "devspace-test@example.com"], repo);
  await git(["config", "user.name", "DevSpace Test"], repo);
  await writeFile(join(repo, "README.md"), "# lifecycle\n", "utf8");
  await git(["add", "README.md"], repo);
  await git(["commit", "-m", "initial"], repo);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "git-worktree-test-owner-token-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:17679",
    HOST: "127.0.0.1",
    PORT: "17679",
    DEVSPACE_LOG_LEVEL: "error",
  });

  const created = await createManagedWorktree({
    sourcePath: repo,
    baseRef: "HEAD",
    config,
  });
  assert.equal(created.managed, true);
  assert.equal(created.detached, true);
  assert.equal((await stat(created.path)).isDirectory(), true);

  const clean = await inspectManagedWorktree({
    sourceRoot: created.sourceRoot,
    path: created.path,
    config,
  });
  assert.equal(clean.exists, true);
  assert.equal(clean.recognizedByGit, true);
  assert.equal(clean.locked, false);
  assert.equal(clean.dirty, false);
  assert.equal(clean.headSha, created.baseSha);

  const dirtyFile = join(created.path, "DIRTY.txt");
  await writeFile(dirtyFile, "preserve me\n", "utf8");
  const dirty = await inspectManagedWorktree({
    sourceRoot: created.sourceRoot,
    path: created.path,
    config,
  });
  assert.equal(dirty.dirty, true);

  await assert.rejects(
    () => removeManagedWorktree({
      sourceRoot: created.sourceRoot,
      path: created.path,
      config,
    }),
    (error: unknown) =>
      error instanceof GitWorktreeError &&
      error.code === "GIT_WORKTREE_REMOVE_FAILED",
  );
  assert.equal((await stat(created.path)).isDirectory(), true);
  assert.equal((await stat(dirtyFile)).isFile(), true);

  await rm(dirtyFile);
  const cleanAgain = await inspectManagedWorktree({
    sourceRoot: created.sourceRoot,
    path: created.path,
    config,
  });
  assert.equal(cleanAgain.dirty, false);

  await removeManagedWorktree({
    sourceRoot: created.sourceRoot,
    path: created.path,
    config,
  });
  await assert.rejects(() => stat(created.path), /ENOENT|no such file/i);

  const remaining = parseGitWorktreeList(await gitOutput(["worktree", "list", "--porcelain"], repo));
  assert.equal(remaining.some((entry) => entry.path === created.path), false);

  const parsed = parseGitWorktreeList([
    "worktree /tmp/example-a",
    "HEAD 0123456789abcdef",
    "detached",
    "locked retained by test",
    "",
    "worktree /tmp/example-b",
    "HEAD fedcba9876543210",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n"));
  assert.deepEqual(parsed, [
    { path: "/tmp/example-a", locked: true, prunable: false },
    { path: "/tmp/example-b", locked: false, prunable: true },
  ]);

  console.log("Git worktree lifecycle safety tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
