import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from "./mime.js";

export interface ImageBytes {
  bytes: Buffer;
  mediaType: string;
}

export type FetchBytes = (storageId: string) => Promise<ImageBytes>;

export interface BuildPromptArgs {
  text: string;
  imageStorageIds: string[] | undefined;
  fetchBytes: FetchBytes;
}

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type TextBlock = { type: "text"; text: string };

export type PromptInput = string | Array<ImageBlock | TextBlock>;

export async function buildPromptWithImages(
  args: BuildPromptArgs,
): Promise<PromptInput> {
  const ids = args.imageStorageIds ?? [];
  if (ids.length === 0) return args.text;

  const blocks: Array<ImageBlock | TextBlock> = [];
  for (const id of ids) {
    const { bytes, mediaType } = await args.fetchBytes(id);
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: bytes.toString("base64"),
      },
    });
  }
  blocks.push({ type: "text", text: args.text.length > 0 ? args.text : "(image)" });
  return blocks;
}

export async function fetchStoredBytes(storageId: string): Promise<ImageBytes> {
  // TODO(codegen): drop the `as never` once the regenerated Convex API
  // reflects the new getStorageUrl query (blocked on schema push).
  const url = await convex.query(api.messages.getStorageUrl, {
    storageId: storageId as never,
  });
  if (!url) throw new Error(`image storage missing: ${storageId}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  // Defence-in-depth: a regression in the ingest validator or a future
  // schema change could leave an oversized blob behind; refuse to base64
  // it into the prompt rather than balloon memory.
  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_IMAGE_BYTES) {
    throw new Error(`stored image too large: ${lenHeader} bytes`);
  }
  const rawCt = res.headers.get("content-type") ?? "";
  const mediaType = rawCt.split(";")[0]!.trim().toLowerCase();
  // Symmetry with ingest: only accept image MIMEs we'd have ingested.
  // If Convex CDN returned anything else, reject — better than poisoning
  // the Anthropic call with a bogus media_type.
  if (!ALLOWED_IMAGE_MIME.has(mediaType)) {
    throw new Error(`unexpected stored media_type: ${rawCt || "(empty)"}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`stored image too large: ${bytes.byteLength} bytes`);
  }
  return { bytes, mediaType };
}
