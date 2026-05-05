import { Sandbox } from "@e2b/code-interpreter";
import { SandboxError, ToolOutputError } from "@patch-cat/shared";
import type { ParsedTool, ToolManifest } from "@patch-cat/shared";

const DEFAULT_TIMEOUT_MS = 60_000;
const TOOL_PATH = "/tmp/tool.py";
const ARGS_PATH = "/tmp/args.json";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxLike {
  files: {
    write(path: string, content: string): Promise<unknown>;
  };
  commands: {
    run(cmd: string, options?: { timeoutMs?: number }): Promise<CommandResult>;
  };
  kill(): Promise<unknown>;
}

export interface SandboxCreateOptions {
  timeoutMs?: number;
  /**
   * If false, the sandbox is created with network egress blocked at the
   * provider level (e2b's `allowInternetAccess: false`). Default: true.
   */
  allowInternetAccess?: boolean;
  /**
   * Environment variables visible inside the sandbox. Used to inject Arcade-
   * minted PATCH_ACCESS_TOKEN values for tools with external_auth scopes.
   */
  envs?: Record<string, string>;
}

export interface SandboxFactory {
  create(options?: SandboxCreateOptions): Promise<SandboxLike>;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Env vars to inject into the sandbox (e.g. PATCH_ACCESS_TOKEN). */
  envs?: Record<string, string>;
}

export interface CapabilityEnforcement {
  network: "enforced" | "not_enforced";
  filesystem: "not_enforced";
}

export const CAPABILITY_ENFORCEMENT: CapabilityEnforcement = {
  network: "enforced",
  filesystem: "not_enforced",
};

export interface RunResult {
  result: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxRunner {
  runTool(
    parsed: ParsedTool,
    args: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<RunResult>;
  syntaxCheck(parsed: ParsedTool, options?: RunOptions): Promise<void>;
}

export function createSandboxRunner(factory: SandboxFactory): SandboxRunner {
  return {
    async runTool(parsed, args, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // Capability enforcement: when manifest declares network: false, the
      // sandbox is created with allowInternetAccess: false so e2b blocks egress
      // at the provider layer. This is enforced by sandbox config, not by the
      // generated tool's promise to behave.
      const allowInternetAccess = parsed.manifest.capabilities.network !== false;
      const sandbox = await createSandbox(factory, {
        timeoutMs,
        allowInternetAccess,
        envs: options.envs,
      });

      try {
        await writeToolFiles(sandbox, parsed, args);
        await installPackages(sandbox, parsed.manifest, timeoutMs);

        const result = await sandbox.commands.run(`python ${TOOL_PATH} < ${ARGS_PATH}`, {
          timeoutMs,
        });

        if (result.exitCode !== 0) {
          throw new ToolOutputError(
            `Tool exited with code ${result.exitCode}.`,
            result.stdout,
            result.stderr,
          );
        }

        const parsedOutput = parseOutput(result.stdout, result.stderr);
        return {
          result: parsedOutput,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } finally {
        await safeKill(sandbox);
      }
    },

    async syntaxCheck(parsed, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // Syntax check only runs `python -m py_compile`; no network needed.
      const sandbox = await createSandbox(factory, {
        timeoutMs,
        allowInternetAccess: false,
      });
      try {
        await sandbox.files.write(TOOL_PATH, serializeForCheck(parsed));
        const result = await sandbox.commands.run(`python -m py_compile ${TOOL_PATH}`, {
          timeoutMs,
        });
        if (result.exitCode !== 0) {
          throw new ToolOutputError(
            "Generated tool failed py_compile.",
            result.stdout,
            result.stderr,
          );
        }
      } finally {
        await safeKill(sandbox);
      }
    },
  };
}

export function createE2BSandboxFactory(apiKey?: string): SandboxFactory {
  return {
    async create(options = {}) {
      try {
        const sandbox = await Sandbox.create({
          apiKey,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          allowInternetAccess: options.allowInternetAccess ?? true,
          envs: options.envs,
        });
        return sandbox as unknown as SandboxLike;
      } catch (error) {
        throw new SandboxError("Failed to create e2b sandbox.", error);
      }
    },
  };
}

async function createSandbox(
  factory: SandboxFactory,
  options: SandboxCreateOptions,
): Promise<SandboxLike> {
  try {
    return await factory.create(options);
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    throw new SandboxError("Failed to create sandbox.", error);
  }
}

async function writeToolFiles(
  sandbox: SandboxLike,
  parsed: ParsedTool,
  args: Record<string, unknown>,
): Promise<void> {
  await sandbox.files.write(TOOL_PATH, serializeForCheck(parsed));
  await sandbox.files.write(ARGS_PATH, JSON.stringify(args));
}

async function installPackages(
  sandbox: SandboxLike,
  manifest: ToolManifest,
  timeoutMs: number,
): Promise<void> {
  if (manifest.runtime.packages.length === 0) return;
  const packageList = manifest.runtime.packages.map(shellQuote).join(" ");
  const result = await sandbox.commands.run(
    `pip install --no-input --quiet --disable-pip-version-check ${packageList}`,
    { timeoutMs },
  );
  if (result.exitCode !== 0) {
    throw new SandboxError(
      `pip install failed with exit code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
    );
  }
}

function parseOutput(stdout: string, stderr: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ToolOutputError("Tool produced no stdout.", stdout, stderr);
  }
  const lastLine = trimmed.split(/\r?\n/).at(-1) ?? "";
  try {
    return JSON.parse(lastLine);
  } catch (error) {
    throw new ToolOutputError(
      "Tool output is not valid JSON on the final stdout line.",
      stdout,
      stderr,
      error,
    );
  }
}

function serializeForCheck(parsed: ParsedTool): string {
  return parsed.body.startsWith("# ---") ? parsed.body : reconstruct(parsed);
}

function reconstruct(parsed: ParsedTool): string {
  // We rebuild a minimal Python file by trusting the body — the body already excludes the
  // frontmatter. For execution, the frontmatter is comments only, so it's safe to omit.
  return parsed.body;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9._=@+\-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function safeKill(sandbox: SandboxLike): Promise<void> {
  try {
    await sandbox.kill();
  } catch {
    // Best effort — already torn down or unreachable.
  }
}
