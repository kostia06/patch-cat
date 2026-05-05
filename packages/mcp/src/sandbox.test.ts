import { ToolOutputError } from "@patch-cat/shared";
import type { ParsedTool } from "@patch-cat/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CommandResult,
  type SandboxFactory,
  type SandboxLike,
  createSandboxRunner,
} from "./sandbox.js";

function makeParsedTool(packages: string[] = []): ParsedTool {
  return {
    manifest: {
      name: "echo",
      version: "1.0.0",
      description: "echo input",
      inputs: [
        {
          name: "msg",
          type: "string",
          description: "message",
          required: true,
          tainted_ok: false,
        },
      ],
      outputs: { type: "string" },
      capabilities: { network: false, filesystem: "none", human_confirm: false },
      runtime: { language: "python", python_version: "3.12", packages },
    },
    body: `import json, sys

def main(msg: str):
    return msg

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`,
  };
}

interface MockSandboxOptions {
  runResults?: CommandResult[];
}

function makeMockSandbox(options: MockSandboxOptions = {}): {
  sandbox: SandboxLike;
  writes: Array<{ path: string; content: string }>;
  runs: string[];
  killed: boolean;
} {
  const writes: Array<{ path: string; content: string }> = [];
  const runs: string[] = [];
  let killed = false;
  const queue = [...(options.runResults ?? [])];

  const sandbox: SandboxLike = {
    files: {
      async write(path: string, content: string) {
        writes.push({ path, content });
      },
    },
    commands: {
      async run(cmd: string) {
        runs.push(cmd);
        return queue.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    async kill() {
      killed = true;
    },
  };

  return {
    sandbox,
    writes,
    runs,
    get killed() {
      return killed;
    },
  };
}

function makeFactory(sandbox: SandboxLike): SandboxFactory {
  return {
    create: vi.fn().mockResolvedValue(sandbox),
  };
}

describe("sandbox runner", () => {
  it("runs a tool with no packages and parses JSON output", async () => {
    const mock = makeMockSandbox({
      runResults: [{ stdout: '"hello"\n', stderr: "", exitCode: 0 }],
    });
    const runner = createSandboxRunner(makeFactory(mock.sandbox));

    const result = await runner.runTool(makeParsedTool(), { msg: "hello" });
    expect(result.result).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(mock.writes.map((w) => w.path)).toEqual(["/tmp/tool.py", "/tmp/args.json"]);
    expect(mock.runs).toEqual(["python /tmp/tool.py < /tmp/args.json"]);
    expect(mock.killed).toBe(true);
  });

  it("installs pinned packages before running", async () => {
    const mock = makeMockSandbox({
      runResults: [
        { stdout: "", stderr: "", exitCode: 0 }, // pip install
        { stdout: '{"ok": true}\n', stderr: "", exitCode: 0 }, // tool run
      ],
    });
    const runner = createSandboxRunner(makeFactory(mock.sandbox));

    await runner.runTool(makeParsedTool(["requests==2.32.3"]), { msg: "x" });
    expect(mock.runs[0]).toContain("pip install");
    expect(mock.runs[0]).toContain("requests==2.32.3");
  });

  it("throws ToolOutputError when exit code is non-zero", async () => {
    const mock = makeMockSandbox({
      runResults: [{ stdout: "", stderr: "boom", exitCode: 1 }],
    });
    const runner = createSandboxRunner(makeFactory(mock.sandbox));

    await expect(runner.runTool(makeParsedTool(), { msg: "x" })).rejects.toThrow(ToolOutputError);
    expect(mock.killed).toBe(true);
  });

  it("throws ToolOutputError when stdout is not JSON", async () => {
    const mock = makeMockSandbox({
      runResults: [{ stdout: "not json\n", stderr: "", exitCode: 0 }],
    });
    const runner = createSandboxRunner(makeFactory(mock.sandbox));
    await expect(runner.runTool(makeParsedTool(), { msg: "x" })).rejects.toThrow(ToolOutputError);
  });

  it("kills the sandbox even when run fails", async () => {
    const failing: SandboxLike = {
      files: { async write() {} },
      commands: {
        async run() {
          throw new Error("network gone");
        },
      },
      async kill() {},
    };
    const killSpy = vi.spyOn(failing, "kill");
    const runner = createSandboxRunner(makeFactory(failing));

    await expect(runner.runTool(makeParsedTool(), { msg: "x" })).rejects.toThrow();
    expect(killSpy).toHaveBeenCalled();
  });

  it("runs syntaxCheck via py_compile", async () => {
    const mock = makeMockSandbox({
      runResults: [{ stdout: "", stderr: "", exitCode: 0 }],
    });
    const runner = createSandboxRunner(makeFactory(mock.sandbox));
    await expect(runner.syntaxCheck(makeParsedTool())).resolves.toBeUndefined();
    expect(mock.runs[0]).toContain("py_compile");
  });

  it("syntaxCheck throws when py_compile fails", async () => {
    const mock = makeMockSandbox({
      runResults: [{ stdout: "", stderr: "SyntaxError", exitCode: 1 }],
    });
    const runner = createSandboxRunner(makeFactory(mock.sandbox));
    await expect(runner.syntaxCheck(makeParsedTool())).rejects.toThrow(ToolOutputError);
  });
});
