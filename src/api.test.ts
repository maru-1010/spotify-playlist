// src/api.ts のテスト（ケースは「エラー推測」で洗い出したもの）
//
// 方針
// - 外部への通信はしない。fetch は vi.stubGlobal で差し替える。
// - 応答には Node 標準の本物の Response を使う。「本文は一度しか読めない」
//   「ok は 200〜299 だけ」といった Fetch API の性質をそのまま再現するため。
// - API_BASE_URL はモジュールを読み込んだ時点で決まる。手元の .env に左右されないよう、
//   テストごとに環境変数を固定してから src/api.ts を読み込み直す。
// - 今の動きが本来の動きと食い違って見える点は、今の動きを正として書かない。
//   本来の動きを書いたテストを末尾の「既知の食い違い」にまとめ、既定では skip にしている。
//   環境変数 RUN_KNOWN_ISSUES=1 を付けて実行すると走る（今のコードでは失敗する）。
// - 仕様が決まっていない点（範囲外の limit、期限切れトークンの扱いなど）はテストにしていない。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";

type Api = typeof import("./api");

const BASE_URL = "http://backend.test";
const DEFAULT_BASE_URL = "http://localhost:3001";
const SESSION_ID = "session-abc-123";

const knownIssue = it.skipIf(import.meta.env.RUN_KNOWN_ISSUES !== "1");

let api: Api;
let fetchMock: Mock<typeof fetch>;
let consoleErrorSpy: MockInstance<typeof console.error>;

/**
 * 環境変数 VITE_API_BASE_URL を固定してから src/api.ts を読み込み直す。
 * undefined を渡すと「未設定」になる（既定引数にすると undefined が既定値に化けるので付けない）。
 */
async function loadApi(baseUrl: string | undefined): Promise<Api> {
  vi.resetModules();
  vi.stubEnv("VITE_API_BASE_URL", baseUrl);
  return import("./api");
}

/** ログイン後に auth.ts が保存するのと同じ形のトークンを置く */
function saveLoginToken(sessionId: string = SESSION_ID) {
  localStorage.setItem(
    "spotify_token",
    JSON.stringify({
      session_id: sessionId,
      access_token: "access-token",
      refresh_token: null,
      expires_at: Date.now() + 60 * 60 * 1000,
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function textResponse(body: string, status: number, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

/** index 回目（0 始まり）の fetch 呼び出しを、確かめやすい形にして返す */
function requestAt(index = 0) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch の ${index + 1} 回目の呼び出しがありません`);
  const [input, init = {}] = call;
  const rawUrl = String(input);
  return {
    rawUrl,
    url: new URL(rawUrl),
    method: (init.method ?? "GET").toUpperCase(),
    headers: new Headers(init.headers),
    body: init.body,
    jsonBody: (): unknown => JSON.parse(String(init.body)),
  };
}

/** reject されることを確かめ、その理由（Error）を返す */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("reject されるはずが resolve された");
}

/** パスを "/" で区切った各区画（先頭の空文字は除く） */
function pathSegments(url: URL): string[] {
  return url.pathname.split("/").slice(1);
}

beforeEach(async () => {
  localStorage.clear();
  saveLoginToken();
  fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  api = await loadApi(BASE_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

type ApiCase = {
  name: string;
  call: (api: Api) => Promise<unknown>;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  hasBody: boolean;
};

// 宛先は backend/src/server.js の受け口と突き合わせたもの
const API_CASES: ApiCase[] = [
  { name: "fetchMyPlaylists", call: (a) => a.fetchMyPlaylists(), method: "GET", path: "/api/spotify/me/playlists", hasBody: false },
  { name: "fetchPlaylistItems", call: (a) => a.fetchPlaylistItems("pl1"), method: "GET", path: "/api/spotify/playlists/pl1/tracks", hasBody: false },
  { name: "searchSpotify", call: (a) => a.searchSpotify("beatles"), method: "GET", path: "/api/spotify/search", hasBody: false },
  { name: "addTracksToPlaylist", call: (a) => a.addTracksToPlaylist("pl1", ["spotify:track:t1"]), method: "POST", path: "/api/spotify/playlists/pl1/tracks", hasBody: true },
  { name: "removeTracksFromPlaylist", call: (a) => a.removeTracksFromPlaylist("pl1", ["spotify:track:t1"]), method: "DELETE", path: "/api/spotify/playlists/pl1/tracks", hasBody: true },
  { name: "reorderPlaylistTracks", call: (a) => a.reorderPlaylistTracks("pl1", 0, 2), method: "PUT", path: "/api/spotify/playlists/pl1/tracks", hasBody: true },
  { name: "updatePlaylist", call: (a) => a.updatePlaylist("pl1", { name: "新しい名前" }), method: "PUT", path: "/api/spotify/playlists/pl1", hasBody: true },
  { name: "deletePlaylist", call: (a) => a.deletePlaylist("pl1"), method: "DELETE", path: "/api/spotify/playlists/pl1/followers", hasBody: false },
  { name: "getCurrentUser", call: (a) => a.getCurrentUser(), method: "GET", path: "/api/spotify/me", hasBody: false },
  { name: "createPlaylist", call: (a) => a.createPlaylist("user1", { name: "新しいプレイリスト" }), method: "POST", path: "/api/spotify/users/user1/playlists", hasBody: true },
];

describe("全関数に共通", () => {
  it.each(API_CASES)("$name: $method $path に x-session-id を付けて送り、応答の JSON を返す", async ({ name, call, method, path }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ from: name }));

    await expect(call(api)).resolves.toEqual({ from: name });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = requestAt(0);
    expect(req.url.origin + req.url.pathname).toBe(BASE_URL + path);
    expect(req.method).toBe(method);
    expect(req.headers.get("x-session-id")).toBe(SESSION_ID);
  });

  it.each(API_CASES.filter((c) => c.hasBody))(
    "$name: 本文を JSON で送り、Content-Type: application/json を付ける（無いとバックエンドが本文を読まない）",
    async ({ call }) => {
      await call(api);
      const req = requestAt(0);
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(typeof req.body).toBe("string");
      expect(() => req.jsonBody()).not.toThrow();
    },
  );

  // 本物の fetch は GET に本文があると例外を投げる。モックでは起きないので、本文が無いことを直に見る
  it.each(API_CASES.filter((c) => !c.hasBody))("$name: $method で本文を付けずに送る", async ({ call }) => {
    await call(api);
    expect(requestAt(0).body).toBeUndefined();
  });

  it.each(API_CASES)("$name: トークンが無い（未ログイン）と通信せずに reject する（その場で throw はしない）", async ({ call }) => {
    localStorage.removeItem("spotify_token");

    let pending: Promise<unknown> = Promise.resolve();
    expect(() => {
      pending = call(api);
    }).not.toThrow();
    const error = await rejectionOf(pending);

    expect(error.message).toContain("token not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(API_CASES)("$name: エラー応答を握りつぶさずに reject する", async ({ call }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Token expired" }, 401));

    const error = await rejectionOf(call(api));

    expect(error.message).toBe("401 Token expired");
  });
});

describe("接続先（環境変数 VITE_API_BASE_URL）", () => {
  it("設定されていれば、その値の後ろに API のパスをつないで送る", async () => {
    api = await loadApi("https://api.example.test:8443");
    await api.getCurrentUser();
    expect(requestAt(0).rawUrl).toBe("https://api.example.test:8443/api/spotify/me");
  });

  it("パス付き（/backend）で設定されていても、そのパスを残してつなぐ", async () => {
    api = await loadApi("https://example.test/backend");
    await api.getCurrentUser();
    expect(requestAt(0).rawUrl).toBe("https://example.test/backend/api/spotify/me");
  });

  it("設定されていなければ http://localhost:3001 に送る", async () => {
    api = await loadApi(undefined);
    await api.getCurrentUser();
    expect(requestAt(0).rawUrl).toBe(`${DEFAULT_BASE_URL}/api/spotify/me`);
  });

  it("空文字なら、設定されていないのと同じく http://localhost:3001 に送る（境目）", async () => {
    api = await loadApi("");
    await api.getCurrentUser();
    expect(requestAt(0).rawUrl).toBe(`${DEFAULT_BASE_URL}/api/spotify/me`);
  });
});

describe("セッションID（localStorage の spotify_token）", () => {
  it("spotify_token が空文字のときも、無いときと同じく通信せずに reject する（境目）", async () => {
    localStorage.setItem("spotify_token", "");

    const error = await rejectionOf(api.getCurrentUser());

    expect(error.message).toContain("token not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["session_id が無い", "{}"],
    ["session_id が空文字", '{"session_id":""}'],
    ["session_id が null", '{"session_id":null}'],
    ["access_token だけの古い形", '{"access_token":"old-access-token"}'],
    ["JSON の配列", "[]"],
    ["JSON の文字列", '"session-abc-123"'],
    ["JSON の数値", "123"],
  ])("%s（%s）のときは、ログインし直すよう促すエラーで reject し、通信しない", async (_label, saved) => {
    localStorage.setItem("spotify_token", saved);

    const error = await rejectionOf(api.getCurrentUser());

    expect(error.message).toContain("session_id not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // エラーの文言は仕様が決まっていないので見ない（最終報告の「仕様の確認が要る点」）
  it.each([
    ["JSON でない文字列", "not-json"],
    ["途中で切れた JSON", '{"session_id":"abc"'],
    ["文字列の undefined", "undefined"],
    ["JSON の null", "null"],
  ])("%s（%s）のときは reject し、通信しない", async (_label, saved) => {
    localStorage.setItem("spotify_token", saved);

    await rejectionOf(api.getCurrentUser());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("localStorage を読めない（例外が出る）ときも、その場で throw せずに reject する", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });

    let pending: Promise<unknown> = Promise.resolve();
    expect(() => {
      pending = api.getCurrentUser();
    }).not.toThrow();
    const error = await rejectionOf(pending);

    expect(error.message).toContain("insecure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("呼ぶたびに読み直す（再ログインで session_id が変われば新しい値を送り、ログアウト後は送らない）", async () => {
    await api.getCurrentUser();
    saveLoginToken("session-2");
    await api.getCurrentUser();
    localStorage.removeItem("spotify_token");
    await rejectionOf(api.getCurrentUser());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(0).headers.get("x-session-id")).toBe(SESSION_ID);
    expect(requestAt(1).headers.get("x-session-id")).toBe("session-2");
  });
});

describe("成功応答の扱い", () => {
  it.each([200, 201, 299])("%i なら本文の JSON を返す（ok の範囲 200〜299。299 は上端）", async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "user1", status }, status));

    await expect(api.getCurrentUser()).resolves.toEqual({ id: "user1", status });
  });

  it("204 No Content なら本文を読まずに {} を返す", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(api.deletePlaylist("pl1")).resolves.toEqual({});
  });

  it("成功したときは console.error を出さない", async () => {
    await api.getCurrentUser();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("ok でも本文が JSON でない（接続先を間違えて HTML が返る等）なら、壊れた値を返さずに reject する", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("<!doctype html><html><body>Vite App</body></html>", 200, "text/html"));

    await rejectionOf(api.fetchMyPlaylists());
  });
});

describe("エラー応答の扱い", () => {
  it.each([300, 400, 401, 404, 429, 500, 503, 599])(
    "%i は「<status> <error の文言>」の Error で reject する（ok でない範囲。300 は下端、599 は上端）",
    async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "バックエンドからの文言" }, status));

      const error = await rejectionOf(api.getCurrentUser());

      expect(error.message).toBe(`${status} バックエンドからの文言`);
    },
  );

  it.each([
    ["error が空文字", { error: "" }],
    ["error が null", { error: null }],
    ["error が無い", {}],
  ])("%s（%j）のときは、status 付きの既定の文言（Request failed）で reject する", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 500));

    const error = await rejectionOf(api.getCurrentUser());

    expect(error.message).toMatch(/^500 /);
    expect(error.message).toContain("Request failed");
  });

  it("本文が空（502 など）のときも、status 付きの既定の文言（Request failed）で reject する", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));

    const error = await rejectionOf(api.getCurrentUser());

    expect(error.message).toMatch(/^502 /);
    expect(error.message).toContain("Request failed");
  });

  it("失敗したときは console.error にエンドポイント・status・文言を出す", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Playlist not found" }, 404));

    await rejectionOf(api.deletePlaylist("pl1"));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/spotify/playlists/pl1/followers"),
      404,
      "Playlist not found",
    );
  });

  it("通信そのものが失敗した（fetch が reject した）ときは、元のエラーの内容が分かる形で reject する", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const error = await rejectionOf(api.getCurrentUser());

    expect(error.message).toContain("Failed to fetch");
  });
});

describe("fetchMyPlaylists", () => {
  it("引数を省くと limit=20・offset=0 で取りに行く", async () => {
    await api.fetchMyPlaylists();

    const { url } = requestAt(0);
    expect([...url.searchParams.keys()]).toEqual(["limit", "offset"]);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it.each([
    [1, 0],
    [50, 980],
  ])("limit=%i・offset=%i を渡すと、その値で取りに行く（limit の下端と上端）", async (limit, offset) => {
    await api.fetchMyPlaylists(limit, offset);

    const { url } = requestAt(0);
    expect(url.searchParams.get("limit")).toBe(String(limit));
    expect(url.searchParams.get("offset")).toBe(String(offset));
  });

  it("limit に undefined を渡すと既定の 20 になり、offset は渡した値のまま（ページ送り）", async () => {
    await api.fetchMyPlaylists(undefined, 40);

    const { url } = requestAt(0);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("40");
  });
});

describe("fetchPlaylistItems", () => {
  const EXPECTED_FIELDS =
    "items(added_at,is_local,track(id,name,uri,preview_url,external_urls,artists(id,name),album(id,name,images)))" +
    ",total,next,previous,limit,offset";

  it("引数を省くと limit=100・offset=0 で取りに行き、fields は1回だけエンコードして付ける", async () => {
    await api.fetchPlaylistItems("pl1");

    const { url, rawUrl } = requestAt(0);
    expect([...url.searchParams.keys()]).toEqual(["limit", "offset", "fields"]);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("fields")).toBe(EXPECTED_FIELDS);
    expect(rawUrl).not.toContain("%25"); // 二重にエンコードしていない
  });

  it.each([
    [1, 0],
    [100, 200],
  ])("limit=%i・offset=%i を渡すと、その値で取りに行く", async (limit, offset) => {
    await api.fetchPlaylistItems("pl1", limit, offset);

    const { url } = requestAt(0);
    expect(url.searchParams.get("limit")).toBe(String(limit));
    expect(url.searchParams.get("offset")).toBe(String(offset));
  });

  it("playlistId の記号（/ ? = # % 空白）や日本語は、パスの1区画に収まるようにエンコードする", async () => {
    const playlistId = "a/b?c=1#d e%f日本";

    await api.fetchPlaylistItems(playlistId);

    const { url } = requestAt(0);
    const segments = pathSegments(url); // api / spotify / playlists / {id} / tracks
    expect(segments).toHaveLength(5);
    expect(decodeURIComponent(segments[3])).toBe(playlistId);
    expect(segments[4]).toBe("tracks");
    expect([...url.searchParams.keys()]).toEqual(["limit", "offset", "fields"]);
    expect(url.hash).toBe("");
  });
});

describe("searchSpotify", () => {
  it("type・limit を省くと type=track・limit=20 で検索する", async () => {
    await api.searchSpotify("beatles");

    const { url } = requestAt(0);
    expect([...url.searchParams.keys()]).toEqual(["q", "type", "limit"]);
    expect(url.searchParams.get("q")).toBe("beatles");
    expect(url.searchParams.get("type")).toBe("track");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("検索語の記号（& = # % + ? /）・日本語・絵文字は q にそのまま入り、ほかのパラメータに漏れない", async () => {
    const query = "AC/DC & Queen #1 100% a+b=c ?x=y 日本語 🎵";

    await api.searchSpotify(query);

    const { url } = requestAt(0);
    expect(url.searchParams.get("q")).toBe(query);
    expect([...url.searchParams.keys()]).toEqual(["q", "type", "limit"]);
    expect(url.searchParams.get("type")).toBe("track");
    expect(url.hash).toBe("");
  });

  // テスト名に "$type・limit" と書くと「・」まで変数名と読まれるので、区切りは半角のカンマにしている
  it.each([
    { type: "track,artist", limit: 1 },
    { type: "album", limit: 50 },
  ])("type=$type, limit=$limit を渡すと、その値で検索する（カンマ区切りの複数 type、limit の端）", async ({ type, limit }) => {
    await api.searchSpotify("beatles", type, limit);

    const { url } = requestAt(0);
    expect(url.searchParams.get("type")).toBe(type);
    expect(url.searchParams.get("limit")).toBe(String(limit));
  });
});

describe("addTracksToPlaylist", () => {
  it("POST で { uris } を送る（ローカル曲の URI の記号も崩れない）", async () => {
    const uris = ["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:local:Artist+Name:Album:Title+%28Live%29:240"];

    await api.addTracksToPlaylist("pl1", uris);

    expect(requestAt(0).jsonBody()).toStrictEqual({ uris });
  });

  it("1回で送れる上限の 100 件は、分けずに1回で送る（境目）", async () => {
    const uris = Array.from({ length: 100 }, (_, i) => `spotify:track:t${i}`);

    await api.addTracksToPlaylist("pl1", uris);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAt(0).jsonBody()).toStrictEqual({ uris });
  });
});

describe("reorderPlaylistTracks", () => {
  it("PUT で range_start・insert_before と range_length=1 を送る", async () => {
    await api.reorderPlaylistTracks("pl1", 3, 1);

    expect(requestAt(0).jsonBody()).toStrictEqual({ range_start: 3, insert_before: 1, range_length: 1 });
  });

  it.each([
    { label: "先頭の曲を動かす", rangeStart: 0, insertBefore: 3 },
    { label: "先頭へ動かす", rangeStart: 5, insertBefore: 0 },
  ])("$label（range_start=$rangeStart, insert_before=$insertBefore）ときも 0 を落とさずに送る（境目）", async ({ rangeStart, insertBefore }) => {
    await api.reorderPlaylistTracks("pl1", rangeStart, insertBefore);

    expect(requestAt(0).jsonBody()).toStrictEqual({ range_start: rangeStart, insert_before: insertBefore, range_length: 1 });
  });
});

describe("updatePlaylist", () => {
  it("PUT で渡した項目を送り、undefined の項目は送らない", async () => {
    await api.updatePlaylist("pl1", { name: "新しい名前", description: undefined, public: true });

    expect(requestAt(0).jsonBody()).toStrictEqual({ name: "新しい名前", public: true });
  });

  it('public: false・description: "" のような偽の値も落とさずに送る（境目）', async () => {
    await api.updatePlaylist("pl1", { public: false, description: "" });

    expect(requestAt(0).jsonBody()).toStrictEqual({ public: false, description: "" });
  });

  it("名前の引用符・バックスラッシュ・改行・絵文字も崩さずに送る", async () => {
    const name = 'He said "hi" \\ \n🎵 日本語';

    await api.updatePlaylist("pl1", { name });

    expect(requestAt(0).jsonBody()).toStrictEqual({ name });
  });
});

describe("createPlaylist", () => {
  it("POST で name・description・public を送る", async () => {
    await api.createPlaylist("user1", { name: "ドライブ用", description: "週末に聴く", public: true });

    expect(requestAt(0).jsonBody()).toStrictEqual({ name: "ドライブ用", description: "週末に聴く", public: true });
  });

  it.each([
    { given: undefined, sent: false },
    { given: false, sent: false },
    { given: true, sent: true },
  ])("public が $given のときは public: $sent で送る（省くと非公開）", async ({ given, sent }) => {
    await api.createPlaylist("user1", { name: "n", public: given });

    expect(requestAt(0).jsonBody()).toMatchObject({ public: sent });
  });

  it("description を省くと、本文に description を入れない", async () => {
    await api.createPlaylist("user1", { name: "n" });

    expect(requestAt(0).jsonBody()).toStrictEqual({ name: "n", public: false });
  });

  it("userId の記号（. + @ / ?）は、パスの1区画に収まるようにエンコードする", async () => {
    const userId = "user.name+tag@example/x?y";

    await api.createPlaylist(userId, { name: "n" });

    const { url } = requestAt(0);
    const segments = pathSegments(url); // api / spotify / users / {userId} / playlists
    expect(segments).toHaveLength(5);
    expect(decodeURIComponent(segments[3])).toBe(userId);
    expect(segments[4]).toBe("playlists");
    expect(url.search).toBe("");
  });
});

// ここから下は「本来の動き」を書いたテスト。今のコードとは食い違うので、既定では skip。
// RUN_KNOWN_ISSUES=1 を付けて実行すると走り、今のコードでは失敗する。直したら skip を外す。
describe("既知の食い違い（本来の動きを書いたもの。既定では skip）", () => {
  const EXPRESS_404_HTML =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n' +
    "<body>\n<pre>Cannot DELETE /api/spotify/playlists/pl1/followers</pre>\n</body>\n</html>\n";

  // api.ts は response.json() に失敗したら response.text() で本文を読み直すつもりだが、
  // 本文は json() で読み終わっているので text() も失敗し、TypeError（Body is unusable）になる。
  knownIssue.each([
    { label: "text/plain の 500", status: 500, body: "Internal Server Error", contentType: "text/plain; charset=utf-8", expected: "Internal Server Error" },
    { label: "Express 既定の 404 の HTML", status: 404, body: EXPRESS_404_HTML, contentType: "text/html; charset=utf-8", expected: "Cannot DELETE" },
    { label: "プロキシの 502", status: 502, body: "Bad Gateway", contentType: "text/plain", expected: "Bad Gateway" },
  ])("JSON でないエラー本文（$label）は、本文を文言にして「<status> …」の Error で reject する", async ({ status, body, contentType, expected }) => {
    fetchMock.mockResolvedValueOnce(textResponse(body, status, contentType));

    const error = await rejectionOf(api.deletePlaylist("pl1"));

    expect(error.message).toMatch(new RegExp(`^${status} `));
    expect(error.message).toContain(expected);
  });

  // backend/src/server.js の DELETE /api/spotify/playlists/:id/tracks は req.body.uris を読み、
  // 無ければ 400「uris array is required」を返す。api.ts は { tracks: [{ uri }] } を送っている。
  knownIssue("removeTracksFromPlaylist は、バックエンドの受け口に合わせて { uris } を送る", async () => {
    const uris = ["spotify:track:a", "spotify:track:b"];

    await api.removeTracksFromPlaylist("pl1", uris);

    expect(requestAt(0).jsonBody()).toStrictEqual({ uris });
  });

  knownIssue("error が文字列でない（Spotify 形式の { error: { status, message } }）ときも、中身の文言が分かる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { status: 401, message: "The access token expired" } }, 401));

    const error = await rejectionOf(api.getCurrentUser());

    expect(error.message).not.toContain("[object Object]");
    expect(error.message).toContain("The access token expired");
  });
});
