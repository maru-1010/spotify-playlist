// テスト用の共通部品（テストデータの作成・「応答待ち」を作る Promise など）
// 型だけを読み込むので、api.ts の実体（通信処理）は読み込まない。
import type { Paging, SpotifyPlaylist, SpotifyPlaylistItem, SpotifyTrack } from "../../api";

/** 曲を1件作る。key から id・曲名・URI などを決める（例: "A" → 曲名 "Song A"） */
export function makeTrack(key: string | number, overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  const id = `track-${key}`;
  return {
    id,
    name: `Song ${key}`,
    uri: `spotify:track:${id}`,
    preview_url: null,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    artists: [{ id: `artist-${key}`, name: `Artist ${key}` }],
    album: { id: `album-${key}`, name: `Album ${key}`, images: [] },
    ...overrides,
  };
}

/** 1 から count までの番号で、曲を count 件作る */
export function makeTracks(count: number): SpotifyTrack[] {
  return Array.from({ length: count }, (_, i) => makeTrack(i + 1));
}

/** プレイリストを1件作る */
export function makePlaylist(overrides: Partial<SpotifyPlaylist> = {}): SpotifyPlaylist {
  return {
    id: "playlist-1",
    name: "テスト用プレイリスト",
    public: false,
    tracks: { total: 0 },
    images: [],
    owner: { id: "user-1" },
    ...overrides,
  };
}

/** searchSpotify の応答の形（{ tracks: { items } }）にする */
export function searchResponse(tracks: SpotifyTrack[]) {
  return { tracks: { items: tracks } };
}

/** fetchPlaylistItems の応答の形（Paging）にする。null はローカルファイル等で曲情報が無い項目 */
export function playlistItemsPage(tracks: (SpotifyTrack | null)[]): Paging<SpotifyPlaylistItem> {
  return {
    items: tracks.map((track) => ({ track })),
    total: tracks.length,
    next: null,
    previous: null,
    limit: 100,
    offset: 0,
  };
}

/** 外から成功・失敗させられる Promise（API の「応答待ち」の状態を作るため） */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 配列を size 件ずつに区切る（期待値の組み立て用） */
export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/** 要素から親へたどり、ボタンを含む最初の要素（＝1曲分の行）を返す */
export function rowOf(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element;
  while (current && !current.querySelector("button")) {
    current = current.parentElement;
  }
  if (!current) throw new Error("曲の行が見つかりません");
  return current;
}

/** 要素の親要素を返す（見出しから、その見出しを含む区画を取り出すため） */
export function parentOf(element: HTMLElement): HTMLElement {
  const parent = element.parentElement;
  if (!parent) throw new Error("親要素が見つかりません");
  return parent;
}
