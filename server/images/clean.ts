import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

const DEFAULT_RETENTION_DAYS = 3;

export function getImageRetentionDays(): number {
  const raw = process.env.BOOP_IMAGE_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

// Hard cap on how many expired rows we scan in one cleanup invocation. The
// per-tick scan stops if we hit this even when more pages are available — the
// next interval picks up where we left off thanks to ascending createdAt.
const MAX_SCAN_PAGES = 50;

export async function runImageCleanup(): Promise<{ deleted: number; kept: number }> {
  const retention = getImageRetentionDays();
  if (retention === 0) return { deleted: 0, kept: 0 };

  const olderThanMs = Date.now() - retention * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;
  let afterMs = 0;

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    // TODO(codegen): drop cast once schema push regenerates Convex API.
    const result = (await convex.query(api.messages.expiredWithImages, {
      olderThanMs,
      afterMs,
      scanLimit: 200,
    } as never)) as {
      rows: Array<{ _id: string; imageStorageIds?: string[] }>;
      hasMore: boolean;
      nextAfterMs: number;
    };

    for (const msg of result.rows) {
      const ids = msg.imageStorageIds ?? [];
      for (const storageId of ids) {
        // TODO(codegen): drop cast once schema push regenerates Convex API.
        const anchored = await convex.query(api.memoryRecords.hasImageRef, {
          storageId: storageId as never,
        });
        if (anchored) {
          kept++;
          continue;
        }
        // TODO(codegen): drop cast once schema push regenerates Convex API.
        await convex.mutation(api.messages.deleteImageBytes, {
          storageId: storageId as never,
        });
        // TODO(codegen): drop cast once schema push regenerates Convex API.
        await convex.mutation(api.messages.clearMessageImage, {
          messageId: msg._id as never,
          storageId: storageId as never,
        });
        deleted++;
      }
    }

    if (!result.hasMore) break;
    // Without forward progress the loop would spin; defensive.
    if (result.nextAfterMs <= afterMs) break;
    afterMs = result.nextAfterMs;
  }

  return { deleted, kept };
}

export function startImageCleanup(): () => void {
  if (getImageRetentionDays() === 0) {
    console.log("[image-cleanup] disabled (BOOP_IMAGE_RETENTION_DAYS=0)");
    return () => undefined;
  }
  const rawIntervalMs = process.env.BOOP_IMAGE_CLEANUP_INTERVAL_MS;
  const parsed = rawIntervalMs === undefined ? 12 * 60 * 60 * 1000 : Number(rawIntervalMs);
  const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 12 * 60 * 60 * 1000;
  if (rawIntervalMs !== undefined && intervalMs !== Number(rawIntervalMs)) {
    console.warn(
      `[image-cleanup] ignoring invalid BOOP_IMAGE_CLEANUP_INTERVAL_MS="${rawIntervalMs}", falling back to 12h`,
    );
  }
  console.log(
    `[image-cleanup] enabled (retention=${getImageRetentionDays()}d, interval=${intervalMs}ms)`,
  );
  // In-flight guard so a slow cleanup can't race against the next tick.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runImageCleanup();
      if (r.deleted > 0 || r.kept > 0) {
        console.log(`[image-cleanup] deleted=${r.deleted} kept=${r.kept}`);
      }
    } catch (err) {
      console.warn("[image-cleanup] tick failed", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
