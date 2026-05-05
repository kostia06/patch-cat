import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./errors.js";
import {
  manifestToInputSchema,
  parseManifest,
  serializeManifest,
  type ToolManifest,
} from "./manifest.js";

const VALID_TOOL = `# ---
# name: extract_pdf_table
# version: 1.0.0
# description: Extract tables from a PDF file as JSON.
# inputs:
#   - name: pdf_path
#     type: string
#     description: Absolute path to the PDF file.
#     tainted_ok: true
# outputs:
#   type: array
#   description: Array of tables.
# capabilities:
#   network: false
#   filesystem: read-only
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages:
#     - pdfplumber==0.11.4
# generated_by: claude-opus-4-7
# generated_at: 2026-05-04T12:34:56Z
# ---

import pdfplumber
import json
import sys

def main(pdf_path: str):
    with pdfplumber.open(pdf_path) as pdf:
        return [page.extract_tables() for page in pdf.pages]

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

describe("parseManifest", () => {
  it("parses a valid tool file", () => {
    const { manifest, body } = parseManifest(VALID_TOOL);
    expect(manifest.name).toBe("extract_pdf_table");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.inputs).toHaveLength(1);
    expect(manifest.inputs[0]?.tainted_ok).toBe(true);
    expect(manifest.runtime.packages).toEqual(["pdfplumber==0.11.4"]);
    expect(body).toContain("import pdfplumber");
    expect(body).toContain('if __name__ == "__main__":');
  });

  it("rejects missing opening marker", () => {
    expect(() => parseManifest("import os\nprint('hi')\n")).toThrow(ManifestParseError);
  });

  it("rejects missing closing marker", () => {
    const broken = `# ---\n# name: foo\n# version: 1.0.0\n\nimport os\n`;
    expect(() => parseManifest(broken)).toThrow(ManifestParseError);
  });

  it("rejects manifest missing required fields", () => {
    const missing = `# ---
# name: foo
# version: 1.0.0
# ---

import os
`;
    expect(() => parseManifest(missing)).toThrow(ManifestParseError);
  });

  it("rejects malformed YAML", () => {
    const broken = `# ---
# name: foo:bar:baz: oops
#   not valid
# ---

import os
`;
    expect(() => parseManifest(broken)).toThrow(ManifestParseError);
  });

  it("rejects invalid tool name", () => {
    const bad = VALID_TOOL.replace("name: extract_pdf_table", "name: ExtractPDFTable");
    expect(() => parseManifest(bad)).toThrow(ManifestParseError);
  });

  it("rejects non-semver version", () => {
    const bad = VALID_TOOL.replace("version: 1.0.0", "version: v1");
    expect(() => parseManifest(bad)).toThrow(ManifestParseError);
  });
});

describe("serializeManifest / round-trip", () => {
  it("round-trips a parsed manifest", () => {
    const { manifest, body } = parseManifest(VALID_TOOL);
    const serialized = serializeManifest(manifest, body);
    const reparsed = parseManifest(serialized);
    expect(reparsed.manifest).toEqual(manifest);
    expect(reparsed.body.trim()).toBe(body.trim());
  });
});

describe("manifestToInputSchema", () => {
  it("builds JSON Schema with x-tainted-ok preserved", () => {
    const { manifest } = parseManifest(VALID_TOOL);
    const schema = manifestToInputSchema(manifest);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["pdf_path"]);
    expect(schema.properties.pdf_path).toMatchObject({
      type: "string",
      description: "Absolute path to the PDF file.",
      "x-tainted-ok": true,
    });
    expect(schema.additionalProperties).toBe(false);
  });

  it("marks optional inputs as not required", () => {
    const manifest: ToolManifest = {
      name: "foo",
      version: "1.0.0",
      description: "test",
      inputs: [
        {
          name: "opt",
          type: "string",
          description: "optional input",
          required: false,
          tainted_ok: false,
        },
      ],
      outputs: { type: "string" },
      capabilities: { network: false, filesystem: "none", human_confirm: false },
      runtime: { language: "python", python_version: "3.12", packages: [] },
    };
    const schema = manifestToInputSchema(manifest);
    expect(schema.required).toEqual([]);
    expect(schema.properties.opt).toBeDefined();
  });

  it("does not set x-tainted-ok when input is not tainted_ok", () => {
    const manifest: ToolManifest = {
      name: "foo",
      version: "1.0.0",
      description: "test",
      inputs: [
        {
          name: "trusted",
          type: "string",
          description: "trusted input",
          required: true,
          tainted_ok: false,
        },
      ],
      outputs: { type: "string" },
      capabilities: { network: false, filesystem: "none", human_confirm: false },
      runtime: { language: "python", python_version: "3.12", packages: [] },
    };
    const schema = manifestToInputSchema(manifest);
    expect(schema.properties.trusted?.["x-tainted-ok"]).toBeUndefined();
  });
});
