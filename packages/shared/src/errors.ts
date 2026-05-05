export class PatchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ManifestParseError extends PatchError {}
export class ToolSyntaxError extends PatchError {}
export class ToolNameCollisionError extends PatchError {
  constructor(
    public readonly toolName: string,
    cause?: unknown,
  ) {
    super(`Tool name "${toolName}" already exists in toolbox.`, cause);
  }
}
export class ToolOutputError extends PatchError {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}
export class ToolNotFoundError extends PatchError {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" not found in toolbox.`);
  }
}
export class SandboxError extends PatchError {}
export class GeneratorError extends PatchError {}
