// src/api.ts

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export type SpotifyImage = { url: string; height?: number; width?: number };
export type SpotifyOwner = { id: string; display_name?: string };

export type SpotifyUser = {
  id: string;
  display_name?: string;
  email?: string;
  images?: SpotifyImage[];
  external_urls?: { spotify?: string };
};

export type SpotifyPlaylist = {
  id: string;
  name: string;
  public: boolean;
  tracks: { total: number };
  images: SpotifyImage[];
  owner: SpotifyOwner;
  external_urls?: { spotify?: string };
};

export type SpotifyTrack = {
  id: string;
  name: string;
  uri: string;
  preview_url: string | null;
  external_urls: { spotify: string };
  artists: { id: string; name: string }[];
  album: { id: string; name: string; images: { url: string; width: number; height: number }[]; };
};

export type SpotifyPlaylistItem = {
  track: SpotifyTrack | null; // local tracksの可能性もあるのでnull許容
}

export type Paging<T> = {
  items: T[];
  total: number;
  next: string | null;
  previous: string | null;
  limit: number;
  offset: number;
};

// セッションIDを取得するヘルパー関数
function getSessionId(): string {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  
  const tokenData = JSON.parse(saved);
  if (!tokenData.session_id) {
    throw new Error("session_id not found. Please login again.");
  }
  
  return tokenData.session_id;
}

// バックエンドAPI呼び出しの共通ヘルパー
async function apiRequest(endpoint: string, options: RequestInit = {}) {
  const sessionId = getSessionId();
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      ...options.headers,
    },
  });

  if (!response.ok) {
    let errorMessage = `Request failed: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error || errorMessage;
    } catch {
      // JSONパースに失敗した場合はテキストとして取得
      errorMessage = await response.text() || errorMessage;
    }
    console.error(`[API Error] ${endpoint}:`, response.status, errorMessage);
    throw new Error(`${response.status} ${errorMessage}`);
  }

  // 204 No Content の場合は空オブジェクトを返す
  if (response.status === 204) {
    return {};
  }

  return response.json();
}

export async function fetchMyPlaylists(
  limit = 20,
  offset = 0
): Promise<Paging<SpotifyPlaylist>> {
  return apiRequest(`/api/spotify/me/playlists?limit=${limit}&offset=${offset}`);
}

export async function fetchPlaylistItems(
  playlistId: string, 
  limit = 100,
  offset = 0): Promise<Paging<SpotifyPlaylistItem>> {
  // fields を指定して必要十分な情報だけ取得（軽量化）
  const fields =
    "items(added_at,is_local,track(id,name,uri,preview_url,external_urls,artists(id,name),album(id,name,images)))" +
    ",total,next,previous,limit,offset";
  
  return apiRequest(
    `/api/spotify/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`
  );
}

// 楽曲検索
export async function searchSpotify(query: string, type = "track", limit = 20) {
  return apiRequest(`/api/spotify/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
}

// プレイリストにトラックを追加
export async function addTracksToPlaylist(playlistId: string, uris: string[]) {
  return apiRequest(`/api/spotify/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: 'POST',
    body: JSON.stringify({ uris }),
  });
}

// プレイリストからトラックを削除
export async function removeTracksFromPlaylist(playlistId: string, uris: string[]) {
  return apiRequest(`/api/spotify/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: 'DELETE',
    body: JSON.stringify({
      tracks: uris.map(uri => ({ uri })),
    }),
  });
}

// プレイリスト内のトラックを並び替え
export async function reorderPlaylistTracks(
  playlistId: string, 
  rangeStart: number, 
  insertBefore: number
) {
  return apiRequest(`/api/spotify/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: 'PUT',
    body: JSON.stringify({
      range_start: rangeStart,
      insert_before: insertBefore,
      range_length: 1,
    }),
  });
}

// プレイリスト情報を更新
export async function updatePlaylist(
  playlistId: string, 
  data: { name?: string; description?: string; public?: boolean }
) {
  return apiRequest(`/api/spotify/playlists/${encodeURIComponent(playlistId)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// プレイリストを削除（フォロー解除）
export async function deletePlaylist(playlistId: string) {
  return apiRequest(`/api/spotify/playlists/${encodeURIComponent(playlistId)}/followers`, {
    method: 'DELETE',
  });
}

// 現在のユーザー情報を取得
export async function getCurrentUser(): Promise<SpotifyUser> {
  return apiRequest('/api/spotify/me');
}

// プレイリストを作成
export async function createPlaylist(
  userId: string,
  data: { name: string; description?: string; public?: boolean }
): Promise<SpotifyPlaylist> {
  return apiRequest(`/api/spotify/users/${encodeURIComponent(userId)}/playlists`, {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      description: data.description,
      public: data.public ?? false,
    }),
  });
}
