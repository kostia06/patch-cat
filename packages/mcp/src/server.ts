import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  manifestToInputSchema,
  PatchError,
  serializeManifest,
  ToolNotFoundError,
  type ToolManifest,
} from "@patch-cat/shared";
import type { Logger } from "pino";
import { type ArcadeClient, NOOP_ARCADE_CLIENT, providersFromScopes } from "./arcade.js";
import { type AuditBlob, type AuditWriter, createAuditWriter, sha256 } from "./audit.js";
import { startOAuthListener } from "./auth-flow.js";
import {
  type ConfirmationStore,
  createConfirmationStore,
  summarizeArgs,
} from "./confirmation.js";
import { loadConfig, saveConfig, type PatchConfig } from "./config.js";
import type { Generator } from "./generator.js";
import { NOOP_REGISTRY_CLIENT, type RegistryClient } from "./registry-client.js";
import type { SandboxRunner } from "./sandbox.js";
import { createTaintTracker, findTaintedInputs, type TaintTracker } from "./taint.js";
import type { Toolbox } from "./toolbox.js";

const META_GENERATE = "patch_generate_tool";
const META_RUN = "patch_run_tool";
const META_LIST = "patch_list_tools";
const META_AUTH_REGISTER = "patch_auth_register";
const META_AUTH_STATUS = "patch_auth_status";
const META_CONFIRM_ACTION = "patch_confirm_action";
const META_LIST_RUNS = "patch_list_runs";
const META_REPLAY = "patch_replay";

const PULL_SIMILARITY_THRESHOLD = 0.85;
const PULL_SUCCESS_RATE_THRESHOLD = 0.7;

const META_TOOLS: Tool[] = [
  {
    name: META_GENERATE,
    description:
      "Acquire a Python tool that fulfills the description. If a high-quality match exists in the hosted registry, it's pulled and registered. Otherwise a new tool is generated locally, sandbox-tested, and persisted. Call this whenever you need a capability the toolbox doesn't have.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "What the new tool should do.",
        },
        name_hint: {
          type: "string",
          description: "Optional snake_case name suggestion.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: META_RUN,
    description:
      "Explicitly invoke a tool from the toolbox by name. Mostly for debugging — normally call the individual tool directly.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name." },
        args: {
          type: "object",
          description: "Tool arguments.",
          additionalProperties: true,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: META_LIST,
    description: "List every tool currently in the local toolbox with name, version, description.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: META_AUTH_REGISTER,
    description:
      "Authorize this Patch instance to contribute new tools to the registry under the user's GitHub identity. Returns a URL the user must open in a browser; Patch detects the OAuth callback automatically and persists the contribute token. Blocks for up to 5 minutes waiting for completion.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "OAuth provider. Only 'github' is supported in v0.2.",
          default: "github",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: META_AUTH_STATUS,
    description:
      "Show whether registry read/contribute are enabled and whether a contribute token is configured.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: META_CONFIRM_ACTION,
    description:
      "Approve and execute a tool call that was previously blocked by a 'confirmation_required' response. Pass the confirmation_token from that response. After explicit user approval only — never auto-confirm. Tokens are single-use and expire after 60 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        confirmation_token: {
          type: "string",
          description: "Token from the prior confirmation_required response.",
        },
      },
      required: ["confirmation_token"],
      additionalProperties: false,
    },
  },
  {
    name: META_LIST_RUNS,
    description:
      "List recent tool execution runs from the local audit log. Each run has a run_id usable with patch_replay. Useful for debugging, forensics, and curiosity about what an agent did.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum runs to return (default 20, max 200).",
          default: 20,
        },
        tool_name: {
          type: "string",
          description: "Optional filter by tool name.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: META_REPLAY,
    description:
      "Replay a recorded tool execution from the local audit log. Re-runs the same tool with the same inputs in a fresh sandbox and reports whether the source, sandbox config, and output match. Output match is reported honestly: yes / no / n/a-due-to-network (because tools that hit live APIs are non-deterministic by nature).",
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "run_id from a prior patch_list_runs call or audit blob.",
        },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
];

export interface ServerDeps {
  toolbox: Toolbox;
  generator: Generator;
  sandbox: SandboxRunner;
  logger: Logger;
  registry?: RegistryClient;
  config?: PatchConfig;
  serverName?: string;
  serverVersion?: string;
  skipSyntaxCheck?: boolean;
  taintTracker?: TaintTracker;
  confirmationStore?: ConfirmationStore;
  arcade?: ArcadeClient;
  auditWriter?: AuditWriter;
}

export interface PatchServer {
  readonly mcp: Server;
  start(): Promise<void>;
}

export function createPatchServer(deps: ServerDeps): PatchServer {
  const { toolbox, generator, sandbox, logger } = deps;
  const registry = deps.registry ?? NOOP_REGISTRY_CLIENT;
  const taintTracker = deps.taintTracker ?? createTaintTracker();
  const confirmationStore = deps.confirmationStore ?? createConfirmationStore();
  const arcade = deps.arcade ?? NOOP_ARCADE_CLIENT;
  const auditWriter = deps.auditWriter ?? createAuditWriter({ toolboxDir: toolbox.rootDir });
  let config: PatchConfig = deps.config ?? {
    registry: {
      url: registry.baseUrl,
      read_enabled: true,
      contribute_enabled: false,
      contribute_token: null,
    },
  };

  const mcp = new Server(
    {
      name: deps.serverName ?? "patch-cat",
      version: deps.serverVersion ?? "0.2.0",
    },
    {
      capabilities: {
        tools: { listChanged: true },
        logging: {},
      },
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const entries = await toolbox.listTools();
    const dynamicTools: Tool[] = [];
    for (const entry of entries) {
      const parsed = await toolbox.getTool(entry.name);
      if (!parsed) continue;
      dynamicTools.push(buildToolDescriptor(parsed.manifest));
    }
    return { tools: [...META_TOOLS, ...dynamicTools] };
  });

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case META_GENERATE:
          return successJson(await handleGenerate(args));
        case META_RUN:
          return successJson(await handleRun(args));
        case META_LIST:
          return successJson(await handleList());
        case META_AUTH_REGISTER:
          return successJson(await handleAuthRegister(args));
        case META_AUTH_STATUS:
          return successJson(handleAuthStatus());
        case META_CONFIRM_ACTION:
          return successJson(await handleConfirmAction(args));
        case META_LIST_RUNS:
          return successJson(await handleListRuns(args));
        case META_REPLAY:
          return successJson(await handleReplay(args));
        default:
          return successJson(await handleDynamicCall(name, args));
      }
    } catch (error) {
      logger.error({ err: error, tool: name }, "Tool call failed.");
      return errorJson(error);
    }
  });

  async function handleGenerate(args: Record<string, unknown>): Promise<unknown> {
    const description = requireString(args, "description");
    const nameHint = optionalString(args, "name_hint");

    const existing = await toolbox.listTools();
    const existingNames = existing.map((t) => t.name);

    if (config.registry.read_enabled) {
      const pulled = await tryPullFromRegistry(description, existingNames);
      if (pulled) return pulled;
    }

    logger.info({ description, nameHint }, "Generating tool locally.");
    const parsed = await generator.generate({ description, existingNames, nameHint });

    if (!deps.skipSyntaxCheck) {
      logger.info({ tool: parsed.manifest.name }, "Running syntax check.");
      await sandbox.syntaxCheck(parsed);
    }

    const entry = await toolbox.saveTool(parsed.manifest, parsed.body);
    logger.info({ tool: entry.name, version: entry.version }, "Tool saved.");

    await mcp.sendToolListChanged();

    if (config.registry.contribute_enabled && config.registry.contribute_token) {
      const sourceWithFrontmatter = serializeManifest(parsed.manifest, parsed.body);
      registry
        .contributeTool(parsed.manifest, sourceWithFrontmatter)
        .then((response) => {
          logger.info(
            {
              tool: parsed.manifest.name,
              status: response.status,
              sha256: response.source_sha256,
            },
            "Contributed tool to registry.",
          );
        })
        .catch((error) => {
          logger.warn(
            { err: error, tool: parsed.manifest.name },
            "Failed to contribute tool.",
          );
        });
    }

    return {
      name: entry.name,
      version: entry.version,
      description: entry.description,
      status: "created",
      source: "generated",
    };
  }

  async function tryPullFromRegistry(
    description: string,
    existingNames: string[],
  ): Promise<unknown | null> {
    let candidates;
    try {
      candidates = await registry.searchTools(description, 5);
    } catch (error) {
      logger.warn({ err: error }, "Registry search failed; falling back to generation.");
      return null;
    }

    const top = candidates.find((c) => !existingNames.includes(c.name));
    if (!top) {
      logger.info({ candidates: candidates.length }, "No suitable registry tool — will generate.");
      return null;
    }

    const similarity = top.similarity ?? 0;
    const successRate = top.success_rate ?? 1;

    if (similarity < PULL_SIMILARITY_THRESHOLD || successRate < PULL_SUCCESS_RATE_THRESHOLD) {
      logger.info(
        { tool: top.name, similarity, success_rate: successRate },
        "Top registry candidate below thresholds — will generate.",
      );
      return null;
    }

    let fetched;
    try {
      fetched = await registry.fetchTool(top.name, top.latest_version);
    } catch (error) {
      logger.warn(
        { err: error, tool: top.name },
        "Registry fetch failed; falling back to generation.",
      );
      return null;
    }

    const entry = await toolbox.saveTool(fetched.manifest, fetched.source);
    logger.info(
      { tool: entry.name, version: entry.version, similarity, success_rate: successRate },
      "Pulled tool from registry.",
    );
    await mcp.sendToolListChanged();

    return {
      name: entry.name,
      version: entry.version,
      description: entry.description,
      status: "pulled",
      source: "registry",
      similarity,
      success_rate: successRate,
    };
  }

  async function handleRun(args: Record<string, unknown>): Promise<unknown> {
    const name = requireString(args, "name");
    const inner = (args.args ?? {}) as Record<string, unknown>;
    return invokeTool(name, inner);
  }

  async function handleList(): Promise<unknown> {
    const entries = await toolbox.listTools();
    return entries.map(({ name, version, description, lastUsedAt, createdAt }) => ({
      name,
      version,
      description,
      lastUsedAt,
      createdAt,
    }));
  }

  async function handleDynamicCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return invokeTool(name, args);
  }

  async function invokeTool(
    name: string,
    args: Record<string, unknown>,
    options: { skipChecks?: boolean } = {},
  ): Promise<unknown> {
    const parsed = await toolbox.getTool(name);
    if (!parsed) {
      throw new ToolNotFoundError(name);
    }

    if (!options.skipChecks) {
      const violations = findTaintedInputs(args, parsed.manifest.inputs, taintTracker);
      if (violations.length > 0) {
        const sources = Array.from(new Set(violations.flatMap((v) => v.matchedTools)));
        const inputNames = violations.map((v) => v.inputName).join(", ");
        const reason = `Tainted data is being passed to inputs that are not declared tainted_ok: ${inputNames}. Origin: ${sources.join(", ") || "unknown prior tool output"}.`;
        const pending = confirmationStore.create({
          kind: "tainted_input",
          toolName: name,
          args,
          argsSummary: summarizeArgs(args),
          reason,
        });
        logger.warn(
          { tool: name, violations, token: pending.token },
          "Blocked tool call: tainted input requires confirmation.",
        );
        return {
          status: "confirmation_required",
          kind: "tainted_input",
          tool: name,
          confirmation_token: pending.token,
          args_summary: pending.argsSummary,
          reason: pending.reason,
          tainted_inputs: violations,
          instruction: `Surface this to the user. Only after explicit user approval, call patch_confirm_action({ confirmation_token: "${pending.token}" }). Do NOT auto-approve. Token expires in 60 seconds.`,
        };
      }

      if (parsed.manifest.capabilities.human_confirm) {
        const pending = confirmationStore.create({
          kind: "human_confirm",
          toolName: name,
          args,
          argsSummary: summarizeArgs(args),
          reason: "Tool is marked capabilities.human_confirm: true (irreversible action).",
        });
        logger.info(
          { tool: name, token: pending.token },
          "Tool call paused for human confirmation.",
        );
        return {
          status: "confirmation_required",
          kind: "human_confirm",
          tool: name,
          confirmation_token: pending.token,
          args_summary: pending.argsSummary,
          reason: pending.reason,
          instruction: `Surface this to the user. Only after explicit user approval, call patch_confirm_action({ confirmation_token: "${pending.token}" }). Do NOT auto-approve. Token expires in 60 seconds.`,
        };
      }
    }

    // Arcade: mint a scoped token for tools with external_auth, inject into sandbox env.
    let envs: Record<string, string> | undefined;
    const externalAuth = parsed.manifest.external_auth ?? [];
    if (externalAuth.length > 0) {
      const arcadeResult = await arcade.authorize(externalAuth);
      if (arcadeResult.status === "auth_required") {
        const providers = providersFromScopes(externalAuth);
        logger.info(
          { tool: name, scopes: externalAuth, authUrl: arcadeResult.authUrl },
          "Tool requires external auth; surfacing Arcade authorization URL.",
        );
        return {
          status: "external_auth_required",
          tool: name,
          scopes: externalAuth,
          providers,
          auth_url: arcadeResult.authUrl,
          instruction: `This tool needs scoped access to ${providers.join(", ")}. Show the user the auth_url to authorize at Arcade. Once they confirm authorization, retry the original tool call. Patch never sees the user's refresh token.`,
        };
      }
      envs = { PATCH_ACCESS_TOKEN: arcadeResult.token.token };
    }

    logger.info({ tool: name, confirmed: options.skipChecks ?? false }, "Invoking tool.");
    const t0 = Date.now();
    let success = false;
    let errorClass: string | undefined;
    try {
      const result = await sandbox.runTool(parsed, args, { envs });
      success = true;
      await toolbox.markUsed(name);
      taintTracker.recordOutput(name, result.result);

      const durationMs = Date.now() - t0;
      void registry.recordRun(name, {
        version: parsed.manifest.version,
        success: true,
        duration_ms: durationMs,
      });

      // Forensic audit trail. Best-effort — failures here do not break the run.
      try {
        const blob = await auditWriter.recordRun({
          toolName: name,
          toolVersion: parsed.manifest.version,
          toolSource: serializeManifest(parsed.manifest, parsed.body),
          capabilities: parsed.manifest.capabilities,
          packagesInstalled: parsed.manifest.runtime.packages,
          allowInternetAccess: parsed.manifest.capabilities.network !== false,
          envsKeys: envs ? Object.keys(envs) : [],
          trigger: {
            host_app: getHostApp(mcp),
            mcp_client_name: getClientName(mcp),
            user_prompt_hash: null,
          },
          inputs: args,
          output: result.result,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs,
        });
        logger.debug({ tool: name, run_id: blob.run_id }, "Audit blob written.");
      } catch (auditErr) {
        logger.warn({ err: auditErr, tool: name }, "Failed to write audit blob (run not persisted).");
      }

      return result.result;
    } catch (error) {
      errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
      void registry.recordRun(name, {
        version: parsed.manifest.version,
        success: false,
        error_class: errorClass,
        duration_ms: Date.now() - t0,
      });
      throw error;
    } finally {
      logger.debug({ tool: name, success, error_class: errorClass }, "Tool invocation finished.");
    }
  }

  async function handleListRuns(args: Record<string, unknown>): Promise<unknown> {
    const limit = Math.min(Number(args.limit ?? 20) || 20, 200);
    const filterTool = optionalString(args, "tool_name");
    const blobs = await listRecentBlobs(auditWriter.runsDir, limit * 4);
    const filtered = filterTool
      ? blobs.filter((b) => b.tool.name === filterTool)
      : blobs;
    return filtered.slice(0, limit).map((b) => ({
      run_id: b.run_id,
      ran_at: b.ran_at,
      tool: b.tool.name,
      version: b.tool.version,
      duration_ms: b.duration_ms,
      exit_code: b.exit_code,
    }));
  }

  async function handleReplay(args: Record<string, unknown>): Promise<unknown> {
    const runId = requireString(args, "run_id");
    const blob = await auditWriter.loadBlob(runId);
    if (!blob) {
      throw new PatchError(`No audit blob found for run_id "${runId}".`);
    }

    const current = await toolbox.getTool(blob.tool.name);
    if (!current) {
      return {
        run_id: runId,
        replay_status: "tool_missing",
        original: blob.tool,
        message: `Tool "${blob.tool.name}" is not in the current toolbox. Pull it from the registry by version "${blob.tool.version}" to replay.`,
      };
    }

    const currentSourceSha = sha256(serializeManifest(current.manifest, current.body));
    if (currentSourceSha !== blob.tool.source_sha256) {
      return {
        run_id: runId,
        replay_status: "source_changed",
        original: blob.tool,
        current: { name: current.manifest.name, version: current.manifest.version, source_sha256: currentSourceSha },
        message:
          "The local copy of this tool has different source than the recorded run. Replay would not faithfully reproduce the original; pin to the recorded version (or fetch from the registry by source_sha256) and retry.",
      };
    }

    // Source matches — re-run.
    const t0 = Date.now();
    const result = await sandbox.runTool(current, blob.inputs as Record<string, unknown>, {
      envs: blob.sandbox.envs_keys.includes("PATCH_ACCESS_TOKEN")
        ? { PATCH_ACCESS_TOKEN: "(replay-placeholder)" }
        : undefined,
    });
    const durationMs = Date.now() - t0;

    const originalOutputJson = JSON.stringify(blob.output);
    const replayOutputJson = JSON.stringify(result.result);

    let outputMatch: "yes" | "no" | "na_non_deterministic";
    if (originalOutputJson === replayOutputJson) {
      outputMatch = "yes";
    } else if (blob.sandbox.capabilities.network) {
      outputMatch = "na_non_deterministic";
    } else {
      outputMatch = "no";
    }

    return {
      run_id: runId,
      replay_status: "replayed",
      source_match: true,
      sandbox_match: {
        capabilities: blob.sandbox.capabilities,
        allow_internet_access: blob.sandbox.allow_internet_access,
      },
      output_match: outputMatch,
      original_output: blob.output,
      replay_output: result.result,
      original_duration_ms: blob.duration_ms,
      replay_duration_ms: durationMs,
      capability_assertions: blob.capability_assertions,
      explanation: explainOutputMatch(outputMatch, blob),
    };
  }

  async function handleConfirmAction(args: Record<string, unknown>): Promise<unknown> {
    const token = requireString(args, "confirmation_token");
    const pending = confirmationStore.consume(token);
    if (!pending) {
      throw new PatchError(
        "Confirmation token is invalid, expired, or already used. Re-issue the original tool call to obtain a new token.",
      );
    }
    logger.info(
      { tool: pending.toolName, kind: pending.kind, age_ms: Date.now() - pending.createdAt },
      "Confirming previously paused tool call.",
    );
    return invokeTool(pending.toolName, pending.args, { skipChecks: true });
  }

  async function handleAuthRegister(args: Record<string, unknown>): Promise<unknown> {
    const provider = optionalString(args, "provider") ?? "github";
    if (provider !== "github") {
      throw new PatchError(
        `Unsupported provider "${provider}". Only "github" is supported in v0.2.`,
      );
    }

    const listener = await startOAuthListener();
    const authStartUrl = `${config.registry.url.replace(/\/$/, "")}/auth/github/start?redirect=${encodeURIComponent(listener.url)}`;

    logger.info({ authStartUrl, callback: listener.url }, "Started OAuth listener.");

    // Direct stderr write — bypasses pino + MCP logging notifications. Always visible to
    // anyone reading the subprocess stderr (which the auth-bootstrap script forwards to
    // the terminal). Hosts with logging capability also get the structured notification below.
    process.stderr.write(
      `\n[patch-cat] Open this URL in a browser to authorize:\n  ${authStartUrl}\n\n`,
    );

    try {
      try {
        await mcp.sendLoggingMessage({
          level: "info",
          logger: "patch-cat",
          data: `Open this URL in a browser to authorize Patch contribution: ${authStartUrl}`,
        });
      } catch {
        // Hosts that don't support logging notifications still see the URL in the response.
      }

      const token = await listener.tokenPromise;
      const updated: PatchConfig = {
        registry: {
          ...config.registry,
          contribute_token: token,
          contribute_enabled: true,
        },
      };
      await saveConfig(toolbox.rootDir, updated);
      config = updated;

      logger.info("Contribute token saved; contribute_enabled = true.");

      return {
        status: "authorized",
        auth_url: authStartUrl,
        message:
          "OAuth completed. Contribute token saved to config.json. registry.contribute_enabled is now true.",
      };
    } catch (error) {
      listener.close();
      throw error;
    }
  }

  function handleAuthStatus(): unknown {
    return {
      registry_url: config.registry.url,
      read_enabled: config.registry.read_enabled,
      contribute_enabled: config.registry.contribute_enabled,
      has_contribute_token: Boolean(config.registry.contribute_token),
    };
  }

  return {
    mcp,
    async start() {
      await toolbox.init();

      if (!deps.config) {
        config = await loadConfig(toolbox.rootDir);
      }

      logger.info(
        {
          root: toolbox.rootDir,
          registry_url: config.registry.url,
          read_enabled: config.registry.read_enabled,
          contribute_enabled: config.registry.contribute_enabled,
        },
        "Toolbox initialized.",
      );
    },
  };
}

function buildToolDescriptor(manifest: ToolManifest): Tool {
  return {
    name: manifest.name,
    description: manifest.description,
    inputSchema: manifestToInputSchema(manifest) as unknown as Tool["inputSchema"],
  };
}

function getHostApp(server: Server): string | null {
  try {
    const version = (server as unknown as { getClientVersion?: () => { name?: string } | undefined })
      .getClientVersion?.();
    if (typeof version?.name === "string") return version.name;
  } catch {
    /* swallow */
  }
  return null;
}

function getClientName(server: Server): string | null {
  return getHostApp(server);
}

async function listRecentBlobs(runsDir: string, max: number): Promise<AuditBlob[]> {
  if (!existsSyncSafe(runsDir)) return [];
  const fsPromises = await import("node:fs/promises");
  const entries = await fsPromises.readdir(runsDir);
  const jsonFiles = entries.filter((e) => e.endsWith(".json"));
  const stats = await Promise.all(
    jsonFiles.map(async (f) => {
      const path = `${runsDir}/${f}`;
      const stat = await fsPromises.stat(path);
      return { path, mtime: stat.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  const blobs: AuditBlob[] = [];
  for (const { path } of stats.slice(0, max)) {
    try {
      const raw = await fsPromises.readFile(path, "utf8");
      blobs.push(JSON.parse(raw) as AuditBlob);
    } catch {
      /* skip malformed */
    }
  }
  return blobs;
}

function existsSyncSafe(path: string): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: Node's fs is loaded lazily
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function explainOutputMatch(
  outputMatch: "yes" | "no" | "na_non_deterministic",
  blob: AuditBlob,
): string {
  if (outputMatch === "yes") {
    return "Source, sandbox config, and output all match — replay is fully reproducible.";
  }
  if (outputMatch === "na_non_deterministic") {
    return "Source and sandbox config match, but the tool was declared `network: true` and outputs differ. This is expected for tools that hit live external APIs (search results change, wall-clock differs, etc.). The replay confirms the tool RAN as recorded; it cannot guarantee the output is byte-equal because the external world is not part of the audit blob. See THREAT_MODEL.md → \"What replay actually proves.\"";
  }
  return `Source matches but outputs differ on a tool declared \`network: false\`. Possible causes: clock-dependent code, /dev/urandom, env-var differences (envs: ${blob.sandbox.envs_keys.join(", ") || "none"}), or a non-deterministic dependency. This is a finding worth investigating.`;
}

function successJson(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorJson(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const message =
    error instanceof PatchError || error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: name, message }, null, 2),
      },
    ],
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PatchError(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new PatchError(`Argument "${key}" must be a string if provided.`);
  }
  return value || undefined;
}
