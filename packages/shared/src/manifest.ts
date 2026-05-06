import yaml from "js-yaml";
import { z } from "zod";
import { ManifestParseError } from "./errors.js";

const FRONTMATTER_DELIMITER = "# ---";

export const ManifestInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "integer", "boolean", "array", "object"]),
  description: z.string().min(1),
  required: z.boolean().optional().default(true),
  default: z.unknown().optional(),
  tainted_ok: z.boolean().optional().default(false),
  items: z
    .object({
      type: z.string(),
    })
    .optional(),
});

export const ManifestOutputSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  items: z.unknown().optional(),
});

export const ManifestCapabilitiesSchema = z
  .object({
    network: z.boolean().default(false),
    filesystem: z.enum(["none", "read-only", "read-write"]).default("none"),
    human_confirm: z.boolean().default(false),
    /**
     * If true, the sandbox boots Playwright + a headless Chromium so the tool
     * can drive a real browser. Forces `network: true` — you can't browse
     * without network egress. Adds ~15s of cold-start time per call.
     */
    browser: z.boolean().default(false),
  })
  .superRefine((cap, ctx) => {
    if (cap.browser && !cap.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["browser"],
        message: "capabilities.browser requires capabilities.network: true",
      });
    }
  });

export const ManifestRuntimeSchema = z.object({
  language: z.literal("python"),
  python_version: z.string().default("3.12"),
  packages: z.array(z.string()).default([]),
});

export const ToolManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, "Tool name must be snake_case starting with a lowercase letter."),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver (x.y.z)."),
  description: z.string().min(1),
  inputs: z.array(ManifestInputSchema).default([]),
  outputs: ManifestOutputSchema,
  capabilities: ManifestCapabilitiesSchema,
  runtime: ManifestRuntimeSchema,
  /**
   * Scoped permissions the tool needs from external services. Format:
   * "<provider>.<scope>" (e.g. "gmail.read", "slack.send_message"). The
   * runtime mints a short-lived scoped token via Arcade.dev and injects it
   * into the sandbox; the user's refresh token never reaches the tool.
   */
  external_auth: z
    .array(
      z
        .string()
        .regex(
          /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
          "external_auth scopes must be '<provider>.<scope>' in snake_case",
        ),
    )
    .optional()
    .default([]),
  generated_by: z.string().optional(),
  generated_at: z.string().optional(),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;
export type ManifestInput = z.infer<typeof ManifestInputSchema>;

export interface ParsedTool {
  manifest: ToolManifest;
  body: string;
}

export function parseManifest(pythonSource: string): ParsedTool {
  const lines = pythonSource.split(/\r?\n/);

  const startIndex = lines.findIndex((line) => line.trim() === FRONTMATTER_DELIMITER);
  if (startIndex === -1) {
    throw new ManifestParseError(`Missing opening "${FRONTMATTER_DELIMITER}" frontmatter marker.`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new ManifestParseError(`Missing closing "${FRONTMATTER_DELIMITER}" frontmatter marker.`);
  }

  const frontmatterLines = lines.slice(startIndex + 1, endIndex);
  const yamlText = frontmatterLines.map(stripCommentPrefix).join("\n");

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new ManifestParseError("Frontmatter is not valid YAML.", error);
  }

  const result = ToolManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new ManifestParseError(
      `Manifest failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
      result.error,
    );
  }

  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .replace(/^\n+/, "");

  return { manifest: result.data, body };
}

export function serializeManifest(manifest: ToolManifest, body: string): string {
  const yamlText = yaml.dump(manifest, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
    schema: yaml.JSON_SCHEMA,
  });

  const commented = yamlText
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? "#" : `# ${line}`))
    .join("\n");

  const trimmedBody = body.replace(/^\n+/, "");
  return `${FRONTMATTER_DELIMITER}\n${commented}\n${FRONTMATTER_DELIMITER}\n\n${trimmedBody}`;
}

function stripCommentPrefix(line: string): string {
  if (line.startsWith("# ")) return line.slice(2);
  if (line === "#") return "";
  if (line.startsWith("#")) return line.slice(1);
  return line;
}

export interface JsonSchema {
  type: string;
  description?: string;
  items?: { type: string };
  default?: unknown;
  "x-tainted-ok"?: boolean;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: false;
}

export function manifestToInputSchema(manifest: ToolManifest): JsonSchemaObject {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const input of manifest.inputs) {
    const property: JsonSchema = {
      type: input.type,
      description: input.description,
    };

    if (input.items) {
      property.items = input.items;
    }
    if (input.default !== undefined) {
      property.default = input.default;
    }
    if (input.tainted_ok) {
      property["x-tainted-ok"] = true;
    }

    properties[input.name] = property;

    if (input.required) {
      required.push(input.name);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
