#!/usr/bin/env node
// scripts/seed-batch.mjs
//
// Hand-curated batch of 30 utility tools, contributed to the dev registry in
// one shot. No LLM calls during execution — every Python source is embedded
// inline below as a template literal. Validates each via `python3 -m
// py_compile` then POSTs to /v1/tools with the contributor's bearer token
// (read from the local toolbox config.json).
//
// Usage:
//   node scripts/seed-batch.mjs
//   node scripts/seed-batch.mjs --registry-url <url>     # override default
//   node scripts/seed-batch.mjs --dry-run                 # validate, don't POST

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import envPaths from "env-paths";
import yaml from "js-yaml";

const args = parseArgs(process.argv.slice(2));
const REGISTRY_URL = (args["registry-url"] ?? "https://patchcat-registry-dev.ilnkostia-dev.workers.dev").replace(/\/$/, "");
const DRY_RUN = args["dry-run"] === "true";

const toolboxDir = envPaths("patch-cat", { suffix: "" }).config;
const configPath = join(toolboxDir, "config.json");
if (!existsSync(configPath)) {
  fail(`Toolbox config not found at ${configPath}. Run patch_auth_register first.`);
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const token = config?.registry?.contribute_token;
if (!token) {
  fail("registry.contribute_token missing in config.json. Run patch_auth_register first.");
}

console.log(`registry: ${REGISTRY_URL}`);
console.log(`mode:     ${DRY_RUN ? "dry-run (no POSTs)" : "live"}`);
console.log("");

let created = 0;
let existed = 0;
let failed = 0;
const failures = [];

async function runSeed() {
for (const tool of TOOLS) {
  let manifest;
  try {
    manifest = parseManifestFromSource(tool.source);
  } catch (err) {
    console.log(`✗ <unparseable>: ${err.message.slice(0, 100)}`);
    failed += 1;
    failures.push({ name: "<unparseable>", reason: err.message });
    continue;
  }

  const compile = pyCompileSync(tool.source);
  if (!compile.ok) {
    console.log(`✗ ${manifest.name}: py_compile failed`);
    failed += 1;
    failures.push({ name: manifest.name, reason: "py_compile", detail: compile.stderr.slice(0, 200) });
    continue;
  }

  if (DRY_RUN) {
    console.log(`✓ ${manifest.name} (validated, dry-run)`);
    continue;
  }

  try {
    const resp = await fetch(`${REGISTRY_URL}/v1/tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ manifest, source: tool.source }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      failed += 1;
      failures.push({ name: manifest.name, status: resp.status, detail: text.slice(0, 200) });
      console.log(`✗ ${manifest.name}: HTTP ${resp.status} — ${text.slice(0, 120)}`);
      continue;
    }

    const body = await resp.json();
    if (body.status === "created") {
      created += 1;
      console.log(`✓ ${manifest.name} created (${body.source_sha256.slice(0, 12)}…)`);
    } else {
      existed += 1;
      console.log(`= ${manifest.name} already exists`);
    }
  } catch (err) {
    failed += 1;
    failures.push({ name: manifest.name, reason: "network", detail: String(err) });
    console.log(`✗ ${manifest.name}: ${String(err).slice(0, 120)}`);
  }
}

console.log("");
console.log("══════════════════════════════════════");
console.log("  Summary");
console.log("══════════════════════════════════════");
console.log(`  total attempted: ${TOOLS.length}`);
console.log(`  created:         ${created}`);
console.log(`  already exists:  ${existed}`);
console.log(`  failed:          ${failed}`);

if (failures.length > 0) {
  console.log("");
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  ${f.name}: ${f.reason ?? f.status} — ${(f.detail ?? "").slice(0, 120)}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
} // close runSeed

// ============================================================
// Helpers
// ============================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      out[argv[i].slice(2)] = next && !next.startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseManifestFromSource(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "# ---");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "# ---");
  if (start < 0 || end < 0) throw new Error("missing # --- markers");
  const yamlText = lines
    .slice(start + 1, end)
    .map((l) => (l.startsWith("# ") ? l.slice(2) : l === "#" ? "" : l.replace(/^#/, "")))
    .join("\n");
  return yaml.load(yamlText, { schema: yaml.JSON_SCHEMA });
}

function pyCompileSync(source) {
  const dir = mkdtempSync(join(tmpdir(), "patch-seed-"));
  const file = join(dir, "tool.py");
  writeFileSync(file, source);
  const result = spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" });
  return { ok: result.status === 0, stderr: result.stderr };
}

// ============================================================
// 30 hand-written tools, each as a complete Python file
// ============================================================

const TOOLS = [
  // ---- 1. text manipulation ----
  {
    source: `# ---
# name: word_count
# version: 1.0.0
# description: Count words, characters, and lines in a text string.
# inputs:
#   - name: text
#     type: string
#     description: The text to analyze.
#     tainted_ok: true
# outputs:
#   type: object
#   description: Counts for words, chars, chars_no_spaces, and lines.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import re
import sys


def main(text: str):
    return {
        "words": len(re.findall(r"\\S+", text)),
        "chars": len(text),
        "chars_no_spaces": len(re.sub(r"\\s", "", text)),
        "lines": text.count("\\n") + (1 if text else 0),
    }


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 2. slugify ----
  {
    source: `# ---
# name: slugify
# version: 1.0.0
# description: Convert a string into a URL-friendly lowercase slug.
# inputs:
#   - name: text
#     type: string
#     description: The text to convert.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The slugified text.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import re
import sys
import unicodedata


def main(text: str):
    normalized = unicodedata.normalize("NFKD", text)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    lower = ascii_only.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lower).strip("-")
    return slug


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 3. regex_findall ----
  {
    source: `# ---
# name: regex_findall
# version: 1.0.0
# description: Find all non-overlapping matches of a Python regex in a text string.
# inputs:
#   - name: pattern
#     type: string
#     description: Python regular expression.
#   - name: text
#     type: string
#     description: The text to search.
#     tainted_ok: true
# outputs:
#   type: array
#   description: List of matched substrings.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import re
import sys


def main(pattern: str, text: str):
    return re.findall(pattern, text)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 4. base64_encode ----
  {
    source: `# ---
# name: base64_encode
# version: 1.0.0
# description: Encode a UTF-8 string as base64.
# inputs:
#   - name: text
#     type: string
#     description: The text to encode.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The base64-encoded text.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import base64
import json
import sys


def main(text: str):
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 5. base64_decode ----
  {
    source: `# ---
# name: base64_decode
# version: 1.0.0
# description: Decode a base64 string into UTF-8 text.
# inputs:
#   - name: encoded
#     type: string
#     description: The base64-encoded input.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The decoded UTF-8 text.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import base64
import json
import sys


def main(encoded: str):
    return base64.b64decode(encoded.encode("ascii")).decode("utf-8")


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 6. url_encode ----
  {
    source: `# ---
# name: url_encode
# version: 1.0.0
# description: Percent-encode a string for use in a URL component.
# inputs:
#   - name: text
#     type: string
#     description: The text to encode.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The percent-encoded text.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.parse


def main(text: str):
    return urllib.parse.quote(text, safe="")


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 7. url_decode ----
  {
    source: `# ---
# name: url_decode
# version: 1.0.0
# description: Decode percent-encoded text from a URL component.
# inputs:
#   - name: encoded
#     type: string
#     description: The percent-encoded input.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The decoded text.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.parse


def main(encoded: str):
    return urllib.parse.unquote(encoded)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 8. sha256_hash ----
  {
    source: `# ---
# name: sha256_hash
# version: 1.0.0
# description: Compute the SHA-256 hex digest of a UTF-8 string.
# inputs:
#   - name: text
#     type: string
#     description: The text to hash.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The hex-encoded SHA-256 digest.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import hashlib
import json
import sys


def main(text: str):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 9. md5_hash ----
  {
    source: `# ---
# name: md5_hash
# version: 1.0.0
# description: Compute the MD5 hex digest of a UTF-8 string. Use only for non-cryptographic purposes such as cache keys or content addressing.
# inputs:
#   - name: text
#     type: string
#     description: The text to hash.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The hex-encoded MD5 digest.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import hashlib
import json
import sys


def main(text: str):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 10. hmac_sha256 ----
  {
    source: `# ---
# name: hmac_sha256
# version: 1.0.0
# description: Compute an HMAC-SHA-256 hex digest of a message using a secret key.
# inputs:
#   - name: key
#     type: string
#     description: The secret key.
#   - name: message
#     type: string
#     description: The message to authenticate.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The hex-encoded HMAC digest.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import hashlib
import hmac
import json
import sys


def main(key: str, message: str):
    return hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 11. json_pretty_print ----
  {
    source: `# ---
# name: json_pretty_print
# version: 1.0.0
# description: Pretty-print a JSON-serializable value with 2-space indentation and sorted keys.
# inputs:
#   - name: value
#     type: object
#     description: Any JSON-serializable value.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The pretty-printed JSON.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys


def main(value):
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 12. json_minify ----
  {
    source: `# ---
# name: json_minify
# version: 1.0.0
# description: Convert a JSON string to its most compact equivalent.
# inputs:
#   - name: text
#     type: string
#     description: The JSON-formatted input string.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The minified JSON.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys


def main(text: str):
    parsed = json.loads(text)
    return json.dumps(parsed, separators=(",", ":"), ensure_ascii=False)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 13. format_unix_timestamp ----
  {
    source: `# ---
# name: format_unix_timestamp
# version: 1.0.0
# description: Convert a Unix epoch timestamp to an ISO 8601 string in the requested timezone.
# inputs:
#   - name: timestamp
#     type: number
#     description: Seconds since the Unix epoch.
#   - name: timezone_offset_minutes
#     type: integer
#     description: Offset from UTC in minutes (e.g., 0 for UTC, -300 for UTC-5).
#     required: false
#     default: 0
# outputs:
#   type: string
#   description: The ISO 8601 formatted datetime.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import datetime
import json
import sys


def main(timestamp, timezone_offset_minutes: int = 0):
    tz = datetime.timezone(datetime.timedelta(minutes=int(timezone_offset_minutes)))
    return datetime.datetime.fromtimestamp(float(timestamp), tz).isoformat()


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 14. days_between ----
  {
    source: `# ---
# name: days_between
# version: 1.0.0
# description: Count the integer number of days between two ISO 8601 dates.
# inputs:
#   - name: start_date
#     type: string
#     description: ISO 8601 date or datetime (YYYY-MM-DD or with time).
#   - name: end_date
#     type: string
#     description: ISO 8601 date or datetime (YYYY-MM-DD or with time).
# outputs:
#   type: integer
#   description: The integer day delta (end - start). May be negative.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import datetime
import json
import sys


def _parse(value: str) -> datetime.date:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def main(start_date: str, end_date: str):
    return (_parse(end_date) - _parse(start_date)).days


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 15. statistics_summary ----
  {
    source: `# ---
# name: statistics_summary
# version: 1.0.0
# description: Compute mean, median, sample stddev, min, max, and count for a list of numbers.
# inputs:
#   - name: numbers
#     type: array
#     description: The numbers to summarize.
#     items:
#       type: number
# outputs:
#   type: object
#   description: Statistics object.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import statistics
import sys


def main(numbers):
    if not numbers:
        return {"count": 0}
    nums = [float(n) for n in numbers]
    return {
        "count": len(nums),
        "mean": statistics.mean(nums),
        "median": statistics.median(nums),
        "stdev": statistics.stdev(nums) if len(nums) > 1 else 0.0,
        "min": min(nums),
        "max": max(nums),
    }


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 16. is_prime ----
  {
    source: `# ---
# name: is_prime
# version: 1.0.0
# description: Test whether a non-negative integer is prime using trial division.
# inputs:
#   - name: 'n'
#     type: integer
#     description: The non-negative integer to test.
# outputs:
#   type: boolean
#   description: True if n is prime.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import math
import sys


def main(n: int) -> bool:
    n = int(n)
    if n < 2:
        return False
    if n < 4:
        return True
    if n % 2 == 0:
        return False
    for i in range(3, int(math.isqrt(n)) + 1, 2):
        if n % i == 0:
            return False
    return True


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 17. dedupe_list_preserving_order ----
  {
    source: `# ---
# name: dedupe_list_preserving_order
# version: 1.0.0
# description: Remove duplicate items from a list while preserving the order of first occurrence.
# inputs:
#   - name: items
#     type: array
#     description: The input list (any JSON-serializable items).
#     tainted_ok: true
# outputs:
#   type: array
#   description: The deduplicated list.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys


def main(items):
    seen = set()
    out = []
    for item in items:
        key = json.dumps(item, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 18. group_by_key ----
  {
    source: `# ---
# name: group_by_key
# version: 1.0.0
# description: Group a list of objects by the value at a given key.
# inputs:
#   - name: items
#     type: array
#     description: The list of objects to group.
#     tainted_ok: true
#   - name: key
#     type: string
#     description: The object key to group by.
# outputs:
#   type: object
#   description: Object mapping each unique key value to its list of items.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys


def main(items, key: str):
    groups = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        bucket = str(item.get(key, ""))
        groups.setdefault(bucket, []).append(item)
    return groups


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 19. levenshtein_distance ----
  {
    source: `# ---
# name: levenshtein_distance
# version: 1.0.0
# description: Compute the Levenshtein edit distance between two strings.
# inputs:
#   - name: a
#     type: string
#     description: The first string.
#     tainted_ok: true
#   - name: b
#     type: string
#     description: The second string.
#     tainted_ok: true
# outputs:
#   type: integer
#   description: The minimum number of single-character edits between a and b.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys


def main(a: str, b: str):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(curr[j] + 1, prev[j + 1] + 1, prev[j] + (ca != cb)))
        prev = curr
    return prev[-1]


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 20. is_email ----
  {
    source: `# ---
# name: is_email
# version: 1.0.0
# description: Validate that a string is plausibly an email address using a simple regex check.
# inputs:
#   - name: text
#     type: string
#     description: The candidate email string.
#     tainted_ok: true
# outputs:
#   type: boolean
#   description: True if the string matches an email pattern.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import re
import sys


_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$")


def main(text: str):
    return bool(_EMAIL_RE.match(text or ""))


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 21. is_url ----
  {
    source: `# ---
# name: is_url
# version: 1.0.0
# description: Validate that a string is a syntactically well-formed http or https URL.
# inputs:
#   - name: text
#     type: string
#     description: The candidate URL string.
#     tainted_ok: true
# outputs:
#   type: boolean
#   description: True if the string is a well-formed http(s) URL.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.parse


def main(text: str):
    try:
        parsed = urllib.parse.urlparse(text)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    return bool(parsed.netloc)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 22. is_uuid ----
  {
    source: `# ---
# name: is_uuid
# version: 1.0.0
# description: Validate that a string is a well-formed UUID (any version).
# inputs:
#   - name: text
#     type: string
#     description: The candidate UUID string.
#     tainted_ok: true
# outputs:
#   type: boolean
#   description: True if the string is a syntactically valid UUID.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import uuid


def main(text: str):
    try:
        uuid.UUID(text)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 23. parse_csv_to_json ----
  {
    source: `# ---
# name: parse_csv_to_json
# version: 1.0.0
# description: Parse a CSV-formatted string with a header row into a list of objects keyed by header.
# inputs:
#   - name: csv_text
#     type: string
#     description: The raw CSV content with a header row.
#     tainted_ok: true
# outputs:
#   type: array
#   description: List of rows as JSON objects.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import csv
import io
import json
import sys


def main(csv_text: str):
    reader = csv.DictReader(io.StringIO(csv_text))
    return list(reader)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 24. extract_html_text ----
  {
    source: `# ---
# name: extract_html_text
# version: 1.0.0
# description: Strip HTML tags and collapse whitespace, returning plain text.
# inputs:
#   - name: html
#     type: string
#     description: The HTML input.
#     tainted_ok: true
# outputs:
#   type: string
#   description: The extracted plain text.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import html as _html
import json
import re
import sys


_TAG_RE = re.compile(r"<[^>]+>")


def main(html: str):
    no_tags = _TAG_RE.sub(" ", html or "")
    decoded = _html.unescape(no_tags)
    return re.sub(r"\\s+", " ", decoded).strip()


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 25. extract_html_links ----
  {
    source: `# ---
# name: extract_html_links
# version: 1.0.0
# description: Extract all href values from anchor tags in an HTML string.
# inputs:
#   - name: html
#     type: string
#     description: The HTML input.
#     tainted_ok: true
# outputs:
#   type: array
#   description: List of href values as strings.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import re
import sys


_HREF_RE = re.compile('<a[^>]+href=["\\']([^"\\']+)["\\']', re.IGNORECASE)


def main(html: str):
    return _HREF_RE.findall(html or "")


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 26. fetch_url ----
  {
    source: `# ---
# name: fetch_url
# version: 1.0.0
# description: Fetch a URL via HTTP GET and return the response body as a UTF-8 string.
# inputs:
#   - name: url
#     type: string
#     description: The HTTP or HTTPS URL to fetch.
#     tainted_ok: true
#   - name: timeout_seconds
#     type: integer
#     description: Per-request timeout in seconds.
#     required: false
#     default: 30
# outputs:
#   type: string
#   description: The response body as text.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.request


def main(url: str, timeout_seconds: int = 30):
    req = urllib.request.Request(url, headers={"User-Agent": "patch/fetch_url"})
    with urllib.request.urlopen(req, timeout=int(timeout_seconds)) as resp:
        return resp.read().decode("utf-8", errors="replace")


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 27. fetch_json ----
  {
    source: `# ---
# name: fetch_json
# version: 1.0.0
# description: Fetch a URL via HTTP GET and parse the response body as JSON.
# inputs:
#   - name: url
#     type: string
#     description: The HTTP or HTTPS URL to fetch.
#     tainted_ok: true
#   - name: timeout_seconds
#     type: integer
#     description: Per-request timeout in seconds.
#     required: false
#     default: 30
# outputs:
#   type: object
#   description: Parsed JSON body.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.request


def main(url: str, timeout_seconds: int = 30):
    req = urllib.request.Request(url, headers={"User-Agent": "patch/fetch_json"})
    with urllib.request.urlopen(req, timeout=int(timeout_seconds)) as resp:
        return json.loads(resp.read().decode("utf-8"))


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 28. get_weather ----
  {
    source: `# ---
# name: get_weather_open_meteo
# version: 1.0.0
# description: Get the current weather for a latitude/longitude using the Open-Meteo forecast API. No API key required.
# inputs:
#   - name: latitude
#     type: number
#     description: Latitude in decimal degrees.
#   - name: longitude
#     type: number
#     description: Longitude in decimal degrees.
# outputs:
#   type: object
#   description: Current temperature, wind speed, and weather code.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.parse
import urllib.request


def main(latitude, longitude):
    params = urllib.parse.urlencode({
        "latitude": float(latitude),
        "longitude": float(longitude),
        "current_weather": "true",
    })
    url = f"https://api.open-meteo.com/v1/forecast?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "patch/get_weather_open_meteo"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    cw = body.get("current_weather", {})
    return {
        "temperature_c": cw.get("temperature"),
        "wind_speed_kmh": cw.get("windspeed"),
        "wind_direction_deg": cw.get("winddirection"),
        "weather_code": cw.get("weathercode"),
        "time": cw.get("time"),
    }


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 29. geocode_address ----
  {
    source: `# ---
# name: geocode_address_nominatim
# version: 1.0.0
# description: Geocode a free-text address using OpenStreetMap's Nominatim service. No API key required.
# inputs:
#   - name: address
#     type: string
#     description: The address or place name to geocode.
#     tainted_ok: true
# outputs:
#   type: object
#   description: Best-match location with latitude, longitude, and display name. Null if no match.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.parse
import urllib.request


def main(address: str):
    params = urllib.parse.urlencode({"q": address, "format": "json", "limit": 1})
    url = f"https://nominatim.openstreetmap.org/search?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "patch/geocode_address_nominatim"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if not body:
        return None
    hit = body[0]
    return {
        "latitude": float(hit["lat"]),
        "longitude": float(hit["lon"]),
        "display_name": hit.get("display_name"),
        "type": hit.get("type"),
    }


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },

  // ---- 30. fetch_wikipedia_summary ----
  {
    source: `# ---
# name: fetch_wikipedia_summary
# version: 1.0.0
# description: Fetch the lead summary of an English Wikipedia article by title using the Wikipedia REST API.
# inputs:
#   - name: title
#     type: string
#     description: Article title (e.g., "Python (programming language)").
#     tainted_ok: true
# outputs:
#   type: object
#   description: Title, extract, and canonical page URL. Null fields if not found.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.parse
import urllib.request


def main(title: str):
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    req = urllib.request.Request(url, headers={"User-Agent": "patch/fetch_wikipedia_summary"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"title": None, "extract": None, "url": None, "error": "not_found"}
        raise
    return {
        "title": body.get("title"),
        "extract": body.get("extract"),
        "url": body.get("content_urls", {}).get("desktop", {}).get("page"),
    }


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  },
];

await runSeed();
