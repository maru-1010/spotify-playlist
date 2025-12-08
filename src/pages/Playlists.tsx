import { useEffect, useState } from "react";
import { fetchMyPlaylists, type SpotifyPlaylist } from "../api";
import PlaylistTracks from "../components/PlaylistTracks";
import CreatePlaylistModal from "../components/CreatePlaylistModal"; 

console.log(">>> Playlists mounted");

type Data = Awaited<ReturnType<typeof fetchMyPlaylists>>;

export default function Playlists() {
 // console.log("Playlists mounted");
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // 展開状態を管理するstate追加
  const [expandedPlaylist, setExpandedPlaylist] = useState<string | null>(null);
  // モーダル表示状態を管理するstate追加
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

// プレイリストクリック時のハンドラー
  const handlePlaylistClick = (playlistId: string) => {
    setExpandedPlaylist(prev => prev === playlistId ? null : playlistId);
  };

  // プレイリスト作成後のハンドラー
  const handlePlaylistCreated = () => {
    // プレイリスト一覧を再読み込み
    setErr(null);
    setData(null);
    fetchMyPlaylists(20, page * 20)
      .then(setData)
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    setErr(null);
    setData(null);
    console.log(">>> useEffect fire, page =", page);
    fetchMyPlaylists(20, page * 20)
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [page]);

  if (err) {
    return (
      <div style={{ padding: 16, color: "#b00" }}>
        <h3>プレイリストの取得に失敗しました</h3>
        <pre style={{ whiteSpace: "pre-wrap" }}>{err}</pre>
        <button onClick={() => location.reload()}>再読み込み</button>
      </div>
    );
  }

  if (!data) return <p style={{ padding: 16 }}>Loading playlists...</p>;

  if (!data.items || data.items.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <h2>My Playlists</h2>
        <p>プレイリストが見つかりませんでした。</p>
        <p>ヒント: スコープ <code>playlist-read-private</code> を付けて再ログインしてね。</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginBottom: 8 }}>My Playlists</h2>
      <ul style={{ display: "grid", gap: 8, listStyle: "none", padding: 0 }}>
        {data.items.map((p: SpotifyPlaylist) => (
          <li key={p.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <div 
              onClick={() => handlePlaylistClick(p.id)}
              style={{ 
                cursor: 'pointer', 
                fontWeight: 'bold',
                color: '#1db954'
              }}
            >
              {p.name}
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {p.tracks?.total ?? 0} tracks • {p.public ? "Public" : "Private"}
            </div>
            
            {/* 展開時にトラック一覧を表示 */}
            {expandedPlaylist === p.id && (
              <PlaylistTracks 
                playlistId={p.id} 
                playlist={p}
                onPlaylistDeleted={handlePlaylistCreated}
                onPlaylistUpdated={handlePlaylistCreated}
              />
            )}
          </li>
        ))}
      </ul>

      {/* プレイリスト作成ボタン */}
      <div style={{ marginTop: 20, textAlign: "center" }}>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          style={{
            padding: "12px 24px",
            backgroundColor: "#1db954",
            color: "white",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 16,
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "0 auto"
          }}
        >
          ＋ 作成
        </button>
      </div>
  
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button disabled={!data.previous} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</button>
        <button disabled={!data.next} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      {/* プレイリスト作成モーダル */}
      <CreatePlaylistModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onPlaylistCreated={handlePlaylistCreated}
      />
    </div>
  );
}
