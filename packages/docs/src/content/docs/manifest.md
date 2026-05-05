---
title: Manifest format
description: The locked Python manifest contract that every Patch tool must conform to.
sidebar:
  order: 4
---

Every Patch tool is a single Python file. The manifest is YAML in commented frontmatter inside `# ---` markers (so the file is valid Python).

## Example

```python
# ---
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
#   items: object
# capabilities:
#   network: false
#   filesystem: read-only
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: ["pdfplumber==0.11.4"]
# external_auth: []
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
```

## Fields

### Top-level

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | snake_case, lowercase letters/digits/underscore. Globally unique in the registry. |
| `version` | string | yes | Strict semver `x.y.z`. New content = new version, never overwrite. |
| `description` | string | yes | One sentence. Sanitized + quarantine-LLM-checked at registry contribute time. |
| `inputs` | array | yes (can be `[]`) | See below. |
| `outputs` | object | yes | `{type, description?, items?}`. |
| `capabilities` | object | yes | `{network, filesystem, human_confirm}`. |
| `runtime` | object | yes | `{language, python_version, packages}`. |
| `external_auth` | array | optional | Scope labels like `["gmail.read"]`. |
| `generated_by` | string | optional | `"claude-opus-4-7"` for LLM-generated tools. |
| `generated_at` | string | optional | ISO 8601 UTC. |

### `inputs[]`

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Argument name on the Python `main()` function. |
| `type` | enum | `string` / `number` / `integer` / `boolean` / `array` / `object`. |
| `description` | string | One sentence. |
| `required` | bool, default `true` | If `false`, the tool's `main()` should provide a default. |
| `default` | any | Optional. |
| `tainted_ok` | bool, default `false` | If `true`, this input may legitimately receive untrusted content. The runtime won't block tainted data from flowing in. |
| `items` | object | For `array` types — `{type: "string"}`, etc. |

### `capabilities`

| Field | Type | Notes |
|-------|------|-------|
| `network` | bool | If `false`, sandbox boots with `allowInternetAccess: false`. **Enforced** at runtime. |
| `filesystem` | enum | `none` / `read-only` / `read-write`. **Not yet enforced** in v0.4 — declared only. v0.4.x. |
| `human_confirm` | bool | If `true`, the runtime returns `confirmation_required` instead of executing. The host AI must surface to the user; only after explicit approval does `patch_confirm_action(token)` actually run the call. |

### `runtime`

| Field | Type | Notes |
|-------|------|-------|
| `language` | literal | Always `python`. |
| `python_version` | string | `"3.12"`. |
| `packages` | array | Pinned versions like `["requests==2.32.3"]`. Each package must match `^[a-zA-Z0-9._-]+==\d+(\.\d+){0,2}$`. |

### `external_auth`

Array of `<provider>.<scope>` strings:

```yaml
external_auth:
  - gmail.read
  - slack.send_message
```

When present, the runtime mints a short-lived Arcade-scoped token before invocation and injects it as `PATCH_ACCESS_TOKEN` env var. The user's refresh token stays at Arcade.

Supported providers in v0.4: `gmail`, `google_calendar`, `slack`, `github`, `linear`. (Arcade integration is a stub in v0.4 — see [threat model](/threat-model#whats-still-possible).)

## Source body

After the closing `# ---`, the file is a normal Python script that:

- Defines a top-level `main(...)` whose parameters match `manifest.inputs`.
- Reads its arguments from stdin as a single JSON object: `args = json.loads(sys.stdin.read())`.
- Prints exactly one line of JSON to stdout: `print(json.dumps(main(**args)))`.

The script must NOT perform side effects at import time. All work happens inside `main`.
