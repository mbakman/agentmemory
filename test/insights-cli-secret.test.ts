import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInsightClientEnv } from "../src/cli/insights.js";

describe("insight client authentication", () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "am-insights-client-secret-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".agentmemory"), { mode: 0o700 });
    writeFileSync(join(home, ".agentmemory", "secret"), "stored-fixture-secret\n", { mode: 0o600 });
    writeFileSync(join(home, ".agentmemory", ".env"), "AGENTMEMORY_SECRET=env-file-fixture-secret\n", { mode: 0o600 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reads the env file before the generated secret for loopback", () => {
    expect(resolveInsightClientEnv({ AGENTMEMORY_URL: "http://127.0.0.1:4311" }).AGENTMEMORY_SECRET)
      .toBe("env-file-fixture-secret");
  });

  it.each(["https://memory.example.com", "http://localhost.example.com:4311"])(
    "does not send local credentials to %s", (url) => {
      expect(resolveInsightClientEnv({ AGENTMEMORY_URL: url }).AGENTMEMORY_SECRET).toBe("");
    },
  );

  it("retains an explicit secret for a remote server", () => {
    const env = { AGENTMEMORY_URL: "https://memory.example.com", AGENTMEMORY_SECRET: "explicit-fixture-secret" };
    expect(resolveInsightClientEnv(env).AGENTMEMORY_SECRET).toBe("explicit-fixture-secret");
    expect(env).toEqual({ AGENTMEMORY_URL: "https://memory.example.com", AGENTMEMORY_SECRET: "explicit-fixture-secret" });
  });

  it("preserves an invalid explicit secret for the existing header validation", () => {
    expect(resolveInsightClientEnv({ AGENTMEMORY_SECRET: "fixture\nsecret" }).AGENTMEMORY_SECRET)
      .toBe("fixture\nsecret");
  });
});
