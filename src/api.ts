// src/api.ts

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

export async function fetchMyPlaylists(
  limit = 20,
  offset = 0
): Promise<Paging<SpotifyPlaylist>> {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");

  const { access_token } = JSON.parse(saved);

  const res = await fetch(
    `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`,
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error("[/me/playlists error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }

  return res.json();
}

export async function fetchPlaylistItems(
  playlistId: string, 
  limit = 100,
  offset = 0): Promise<Paging<SpotifyPlaylistItem>> {
    const saved = localStorage.getItem("spotify_token");
    if (!saved) throw new Error("token not found");
    const { access_token } = JSON.parse(saved);
  
    // fields を指定して必要十分な情報だけ取得（軽量化）
    const fields =
      "items(added_at,is_local,track(id,name,uri,preview_url,external_urls,artists(id,name),album(id,name,images)))" +
      ",total,next,previous,limit,offset";
  
    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
      playlistId
    )}/tracks?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`;
  
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  
    if (!res.ok) {
      const text = await res.text();
      console.error("[/playlists/:id/tracks error]", res.status, text);
      throw new Error(`${res.status} ${text}`);
    }
    return res.json();
}

// 楽曲検索
export async function searchSpotify(query: string, type = "track", limit = 20) {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/search error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

// プレイリストにトラックを追加
export async function addTracksToPlaylist(playlistId: string, uris: string[]) {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ uris })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/playlists/:id/tracks POST error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

// プレイリストからトラックを削除
export async function removeTracksFromPlaylist(playlistId: string, uris: string[]) {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tracks: uris.map(uri => ({ uri }))
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/playlists/:id/tracks DELETE error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

// プレイリスト内のトラックを並び替え
export async function reorderPlaylistTracks(
  playlistId: string, 
  rangeStart: number, 
  insertBefore: number
) {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      range_start: rangeStart,
      insert_before: insertBefore,
      range_length: 1
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/playlists/:id/tracks PUT error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

// プレイリスト情報を更新
export async function updatePlaylist(
  playlistId: string, 
  data: { name?: string; description?: string; public?: boolean }
) {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/playlists/:id PUT error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  // 204 No Content の場合もあるので、空レスポンスを許容
  if (res.status === 204) return {};
  return res.json();
}

// プレイリストを削除（フォロー解除）
export async function deletePlaylist(playlistId: string) {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/followers`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${access_token}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/playlists/:id/followers DELETE error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  // 200 OK または 204 No Content
  if (res.status === 204 || res.status === 200) return {};
  return res.json();
}

// 現在のユーザー情報を取得
export async function getCurrentUser(): Promise<SpotifyUser> {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/me`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/me error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

// プレイリストを作成
export async function createPlaylist(
  userId: string,
  data: { name: string; description?: string; public?: boolean }
): Promise<SpotifyPlaylist> {
  const saved = localStorage.getItem("spotify_token");
  if (!saved) throw new Error("token not found");
  const { access_token } = JSON.parse(saved);

  const url = `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: data.name,
      description: data.description,
      public: data.public ?? false
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[/users/:id/playlists POST error]", res.status, text);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}
