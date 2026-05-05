import { z } from "zod";
import { ToolManifestSchema } from "./manifest.js";

export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const SearchToolsRequestSchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  include_unverified: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === true || v === "true"),
});
export type SearchToolsRequest = z.infer<typeof SearchToolsRequestSchema>;

/**
 * Reputation threshold: a contributor is "verified" once the total use_count
 * across all their tools meets this number. Default search filters out tools
 * from unverified contributors. Documented in THREAT_MODEL.md.
 */
export const VERIFIED_CONTRIBUTOR_THRESHOLD = 100;

export const RegistryContributorSchema = z.object({
  github_handle: z.string(),
});
export type RegistryContributor = z.infer<typeof RegistryContributorSchema>;

export const RegistryToolEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  latest_version: SemverSchema,
  contributor: RegistryContributorSchema,
  use_count: z.number().int().min(0),
  success_count: z.number().int().min(0),
  success_rate: z.number().min(0).max(1).nullable(),
  similarity: z.number().min(0).max(1).optional(),
  /** True if the contributor's total use_count across all their tools meets the verified threshold. */
  verified: z.boolean().optional(),
  created_at: z.string(),
});
export type RegistryToolEntry = z.infer<typeof RegistryToolEntrySchema>;

export const SearchToolsResponseSchema = z.object({
  results: z.array(RegistryToolEntrySchema),
});
export type SearchToolsResponse = z.infer<typeof SearchToolsResponseSchema>;

export const RegistryToolVersionSchema = z.object({
  name: z.string(),
  version: SemverSchema,
  description: z.string(),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source_url: z.string().url(),
  manifest: ToolManifestSchema,
  contributor: RegistryContributorSchema,
  created_at: z.string(),
});
export type RegistryToolVersion = z.infer<typeof RegistryToolVersionSchema>;

export const ContributeToolRequestSchema = z.object({
  manifest: ToolManifestSchema,
  source: z.string().min(1),
});
export type ContributeToolRequest = z.infer<typeof ContributeToolRequestSchema>;

export const ContributeToolResponseSchema = z.object({
  name: z.string(),
  version: SemverSchema,
  source_sha256: z.string(),
  status: z.enum(["created", "exists"]),
});
export type ContributeToolResponse = z.infer<typeof ContributeToolResponseSchema>;

export const RecordRunRequestSchema = z.object({
  version: SemverSchema,
  success: z.boolean(),
  error_class: z.string().optional(),
  duration_ms: z.number().int().min(0),
});
export type RecordRunRequest = z.infer<typeof RecordRunRequestSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
