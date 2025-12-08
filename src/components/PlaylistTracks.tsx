import { useEffect, useState } from "react";
import { fetchPlaylistItems, deletePlaylist, type SpotifyPlaylistItem, type SpotifyPlaylist } from "../api";
import EditPlaylistModal from "./EditPlaylistModal";

type Props = {
  playlistId: string;
  playlist: SpotifyPlaylist;
  onPlaylistDeleted: () => void;
  onPlaylistUpdated: () => void;
};

export default function PlaylistTracks({ playlistId, playlist, onPlaylistDeleted, onPlaylistUpdated }: Props) {
  const [tracks, setTracks] = useState<SpotifyPlaylistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    
    fetchPlaylistItems(playlistId)
      .then(data => {
        setTracks(data.items);
        setLoading(false);
      })
      .catch(err => {
        setError(String(err));
        setLoading(false);
      });
  }, [playlistId]);

  // プレイリスト削除
  const handleDeletePlaylist = async () => {
    if (!confirm(`プレイリスト「${playlist.name}」を削除しますか？この操作は取り消せません。`)) {
      return;
    }

    setIsDeleting(true);
    try {
      await deletePlaylist(playlistId);
      alert(`プレイリスト「${playlist.name}」を削除しました`);
      onPlaylistDeleted();
    } catch (error) {
      console.error("プレイリスト削除エラー:", error);
      alert("プレイリストの削除に失敗しました");
    } finally {
      setIsDeleting(false);
    }
  };

  if (loading) return <div style={{ padding: 8 }}>トラックを読み込み中...</div>;
  if (error) return <div style={{ padding: 8, color: 'red' }}>エラー: {error}</div>;

  return (
    <div style={{ marginTop: 12, paddingLeft: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h4>トラック一覧</h4>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setIsEditModalOpen(true)}
            style={{
              padding: "6px 12px",
              backgroundColor: "#007bff",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12
            }}
          >
            編集
          </button>
          <button
            onClick={handleDeletePlaylist}
            disabled={isDeleting}
            style={{
              padding: "6px 12px",
              backgroundColor: "#dc3545",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: isDeleting ? "not-allowed" : "pointer",
              fontSize: 12,
              opacity: isDeleting ? 0.6 : 1
            }}
          >
            {isDeleting ? "削除中..." : "削除"}
          </button>
        </div>
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tracks.map((item, index) => {
          if (!item.track) return null;
          
          const track = item.track;
          const albumImage = track.album.images[0]?.url;
          const artistNames = track.artists.map(a => a.name).join(', ');
          
          return (
            <li key={`${track.id}-${index}`} style={{ 
              display: 'flex', 
              alignItems: 'center', 
              padding: 8, 
              borderBottom: '1px solid #eee' 
            }}>
              {albumImage && (
                <img 
                  src={albumImage} 
                  alt={track.album.name}
                  style={{ 
                    width: 50, 
                    height: 50, 
                    marginRight: 12, 
                    borderRadius: 4 
                  }}
                />
              )}
              
              <div style={{ flex: 1 }}>
                <div>
                  <a 
                    href={track.external_urls.spotify}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ 
                      textDecoration: 'none', 
                      color: '#1db954',
                      fontWeight: 'bold'
                    }}
                  >
                    {track.name}
                  </a>
                </div>
                
                <div style={{ fontSize: 12, color: '#666' }}>
                  {artistNames}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* 編集モーダル */}
      <EditPlaylistModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        onPlaylistUpdated={onPlaylistUpdated}
        playlist={playlist}
      />
    </div>
  );
}