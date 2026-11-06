// src/auth.test.ts
// auth.ts（Spotify ログイン：PKCE 付きの認可コードフロー）のテスト
//
// ■ テスト技法：状態遷移テスト
//   auth.ts はブラウザの保存領域のほかに状態を持たないので、「何が保存されているか」で状態を決める。
//
//   状態 | sessionStorage の PKCE | localStorage の spotify_token | どんなときか
//   -----+------------------------+-------------------------------+------------------------------------------
//   S0   | なし                   | なし                          | 初めて開いた・未ログイン
//   S1   | あり                   | なし                          | ログインボタンを押してから Spotify から戻るまで
//   S2   | あり                   | あり                          | ログイン直後の同じタブ（PKCE は消されず残る）
//        |                        |                               | ／ログイン済みで再ログインを始めた
//   S3   | なし                   | あり                          | ブラウザ再起動後・別タブ（sessionStorage はタブごと）
//   ※ PKCE＝pkce_verifier・pkce_redirect_uri・pkce_started_at
//
//   イベント
//   E1  beginLogin が成功（PKCE を作って保存し、認可画面へ遷移）
//   E1x beginLogin が失敗（PKCE を作れない／sessionStorage に書けない）
//   E2  /callback に code あり → バックエンドが 2xx の正常な応答
//   E3  /callback に code なし（同意しなかった ?error=access_denied、直接アクセスなど）
//   E4  /callback に code あり → バックエンドに接続できない
//   E5  /callback に code あり → バックエンドが 2xx 以外を返す（使用済み code の再送もここ）
//   E6  /callback に code あり → 2xx だが本文が JSON でない
//
//   状態遷移表（行＝今の状態、列＝イベント、セル＝次の状態。✕＝例外になる）
//         | E1 | E1x | E2  | E3  | E4  | E5  | E6
//   ------+----+-----+-----+-----+-----+-----+-----
//   S0    | S1 | S0  | S0✕ | S0✕ | S0✕ | S0✕ | S0✕   ← PKCE が無いので、バックエンドへ問い合わせない
//   S1    | S1 | S1  | S2  | S1✕ | S1✕ | S1✕ | S1✕
//   S2    | S2 | S2  | S2  | S2✕ | S2✕ | S2✕ | S2✕   ← 失敗してもログイン中のトークンは壊さない
//   S3    | S2 | S3  | S3✕ | S3✕ | S3✕ | S3✕ | S3✕   ← PKCE が無いので、バックエンドへ問い合わせない
//   ※ 失敗したあとに PKCE を残すか消すかは決まっていない（仕様確認 Q2）ので、テストでは見ない。
//
// ■ 外部への通信
//   fetch はモック。認可画面への遷移（location.href への代入）は location ごと差し替えて、行き先を記録するだけにする。
//   fetch の応答には本物の Response を使う（手作りのオブジェクトでは「本文は一度しか読めない」等の本物の性質が出ないため）。
//
// ■ 「【食い違い】」の describe は、本来の動きを期待するテスト。今のコードでは失敗する（報告 D1・D2）。
// ■ 「仕様の確認待ち」の it.todo は、仕様が決まったらテストにするもの（報告 Q1〜Q8）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- pkce.ts はモックにする（作られる値を固定して、保存・送信された値と突き合わせるため）
const { pkcePairMock } = vi.hoisted(() => ({ pkcePairMock: vi.fn() }));
vi.mock("./lib/pkce", () => ({ pkcePair: pkcePairMock }));

// ---- 定数
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0); // テスト中の「今」（Date.now を固定する）
const ORIGIN = "http://127.0.0.1:5173";
const REDIRECT_URI = `${ORIGIN}/callback`;
const CLIENT_ID = "test-client-id";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const DEFAULT_TOKEN_URL = "http://localhost:3001/api/auth/token";
const SCOPES = [
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-email",
  "user-read-private",
  "playlist-read-private",
];

const MSG_NO_CODE = "authorization code not found";
const MSG_NO_PKCE = "verifier/redirect_uri missing";
const MSG_CONNECT_FAILED =
  "バックエンドサーバーに接続できませんでした。\n" +
  "URL: http://localhost:3001\n" +
  "バックエンドサーバーが起動しているか確認してください。\n" +
  "エラー: Failed to fetch";
const MSG_EXCHANGE_400 = "token exchange failed: 400 Token exchange failed: invalid_grant";

/** ログイン中のトークン（S2・S3 の準備に使う） */
const OLD_TOKEN = JSON.stringify({
  session_id: "old-session",
  access_token: "old-access",
  refresh_token: "old-refresh",
  expires_at: NOW + 30 * 60 * 1000,
});

/** 正常な応答（tokenResponseBody）から保存されるはずのトークン */
const NEW_TOKEN = {
  session_id: "new-session",
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_at: NOW + 3600 * 1000,
};

// ---- 道具
const fetchMock = vi.fn<typeof fetch>();

type State = "S0" | "S1" | "S2" | "S3";
const STATES: State[] = ["S0", "S1", "S2", "S3"];

type FakeLocation = { href: string; origin: string; search: string };

/** location を差し替える（jsdom は他サイトへ遷移できないので、href への代入を記録するだけにする） */
function stubLocation(url: string): FakeLocation {
  const u = new URL(url);
  const fake: FakeLocation = { href: u.href, origin: u.origin, search: u.search };
  vi.stubGlobal("location", fake);
  return fake;
}

/** auth.ts を読み込み直す（API_BASE_URL は読み込んだ時点で決まるので、環境変数を変えた後に読み込む） */
async function loadAuth() {
  vi.resetModules();
  return import("./auth");
}

/** 状態を用意する */
function arrange(state: State) {
  if (state === "S1" || state === "S2") {
    sessionStorage.setItem("pkce_verifier", "old-verifier");
    sessionStorage.setItem("pkce_redirect_uri", REDIRECT_URI);
    sessionStorage.setItem("pkce_started_at", String(NOW - 60_000));
  }
  if (state === "S2" || state === "S3") {
    localStorage.setItem("spotify_token", OLD_TOKEN);
  }
}

/** 保存領域の中身を丸ごと写し取る */
function snapshot(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) out[key] = storage.getItem(key) ?? "";
  }
  return out;
}

/** 保存されたトークン（無ければ null） */
function savedToken(): unknown {
  const raw = localStorage.getItem("spotify_token");
  return raw === null ? null : JSON.parse(raw);
}

/** バックエンドの正常な応答の本文（backend/src/server.js の /api/auth/token と同じ形） */
function tokenResponseBody(): Record<string, unknown> {
  return {
    session_id: "new-session",
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number, contentType = "text/plain"): Response {
  return new Response(text, { status, headers: { "Content-Type": contentType } });
}

/** fetch に渡された内容（1回だけ呼ばれた前提） */
function sentRequest() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  return {
    url: String(input),
    method: init?.method,
    headers: init?.headers,
    body: JSON.parse(String(init?.body)) as unknown,
  };
}

/** reject された値を取り出す（resolve したらテストを失敗させる） */
async function caught(promise: Promise<unknown>): Promise<{ name?: string; message?: string }> {
  try {
    await promise;
  } catch (e) {
    return e as { name?: string; message?: string };
  }
  throw new Error("例外になるはずが、正常に終わった");
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("VITE_API_BASE_URL", undefined); // 手元の .env に左右されないようにする
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  pkcePairMock.mockReset();
  pkcePairMock.mockResolvedValue({ verifier: "new-verifier", challenge: "new-challenge" });
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error("fetch のモックが未設定")); // 想定外の通信を外へ出さない
  vi.stubGlobal("fetch", fetchMock);
  stubLocation(`${ORIGIN}/`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// =====================================================================
// 状態遷移表の全セル（4状態 × 7イベント）
// =====================================================================

describe("E1 beginLogin（成功）：各状態から", () => {
  const rows: Array<{ state: State; next: string }> = [
    { state: "S0", next: "S1：PKCE を保存して認可画面へ遷移する" },
    { state: "S1", next: "S1：PKCE を新しいものに上書きする" },
    { state: "S2", next: "S2：PKCE を上書きし、ログイン中のトークンはそのまま" },
    { state: "S3", next: "S2：PKCE を保存し、ログイン中のトークンはそのまま" },
  ];

  it.each(rows)("[$state × E1] → $next", async ({ state }) => {
    arrange(state);
    const tokenBefore = localStorage.getItem("spotify_token");
    const { beginLogin } = await loadAuth();
    const loc = stubLocation(`${ORIGIN}/`);

    await beginLogin();

    expect(sessionStorage.getItem("pkce_verifier")).toBe("new-verifier");
    expect(sessionStorage.getItem("pkce_redirect_uri")).toBe(REDIRECT_URI);
    expect(sessionStorage.getItem("pkce_started_at")).toBe(String(NOW));
    expect(localStorage.getItem("spotify_token")).toBe(tokenBefore);
    const url = new URL(loc.href);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("code_challenge")).toBe("new-challenge");
  });
});

describe("E1x beginLogin（失敗）：どの状態でも例外になり、保存内容も今の画面も変わらない", () => {
  const failures = [
    {
      kind: "PKCE を作れない（http://192.168.x.x のような安全でない接続では crypto.subtle が無い）",
      errorName: "TypeError",
      breakIt: () =>
        pkcePairMock.mockRejectedValue(
          new TypeError("Cannot read properties of undefined (reading 'digest')"),
        ),
    },
    {
      kind: "sessionStorage に書けない（容量超過・保存の無効化）",
      errorName: "QuotaExceededError",
      breakIt: () =>
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }),
    },
  ];

  describe.each(failures)("$kind", ({ errorName, breakIt }) => {
    it.each(STATES)("[%s × E1x] → 同じ状態のまま（遷移しない）", async (state) => {
      arrange(state);
      const before = { session: snapshot(sessionStorage), local: snapshot(localStorage) };
      const { beginLogin } = await loadAuth();
      const loc = stubLocation(`${ORIGIN}/`);
      breakIt();

      const err = await caught(beginLogin());

      expect(err.name).toBe(errorName);
      expect(snapshot(sessionStorage)).toEqual(before.session);
      expect(snapshot(localStorage)).toEqual(before.local);
      expect(loc.href).toBe(`${ORIGIN}/`);
    });
  });
});

describe("E2〜E6 handleCallback：各状態 × 各イベント", () => {
  type CallbackEvent = "E2" | "E3" | "E4" | "E5" | "E6";

  /** イベントを用意する：Spotify からの戻り先 URL と、バックエンドの応答 */
  function arrangeCallback(event: CallbackEvent) {
    if (event === "E3") {
      stubLocation(`${REDIRECT_URI}?error=access_denied&state=xyz`);
      return;
    }
    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE&state=xyz`);
    if (event === "E2") fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));
    if (event === "E4") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    if (event === "E5") {
      fetchMock.mockResolvedValue(jsonResponse({ error: "Token exchange failed: invalid_grant" }, 400));
    }
    if (event === "E6") {
      fetchMock.mockResolvedValue(textResponse("<!doctype html><title>OK</title>", 200, "text/html"));
    }
  }

  const KEPT = JSON.parse(OLD_TOKEN) as unknown;

  const successRows: Array<{ state: State; event: CallbackEvent; next: string; token: unknown }> = [
    { state: "S1", event: "E2", next: "S2：トークンを保存する（ログイン完了）", token: NEW_TOKEN },
    { state: "S2", event: "E2", next: "S2：トークンを新しいものに置き換える（再ログイン完了）", token: NEW_TOKEN },
  ];

  it.each(successRows)("[$state × $event] → $next", async ({ state, event, token }) => {
    arrange(state);
    const { handleCallback } = await loadAuth();
    arrangeCallback(event);

    await handleCallback();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedToken()).toEqual(token);
  });

  // message に expect.any(String) を入れた行は、例外の文言を問わない（仕様確認 Q8）
  const errorRows: Array<{
    state: State;
    event: CallbackEvent;
    next: string;
    message: unknown;
    fetched: boolean;
    token: unknown;
  }> = [
    { state: "S0", event: "E2", next: "S0✕ 問い合わせない", message: MSG_NO_PKCE, fetched: false, token: null },
    { state: "S0", event: "E3", next: "S0✕ 問い合わせない", message: MSG_NO_CODE, fetched: false, token: null },
    { state: "S0", event: "E4", next: "S0✕ 問い合わせない", message: MSG_NO_PKCE, fetched: false, token: null },
    { state: "S0", event: "E5", next: "S0✕ 問い合わせない", message: MSG_NO_PKCE, fetched: false, token: null },
    { state: "S0", event: "E6", next: "S0✕ 問い合わせない", message: MSG_NO_PKCE, fetched: false, token: null },
    { state: "S1", event: "E3", next: "S1✕ 問い合わせない", message: MSG_NO_CODE, fetched: false, token: null },
    { state: "S1", event: "E4", next: "S1✕ トークンは作らない", message: MSG_CONNECT_FAILED, fetched: true, token: null },
    { state: "S1", event: "E5", next: "S1✕ トークンは作らない", message: MSG_EXCHANGE_400, fetched: true, token: null },
    { state: "S1", event: "E6", next: "S1✕ トークンは作らない", message: expect.any(String), fetched: true, token: null },
    { state: "S2", event: "E3", next: "S2✕ トークンは壊さない", message: MSG_NO_CODE, fetched: false, token: KEPT },
    { state: "S2", event: "E4", next: "S2✕ トークンは壊さない", message: MSG_CONNECT_FAILED, fetched: true, token: KEPT },
    { state: "S2", event: "E5", next: "S2✕ トークンは壊さない", message: MSG_EXCHANGE_400, fetched: true, token: KEPT },
    { state: "S2", event: "E6", next: "S2✕ トークンは壊さない", message: expect.any(String), fetched: true, token: KEPT },
    { state: "S3", event: "E2", next: "S3✕ 問い合わせず、トークンは壊さない", message: MSG_NO_PKCE, fetched: false, token: KEPT },
    { state: "S3", event: "E3", next: "S3✕ 問い合わせず、トークンは壊さない", message: MSG_NO_CODE, fetched: false, token: KEPT },
    { state: "S3", event: "E4", next: "S3✕ 問い合わせず、トークンは壊さない", message: MSG_NO_PKCE, fetched: false, token: KEPT },
    { state: "S3", event: "E5", next: "S3✕ 問い合わせず、トークンは壊さない", message: MSG_NO_PKCE, fetched: false, token: KEPT },
    { state: "S3", event: "E6", next: "S3✕ 問い合わせず、トークンは壊さない", message: MSG_NO_PKCE, fetched: false, token: KEPT },
  ];

  it.each(errorRows)("[$state × $event] → $next", async ({ state, event, message, fetched, token }) => {
    arrange(state);
    const { handleCallback } = await loadAuth();
    arrangeCallback(event);

    const err = await caught(handleCallback());

    expect(err.message).toEqual(message);
    expect(fetchMock).toHaveBeenCalledTimes(fetched ? 1 : 0);
    expect(savedToken()).toEqual(token);
  });
});

// =====================================================================
// 遷移の中身と、遷移の条件の境目・極端な値
// =====================================================================

describe("beginLogin の中身（S0 → S1）", () => {
  it("B-01 認可画面の URL：宛先と送るパラメータ。verifier そのものは認可画面に出さない", async () => {
    const { beginLogin } = await loadAuth();
    const loc = stubLocation(`${ORIGIN}/`);

    await beginLogin();

    const url = new URL(loc.href);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("new-challenge");
    // scope はコードに書かれた5つ（.env.example の VITE_SCOPES は使われていない。仕様確認 Q9）
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([...SCOPES].sort());
    // state は送っているが、保存も照合もしていない（仕様確認 Q1）。ここでは空でないことだけ見る
    expect(url.searchParams.get("state")).toMatch(/\S/);
    expect(loc.href).not.toContain("new-verifier");
  });

  it.each([
    { page: "http://127.0.0.1:5173/", expected: "http://127.0.0.1:5173/callback" },
    { page: "http://localhost:5173/", expected: "http://localhost:5173/callback" },
    { page: "https://playlist.example.com/", expected: "https://playlist.example.com/callback" }, // 既定ポート（ポート表記なし）
    { page: "http://[::1]:5173/", expected: "http://[::1]:5173/callback" }, // IPv6 のループバック
    { page: "http://127.0.0.1:5173/playlists?tab=mine#top", expected: "http://127.0.0.1:5173/callback" }, // 今のパス・クエリは含めない
  ])("B-02 redirect_uri は「今の origin + /callback」：$page → $expected（送る値と保存する値が同じ）", async ({ page, expected }) => {
    const { beginLogin } = await loadAuth();
    const loc = stubLocation(page);

    await beginLogin();

    expect(new URL(loc.href).searchParams.get("redirect_uri")).toBe(expected);
    expect(sessionStorage.getItem("pkce_redirect_uri")).toBe(expected);
  });

  it("B-03 連打などで2回同時に呼ばれ、後の呼び出しが先に終わっても、保存する verifier と遷移先の challenge は同じ回の組になる", async () => {
    const { beginLogin } = await loadAuth();
    const loc = stubLocation(`${ORIGIN}/`);
    type Pair = { verifier: string; challenge: string };
    const resolvers: Array<(pair: Pair) => void> = [];
    pkcePairMock.mockImplementation(() => new Promise<Pair>((resolve) => resolvers.push(resolve)));

    const first = beginLogin();
    const second = beginLogin();
    resolvers[1]({ verifier: "verifier-2", challenge: "challenge-2" });
    await second;
    resolvers[0]({ verifier: "verifier-1", challenge: "challenge-1" });
    await first;

    expect(sessionStorage.getItem("pkce_verifier")).toBe("verifier-1");
    expect(new URL(loc.href).searchParams.get("code_challenge")).toBe("challenge-1");
  });
});

describe("handleCallback の中身と条件（S1 → S2）", () => {
  /** S1 で、code 付きの /callback に戻ってきた状況を作る */
  async function setupS1Callback(search = "?code=AUTH_CODE&state=xyz") {
    arrange("S1");
    const auth = await loadAuth();
    stubLocation(`${REDIRECT_URI}${search}`);
    return auth;
  }

  it("C-01 バックエンドへ送る内容：URL・メソッド・ヘッダー・本文（code・verifier・redirect_uri の3つだけ）", async () => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));

    await handleCallback();

    const req = sentRequest();
    expect(req.url).toBe(DEFAULT_TOKEN_URL);
    expect(req.method).toBe("POST");
    expect(req.headers).toEqual({ "Content-Type": "application/json" });
    expect(req.body).toEqual({ code: "AUTH_CODE", code_verifier: "old-verifier", redirect_uri: REDIRECT_URI });
  });

  it("C-02 保存するトークン：session_id・access_token・refresh_token・expires_at（今 + expires_in 秒）", async () => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));

    await handleCallback();

    expect(savedToken()).toEqual(NEW_TOKEN);
  });

  it.each([
    { case: "refresh_token が無い", body: { session_id: "new-session", access_token: "new-access", expires_in: 3600 } },
    { case: "refresh_token が null", body: { ...tokenResponseBody(), refresh_token: null } },
  ])("C-03 $case 応答 → refresh_token は null で保存する", async ({ body }) => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse(body));

    await handleCallback();

    expect(savedToken()).toEqual({ ...NEW_TOKEN, refresh_token: null });
  });

  it.each([
    { expiresIn: 1, expiresAt: NOW + 1_000, note: "有効な最小の値（境界）" },
    { expiresIn: 3600, expiresAt: NOW + 3_600_000, note: "Spotify の通常の値（1時間）" },
  ])("C-04 expires_in = $expiresIn（$note）→ expires_at = 今 + $expiresIn 秒", async ({ expiresIn, expiresAt }) => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse({ ...tokenResponseBody(), expires_in: expiresIn }));

    await handleCallback();

    expect(savedToken()).toEqual({ ...NEW_TOKEN, expires_at: expiresAt });
  });

  it.each([200, 299])("C-05 状態コード %i（2xx の端）→ 成功としてトークンを保存する", async (status) => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody(), status));

    await handleCallback();

    expect(savedToken()).toEqual(NEW_TOKEN);
  });

  it.each([
    { status: 300, note: "2xx のすぐ外（境界）" },
    { status: 400, note: "code の誤り・使用済み" },
    { status: 500, note: "サーバー側の失敗" },
    { status: 599, note: "状態コードの上端" },
  ])("C-06 状態コード $status（$note）→ 「token exchange failed: $status <error>」の例外、トークンは保存しない", async ({ status }) => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse({ error: "something wrong" }, status));

    const err = await caught(handleCallback());

    expect(err.message).toBe(`token exchange failed: ${status} something wrong`);
    expect(savedToken()).toBeNull();
  });

  it.each([
    { case: "error が無い JSON", body: {} },
    { case: "error が空文字（境界）", body: { error: "" } },
  ])("C-07 エラー応答が $case → 「Unknown error」を入れた例外", async ({ body }) => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse(body, 500));

    const err = await caught(handleCallback());

    expect(err.message).toBe("token exchange failed: 500 Unknown error");
  });

  it("C-08 接続できず、投げられた値が Error でない（文字列）とき → その値を文字にして例外に入れる", async () => {
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockRejectedValue("offline");

    const err = await caught(handleCallback());

    expect(err.message).toBe(MSG_CONNECT_FAILED.replace("Failed to fetch", "offline"));
    expect(savedToken()).toBeNull();
  });

  it.each([
    { case: "1文字（最小の長さ）", search: "?code=a", code: "a" },
    { case: "2048文字（極端に長い）", search: `?code=${"A".repeat(2048)}`, code: "A".repeat(2048) },
    { case: "URL エンコードされた記号を含む", search: "?code=AQB%2Bx%2Fy%3D-_.~", code: "AQB+x/y=-_.~" },
  ])("C-09 code が $case → 一度だけデコードした値をそのまま送る", async ({ search, code }) => {
    const { handleCallback } = await setupS1Callback(search);
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));

    await handleCallback();

    expect(sentRequest().body).toEqual({ code, code_verifier: "old-verifier", redirect_uri: REDIRECT_URI });
  });

  it.each([
    { case: "クエリが無い（/callback に直接アクセス）", search: "" },
    { case: "code が空（?code=）", search: "?code=" },
    { case: "code に値が無い（?code）", search: "?code" },
    { case: "同意しなかった（?error=access_denied）", search: "?error=access_denied&state=xyz" },
  ])("C-10 $case → 「authorization code not found」、問い合わせない", async ({ search }) => {
    const { handleCallback } = await setupS1Callback(search);

    const err = await caught(handleCallback());

    expect(err.message).toBe(MSG_NO_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { case: "verifier だけある", verifier: "old-verifier", redirectUri: null },
    { case: "redirect_uri だけある", verifier: null, redirectUri: REDIRECT_URI },
    { case: "verifier が空文字（境界）", verifier: "", redirectUri: REDIRECT_URI },
    { case: "redirect_uri が空文字（境界）", verifier: "old-verifier", redirectUri: "" },
  ])("C-11 PKCE が欠けている：$case → 「verifier/redirect_uri missing」、問い合わせない", async ({ verifier, redirectUri }) => {
    const { handleCallback } = await loadAuth();
    if (verifier !== null) sessionStorage.setItem("pkce_verifier", verifier);
    if (redirectUri !== null) sessionStorage.setItem("pkce_redirect_uri", redirectUri);
    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);

    const err = await caught(handleCallback());

    expect(err.message).toBe(MSG_NO_PKCE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("C-12 sessionStorage と localStorage の両方に PKCE があるときは、sessionStorage の値を使う", async () => {
    const { handleCallback } = await setupS1Callback();
    localStorage.setItem("pkce_verifier", "local-verifier");
    localStorage.setItem("pkce_redirect_uri", "http://local.example/callback");
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));

    await handleCallback();

    expect(sentRequest().body).toEqual({ code: "AUTH_CODE", code_verifier: "old-verifier", redirect_uri: REDIRECT_URI });
  });

  it("C-13 PKCE が localStorage にだけあるときは、localStorage の値を使う（beginLogin は localStorage に書かない。仕様確認 Q4）", async () => {
    const { handleCallback } = await loadAuth();
    localStorage.setItem("pkce_verifier", "local-verifier");
    localStorage.setItem("pkce_redirect_uri", REDIRECT_URI);
    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));

    await handleCallback();

    expect(sentRequest().body).toEqual({ code: "AUTH_CODE", code_verifier: "local-verifier", redirect_uri: REDIRECT_URI });
    expect(savedToken()).toEqual(NEW_TOKEN);
  });

  it.each([
    { case: "未設定", value: undefined, url: "http://localhost:3001/api/auth/token" },
    { case: "空文字（境界：未設定と同じ扱い）", value: "", url: "http://localhost:3001/api/auth/token" },
    { case: "指定あり", value: "https://api.example.test", url: "https://api.example.test/api/auth/token" },
  ])("C-14 VITE_API_BASE_URL が $case → $url に送る", async ({ value, url }) => {
    vi.stubEnv("VITE_API_BASE_URL", value);
    const { handleCallback } = await setupS1Callback();
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));

    await handleCallback();

    expect(sentRequest().url).toBe(url);
  });
});

// =====================================================================
// 1スイッチ（遷移を2つ続けたとき）
// =====================================================================

describe("1スイッチ：遷移を2つ続けたとき", () => {
  it("N-01 S0 →E1→ S1 →E2→ S2：認可画面に送った redirect_uri と、challenge の元の verifier でトークンを交換する", async () => {
    const { beginLogin, handleCallback } = await loadAuth();
    pkcePairMock.mockResolvedValue({ verifier: "verifier-xyz", challenge: "challenge-xyz" });
    const loc = stubLocation(`${ORIGIN}/`);
    await beginLogin();
    const authorize = new URL(loc.href);
    const sentRedirectUri = authorize.searchParams.get("redirect_uri");
    expect(authorize.searchParams.get("code_challenge")).toBe("challenge-xyz");

    // Spotify で同意して戻ってくる
    stubLocation(`${sentRedirectUri}?code=AUTH_CODE&state=${authorize.searchParams.get("state")}`);
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));
    await handleCallback();

    expect(sentRequest().body).toEqual({ code: "AUTH_CODE", code_verifier: "verifier-xyz", redirect_uri: sentRedirectUri });
    expect(savedToken()).toEqual(NEW_TOKEN);
  });

  it("N-02 S1 →E1→ S1 →E2→ S2：ログインをやり直したときは、新しい verifier で交換する", async () => {
    arrange("S1");
    const { beginLogin, handleCallback } = await loadAuth();
    await beginLogin();

    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));
    await handleCallback();

    expect(sentRequest().body).toEqual({ code: "AUTH_CODE", code_verifier: "new-verifier", redirect_uri: REDIRECT_URI });
  });

  it("N-03 S2 →E1→ S2 →E5→ S2：再ログインに失敗しても、ログイン中のトークンはそのまま", async () => {
    arrange("S2");
    const { beginLogin, handleCallback } = await loadAuth();
    await beginLogin();

    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Token exchange failed: invalid_grant" }, 400));
    const err = await caught(handleCallback());

    expect(err.message).toBe(MSG_EXCHANGE_400);
    expect(sentRequest().body).toMatchObject({ code_verifier: "new-verifier" });
    expect(localStorage.getItem("spotify_token")).toBe(OLD_TOKEN);
  });

  it("N-04 S3 →E1→ S2 →E2→ S2：ブラウザ再起動後・別タブから再ログインすると、トークンが新しくなる", async () => {
    arrange("S3");
    const { beginLogin, handleCallback } = await loadAuth();
    await beginLogin();

    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);
    fetchMock.mockResolvedValue(jsonResponse(tokenResponseBody()));
    await handleCallback();

    expect(sentRequest().body).toEqual({ code: "AUTH_CODE", code_verifier: "new-verifier", redirect_uri: REDIRECT_URI });
    expect(savedToken()).toEqual(NEW_TOKEN);
  });
});

// =====================================================================
// 仕様の確認待ち（決まったらテストにする）
// =====================================================================

describe("仕様の確認待ち（報告 Q1〜Q8）", () => {
  it.todo("Q1 state：認可画面に送っているが、保存も照合もしていない。照合するか、送るのをやめるか");
  it.todo("Q2 交換が終わった後（成功・失敗）に PKCE を消すか。今は消さないので、ログイン済みでも code 付きの /callback でバックエンドへ問い合わせる");
  it.todo("Q3 pkce_started_at：保存するだけで使っていない。認可待ちに期限を設けるか（何分か）");
  it.todo("Q4 localStorage の PKCE：handleCallback は読むが beginLogin は書かない。別タブに戻った場合もログインできるようにするか、読むのをやめるか");
  it.todo("Q5 同意しなかった（?error=access_denied）とき、code が無いときと区別したメッセージにするか");
  it.todo("Q6 VITE_SPOTIFY_CLIENT_ID が未設定のとき：今は client_id=undefined のまま認可画面へ遷移する。遷移の前に止めるか");
  it.todo("Q7 VITE_API_BASE_URL の末尾が / のとき：今は //api/auth/token に送る。整えるか");
  it.todo("Q8 2xx だが本文が JSON でないとき：今は JSON の解析エラーがそのまま出る。わかる文言にするか");
});

// =====================================================================
// 【食い違い】本来の動きを期待するテスト（今のコードでは失敗する）
// =====================================================================

describe("【食い違い】本来の動きを期待するテスト（今のコードでは失敗する。報告 D1・D2）", () => {
  // auth.ts 73〜75行目のコメント「JSONパースに失敗した場合はテキストとして取得」のとおりなら、こうなるはず。
  // 実際は res.json() で本文を読み切った後に res.text() を呼ぶので、本物の fetch では text() も失敗する。
  it.each([
    { case: "本文がテキスト（プロキシの 502 など）", status: 502, text: "Bad Gateway", expected: "token exchange failed: 502 Bad Gateway" },
    { case: "本文が空", status: 500, text: "", expected: "token exchange failed: 500 Unknown error" },
  ])("D1 エラー応答の $case → 「$expected」の例外になる", async ({ status, text, expected }) => {
    arrange("S1");
    const { handleCallback } = await loadAuth();
    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);
    fetchMock.mockResolvedValue(textResponse(text, status));

    const err = await caught(handleCallback());

    expect(err.message).toBe(expected);
  });

  // App.tsx は session_id が無い・expires_at が今以前のトークンを「未ログイン」とみなし、
  // api.ts は session_id が無いと「Please login again.」で失敗する。
  // それなのに handleCallback は成功で終わるので、利用者には何のエラーも出ずにログインできない。
  it.each([
    { case: "session_id が無い", body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } },
    { case: "expires_in が無い", body: { session_id: "new-session", access_token: "new-access", refresh_token: "new-refresh" } },
    { case: "expires_in が 0（境界：保存した時点で期限切れ）", body: { ...tokenResponseBody(), expires_in: 0 } },
  ])("D2 2xx でも $case 応答 → 使えないトークンを保存して成功にせず、例外にする", async ({ body }) => {
    arrange("S1");
    const { handleCallback } = await loadAuth();
    stubLocation(`${REDIRECT_URI}?code=AUTH_CODE`);
    fetchMock.mockResolvedValue(jsonResponse(body));

    await caught(handleCallback());

    expect(localStorage.getItem("spotify_token")).toBeNull();
  });
});
