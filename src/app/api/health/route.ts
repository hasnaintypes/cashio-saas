import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { getRedis } from "@/lib/redis";
import { createLogger } from "@/lib/logging";
import packageJson from "../../../../package.json";

const logger = createLogger("api:health");

// Health checks must always execute live (never served from a cache) and
// must run in the Node.js runtime since they touch Prisma.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type CheckStatus = "ok" | "error" | "skipped";

interface CheckResult {
  status: CheckStatus;
  latencyMs?: number;
  error?: string;
}

const DB_CHECK_TIMEOUT_MS = 5000;
const REDIS_CHECK_TIMEOUT_MS = 5000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function checkDatabase(): Promise<CheckResult> {
  const start = performance.now();
  try {
    await withTimeout(
      db.$queryRaw`SELECT 1`,
      DB_CHECK_TIMEOUT_MS,
      "Database check",
    );
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Health check: database probe failed", { error: message });
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - start),
      error: message,
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const redis = getRedis();
  if (!redis) {
    return { status: "skipped" };
  }
  const start = performance.now();
  try {
    await withTimeout(redis.ping(), REDIS_CHECK_TIMEOUT_MS, "Redis check");
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Health check: redis probe failed", { error: message });
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - start),
      error: message,
    };
  }
}

async function buildHealthReport() {
  const start = performance.now();

  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  const checks = { database, redis };
  const hasFailure = Object.values(checks).some((c) => c.status === "error");

  return {
    healthy: !hasFailure,
    body: {
      status: hasFailure ? "unhealthy" : "healthy",
      version: (packageJson as { version?: string }).version ?? "unknown",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      responseTimeMs: Math.round(performance.now() - start),
      checks,
    },
  };
}

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export async function GET() {
  try {
    const { healthy, body } = await buildHealthReport();

    if (!healthy) {
      logger.warn("Health check reported unhealthy status", {
        checks: body.checks,
      });
    }

    return NextResponse.json(body, {
      status: healthy ? 200 : 503,
      headers: noStoreHeaders,
    });
  } catch (error) {
    // Should be unreachable (checks handle their own errors) but guards
    // against unexpected failures so the endpoint never throws a 500 with
    // no body for the monitor to parse.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Health check crashed unexpectedly", { error: message });
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: message,
      },
      { status: 503, headers: noStoreHeaders },
    );
  }
}

export async function HEAD() {
  const { healthy } = await buildHealthReport();
  return new NextResponse(null, {
    status: healthy ? 200 : 503,
    headers: noStoreHeaders,
  });
}
