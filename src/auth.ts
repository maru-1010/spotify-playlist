// src/auth.ts
import { pkcePair } from "./lib/pkce";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

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

  // バックエンド経由でトークン交換
  console.log('[Auth] API_BASE_URL:', API_BASE_URL);
  console.log('[Auth] Calling:', `${API_BASE_URL}/api/auth/token`);
  
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
  } catch (fetchError) {
    console.error('[Auth] Fetch error:', fetchError);
    throw new Error(
      `バックエンドサーバーに接続できませんでした。\n` +
      `URL: ${API_BASE_URL}\n` +
      `バックエンドサーバーが起動しているか確認してください。\n` +
      `エラー: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
    );
  }

  if (!res.ok) {
    let errorMessage = 'Unknown error';
    try {
      const errorData = await res.json();
      errorMessage = errorData.error || errorMessage;
    } catch {
      // JSONパースに失敗した場合はテキストとして取得
      errorMessage = await res.text() || errorMessage;
    }
    throw new Error(`token exchange failed: ${res.status} ${errorMessage}`);
  }

  const tokenData = await res.json();
  
  // セッションIDとトークンをlocalStorageに保存
  localStorage.setItem(
    "spotify_token",
    JSON.stringify({
      session_id: tokenData.session_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
      expires_at: Date.now() + tokenData.expires_in * 1000,
    })
  );
}
