import { Redis } from "@upstash/redis";
import { env } from "@/env";

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (redis) return redis;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
    // Auto-pipelining batches commands into the /pipeline REST endpoint.
    // Upstash can return `{ error: ... }` with an HTTP 200 (e.g. when
    // rate-limited), and the SDK's pipeline response handling assumes an
    // array, throwing a confusing "x.map is not a function" instead of a
    // real error. Disabling it routes calls through the single-command
    // path, which correctly throws a clean UpstashError in that case.
    enableAutoPipelining: false,
  });
  return redis;
}
