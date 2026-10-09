// src/api.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  fetchMyPlaylists,
  fetchPlaylistItems,
  getCurrentUser,
  removeTracksFromPlaylist,
  reorderPlaylistTracks,
  searchSpotify,
  updatePlaylist,
  type Paging,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
  type SpotifyTrack,
  type SpotifyUser,
} from "./api";

// API_BASE_URL は src/api.ts の読み込み時に決まるため、vi.hoisted で import より先に環境変数を固定する。
// （開発者の .env.local などに VITE_API_BASE_URL があってもテスト結果が変わらないように）
const BASE_URL = vi.hoisted(() => {
  const url = "http://api.test";
  vi.stubEnv("VITE_API_BASE_URL", url);
  return url;
});

const SESSION_ID = "session-123";

// 外部への通信はすべてこのモックで受ける（実際のネットワークには出ない）
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // ログイン済みの状態（handleCallback が保存する形）にしておく
  saveToken({
    session_id: SESSION_ID,
    access_token: "dummy-access-token",
    refresh_token: null,
    expires_at: Date.now() + 60 * 60 * 1000,
  });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function saveToken(token: object) {
  localStorage.setItem("spotify_token", JSON.stringify(token));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch がちょうど 1 回呼ばれたことを確かめ、渡された URL と RequestInit を返す */
function sentRequest() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init = {}] = fetchMock.mock.calls[0];
  return { url: String(input), init };
}

function paging<T>(items: T[], limit: number, offset = 0): Paging<T> {
  return { items, total: items.length, next: null, previous: null, limit, offset };
}

const playlist: SpotifyPlaylist = {
  id: "playlist-1",
  name: "お気に入り",
  public: false,
  tracks: { total: 1 },
  images: [],
  owner: { id: "user-1", display_name: "テストユーザー" },
};

const track: SpotifyTrack = {
  id: "track-1",
  name: "テスト曲",
  uri: "spotify:track:track-1",
  preview_url: null,
  external_urls: { spotify: "https://open.spotify.com/track/track-1" },
  artists: [{ id: "artist-1", name: "テストアーティスト" }],
  album: { id: "album-1", name: "テストアルバム", images: [] },
};

const playlistItem: SpotifyPlaylistItem = { track };

describe("共通処理", () => {
  describe("リクエストヘッダー", () => {
    it.each([
      { label: "GET", call: () => getCurrentUser() },
      { label: "POST（ボディあり）", call: () => addTracksToPlaylist("playlist-1", [track.uri]) },
    ])("$label でも x-session-id と Content-Type を付ける", async ({ call }) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await call();

      expect(sentRequest().init.headers).toEqual({
        "Content-Type": "application/json",
        "x-session-id": SESSION_ID,
      });
    });
  });

  describe("セッション ID が取れないときは通信せずに失敗する", () => {
    it("spotify_token が無ければ 'token not found'", async () => {
      localStorage.removeItem("spotify_token");

      await expect(getCurrentUser()).rejects.toThrow(new Error("token not found"));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("spotify_token に session_id が無ければ再ログインを促すエラー", async () => {
      // バックエンド経由になる前の形式（session_id を持たない）が残っている場合
      saveToken({ access_token: "old-access-token", refresh_token: null, expires_at: Date.now() });

      await expect(getCurrentUser()).rejects.toThrow(
        new Error("session_id not found. Please login again."),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("spotify_token が JSON として壊れていれば SyntaxError", async () => {
      localStorage.setItem("spotify_token", "{not json");

      await expect(getCurrentUser()).rejects.toThrow(SyntaxError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("成功レスポンス", () => {
    it("204 No Content なら空オブジェクトを返す", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(deletePlaylist("playlist-1")).resolves.toEqual({});
    });
  });

  describe("エラーレスポンス", () => {
    let consoleError: MockInstance<typeof console.error>;

    beforeEach(() => {
      // apiRequest が出すエラーログを抑止しつつ、呼び出し内容を検証できるようにする
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("エラー JSON の error を使って「ステータス メッセージ」の Error を投げ、console.error に記録する", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Session not found" }, 500));

      await expect(getCurrentUser()).rejects.toThrow(new Error("500 Session not found"));
      expect(consoleError).toHaveBeenCalledWith(
        "[API Error] /api/spotify/me:",
        500,
        "Session not found",
      );
    });

    it("エラー JSON に error が無ければ 'Request failed: ステータス' をメッセージにする", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Internal Server Error" }, 500));

      await expect(getCurrentUser()).rejects.toThrow(new Error("500 Request failed: 500"));
    });

    it("エラー本文が JSON でなければ TypeError になる（【既知の不具合】本文を二度読んでいる）", async () => {
      // apiRequest は response.json() に失敗したら response.text() で本文を取り直すつもりだが、
      // json() の時点で本文は読み取り済みのため、実際の Response では text() が TypeError を投げる（ブラウザでも同じ）。
      // Express の 404（HTML）やプロキシの 502 など、JSON でないエラー本文で起こる。
      // 意図どおりなら "502 Bad Gateway" の Error になるはず。直したらこのテストも書き換えること。
      fetchMock.mockResolvedValueOnce(
        new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } }),
      );

      await expect(getCurrentUser()).rejects.toThrow(TypeError);
    });

    it("通信自体に失敗したら fetch のエラーをそのまま投げる", async () => {
      const networkError = new TypeError("Failed to fetch");
      fetchMock.mockRejectedValueOnce(networkError);

      await expect(getCurrentUser()).rejects.toBe(networkError);
    });
  });

  describe("API のベース URL", () => {
    it("VITE_API_BASE_URL が設定されていればその URL に送る", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await getCurrentUser();

      expect(sentRequest().url).toBe(`${BASE_URL}/api/spotify/me`);
    });

    it("VITE_API_BASE_URL が未設定なら http://localhost:3001 に送る", async () => {
      vi.stubEnv("VITE_API_BASE_URL", undefined);
      vi.resetModules();
      const api = await import("./api");
      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await api.getCurrentUser();

      expect(sentRequest().url).toBe("http://localhost:3001/api/spotify/me");
    });
  });
});

describe("fetchMyPlaylists", () => {
  it("既定では limit=20, offset=0 で GET し、レスポンスをそのまま返す", async () => {
    const response = paging([playlist], 20);
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(fetchMyPlaylists()).resolves.toEqual(response);

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/me/playlists?limit=20&offset=0`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("limit と offset を指定できる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(paging([], 50, 100)));

    await fetchMyPlaylists(50, 100);

    expect(sentRequest().url).toBe(`${BASE_URL}/api/spotify/me/playlists?limit=50&offset=100`);
  });
});

describe("fetchPlaylistItems", () => {
  it("既定では limit=100, offset=0 で、必要な項目だけを fields に指定して GET する", async () => {
    const response = paging([playlistItem], 100);
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(fetchPlaylistItems("playlist-1")).resolves.toEqual(response);

    const { url, init } = sentRequest();
    const requested = new URL(url);
    expect(`${requested.origin}${requested.pathname}`).toBe(
      `${BASE_URL}/api/spotify/playlists/playlist-1/tracks`,
    );
    expect(requested.searchParams.get("limit")).toBe("100");
    expect(requested.searchParams.get("offset")).toBe("0");
    expect(requested.searchParams.get("fields")).toBe(
      "items(added_at,is_local,track(id,name,uri,preview_url,external_urls,artists(id,name),album(id,name,images)))" +
        ",total,next,previous,limit,offset",
    );
    expect(init.method ?? "GET").toBe("GET");
  });

  it("limit と offset を指定できる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(paging([], 50, 200)));

    await fetchPlaylistItems("playlist-1", 50, 200);

    const requested = new URL(sentRequest().url);
    expect(requested.searchParams.get("limit")).toBe("50");
    expect(requested.searchParams.get("offset")).toBe("200");
  });
});

describe("searchSpotify", () => {
  it("既定では type=track, limit=20 で検索し、検索語は URL エンコードする", async () => {
    const response = { tracks: paging([track], 20) };
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(searchSpotify("rock & roll")).resolves.toEqual(response);

    // "&" がクエリの区切りとして解釈されないこと
    expect(sentRequest().url).toBe(
      `${BASE_URL}/api/spotify/search?q=rock%20%26%20roll&type=track&limit=20`,
    );
  });

  it("type と limit を指定できる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ artists: paging([], 5) }));

    await searchSpotify("ジャズ", "artist", 5);

    const requested = new URL(sentRequest().url);
    expect(requested.searchParams.get("q")).toBe("ジャズ");
    expect(requested.searchParams.get("type")).toBe("artist");
    expect(requested.searchParams.get("limit")).toBe("5");
  });
});

describe("addTracksToPlaylist", () => {
  it("POST で { uris } を送り、レスポンスを返す", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ snapshot_id: "snapshot-1" }));

    await expect(
      addTracksToPlaylist("playlist-1", ["spotify:track:track-1", "spotify:track:track-2"]),
    ).resolves.toEqual({ snapshot_id: "snapshot-1" });

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/playlists/playlist-1/tracks`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      uris: ["spotify:track:track-1", "spotify:track:track-2"],
    });
  });
});

describe("removeTracksFromPlaylist", () => {
  it("DELETE で { tracks: [{ uri }] } を送る（【既知の不具合】バックエンドは { uris } を期待している）", async () => {
    // backend/src/server.js の DELETE /api/spotify/playlists/:id/tracks は req.body.uris（文字列の配列）を読み、
    // 無ければ 400 "uris array is required" を返すため、この形式のままでは実際の削除は失敗する。
    // ここでは src/api.ts が現在送っている形式を記録している。直したらこのテストも書き換えること。
    fetchMock.mockResolvedValueOnce(jsonResponse({ snapshot_id: "snapshot-2" }));

    await expect(
      removeTracksFromPlaylist("playlist-1", ["spotify:track:track-1", "spotify:track:track-2"]),
    ).resolves.toEqual({ snapshot_id: "snapshot-2" });

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/playlists/playlist-1/tracks`);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({
      tracks: [{ uri: "spotify:track:track-1" }, { uri: "spotify:track:track-2" }],
    });
  });
});

describe("reorderPlaylistTracks", () => {
  it("PUT で range_start・insert_before と、1 曲分の range_length を送る", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ snapshot_id: "snapshot-3" }));

    // 先頭の曲（0）を動かす場合も range_start が欠けないこと
    await reorderPlaylistTracks("playlist-1", 0, 3);

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/playlists/playlist-1/tracks`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      range_start: 0,
      insert_before: 3,
      range_length: 1,
    });
  });
});

describe("updatePlaylist", () => {
  it("PUT で渡した項目だけを送る", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(
      updatePlaylist("playlist-1", { name: "新しい名前", public: true }),
    ).resolves.toEqual({});

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/playlists/playlist-1`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ name: "新しい名前", public: true });
  });
});

describe("deletePlaylist", () => {
  it("DELETE で /followers を呼び、ボディは送らない", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(deletePlaylist("playlist-1")).resolves.toEqual({});

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/playlists/playlist-1/followers`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("getCurrentUser", () => {
  it("ログイン中のユーザー情報を GET して返す", async () => {
    const user: SpotifyUser = {
      id: "user-1",
      display_name: "テストユーザー",
      email: "user@example.com",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(user));

    await expect(getCurrentUser()).resolves.toEqual(user);

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/me`);
    expect(init.method ?? "GET").toBe("GET");
  });
});

describe("createPlaylist", () => {
  it("POST で name・description・public を送り、作成されたプレイリストを返す", async () => {
    const created: SpotifyPlaylist = { ...playlist, id: "playlist-new", name: "ドライブ用", public: true };
    fetchMock.mockResolvedValueOnce(jsonResponse(created));

    await expect(
      createPlaylist("user-1", { name: "ドライブ用", description: "週末に聴く曲", public: true }),
    ).resolves.toEqual(created);

    const { url, init } = sentRequest();
    expect(url).toBe(`${BASE_URL}/api/spotify/users/user-1/playlists`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "ドライブ用",
      description: "週末に聴く曲",
      public: true,
    });
  });

  it("public を省略すると非公開（public: false）で作成する", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(playlist));

    await createPlaylist("user-1", { name: "お気に入り" });

    expect(JSON.parse(String(sentRequest().init.body))).toEqual({
      name: "お気に入り",
      public: false,
    });
  });
});

describe("パスに埋め込む ID の URL エンコード", () => {
  // "/" "?" "#" を含む ID でも、別のパス・クエリ・フラグメントとして解釈されないこと
  const id = "a/b?c#d";
  const encoded = "a%2Fb%3Fc%23d";

  it.each([
    {
      fn: "fetchPlaylistItems",
      call: () => fetchPlaylistItems(id),
      path: `/api/spotify/playlists/${encoded}/tracks`,
    },
    {
      fn: "addTracksToPlaylist",
      call: () => addTracksToPlaylist(id, [track.uri]),
      path: `/api/spotify/playlists/${encoded}/tracks`,
    },
    {
      fn: "removeTracksFromPlaylist",
      call: () => removeTracksFromPlaylist(id, [track.uri]),
      path: `/api/spotify/playlists/${encoded}/tracks`,
    },
    {
      fn: "reorderPlaylistTracks",
      call: () => reorderPlaylistTracks(id, 0, 1),
      path: `/api/spotify/playlists/${encoded}/tracks`,
    },
    {
      fn: "updatePlaylist",
      call: () => updatePlaylist(id, { name: "新しい名前" }),
      path: `/api/spotify/playlists/${encoded}`,
    },
    {
      fn: "deletePlaylist",
      call: () => deletePlaylist(id),
      path: `/api/spotify/playlists/${encoded}/followers`,
    },
    {
      fn: "createPlaylist（ユーザー ID）",
      call: () => createPlaylist(id, { name: "お気に入り" }),
      path: `/api/spotify/users/${encoded}/playlists`,
    },
  ])("$fn", async ({ call, path }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await call();

    expect(new URL(sentRequest().url).pathname).toBe(path);
  });
});
