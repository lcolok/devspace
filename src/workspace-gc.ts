import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  inspectManagedWorktree,
  removeManagedWorktree,
  type ManagedWorktreeInspection,
} from "./git-worktrees.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_DAYS = 7;
const ACTIVE_AGENT_STATUSES = new Set(["starting", "running", "idle"]);

export type WorkspaceGcBlocker =
  | "recently_used"
  | "missing_base_sha"
  | "missing_source_root"
  | "path_outside_worktree_root"
  | "source_outside_allowed_roots"
  | "path_missing"
  | "source_missing"
  | "git_unrecognized"
  | "git_locked"
  | "git_prunable"
  | "dirty"
  | "head_diverged"
  | "conversation_bound"
  | "agent_active"
  | "open_handles"
  | "handles_unknown"
  | "inspection_error";

export interface WorkspaceGcCandidate {
  workspaceId: string;
  path: string;
  sourceRoot?: string;
  baseSha?: string;
  status: string;
  createdAt: string;
  lastUsedAt: string;
  ageMs: number;
  estimatedBytes?: number;
  bindingCount: number;
  activeAgentCount: number;
  openHandleCount?: number;
  inspection?: ManagedWorktreeInspection;
  blockers: WorkspaceGcBlocker[];
  error?: string;
  fingerprint: string;
  reclaimable: boolean;
}

export interface WorkspaceGcPlan {
  planId: string;
  createdAt: string;
  retentionDays: number;
  serverRunning: boolean;
  handleProbeAvailable: boolean;
  totalManagedWorktrees: number;
  totalEstimatedBytes?: number;
  reclaimableCount: number;
  reclaimableEstimatedBytes?: number;
  candidates: WorkspaceGcCandidate[];
}

export interface WorkspaceGcApplyItem {
  workspaceId: string;
  path: string;
  outcome: "reclaimed" | "skipped_changed" | "skipped_blocked" | "failed";
  blockers?: WorkspaceGcBlocker[];
  error?: string;
}

export interface WorkspaceGcApplyResult {
  planId: string;
  reclaimedCount: number;
  reclaimedEstimatedBytes?: number;
  skippedCount: number;
  failedCount: number;
  items: WorkspaceGcApplyItem[];
}

interface WorkspaceSessionRow {
  id: string;
  root: string;
  status: string;
  mode: string;
  source_root: string | null;
  base_sha: string | null;
  managed: string;
  created_at: string;
  last_used_at: string;
}

export interface WorkspaceGcRuntime {
  now?: () => number;
  inspectWorktree?: typeof inspectManagedWorktree;
  removeWorktree?: typeof removeManagedWorktree;
  snapshotOpenPaths?: () => Promise<OpenPathSnapshot>;
  measurePathBytes?: (path: string) => Promise<number | undefined>;
  probeServerRunning?: (config: ServerConfig) => Promise<boolean>;
}

interface OpenPathSnapshot {
  available: boolean;
  paths: string[];
}

interface InspectContext {
  config: ServerConfig;
  database: DatabaseHandle;
  retentionDays: number;
  now: number;
  openPaths: OpenPathSnapshot;
  inspectWorktree: typeof inspectManagedWorktree;
  measurePathBytes: (path: string) => Promise<number | undefined>;
}

export async function planWorkspaceGc(
  config: ServerConfig,
  options: { retentionDays?: number } = {},
  runtime: WorkspaceGcRuntime = {},
): Promise<WorkspaceGcPlan> {
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const now = runtime.now?.() ?? Date.now();
  const inspectWorktree = runtime.inspectWorktree ?? inspectManagedWorktree;
  const snapshotOpenPaths = runtime.snapshotOpenPaths ?? defaultSnapshotOpenPaths;
  const measurePathBytes = runtime.measurePathBytes ?? defaultMeasurePathBytes;
  const probeServerRunning = runtime.probeServerRunning ?? defaultProbeServerRunning;

  const database = openDatabase(config.stateDir);
  try {
    const rows = listManagedWorktreeRows(database);
    const openPaths = await snapshotOpenPaths();
    const candidates: WorkspaceGcCandidate[] = [];

    for (const row of rows) {
      candidates.push(
        await inspectCandidate(row, {
          config,
          database,
          retentionDays,
          now,
          openPaths,
          inspectWorktree,
          measurePathBytes,
        }),
      );
    }

    const reclaimable = candidates.filter((candidate) => candidate.reclaimable);
    return {
      planId: buildPlanId(retentionDays, candidates),
      createdAt: new Date(now).toISOString(),
      retentionDays,
      serverRunning: await probeServerRunning(config),
      handleProbeAvailable: openPaths.available,
      totalManagedWorktrees: candidates.length,
      totalEstimatedBytes: sumKnownBytes(candidates),
      reclaimableCount: reclaimable.length,
      reclaimableEstimatedBytes: sumKnownBytes(reclaimable),
      candidates,
    };
  } finally {
    database.close();
  }
}

export async function applyWorkspaceGcPlan(
  config: ServerConfig,
  plan: WorkspaceGcPlan,
  runtime: WorkspaceGcRuntime = {},
): Promise<WorkspaceGcApplyResult> {
  const probeServerRunning = runtime.probeServerRunning ?? defaultProbeServerRunning;
  if (await probeServerRunning(config)) {
    throw new Error(
      "Refusing to apply workspace GC while the DevSpace server is running. Stop DevSpace first so no in-memory workspace or process session can race with reclamation.",
    );
  }

  const now = runtime.now?.() ?? Date.now();
  const inspectWorktree = runtime.inspectWorktree ?? inspectManagedWorktree;
  const removeWorktree = runtime.removeWorktree ?? removeManagedWorktree;
  const snapshotOpenPaths = runtime.snapshotOpenPaths ?? defaultSnapshotOpenPaths;
  const measurePathBytes = runtime.measurePathBytes ?? defaultMeasurePathBytes;
  const openPaths = await snapshotOpenPaths();
  const database = openDatabase(config.stateDir);
  const items: WorkspaceGcApplyItem[] = [];
  let reclaimedEstimatedBytes = 0;
  let reclaimedBytesKnown = false;

  try {
    for (const planned of plan.candidates.filter((candidate) => candidate.reclaimable)) {
      const row = getManagedWorktreeRow(database, planned.workspaceId);
      if (!row) {
        items.push({
          workspaceId: planned.workspaceId,
          path: planned.path,
          outcome: "skipped_changed",
          error: "Workspace session no longer exists or is no longer a managed worktree.",
        });
        continue;
      }

      const current = await inspectCandidate(row, {
        config,
        database,
        retentionDays: plan.retentionDays,
        now,
        openPaths,
        inspectWorktree,
        measurePathBytes,
      });

      if (!current.reclaimable) {
        items.push({
          workspaceId: current.workspaceId,
          path: current.path,
          outcome: "skipped_blocked",
          blockers: current.blockers,
          error: current.error,
        });
        continue;
      }

      if (current.fingerprint !== planned.fingerprint) {
        items.push({
          workspaceId: current.workspaceId,
          path: current.path,
          outcome: "skipped_changed",
          error: "Workspace state changed after the GC plan was created.",
        });
        continue;
      }

      try {
        await removeWorktree({
          sourceRoot: current.sourceRoot!,
          path: current.path,
          config,
        });
        markWorkspaceReclaimed(database, current.workspaceId);
        if (current.estimatedBytes !== undefined) {
          reclaimedEstimatedBytes += current.estimatedBytes;
          reclaimedBytesKnown = true;
        }
        items.push({
          workspaceId: current.workspaceId,
          path: current.path,
          outcome: "reclaimed",
        });
      } catch (error) {
        items.push({
          workspaceId: current.workspaceId,
          path: current.path,
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    database.close();
  }

  return {
    planId: plan.planId,
    reclaimedCount: items.filter((item) => item.outcome === "reclaimed").length,
    reclaimedEstimatedBytes: reclaimedBytesKnown ? reclaimedEstimatedBytes : undefined,
    skippedCount: items.filter(
      (item) => item.outcome === "skipped_blocked" || item.outcome === "skipped_changed",
    ).length,
    failedCount: items.filter((item) => item.outcome === "failed").length,
    items,
  };
}

async function inspectCandidate(
  row: WorkspaceSessionRow,
  context: InspectContext,
): Promise<WorkspaceGcCandidate> {
  const blockers: WorkspaceGcBlocker[] = [];
  const ageMs = Math.max(0, context.now - parseTimestamp(row.last_used_at));
  const bindingCount = countConversationBindings(context.database, row.id);
  const activeAgentCount = countActiveAgents(context.database, row.id);
  const sourceRoot = row.source_root ?? undefined;
  const baseSha = row.base_sha ?? undefined;
  let inspection: ManagedWorktreeInspection | undefined;
  let error: string | undefined;
  let estimatedBytes: number | undefined;
  let openHandleCount: number | undefined;

  if (ageMs < context.retentionDays * DAY_MS) blockers.push("recently_used");
  if (!baseSha) blockers.push("missing_base_sha");
  if (!sourceRoot) blockers.push("missing_source_root");
  if (bindingCount > 0) blockers.push("conversation_bound");
  if (activeAgentCount > 0) blockers.push("agent_active");

  try {
    assertAllowedPath(row.root, [context.config.worktreeRoot]);
  } catch {
    blockers.push("path_outside_worktree_root");
  }

  if (sourceRoot) {
    try {
      assertAllowedPath(sourceRoot, context.config.allowedRoots);
    } catch {
      blockers.push("source_outside_allowed_roots");
    }
  }

  if (!blockers.includes("path_outside_worktree_root")) {
    if (!context.openPaths.available) {
      blockers.push("handles_unknown");
    } else {
      openHandleCount = context.openPaths.paths.filter((path) =>
        isPathInsideRoot(path, row.root)
      ).length;
      if (openHandleCount > 0) blockers.push("open_handles");
    }
    estimatedBytes = await context.measurePathBytes(row.root);
  }

  if (
    sourceRoot &&
    !blockers.includes("path_outside_worktree_root") &&
    !blockers.includes("source_outside_allowed_roots")
  ) {
    try {
      inspection = await context.inspectWorktree({
        sourceRoot,
        path: row.root,
        config: context.config,
      });
      if (!inspection.exists) blockers.push("path_missing");
      if (!inspection.recognizedByGit) blockers.push("git_unrecognized");
      if (inspection.locked) blockers.push("git_locked");
      if (inspection.prunable) blockers.push("git_prunable");
      if (inspection.dirty) blockers.push("dirty");
      if (baseSha && inspection.headSha && inspection.headSha !== baseSha) {
        blockers.push("head_diverged");
      }
    } catch (inspectionError) {
      blockers.push("inspection_error");
      error = inspectionError instanceof Error ? inspectionError.message : String(inspectionError);
      if (/does not exist|not a git repository|cannot change to/i.test(error)) {
        blockers.push("source_missing");
      }
    }
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  const fingerprint = candidateFingerprint({
    workspaceId: row.id,
    path: row.root,
    sourceRoot,
    baseSha,
    status: row.status,
    lastUsedAt: row.last_used_at,
    bindingCount,
    activeAgentCount,
    openHandleCount,
    inspection,
    blockers: uniqueBlockers,
  });

  return {
    workspaceId: row.id,
    path: row.root,
    sourceRoot,
    baseSha,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ageMs,
    estimatedBytes,
    bindingCount,
    activeAgentCount,
    openHandleCount,
    inspection,
    blockers: uniqueBlockers,
    error,
    fingerprint,
    reclaimable: uniqueBlockers.length === 0,
  };
}

function listManagedWorktreeRows(database: DatabaseHandle): WorkspaceSessionRow[] {
  return database.sqlite
    .prepare(
      `select id, root, status, mode, source_root, base_sha, managed, created_at, last_used_at
       from workspace_sessions
       where mode = 'worktree' and managed = 'true' and status != 'reclaimed'
       order by last_used_at asc`,
    )
    .all() as WorkspaceSessionRow[];
}

function getManagedWorktreeRow(
  database: DatabaseHandle,
  workspaceId: string,
): WorkspaceSessionRow | undefined {
  return database.sqlite
    .prepare(
      `select id, root, status, mode, source_root, base_sha, managed, created_at, last_used_at
       from workspace_sessions
       where id = ? and mode = 'worktree' and managed = 'true' and status != 'reclaimed'
       limit 1`,
    )
    .get(workspaceId) as WorkspaceSessionRow | undefined;
}

function countConversationBindings(database: DatabaseHandle, workspaceId: string): number {
  const row = database.sqlite
    .prepare(
      `select count(*) as count
       from workspace_conversation_bindings
       where workspace_session_id = ?`,
    )
    .get(workspaceId) as { count: number };
  return Number(row.count);
}

function countActiveAgents(database: DatabaseHandle, workspaceId: string): number {
  const rows = database.sqlite
    .prepare(
      `select status
       from local_agent_sessions
       where workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ status: string }>;
  return rows.filter((row) => ACTIVE_AGENT_STATUSES.has(row.status)).length;
}

function markWorkspaceReclaimed(database: DatabaseHandle, workspaceId: string): void {
  const transaction = database.sqlite.transaction(() => {
    database.sqlite
      .prepare("delete from workspace_conversation_bindings where workspace_session_id = ?")
      .run(workspaceId);
    database.sqlite
      .prepare("update workspace_sessions set status = 'reclaimed' where id = ?")
      .run(workspaceId);
  });
  transaction();
}

function normalizeRetentionDays(value: number | undefined): number {
  const retentionDays = value ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`retentionDays must be a non-negative number, got ${String(value)}`);
  }
  return retentionDays;
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildPlanId(retentionDays: number, candidates: WorkspaceGcCandidate[]): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        retentionDays,
        candidates: candidates.map((candidate) => [candidate.workspaceId, candidate.fingerprint]),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `gc_${digest}`;
}

function candidateFingerprint(input: {
  workspaceId: string;
  path: string;
  sourceRoot?: string;
  baseSha?: string;
  status: string;
  lastUsedAt: string;
  bindingCount: number;
  activeAgentCount: number;
  openHandleCount?: number;
  inspection?: ManagedWorktreeInspection;
  blockers: WorkspaceGcBlocker[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        path: resolve(input.path),
        sourceRoot: input.sourceRoot ? resolve(input.sourceRoot) : undefined,
        baseSha: input.baseSha,
        status: input.status,
        lastUsedAt: input.lastUsedAt,
        bindingCount: input.bindingCount,
        activeAgentCount: input.activeAgentCount,
        openHandleCount: input.openHandleCount,
        exists: input.inspection?.exists,
        recognizedByGit: input.inspection?.recognizedByGit,
        locked: input.inspection?.locked,
        prunable: input.inspection?.prunable,
        dirty: input.inspection?.dirty,
        headSha: input.inspection?.headSha,
        blockers: input.blockers,
      }),
    )
    .digest("hex");
}

function sumKnownBytes(candidates: WorkspaceGcCandidate[]): number | undefined {
  const known = candidates.filter((candidate) => candidate.estimatedBytes !== undefined);
  if (known.length === 0) return undefined;
  return known.reduce((sum, candidate) => sum + (candidate.estimatedBytes ?? 0), 0);
}

async function defaultMeasurePathBytes(path: string): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("du", ["-sk", path], {
      maxBuffer: 1024 * 1024,
    });
    const blocks = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(blocks) ? blocks * 1024 : undefined;
  } catch {
    return undefined;
  }
}

async function defaultSnapshotOpenPaths(): Promise<OpenPathSnapshot> {
  if (process.platform === "win32") return { available: false, paths: [] };
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-F", "n"], {
      maxBuffer: 100 * 1024 * 1024,
    });
    const paths = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1))
      .filter((path) => isAbsolute(path));
    return { available: true, paths: Array.from(new Set(paths)) };
  } catch (error) {
    if (isCommandMissing(error)) return { available: false, paths: [] };
    // lsof may return a non-zero status when it cannot inspect every process.
    // Treat that as unknown rather than incorrectly declaring a path unused.
    return { available: false, paths: [] };
  }
}

async function defaultProbeServerRunning(config: ServerConfig): Promise<boolean> {
  const host = localProbeHost(config.host);
  const url = `http://${host}:${config.port}/healthz`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function localProbeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function isCommandMissing(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
