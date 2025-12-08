import { useState, useEffect } from "react";
import { 
  fetchPlaylistItems, 
  searchSpotify, 
  addTracksToPlaylist, 
  removeTracksFromPlaylist,
  reorderPlaylistTracks,
  updatePlaylist,
  type SpotifyPlaylistItem, 
  type SpotifyTrack,
  type SpotifyPlaylist
} from "../api";

interface EditPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlaylistUpdated: () => void;
  playlist: SpotifyPlaylist;
}

export default function EditPlaylistModal({ isOpen, onClose, onPlaylistUpdated, playlist }: EditPlaylistModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [tracks, setTracks] = useState<SpotifyPlaylistItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SpotifyTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // モーダルが開かれた時にプレイリスト情報とトラックを読み込み
  useEffect(() => {
    if (isOpen && playlist) {
      setTitle(playlist.name);
      setDescription(""); // プレイリストの説明は別途取得が必要
      setIsPublic(playlist.public);
      
      setIsLoading(true);
      fetchPlaylistItems(playlist.id)
        .then(data => {
          setTracks(data.items);
          setIsLoading(false);
        })
        .catch(err => {
          console.error("トラック読み込みエラー:", err);
          setIsLoading(false);
        });
    }
  }, [isOpen, playlist]);

  // 検索実行
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    try {
      const results = await searchSpotify(searchQuery);
      setSearchResults(results.tracks.items);
    } catch (error) {
      console.error("検索エラー:", error);
      alert("検索に失敗しました");
    } finally {
      setIsSearching(false);
    }
  };

  // トラックを追加
  const addTrack = async (track: SpotifyTrack) => {
    try {
      await addTracksToPlaylist(playlist.id, [track.uri]);
      
      // ローカル状態を更新
      const newItem: SpotifyPlaylistItem = {
        track: track
      };
      setTracks([...tracks, newItem]);
      
      alert(`「${track.name}」を追加しました`);
    } catch (error) {
      console.error("トラック追加エラー:", error);
      alert("トラックの追加に失敗しました");
    }
  };

  // トラックを削除
  const removeTrack = async (index: number) => {
    const track = tracks[index]?.track;
    if (!track) return;

    if (!confirm(`「${track.name}」を削除しますか？`)) return;

    try {
      await removeTracksFromPlaylist(playlist.id, [track.uri]);
      
      // ローカル状態を更新
      setTracks(tracks.filter((_, i) => i !== index));
      
      alert(`「${track.name}」を削除しました`);
    } catch (error) {
      console.error("トラック削除エラー:", error);
      alert("トラックの削除に失敗しました");
    }
  };

  // ドラッグ開始
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  // ドラッグオーバー
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  // ドロップ
  const handleDrop = async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      return;
    }

    try {
      // Spotify APIで並び替え実行
      const insertBefore = dropIndex > draggedIndex ? dropIndex + 1 : dropIndex;
      await reorderPlaylistTracks(playlist.id, draggedIndex, insertBefore);
      
      // ローカル状態を更新
      const newTracks = [...tracks];
      const [draggedTrack] = newTracks.splice(draggedIndex, 1);
      newTracks.splice(dropIndex, 0, draggedTrack);
      setTracks(newTracks);
      
    } catch (error) {
      console.error("並び替えエラー:", error);
      alert("並び替えに失敗しました");
    } finally {
      setDraggedIndex(null);
    }
  };

  // プレイリスト情報を保存
  const handleSavePlaylist = async () => {
    if (!title.trim()) {
      alert("タイトルは必須です");
      return;
    }

    setIsSaving(true);
    try {
      await updatePlaylist(playlist.id, {
        name: title,
        description: description || undefined,
        public: isPublic
      });

      alert("プレイリスト情報を更新しました");
      onPlaylistUpdated();
    } catch (error) {
      console.error("プレイリスト更新エラー:", error);
      alert("プレイリストの更新に失敗しました");
    } finally {
      setIsSaving(false);
    }
  };

  // モーダルを閉じる
  const handleClose = () => {
    setSearchQuery("");
    setSearchResults([]);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: "white",
        borderRadius: 8,
        padding: 24,
        maxWidth: "95vw",
        maxHeight: "95vh",
        width: 1000,
        overflow: "auto"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2>プレイリストを編集: {playlist.name}</h2>
          <button onClick={handleClose} style={{ fontSize: 20, background: "none", border: "none", cursor: "pointer" }}>
            ×
          </button>
        </div>

        <div style={{ display: "flex", gap: 24 }}>
          {/* 左側: プレイリスト情報編集 */}
          <div style={{ flex: 1 }}>
            <h3>プレイリスト情報</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", marginBottom: 4, fontWeight: "bold" }}>
                タイトル <span style={{ color: "red" }}>*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{
                  width: "100%",
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  fontSize: 14
                }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", marginBottom: 4, fontWeight: "bold" }}>説明文</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                style={{
                  width: "100%",
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  fontSize: 14,
                  resize: "vertical"
                }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                <span>公開プレイリストにする</span>
              </label>
            </div>

            <button
              onClick={handleSavePlaylist}
              disabled={!title.trim() || isSaving}
              style={{
                padding: "8px 16px",
                backgroundColor: "#1db954",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: !title.trim() || isSaving ? "not-allowed" : "pointer",
                opacity: !title.trim() || isSaving ? 0.6 : 1,
                marginBottom: 20
              }}
            >
              {isSaving ? "保存中..." : "プレイリスト情報を保存"}
            </button>

            {/* 楽曲検索・追加 */}
            <h3>楽曲を検索して追加</h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="曲名、アーティスト名、アルバム名で検索"
                onKeyPress={(e) => e.key === "Enter" && handleSearch()}
                style={{
                  flex: 1,
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  fontSize: 14
                }}
              />
              <button
                onClick={handleSearch}
                disabled={isSearching || !searchQuery.trim()}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#1db954",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: isSearching ? "not-allowed" : "pointer",
                  opacity: isSearching ? 0.6 : 1
                }}
              >
                {isSearching ? "検索中..." : "検索"}
              </button>
            </div>

            {/* 検索結果 */}
            {searchResults.length > 0 && (
              <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid #ddd", borderRadius: 4 }}>
                {searchResults.map((track) => (
                  <div
                    key={track.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: 8,
                      borderBottom: "1px solid #eee"
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: "bold" }}>{track.name}</div>
                      <div style={{ fontSize: 12, color: "#666" }}>
                        {track.artists.map(a => a.name).join(", ")} • {track.album.name}
                      </div>
                    </div>
                    <button
                      onClick={() => addTrack(track)}
                      style={{
                        padding: "4px 8px",
                        backgroundColor: "#1db954",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 12
                      }}
                    >
                      追加
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右側: 現在のトラック一覧 */}
          <div style={{ flex: 1 }}>
            <h3>現在のトラック ({tracks.length}曲)</h3>
            {isLoading ? (
              <div>読み込み中...</div>
            ) : (
              <div style={{ maxHeight: 600, overflow: "auto", border: "1px solid #ddd", borderRadius: 4 }}>
                {tracks.map((item, index) => {
                  if (!item.track) return null;
                  
                  const track = item.track;
                  const albumImage = track.album.images[0]?.url;
                  
                  return (
                    <div
                      key={`${track.id}-${index}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, index)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: 8,
                        borderBottom: "1px solid #eee",
                        cursor: "move",
                        backgroundColor: draggedIndex === index ? "#f0f0f0" : "white"
                      }}
                    >
                      <div style={{ marginRight: 8, color: "#666", fontSize: 12, minWidth: 20 }}>
                        {index + 1}
                      </div>
                      
                      {albumImage && (
                        <img 
                          src={albumImage} 
                          alt={track.album.name}
                          style={{ 
                            width: 40, 
                            height: 40, 
                            marginRight: 8, 
                            borderRadius: 4 
                          }}
                        />
                      )}
                      
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "bold", fontSize: 14 }}>{track.name}</div>
                        <div style={{ fontSize: 12, color: "#666" }}>
                          {track.artists.map(a => a.name).join(", ")}
                        </div>
                      </div>
                      
                      <button
                        onClick={() => removeTrack(index)}
                        style={{
                          padding: "4px 8px",
                          backgroundColor: "#dc3545",
                          color: "white",
                          border: "none",
                          borderRadius: 4,
                          cursor: "pointer",
                          fontSize: 12
                        }}
                      >
                        削除
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 閉じるボタン */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
          <button
            onClick={handleClose}
            style={{
              padding: "8px 16px",
              backgroundColor: "#6c757d",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer"
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}


