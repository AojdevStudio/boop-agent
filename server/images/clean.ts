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

export async function runImageCleanup(): Promise<{ deleted: number; kept: number }> {
  const retention = getImageRetentionDays();
  if (retention === 0) return { deleted: 0, kept: 0 };

  const olderThanMs = Date.now() - retention * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;

  const batch = await convex.query(api.messages.expiredWithImages, {
    olderThanMs,
    limit: 200,
  });
  for (const msg of batch) {
    const ids = (msg.imageStorageIds ?? []) as string[];
    for (const storageId of ids) {
      const anchored = await convex.query(api.memoryRecords.hasImageRef, {
        storageId: storageId as never,
      });
      if (anchored) {
        kept++;
        continue;
      }
      await convex.mutation(api.messages.deleteImageBytes, {
        storageId: storageId as never,
      });
      await convex.mutation(api.messages.clearMessageImage, {
        messageId: msg._id,
        storageId: storageId as never,
      });
      deleted++;
    }
  }

  return { deleted, kept };
}

export function startImageCleanup(): () => void {
  if (getImageRetentionDays() === 0) {
    console.log("[image-cleanup] disabled (BOOP_IMAGE_RETENTION_DAYS=0)");
    return () => undefined;
  }
  const intervalMs = Number(
    process.env.BOOP_IMAGE_CLEANUP_INTERVAL_MS ?? 12 * 60 * 60 * 1000,
  );
  console.log(
    `[image-cleanup] enabled (retention=${getImageRetentionDays()}d, interval=${intervalMs}ms)`,
  );
  const tick = async () => {
    try {
      const r = await runImageCleanup();
      if (r.deleted > 0 || r.kept > 0) {
        console.log(`[image-cleanup] deleted=${r.deleted} kept=${r.kept}`);
      }
    } catch (err) {
      console.warn("[image-cleanup] tick failed", err);
    }
  };
  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
