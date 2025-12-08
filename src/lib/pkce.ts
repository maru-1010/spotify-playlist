// PKCEユーティリティ
// src/pkce.ts

// Base64 → URL-safe（+→-、/→_、=削除）
function urlSafeBase64(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ランダムな code_verifier を生成（43〜128文字）
export function randomVerifier(length = 64): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const rand = new Uint32Array(length);
  // モダン環境なら globalThis.crypto でOK
  crypto.getRandomValues(rand);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[rand[i] % chars.length];
  return out;
}

// code_verifier → code_challenge(S256)
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomVerifier(64);
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const challenge = urlSafeBase64(digest);
  return { verifier, challenge };
}
