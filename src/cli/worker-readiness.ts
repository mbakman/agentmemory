export const DEFAULT_WORKER_READY_TIMEOUT_MS = 120_000;
const WORKER_READY_TIMEOUT_KEY = "AGENTMEMORY_WORKER_READY_TIMEOUT_MS";

export function getWorkerReadyTimeoutMs(
  raw = process.env[WORKER_READY_TIMEOUT_KEY],
): number {
  if (raw === undefined) return DEFAULT_WORKER_READY_TIMEOUT_MS;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error(
      `${WORKER_READY_TIMEOUT_KEY} must be an integer between 1000 and 600000 milliseconds.`,
    );
  }
  return value;
}

export function isWorkerReadyPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const data = payload as { viewerPort?: unknown; viewerSkipped?: unknown };
  return typeof data.viewerPort === "number" || data.viewerSkipped === true;
}

export async function waitForWorkerReady(
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<{ ready: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const poll = async (): Promise<boolean> => {
    while (Date.now() < deadline) {
      if (await probe()) return Date.now() < deadline;
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(250, remainingMs)),
        );
      }
    }
    return false;
  };
  try {
    const ready = await Promise.race([poll(), expired]);
    return { ready, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout!);
  }
}
