#!/usr/bin/env node
import { loadConfig } from "./config.js";
import {
  applyWorkspaceGcPlan,
  planWorkspaceGc,
  type WorkspaceGcApplyResult,
  type WorkspaceGcCandidate,
  type WorkspaceGcPlan,
} from "./workspace-gc.js";

interface CliOptions {
  apply: boolean;
  json: boolean;
  retentionDays?: number;
  help: boolean;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const plan = await planWorkspaceGc(config, { retentionDays: options.retentionDays });

  if (!options.apply) {
    if (options.json) console.log(JSON.stringify({ plan }, null, 2));
    else printPlan(plan);
    return;
  }

  const result = await applyWorkspaceGcPlan(config, plan);
  if (options.json) console.log(JSON.stringify({ plan, result }, null, 2));
  else {
    printPlan(plan);
    printApplyResult(result);
  }

  if (result.failedCount > 0) process.exitCode = 1;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--older-than-days" || arg === "--retention-days") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a number.`);
      options.retentionDays = parseNonNegativeNumber(value, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--older-than-days=")) {
      options.retentionDays = parseNonNegativeNumber(arg.slice(arg.indexOf("=") + 1), "--older-than-days");
      continue;
    }
    if (arg.startsWith("--retention-days=")) {
      options.retentionDays = parseNonNegativeNumber(arg.slice(arg.indexOf("=") + 1), "--retention-days");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseNonNegativeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative number, got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function printPlan(plan: WorkspaceGcPlan): void {
  console.log(`DevSpace managed worktree GC plan ${plan.planId}`);
  console.log(`  retention:           ${plan.retentionDays} day(s)`);
  console.log(`  server running:      ${plan.serverRunning ? "yes" : "no"}`);
  console.log(`  open-handle probe:   ${plan.handleProbeAvailable ? "available" : "unavailable (apply blocked)"}`);
  console.log(`  managed worktrees:   ${plan.totalManagedWorktrees}`);
  console.log(`  estimated footprint: ${formatBytes(plan.totalEstimatedBytes)}`);
  console.log(`  reclaimable:         ${plan.reclaimableCount}`);
  console.log(`  estimated reclaim:   ${formatBytes(plan.reclaimableEstimatedBytes)}`);

  const reclaimable = plan.candidates.filter((candidate) => candidate.reclaimable);
  if (reclaimable.length > 0) {
    console.log("\nReclaimable:");
    for (const candidate of reclaimable) printCandidate(candidate);
  }

  const blocked = plan.candidates.filter((candidate) => !candidate.reclaimable);
  if (blocked.length > 0) {
    console.log("\nPreserved:");
    for (const candidate of blocked) printCandidate(candidate);
  }

  if (plan.serverRunning) {
    console.log("\nApply is intentionally refused while the DevSpace server is running. Stop it, rerun the dry-run, then use --apply.");
  } else if (!plan.handleProbeAvailable) {
    console.log("\nApply remains conservative because open handles could not be inspected on this machine.");
  } else {
    console.log("\nDry-run only. Re-run with --apply to revalidate every candidate and reclaim only unchanged safe worktrees.");
  }
}

function printCandidate(candidate: WorkspaceGcCandidate): void {
  const ageDays = candidate.ageMs / (24 * 60 * 60 * 1_000);
  const state = candidate.reclaimable ? "SAFE" : candidate.blockers.join(", ");
  console.log(
    `  ${candidate.workspaceId}  ${formatBytes(candidate.estimatedBytes).padStart(10)}  ${ageDays.toFixed(1).padStart(6)}d  ${state}`,
  );
  console.log(`    ${candidate.path}`);
  if (candidate.error) console.log(`    inspection: ${candidate.error}`);
}

function printApplyResult(result: WorkspaceGcApplyResult): void {
  console.log("\nApply result:");
  console.log(`  reclaimed: ${result.reclaimedCount} (${formatBytes(result.reclaimedEstimatedBytes)})`);
  console.log(`  skipped:   ${result.skippedCount}`);
  console.log(`  failed:    ${result.failedCount}`);

  for (const item of result.items) {
    const details = item.blockers?.length
      ? ` [${item.blockers.join(", ")}]`
      : item.error
        ? ` [${item.error}]`
        : "";
    console.log(`  ${item.outcome.padEnd(15)} ${item.workspaceId} ${item.path}${details}`);
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function printHelp(): void {
  console.log(`Usage: devspace-worktree-gc [options]

Safely inspect and reclaim managed DevSpace Git worktrees.

Options:
  --older-than-days N   Require last use to be at least N days old (default: 7)
  --apply               Revalidate and reclaim safe candidates (dry-run is default)
  --json                Emit machine-readable JSON
  -h, --help            Show this help

Safety:
  * never uses rm -rf for normal reclamation
  * never passes --force to git worktree remove
  * preserves dirty, diverged, locked, bound, active-agent, or open-handle worktrees
  * refuses --apply while the DevSpace server is running
  * revalidates the full candidate fingerprint immediately before removal
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
