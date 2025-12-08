// src/auth.ts
import { pkcePair } from "./lib/pkce";

/** 認可画面へ遷移（PKCEでcode_challenge付き） */
export async function beginLogin() {
  const { verifier, challenge } = await pkcePair();
  const redirectUri = `${location.origin}/callback`;

  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("pkce_redirect_uri", redirectUri);
  sessionStorage.setItem("pkce_started_at", String(Date.now()));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: import.meta.env.VITE_SPOTIFY_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "playlist-modify-private playlist-modify-public user-read-email user-read-private playlist-read-private",
    code_challenge_method: "S256", // ←大文字
    code_challenge: challenge,
    state: crypto.randomUUID(),
  });

  console.log("[CHECK] S256? =", params.get("code_challenge_method") === "S256");
  console.log("[CHECK] redirect_uri =", decodeURIComponent(params.get("redirect_uri") || ""));
  console.log("CLIENT_ID =", import.meta.env.VITE_SPOTIFY_CLIENT_ID);

  location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function handleCallback() {
  const qs = new URLSearchParams(location.search);
  const code = qs.get("code");
  if (!code) throw new Error("authorization code not found");

  const verifier = sessionStorage.getItem("pkce_verifier") ?? localStorage.getItem("pkce_verifier");
  const redirectUri = sessionStorage.getItem("pkce_redirect_uri") ?? localStorage.getItem("pkce_redirect_uri");
  if (!verifier || !redirectUri) {
    throw new Error("verifier/redirect_uri missing");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri, // ← beginLogin時と完全一致
    client_id: import.meta.env.VITE_SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${text}`);
  }

  const token = await res.json(); // { access_token, expires_in, refresh_token? ... }
  localStorage.setItem(
    "spotify_token",
    JSON.stringify({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: Date.now() + token.expires_in * 1000,
    })
  );
}
