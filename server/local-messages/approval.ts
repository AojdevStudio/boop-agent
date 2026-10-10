import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomApprovalToken(): string {
  return randomBytes(24).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function textHash(text: string): string {
  return sha256(text);
}

export function attachmentsHash(paths: string[] = []): string {
  return sha256(JSON.stringify([...paths].sort()));
}

export function tokenHash(token: string): string {
  return sha256(token);
}

export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
