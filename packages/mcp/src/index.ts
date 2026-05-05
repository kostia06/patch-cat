#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArcadeClient } from "./arcade.js";
import { loadConfig } from "./config.js";
import { createGenerator } from "./generator.js";
import { createLogger } from "./logger.js";
import { NOOP_TRACER, createLangfuseTracer } from "./observability.js";
import { NOOP_REGISTRY_CLIENT, createRegistryClient } from "./registry-client.js";
import { createE2BSandboxFactory, createSandboxRunner } from "./sandbox.js";
import { createPatchServer } from "./server.js";
import { createToolbox } from "./toolbox.js";

const VERSION = "0.3.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stderr.write(`@patch-cat/mcp ${VERSION}\n`);
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const logger = createLogger();

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    logger.fatal("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const e2bApiKey = process.env.E2B_API_KEY;
  if (!e2bApiKey) {
    logger.fatal("E2B_API_KEY is not set.");
    process.exit(1);
  }

  // Optional AI Gateway: when CF_AI_GATEWAY_URL is set, route Anthropic calls
  // through it for cost/latency observability and budget caps. Falls back to
  // direct Anthropic API otherwise. Format:
  //   https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_name>
  const aiGatewayUrl = process.env.CF_AI_GATEWAY_URL?.replace(/\/$/, "");
  const anthropicBaseUrl = aiGatewayUrl ? `${aiGatewayUrl}/anthropic` : undefined;
  if (anthropicBaseUrl) {
    logger.info({ baseURL: anthropicBaseUrl }, "Routing Anthropic calls through AI Gateway.");
  }
  const anthropic = new Anthropic({
    apiKey: anthropicApiKey,
    baseURL: anthropicBaseUrl,
  });
  const toolbox = createToolbox(process.env.PATCH_CAT_TOOLBOX_DIR);

  // Optional Langfuse tracing for the Anthropic generator call. No-op when
  // keys are not set.
  const langfusePub = process.env.LANGFUSE_PUBLIC_KEY;
  const langfuseSec = process.env.LANGFUSE_SECRET_KEY;
  const tracer =
    langfusePub && langfuseSec
      ? createLangfuseTracer({
          publicKey: langfusePub,
          secretKey: langfuseSec,
          baseUrl: process.env.LANGFUSE_BASE_URL,
        })
      : NOOP_TRACER;
  if (tracer.enabled) {
    logger.info("Langfuse tracing enabled.");
  }

  const generator = createGenerator(anthropic, { tracer });
  const sandbox = createSandboxRunner(createE2BSandboxFactory(e2bApiKey));

  await toolbox.init();
  const config = await loadConfig(toolbox.rootDir);

  const registry =
    config.registry.read_enabled || config.registry.contribute_enabled
      ? createRegistryClient({
          baseUrl: config.registry.url,
          contributeToken: config.registry.contribute_token,
          logger,
        })
      : NOOP_REGISTRY_CLIENT;

  // Arcade is optional. Tools with external_auth scopes only work when
  // ARCADE_API_KEY is set; otherwise calling such a tool returns an error.
  const arcade = createArcadeClient({
    apiKey: process.env.ARCADE_API_KEY,
    logger,
  });

  const server = createPatchServer({
    toolbox,
    generator,
    sandbox,
    logger,
    registry,
    config,
    arcade,
    serverVersion: VERSION,
  });

  await server.start();

  const transport = new StdioServerTransport();
  await server.mcp.connect(transport);

  logger.info("Patch MCP server connected on stdio.");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down.");
    try {
      await server.mcp.close();
    } catch (error) {
      logger.error({ err: error }, "Error during shutdown.");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function printHelp(): void {
  process.stderr.write(
    [
      "@patch-cat/mcp — MCP server that lets your AI build and remember its own tools.",
      "",
      "Usage:",
      "  patch-cat-mcp           Run as an MCP server over stdio.",
      "  patch-cat-mcp --version Print version and exit.",
      "  patch-cat-mcp --help    Print this help and exit.",
      "",
      "Required environment variables:",
      "  ANTHROPIC_API_KEY  Used to generate new tools via claude-opus-4-7.",
      "  E2B_API_KEY        Used to create sandboxes for tool execution.",
      "",
      "Optional environment variables:",
      "  LOG_LEVEL                 pino log level (default: info).",
      "  PATCH_CAT_TOOLBOX_DIR     Override the local toolbox path (default: env-paths).",
      "",
      "Add this server to your MCP host config and restart the host.",
      "Registry behavior is controlled via <toolbox>/config.json — call patch_auth_status",
      "from the host AI to inspect, and patch_auth_register to enable contribute.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
