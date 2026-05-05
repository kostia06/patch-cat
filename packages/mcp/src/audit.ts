// Forensic audit trails. Every tool execution writes a content-addressed blob
// containing exactly enough state to replay the run later. Privacy-conscious:
// user-prompt content is hashed, never stored verbatim. External-API responses
// captured in stdout/stderr are stored on disk only — never phoned home unless
// the user explicitly opts in via audit.contribute_enabled (Phase 4 §1).
//
// Storage layout (per-toolbox):
//   <toolbox>/runs/<run_id>.json                  — the blob
//   <toolbox>/runs/blobs/<stdout_sha256>.txt      — full stdout (content-addressed; dedupes)
//   <toolbox>/runs/blobs/<stderr_sha256>.txt      — full stderr

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AUDIT_SCHEMA_VERSION = "1";

export interface AuditCapabilities {
  network: boolean;
  filesystem: "none" | "read-only" | "read-write";
  human_confirm: boolean;
}

export interface AuditSandboxState {
  template_id: string | null;
  capabilities: AuditCapabilities;
  packages_installed: string[];
  allow_internet_access: boolean;
  envs_keys: string[];
}

export interface AuditTrigger {
  /** Host MCP client name reported during initialize (e.g. "claude-desktop"). */
  host_app: string | null;
  /** Free-form host descriptor reported by the client. */
  mcp_client_name: string | null;
  /**
   * SHA-256 of the user's natural-language prompt if the host AI surfaces it.
   * MCP does not currently have a standard surface for this; null in v0.4.
   * Phase 5 may add a host-extension protocol that propagates the hash.
   */
  user_prompt_hash: string | null;
}

export interface AuditNetworkCall {
  method: string;
  url: string;
  status: number;
  duration_ms: number;
}

export interface AuditBlob {
  schema_version: typeof AUDIT_SCHEMA_VERSION;
  run_id: string;
  ran_at: string;
  tool: {
    name: string;
    version: string;
    source_sha256: string;
  };
  sandbox: AuditSandboxState;
  trigger: AuditTrigger;
  inputs: Record<string, unknown>;
  output: unknown;
  stdout_sha256: string;
  stderr_sha256: string;
  /**
   * Network calls captured at the sandbox layer. Empty in v0.4; populating
   * this requires either a custom e2b template with mitmproxy or per-call
   * instrumentation in generated tools. Documented as v1.x in THREAT_MODEL.md.
   */
  network: AuditNetworkCall[];
  exit_code: number;
  duration_ms: number;
  /** Human-readable assertions about what was enforced for this run. */
  capability_assertions: string[];
}

export interface AuditWriterDeps {
  toolboxDir: string;
}

export interface RecordRunInput {
  toolName: string;
  toolVersion: string;
  toolSource: string;
  capabilities: AuditCapabilities;
  packagesInstalled: string[];
  allowInternetAccess: boolean;
  envsKeys: string[];
  trigger: AuditTrigger;
  inputs: Record<string, unknown>;
  output: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface AuditWriter {
  readonly runsDir: string;
  recordRun(input: RecordRunInput): Promise<AuditBlob>;
  loadBlob(runId: string): Promise<AuditBlob | null>;
  loadBlobByContent(stream: "stdout" | "stderr", sha256: string): Promise<string | null>;
}

export function createAuditWriter(deps: AuditWriterDeps): AuditWriter {
  const runsDir = join(deps.toolboxDir, "runs");
  const blobsDir = join(runsDir, "blobs");

  async function ensureDirs(): Promise<void> {
    await mkdir(blobsDir, { recursive: true });
  }

  async function writeContentAddressed(content: string): Promise<string> {
    const sha = sha256(content);
    const path = join(blobsDir, `${sha}.txt`);
    if (!existsSync(path)) {
      await writeFile(path, content, "utf8");
    }
    return sha;
  }

  return {
    runsDir,

    async recordRun(input) {
      await ensureDirs();

      const runId = randomUUID();
      const sourceSha = sha256(input.toolSource);
      const stdoutSha = await writeContentAddressed(input.stdout);
      const stderrSha = await writeContentAddressed(input.stderr);

      const assertions = buildCapabilityAssertions(input);

      const blob: AuditBlob = {
        schema_version: AUDIT_SCHEMA_VERSION,
        run_id: runId,
        ran_at: new Date().toISOString(),
        tool: {
          name: input.toolName,
          version: input.toolVersion,
          source_sha256: sourceSha,
        },
        sandbox: {
          template_id: null,
          capabilities: input.capabilities,
          packages_installed: input.packagesInstalled,
          allow_internet_access: input.allowInternetAccess,
          envs_keys: input.envsKeys,
        },
        trigger: input.trigger,
        inputs: input.inputs,
        output: input.output,
        stdout_sha256: stdoutSha,
        stderr_sha256: stderrSha,
        network: [],
        exit_code: input.exitCode,
        duration_ms: input.durationMs,
        capability_assertions: assertions,
      };

      const blobPath = join(runsDir, `${runId}.json`);
      await writeFile(blobPath, `${JSON.stringify(blob, null, 2)}\n`, "utf8");
      return blob;
    },

    async loadBlob(runId) {
      const path = join(runsDir, `${runId}.json`);
      if (!existsSync(path)) return null;
      const raw = await readFile(path, "utf8");
      try {
        return JSON.parse(raw) as AuditBlob;
      } catch {
        return null;
      }
    },

    async loadBlobByContent(_stream, sha256Hex) {
      const path = join(blobsDir, `${sha256Hex}.txt`);
      if (!existsSync(path)) return null;
      return readFile(path, "utf8");
    },
  };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildCapabilityAssertions(input: RecordRunInput): string[] {
  const assertions: string[] = [];

  // Network
  if (input.capabilities.network) {
    assertions.push(
      input.allowInternetAccess
        ? "network: true requested by tool; sandbox allowInternetAccess=true (allowed)."
        : "network: true requested by tool but sandbox allowInternetAccess=false (DENIED — runtime override).",
    );
  } else {
    assertions.push(
      input.allowInternetAccess
        ? "network: false declared by tool but allowInternetAccess=true (mismatch — investigate)."
        : "network: false declared by tool; sandbox allowInternetAccess=false (enforced).",
    );
  }

  // Filesystem
  assertions.push(
    `filesystem: "${input.capabilities.filesystem}" declared (NOT runtime-enforced in v0.4 — see THREAT_MODEL.md).`,
  );

  // Human confirm
  if (input.capabilities.human_confirm) {
    assertions.push("human_confirm: true — execution gated by patch_confirm_action.");
  }

  // Envs (keys only)
  if (input.envsKeys.length > 0) {
    assertions.push(`env keys injected: ${input.envsKeys.join(", ")} (values never logged).`);
  }

  return assertions;
}
