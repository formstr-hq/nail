import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * These handlers only matter when the process is actually dying, which cannot
 * be asserted in-process without taking the test runner down with it. So the
 * assertions run a child Node process that imports the module and triggers the
 * event; the parent reads its stdio and exit code.
 */

const fatalModule = fileURLToPath(new URL("./fatal.ts", import.meta.url));

function runChild(script: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", script], {
      env: { ...process.env, NODE_OPTIONS: "" },
      cwd: path.dirname(fatalModule),
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

describe("registerFatalHandlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a structured message and exits 1 on an uncaught exception", async () => {
    const result = await runChild(`
      import { registerFatalHandlers } from "./fatal.ts";
      registerFatalHandlers();
      setTimeout(() => { throw new Error("boom in a large attachment"); }, 10);
    `);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FATAL uncaught exception");
    expect(result.stderr).toContain("boom in a large attachment");
    expect(result.stderr).toContain("Error: boom in a large attachment");
  });

  it("logs a structured message and exits 1 on an unhandled rejection", async () => {
    const result = await runChild(`
      import { registerFatalHandlers } from "./fatal.ts";
      registerFatalHandlers();
      Promise.reject(new Error("relay pool exploded"));
    `);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FATAL unhandled rejection");
    expect(result.stderr).toContain("relay pool exploded");
  });

  it("labels a normal shutdown as non-fatal", async () => {
    const result = await runChild(`
      import { registerFatalHandlers } from "./fatal.ts";
      registerFatalHandlers();
      setTimeout(() => process.exit(0), 10);
    `);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("process exiting (code 0)");
    expect(result.stdout).not.toContain("fatal");
  });

  it("logs the received signal before exiting", async () => {
    const result = await runChild(`
      import { registerFatalHandlers } from "./fatal.ts";
      registerFatalHandlers();
      setTimeout(() => process.emit("SIGTERM"), 10);
    `);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("received SIGTERM");
    expect(result.stdout).toContain("process exiting (code 0)");
  });

  it("is idempotent — a second registration adds no duplicate handlers", async () => {
    const result = await runChild(`
      import { registerFatalHandlers } from "./fatal.ts";
      registerFatalHandlers();
      registerFatalHandlers();
      Promise.reject(new Error("only once"));
    `);

    expect(result.code).toBe(1);
    const count = result.stderr.split("FATAL unhandled rejection").length - 1;
    expect(count).toBe(1);
  });
});
