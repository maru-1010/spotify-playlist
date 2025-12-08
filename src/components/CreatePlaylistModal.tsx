import { useState, useEffect } from "react";
import { searchSpotify, createPlaylist, addTracksToPlaylist, getCurrentUser, type SpotifyTrack, type SpotifyUser } from "../api";

interface CreatePlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlaylistCreated: () => void;
}

export default function CreatePlaylistModal({ isOpen, onClose, onPlaylistCreated }: CreatePlaylistModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SpotifyTrack[]>([]);
  const [selectedTracks, setSelectedTracks] = useState<SpotifyTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [currentUser, setCurrentUser] = useState<SpotifyUser | null>(null);

  // ユーザー情報を取得
  useEffect(() => {
    if (isOpen) {
      getCurrentUser().then(setCurrentUser).catch(console.error);
    }
  }, [isOpen]);

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

  // トラックを選択リストに追加
  const addTrack = (track: SpotifyTrack) => {
    if (!selectedTracks.find(t => t.id === track.id)) {
      setSelectedTracks([...selectedTracks, track]);
    }
  };

  // 選択リストからトラックを削除
  const removeTrack = (trackId: string) => {
    setSelectedTracks(selectedTracks.filter(t => t.id !== trackId));
  };

  // プレイリスト作成
  const handleCreatePlaylist = async () => {
    if (!title.trim()) {
      alert("タイトルは必須です");
      return;
    }

    if (!currentUser) {
      alert("ユーザー情報の取得に失敗しました");
      return;
    }

    setIsCreating(true);
    try {
      // 1. プレイリスト作成
      const playlist = await createPlaylist(currentUser.id, {
        name: title,
        description: description || undefined,
        public: isPublic
      });

      // 2. トラックを追加（100件ずつバッチ処理）
      if (selectedTracks.length > 0) {
        const trackUris = selectedTracks.map(track => track.uri);
        const batchSize = 100;
        
        for (let i = 0; i < trackUris.length; i += batchSize) {
          const batch = trackUris.slice(i, i + batchSize);
          await addTracksToPlaylist(playlist.id, batch);
        }
      }

      alert(`プレイリスト「${title}」を作成しました！`);
      onPlaylistCreated();
      handleClose();
    } catch (error) {
      console.error("プレイリスト作成エラー:", error);
      alert("プレイリストの作成に失敗しました");
    } finally {
      setIsCreating(false);
    }
  };

  // モーダルを閉じる
  const handleClose = () => {
    setTitle("");
    setDescription("");
    setIsPublic(false);
    setSearchQuery("");
    setSearchResults([]);
    setSelectedTracks([]);
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
        maxWidth: "90vw",
        maxHeight: "90vh",
        width: 800,
        overflow: "auto"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2>新しいプレイリストを作成</h2>
          <button onClick={handleClose} style={{ fontSize: 20, background: "none", border: "none", cursor: "pointer" }}>
            ×
          </button>
        </div>

        {/* プレイリスト情報入力 */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 4, fontWeight: "bold" }}>
              タイトル <span style={{ color: "red" }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="プレイリストのタイトルを入力"
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
              placeholder="プレイリストの説明を入力（任意）"
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
        </div>

        {/* 楽曲検索 */}
        <div style={{ marginBottom: 20 }}>
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
            <div style={{ marginBottom: 20 }}>
              <h4>検索結果</h4>
              <div style={{ maxHeight: 200, overflow: "auto", border: "1px solid #ddd", borderRadius: 4 }}>
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
                      disabled={selectedTracks.some(t => t.id === track.id)}
                      style={{
                        padding: "4px 8px",
                        backgroundColor: selectedTracks.some(t => t.id === track.id) ? "#ccc" : "#1db954",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: selectedTracks.some(t => t.id === track.id) ? "not-allowed" : "pointer",
                        fontSize: 12
                      }}
                    >
                      {selectedTracks.some(t => t.id === track.id) ? "追加済み" : "追加"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 選択された楽曲リスト */}
        {selectedTracks.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h4>選択された楽曲 ({selectedTracks.length}曲)</h4>
            <div style={{ maxHeight: 200, overflow: "auto", border: "1px solid #ddd", borderRadius: 4 }}>
              {selectedTracks.map((track) => (
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
                    onClick={() => removeTrack(track.id)}
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
              ))}
            </div>
          </div>
        )}

        {/* アクションボタン */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
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
            キャンセル
          </button>
          <button
            onClick={handleCreatePlaylist}
            disabled={!title.trim() || isCreating}
            style={{
              padding: "8px 16px",
              backgroundColor: "#1db954",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: !title.trim() || isCreating ? "not-allowed" : "pointer",
              opacity: !title.trim() || isCreating ? 0.6 : 1
            }}
          >
            {isCreating ? "作成中..." : "プレイリストを保存"}
          </button>
        </div>
      </div>
    </div>
  );
}



