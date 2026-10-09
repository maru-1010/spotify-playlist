// src/auth.test.ts
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type AuthModule = typeof import("./auth");
type PkceModule = typeof import("./lib/pkce");

// pkcePair は乱数を使うため固定値を返すモックにする（PKCE 値の生成自体は lib/pkce.ts の責務）
const pkcePairMock = vi.hoisted(() => vi.fn<PkceModule["pkcePair"]>());
vi.mock("./lib/pkce", () => ({ pkcePair: pkcePairMock }));

const APP_ORIGIN = "https://playlist.example.com";
const REDIRECT_URI = `${APP_ORIGIN}/callback`;
const CLIENT_ID = "test-client-id";
const PKCE = { verifier: "test-code-verifier", challenge: "test-code-challenge" };
const STATE = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const NOW = new Date("2026-01-01T00:00:00Z").getTime();
const DEFAULT_API_BASE_URL = "http://localhost:3001";
const TOKEN_RESPONSE = {
  session_id: "test-session-id",
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_in: 3600,
};

let fetchMock: Mock<typeof fetch>;

/**
 * auth.ts を読み込み直して返す。
 * API_BASE_URL はモジュール読み込み時に決まるため、環境変数を固定してから毎回読み込む（.env の内容に左右されないように）。
 */
async function loadAuth(apiBaseUrl?: string): Promise<AuthModule> {
  vi.stubEnv("VITE_API_BASE_URL", apiBaseUrl);
  vi.resetModules();
  return import("./auth");
}

/** location を差し替える（jsdom は別オリジンへの遷移を実装しておらず、遷移先を検証できないため） */
function stubLocation(search = "") {
  const fakeLocation = { origin: APP_ORIGIN, search, href: `${APP_ORIGIN}/` };
  vi.stubGlobal("location", fakeLocation);
  return fakeLocation;
}

/** localStorage に保存されたトークン情報（無ければ null） */
function savedToken(): unknown {
  const raw = localStorage.getItem("spotify_token");
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.setSystemTime(NOW);
  vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", CLIENT_ID);
  pkcePairMock.mockReset().mockResolvedValue(PKCE);

  // 外部への通信はすべてモックにする（応答は本物の Response で作り、本文の読み取りも実物どおりにする）
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);

  // 動作確認用のログでテスト結果が埋もれないようにする
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("beginLogin", () => {
  let beginLogin: AuthModule["beginLogin"];
  let fakeLocation: ReturnType<typeof stubLocation>;

  beforeEach(async () => {
    ({ beginLogin } = await loadAuth());
    fakeLocation = stubLocation();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(STATE);
  });

  it("PKCE（S256）のパラメータを付けて、Spotify の認可画面へ遷移する", async () => {
    await beginLogin();

    const url = new URL(fakeLocation.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, // 現在のオリジン + /callback
      scope: "playlist-modify-private playlist-modify-public user-read-email user-read-private playlist-read-private",
      code_challenge_method: "S256",
      code_challenge: PKCE.challenge,
      state: STATE,
    });
  });

  it("トークン交換で使う verifier と redirect_uri（認可URLと同じ値）、開始時刻を sessionStorage に保存する", async () => {
    await beginLogin();

    const redirectUriInUrl = new URL(fakeLocation.href).searchParams.get("redirect_uri");
    expect(sessionStorage.getItem("pkce_verifier")).toBe(PKCE.verifier);
    expect(sessionStorage.getItem("pkce_redirect_uri")).toBe(redirectUriInUrl);
    expect(sessionStorage.getItem("pkce_started_at")).toBe(String(NOW));
  });

  it("PKCE の生成に失敗したとき（非セキュアコンテキストで crypto.subtle が無い等）は、何も保存せず遷移もしない", async () => {
    pkcePairMock.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'digest')"));

    await expect(beginLogin()).rejects.toThrow(TypeError);
    expect(sessionStorage.length).toBe(0);
    expect(fakeLocation.href).toBe(`${APP_ORIGIN}/`);
  });
});

describe("handleCallback", () => {
  let handleCallback: AuthModule["handleCallback"];

  /** beginLogin が保存した PKCE の値を再現する */
  function storePkce(storage: Storage, values = { verifier: PKCE.verifier, redirectUri: REDIRECT_URI }) {
    storage.setItem("pkce_verifier", values.verifier);
    storage.setItem("pkce_redirect_uri", values.redirectUri);
  }

  /** fetch に渡されたリクエストボディ */
  function sentBody(): unknown {
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse(String(init?.body));
  }

  // 既定: Spotify から ?code=...&state=... 付きで戻ってきて、beginLogin の保存値が sessionStorage にある状態
  beforeEach(async () => {
    ({ handleCallback } = await loadAuth());
    stubLocation(`?code=test-auth-code&state=${STATE}`);
    storePkce(sessionStorage);
  });

  describe("入力の検証", () => {
    it("URL に認可コードが無い（認可を拒否されて ?error=access_denied で戻った等）ときはエラーにし、トークン交換しない", async () => {
      stubLocation(`?error=access_denied&state=${STATE}`);

      await expect(handleCallback()).rejects.toThrow("authorization code not found");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["pkce_verifier", "pkce_redirect_uri"])(
      "%s がどこにも保存されていないときはエラーにし、トークン交換しない",
      async (key) => {
        sessionStorage.removeItem(key);

        await expect(handleCallback()).rejects.toThrow("verifier/redirect_uri missing");
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  describe("トークン交換のリクエスト", () => {
    it("バックエンドの /api/auth/token へ、認可コード・verifier・redirect_uri を JSON で POST する", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(TOKEN_RESPONSE));

      await handleCallback();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${DEFAULT_API_BASE_URL}/api/auth/token`);
      expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
      expect(sentBody()).toEqual({
        code: "test-auth-code",
        code_verifier: PKCE.verifier,
        redirect_uri: REDIRECT_URI,
      });
    });

    it("VITE_API_BASE_URL が設定されていれば、そのバックエンドへ送る", async () => {
      const auth = await loadAuth("https://api.example.com");
      fetchMock.mockResolvedValueOnce(Response.json(TOKEN_RESPONSE));

      await auth.handleCallback();

      expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/api/auth/token", expect.anything());
    });

    it("sessionStorage に無いときは localStorage に保存された値を使う", async () => {
      sessionStorage.clear();
      storePkce(localStorage);
      fetchMock.mockResolvedValueOnce(Response.json(TOKEN_RESPONSE));

      await handleCallback();

      expect(sentBody()).toMatchObject({ code_verifier: PKCE.verifier, redirect_uri: REDIRECT_URI });
    });

    it("sessionStorage と localStorage の両方にあるときは sessionStorage の値を優先する", async () => {
      storePkce(localStorage, { verifier: "stale-verifier", redirectUri: "https://stale.example.com/callback" });
      fetchMock.mockResolvedValueOnce(Response.json(TOKEN_RESPONSE));

      await handleCallback();

      expect(sentBody()).toMatchObject({ code_verifier: PKCE.verifier, redirect_uri: REDIRECT_URI });
    });
  });

  describe("成功時", () => {
    it("セッションID・トークン・有効期限（現在時刻 + expires_in 秒）を localStorage の spotify_token に保存する", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(TOKEN_RESPONSE));

      await handleCallback();

      expect(savedToken()).toEqual({
        session_id: "test-session-id",
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_at: NOW + 3600 * 1000,
      });
    });

    it("refresh_token が含まれないときは null として保存する", async () => {
      const { session_id, access_token, expires_in } = TOKEN_RESPONSE;
      fetchMock.mockResolvedValueOnce(Response.json({ session_id, access_token, expires_in }));

      await handleCallback();

      expect(savedToken()).toMatchObject({ refresh_token: null });
    });
  });

  describe("失敗時", () => {
    it("バックエンドに接続できない（fetch が reject）ときは、接続先URLと原因を含むエラーにし、トークンは保存しない", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const error = await handleCallback().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      const { message } = error as Error;
      expect(message).toContain("バックエンドサーバーに接続できませんでした");
      expect(message).toContain(`URL: ${DEFAULT_API_BASE_URL}`);
      expect(message).toContain("エラー: Failed to fetch");
      expect(savedToken()).toBeNull();
    });

    it("fetch が Error 以外の値で reject されても、その値をメッセージに含める", async () => {
      fetchMock.mockRejectedValueOnce("connection refused");

      await expect(handleCallback()).rejects.toThrow("エラー: connection refused");
    });

    it("エラー応答（JSON）のときは、ステータスと error の内容をメッセージに含め、トークンは保存しない", async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: "SPOTIFY_CLIENT_ID not configured" }, { status: 500 }));

      await expect(handleCallback()).rejects.toThrow("token exchange failed: 500 SPOTIFY_CLIENT_ID not configured");
      expect(savedToken()).toBeNull();
    });

    it("エラー応答（JSON）に error が無いときは Unknown error とする", async () => {
      fetchMock.mockResolvedValueOnce(Response.json({}, { status: 500 }));

      await expect(handleCallback()).rejects.toThrow("token exchange failed: 500 Unknown error");
    });

    // 【既知の不具合】auth.ts は res.json() に失敗すると res.text() で本文を読み直すが、
    // fetch の Response 本文は一度しか読めないため res.text() が TypeError（Body is unusable）になり、
    // そのまま TypeError が投げられる（ステータスも本文もメッセージに残らない）。
    // あるべき挙動を it.fails で記述している。auth.ts を直すとこのテストが失敗するので、そのときは it に戻す。
    it.fails("エラー応答の本文が JSON でない（プロキシの 502 など）ときは、本文テキストをメッセージに含める", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));

      await expect(handleCallback()).rejects.toThrow("token exchange failed: 502 Bad Gateway");
    });
  });
});
