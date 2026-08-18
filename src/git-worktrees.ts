import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED"
      | "GIT_WORKTREE_INSPECT_FAILED"
      | "GIT_WORKTREE_REMOVE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface ManagedWorktreeInspection {
  sourceRoot: string;
  path: string;
  exists: boolean;
  recognizedByGit: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean;
  headSha?: string;
}

interface GitWorktreeListEntry {
  path: string;
  locked: boolean;
  prunable: boolean;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git(["worktree", "add", "--detach", worktreePath, baseSha], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
}

export async function inspectManagedWorktree(input: {
  sourceRoot: string;
  path: string;
  config: ServerConfig;
}): Promise<ManagedWorktreeInspection> {
  const sourceRoot = assertAllowedPath(input.sourceRoot, input.config.allowedRoots);
  const path = assertAllowedPath(input.path, [input.config.worktreeRoot]);

  const pathStats = await stat(path).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (!pathStats?.isDirectory()) {
    return {
      sourceRoot,
      path,
      exists: false,
      recognizedByGit: false,
      locked: false,
      prunable: false,
      dirty: false,
    };
  }

  try {
    const entries = parseGitWorktreeList(await git(["worktree", "list", "--porcelain"], sourceRoot));
    const canonicalPath = await canonicalExistingPath(path);
    let matchingEntry: GitWorktreeListEntry | undefined;
    for (const entry of entries) {
      const entryCanonicalPath = await canonicalExistingPath(entry.path).catch(() => resolve(entry.path));
      if (samePath(entryCanonicalPath, canonicalPath)) {
        matchingEntry = entry;
        break;
      }
    }

    const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"], path);
    const headSha = (await git(["rev-parse", "--verify", "HEAD^{commit}"], path)).trim();

    return {
      sourceRoot,
      path,
      exists: true,
      recognizedByGit: Boolean(matchingEntry),
      locked: matchingEntry?.locked ?? false,
      prunable: matchingEntry?.prunable ?? false,
      dirty: status.trim().length > 0,
      headSha,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_INSPECT_FAILED",
      `Failed to inspect managed worktree ${path}. ${message}`,
    );
  }
}

export async function removeManagedWorktree(input: {
  sourceRoot: string;
  path: string;
  config: ServerConfig;
}): Promise<void> {
  const inspection = await inspectManagedWorktree(input);
  if (!inspection.exists) return;
  if (!inspection.recognizedByGit) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_REMOVE_FAILED",
      `Refusing to remove ${inspection.path} because Git does not recognize it as a worktree of ${inspection.sourceRoot}.`,
    );
  }
  if (inspection.locked) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_REMOVE_FAILED",
      `Refusing to remove locked worktree: ${inspection.path}`,
    );
  }

  try {
    // Intentionally do not pass --force. Git itself is the last protection
    // against removing a worktree whose state changed after our inspection.
    await git(["worktree", "remove", inspection.path], inspection.sourceRoot);
    await git(["worktree", "prune"], inspection.sourceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_REMOVE_FAILED",
      `Git refused to remove managed worktree ${inspection.path}. ${message}`,
    );
  }
}

export function parseGitWorktreeList(output: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: GitWorktreeListEntry | undefined;

  const flush = () => {
    if (current) entries.push(current);
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line === "locked" || line.startsWith("locked ")) current.locked = true;
    if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true;
  }
  flush();
  return entries;
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function canonicalExistingPath(path: string): Promise<string> {
  return resolve(await realpath(path));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      ((error as { code?: unknown }).code === "ENOENT" ||
        (error as { code?: unknown }).code === "ENOTDIR"),
  );
}
