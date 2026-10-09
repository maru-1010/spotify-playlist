import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkcePair } from "./lib/pkce";

// PKCE の値は毎回ランダムに作られるため、決まった値を返すモックに差し替える
vi.mock("./lib/pkce", () => ({ pkcePair: vi.fn() }));

const ORIGIN = "https://app.example.test";
const REDIRECT_URI = `${ORIGIN}/callback`;
const API_BASE_URL = "https://api.example.test";
const CLIENT_ID = "test-client-id";
const VERIFIER = "test-code-verifier";
const CHALLENGE = "test-code-challenge";
const CODE = "test-authorization-code";
const NOW = new Date("2026-01-01T00:00:00Z").getTime();

// 外部への通信（バックエンドとのトークン交換）は、すべてこのモックで受ける
const fetchMock = vi.fn<typeof fetch>();

/**
 * auth.ts を読み込み直す。
 * 接続先（API_BASE_URL）は読み込んだ時点の VITE_API_BASE_URL で決まるため、環境変数を設定してから読み込む
 */
async function importAuth() {
  vi.resetModules();
  return import("./auth");
}

/**
 * location を差し替える。
 * jsdom は別のオリジンへの遷移（Spotify の認可画面へ移るための location.href への代入）を実装していないため、
 * 代入された遷移先をそのまま記録する普通のオブジェクトにする
 */
function stubLocation(url: string) {
  const { origin, search } = new URL(url);
  const fakeLocation = { href: url, origin, search };
  vi.stubGlobal("location", fakeLocation);
  return fakeLocation;
}

/** バックエンドからの JSON の応答 */
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(pkcePair).mockResolvedValue({ verifier: VERIFIER, challenge: CHALLENGE });
  vi.stubGlobal("fetch", fetchMock);
  // 開発者の .env に左右されないよう、テストで使う環境変数はすべて決まった値にする
  vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("VITE_API_BASE_URL", API_BASE_URL);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  // 動作確認用のログでテストの出力が埋もれないようにする
  vi.spyOn(console, "log").mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("beginLogin", () => {
  it("Spotify の認可画面へ、PKCE の code_challenge（S256）と必要な権限を付けて遷移する", async () => {
    const fakeLocation = stubLocation(`${ORIGIN}/`);
    const { beginLogin } = await importAuth();

    await beginLogin();

    const authorizeUrl = new URL(fakeLocation.href);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://accounts.spotify.com/authorize");
    const params = authorizeUrl.searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(CHALLENGE);
    expect(params.get("scope")?.split(" ").sort()).toEqual([
      "playlist-modify-private",
      "playlist-modify-public",
      "playlist-read-private",
      "user-read-email",
      "user-read-private",
    ]);
    expect(params.get("state")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("code_verifier は URL に載せず、トークン交換で使う redirect_uri とともに sessionStorage に保存する", async () => {
    const fakeLocation = stubLocation(`${ORIGIN}/`);
    const { beginLogin } = await importAuth();

    await beginLogin();

    expect(fakeLocation.href).not.toContain(VERIFIER);
    expect(sessionStorage.getItem("pkce_verifier")).toBe(VERIFIER);
    // トークン交換で送る redirect_uri は、認可画面へ渡したものと一致していなければならない
    expect(sessionStorage.getItem("pkce_redirect_uri")).toBe(
      new URL(fakeLocation.href).searchParams.get("redirect_uri"),
    );
    expect(sessionStorage.getItem("pkce_started_at")).toBe(String(NOW));
  });

  it("PKCE の値を作れなければエラーにし、何も保存せず遷移もしない", async () => {
    const fakeLocation = stubLocation(`${ORIGIN}/`);
    // 例: http で localhost 以外から開くと crypto.subtle が使えず、code_challenge を計算できない
    const failure = new TypeError("Cannot read properties of undefined (reading 'digest')");
    vi.mocked(pkcePair).mockRejectedValue(failure);
    const { beginLogin } = await importAuth();

    await expect(beginLogin()).rejects.toBe(failure);

    expect(fakeLocation.href).toBe(`${ORIGIN}/`);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("handleCallback", () => {
  const tokenData = {
    session_id: "test-session-id",
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
  };

  /** バックエンドへ送ったリクエストボディ */
  function sentBody() {
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse(init?.body as string);
  }

  /** localStorage に保存されたトークン */
  function savedToken() {
    const saved = localStorage.getItem("spotify_token");
    return saved === null ? null : JSON.parse(saved);
  }

  beforeEach(() => {
    // beginLogin で保存した値が残っている状態で、Spotify から認可コード付きで戻ってきたところ
    sessionStorage.setItem("pkce_verifier", VERIFIER);
    sessionStorage.setItem("pkce_redirect_uri", REDIRECT_URI);
    stubLocation(`${REDIRECT_URI}?code=${CODE}&state=test-state`);
    fetchMock.mockResolvedValue(jsonResponse(200, tokenData));
  });

  describe("トークン交換", () => {
    it("認可コードと保存しておいた code_verifier・redirect_uri を、バックエンドへ JSON で POST する", async () => {
      const { handleCallback } = await importAuth();

      await handleCallback();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.any(String),
      });
      expect(sentBody()).toEqual({ code: CODE, code_verifier: VERIFIER, redirect_uri: REDIRECT_URI });
    });

    it("受け取ったセッションIDとトークンを localStorage に保存し、有効期限は今から expires_in 秒後（ミリ秒）とする", async () => {
      const { handleCallback } = await importAuth();

      await handleCallback();

      expect(savedToken()).toEqual({
        session_id: "test-session-id",
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_at: NOW + 3600 * 1000,
      });
    });

    it("refresh_token が返らなければ null として保存する", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { session_id: "test-session-id", access_token: "test-access-token", expires_in: 3600 }),
      );
      const { handleCallback } = await importAuth();

      await handleCallback();

      expect(savedToken()).toHaveProperty("refresh_token", null);
    });

    it("sessionStorage に無ければ、localStorage に保存された code_verifier・redirect_uri を使う", async () => {
      sessionStorage.clear();
      localStorage.setItem("pkce_verifier", "verifier-in-localStorage");
      localStorage.setItem("pkce_redirect_uri", "http://127.0.0.1:5173/callback");
      const { handleCallback } = await importAuth();

      await handleCallback();

      expect(sentBody()).toEqual({
        code: CODE,
        code_verifier: "verifier-in-localStorage",
        redirect_uri: "http://127.0.0.1:5173/callback",
      });
    });

    it("sessionStorage と localStorage の両方にあれば、sessionStorage のものを使う", async () => {
      localStorage.setItem("pkce_verifier", "verifier-in-localStorage");
      localStorage.setItem("pkce_redirect_uri", "http://127.0.0.1:5173/callback");
      const { handleCallback } = await importAuth();

      await handleCallback();

      expect(sentBody()).toEqual({ code: CODE, code_verifier: VERIFIER, redirect_uri: REDIRECT_URI });
    });

    it.each([
      ["未設定", undefined],
      ["空", ""],
    ])("VITE_API_BASE_URL が%sなら http://localhost:3001 のバックエンドを呼ぶ", async (_label, apiBaseUrl) => {
      vi.stubEnv("VITE_API_BASE_URL", apiBaseUrl);
      const { handleCallback } = await importAuth();

      await handleCallback();

      expect(fetchMock).toHaveBeenCalledWith("http://localhost:3001/api/auth/token", expect.anything());
    });
  });

  describe("トークン交換の前に失敗する場合", () => {
    it("URL に認可コードが無ければ（ユーザーが認可を拒否したときなど）エラーにし、バックエンドを呼ばない", async () => {
      stubLocation(`${REDIRECT_URI}?error=access_denied&state=test-state`);
      const { handleCallback } = await importAuth();

      await expect(handleCallback()).rejects.toThrow("authorization code not found");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(savedToken()).toBeNull();
    });

    it.each(["pkce_verifier", "pkce_redirect_uri"])(
      "%s が保存されていなければ（別のタブでコールバックを開いたときなど）エラーにし、バックエンドを呼ばない",
      async (key) => {
        sessionStorage.removeItem(key);
        const { handleCallback } = await importAuth();

        await expect(handleCallback()).rejects.toThrow("verifier/redirect_uri missing");

        expect(fetchMock).not.toHaveBeenCalled();
        expect(savedToken()).toBeNull();
      },
    );
  });

  describe("トークン交換に失敗した場合", () => {
    it("バックエンドに接続できなければ、接続先の URL と元のエラーを示してエラーにする", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      const { handleCallback } = await importAuth();

      const result = handleCallback();

      await expect(result).rejects.toThrow("バックエンドサーバーに接続できませんでした");
      await expect(result).rejects.toThrow(`URL: ${API_BASE_URL}`);
      await expect(result).rejects.toThrow("エラー: Failed to fetch");
      expect(savedToken()).toBeNull();
    });

    it("バックエンドがエラーを返したら、ステータスコードと応答の error を示してエラーにする", async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, { error: "Token exchange failed: invalid_grant" }));
      const { handleCallback } = await importAuth();

      await expect(handleCallback()).rejects.toThrow("token exchange failed: 400 Token exchange failed: invalid_grant");

      expect(savedToken()).toBeNull();
    });

    it("エラーの応答に error が無ければ Unknown error とする", async () => {
      fetchMock.mockResolvedValue(jsonResponse(500, {}));
      const { handleCallback } = await importAuth();

      await expect(handleCallback()).rejects.toThrow("token exchange failed: 500 Unknown error");
    });

    it("エラーの応答が JSON でなければ（手前のプロキシが返すエラーページなど）、本文のテキストを示してエラーにする", async () => {
      // 本物の Response は本文を 1 回しか読めない。json() と text() を両方読めてしまう手作りのモックでは
      // この制約を見落とすため、本物の Response で確かめる
      fetchMock.mockResolvedValue(
        new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } }),
      );
      const { handleCallback } = await importAuth();

      await expect(handleCallback()).rejects.toThrow("token exchange failed: 502 Bad Gateway");

      expect(savedToken()).toBeNull();
    });
  });
});
