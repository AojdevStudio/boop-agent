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
  const { api } = await import("../../convex/_generated/api.js");
  const { convex } = await import("../convex-client.js");
  const url = await convex.query(api.messages.getStorageUrl, {
    storageId: storageId as never,
  });
  if (!url) throw new Error(`image storage missing: ${storageId}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mediaType: ct };
}
