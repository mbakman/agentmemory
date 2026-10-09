import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkerReadyTimeoutMs,
  isWorkerReadyPayload,
  waitForWorkerReady,
} from "../src/cli/worker-readiness.js";

const TIMEOUT_KEY = "AGENTMEMORY_WORKER_READY_TIMEOUT_MS";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("worker startup timeout configuration", () => {
  it("defaults to two minutes and reads the process override when present", () => {
    vi.stubEnv(TIMEOUT_KEY, undefined);
    expect(getWorkerReadyTimeoutMs()).toBe(120_000);
    vi.stubEnv(TIMEOUT_KEY, "39000");
    expect(getWorkerReadyTimeoutMs()).toBe(39_000);
  });

  it.each(["1000", "39000", "120000", "600000"])(
    "accepts integer milliseconds %s within the inclusive bounds",
    (value) => expect(getWorkerReadyTimeoutMs(value)).toBe(Number(value)),
  );

  it.each([
    "", " ", "999", "600001", "15000oops", "1.5", "1e5", "0x1d4c0",
    "+120000", "-1000", "120000\n", " 120000", "120000 ", "120_000",
    "NaN", "Infinity", "9999999999999999999999",
  ])("rejects malformed or out-of-range value %j", (value) => {
    expect(() => getWorkerReadyTimeoutMs(value)).toThrow(
      `${TIMEOUT_KEY} must be an integer between 1000 and 600000 milliseconds.`,
    );
  });
});

describe("worker livez readiness", () => {
  it.each([{}, { healthy: true }, { viewerPort: null }, { viewerPort: "3113" },
    { viewerSkipped: false }, { viewerSkipped: "true" }, null])(
    "does not treat a liveness payload %j as completed worker startup",
    (payload) => expect(isWorkerReadyPayload(payload)).toBe(false),
  );

  it.each([{ viewerPort: 3113 }, { viewerPort: null, viewerSkipped: true }])(
    "accepts a started viewer or explicit viewer skip in %j",
    (payload) => expect(isWorkerReadyPayload(payload)).toBe(true),
  );
});

describe("bounded worker readiness wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  it("keeps waiting past the old 15-second cutoff and accepts readiness at 39 seconds", async () => {
    const probe = vi.fn(async () => isWorkerReadyPayload(
      Date.now() < 39_000 ? { healthy: true, viewerPort: null } : { viewerPort: 3113 },
    ));
    const completed = vi.fn();
    const wait = waitForWorkerReady(probe, getWorkerReadyTimeoutMs("120000"));
    void wait.then(completed);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24_000);
    await expect(wait).resolves.toEqual({ ready: true, elapsedMs: 39_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a live but stalled worker at the configured deadline", async () => {
    const probe = vi.fn(async () => isWorkerReadyPayload({ healthy: true }));
    const wait = waitForWorkerReady(probe, getWorkerReadyTimeoutMs("1000"));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(wait).resolves.toEqual({ ready: false, elapsedMs: 1000 });
    const attempts = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires even when a readiness request never settles", async () => {
    const probe = vi.fn(() => new Promise<boolean>(() => {}));
    const wait = waitForWorkerReady(probe, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(wait).resolves.toEqual({ ready: false, elapsedMs: 1000 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately for a worker that explicitly skips its viewer", async () => {
    const wait = waitForWorkerReady(
      async () => isWorkerReadyPayload({ viewerSkipped: true }),
      120_000,
    );
    await expect(wait).resolves.toEqual({ ready: true, elapsedMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CLI startup policy wiring", () => {
  const source = readFileSync("src/cli.ts", "utf8");

  it("uses the same resolved timeout at all five worker waits while retaining engine deadlines", () => {
    expect(source.match(/await waitForAgentmemoryReady\(workerReadyTimeoutMs\)/g)).toHaveLength(5);
    expect(source).not.toContain("waitForAgentmemoryReady(15000)");
    expect(source.match(/await waitForEngine\(15000\)/g)).toHaveLength(3);
    expect(source).toContain("waitForWorkerReady(isAgentmemoryReady, timeoutMs)");
    expect(source).toContain("isWorkerReadyPayload(data)");
  });

  function runCli(cliArgs: string[], timeoutValue?: string, fileValue?: string) {
    const home = mkdtempSync(join(tmpdir(), "agentmemory-worker-ready-"));
    const runtimeDir = join(home, ".agentmemory");
    if (fileValue !== undefined) {
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, ".env"), `${TIMEOUT_KEY}=${fileValue}\n`);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTMEMORY_DATA_DIR: join(home, "data"),
      AGENTMEMORY_RUNTIME_DIR: runtimeDir,
      CI: "1",
      [TIMEOUT_KEY]: timeoutValue,
    };
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...cliArgs], {
      cwd: process.cwd(), encoding: "utf8", env, timeout: 5000,
    });
    return { result, runtimeDir, output: `${result.stdout}\n${result.stderr}` };
  }

  it.each([[], ["--no-engine"], ["demo", "--serve"]])(
    "rejects invalid startup configuration for %j before launching an engine or worker",
    (...cliArgs: string[]) => {
      const { result, runtimeDir, output } = runCli(cliArgs, "15000oops");
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toContain(`${TIMEOUT_KEY} must be an integer`);
      expect(output).not.toContain("[agentmemory]");
      expect(existsSync(join(runtimeDir, "iii.pid"))).toBe(false);
      expect(existsSync(join(runtimeDir, "worker.pid"))).toBe(false);
    },
  );

  it("validates the timeout hydrated from the config file", () => {
    const { result, output } = runCli([], undefined, "bad-config");
    expect(result.status).toBe(1);
    expect(output).toContain(`${TIMEOUT_KEY} must be an integer`);
  });

  it.each([["--version"], ["--help"], ["insights", "--help"], ["init"]])(
    "keeps client command %j usable with invalid worker configuration",
    (...cliArgs: string[]) => {
      const { result, output } = runCli(cliArgs, "bad-config");
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(output).not.toContain(`${TIMEOUT_KEY} must be an integer`);
    },
  );
});
