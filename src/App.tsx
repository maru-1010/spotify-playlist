// src/App.tsx
import { beginLogin } from "./auth";
import Playlists from "./pages/Playlists";
import { useState, useEffect } from "react";

// async function whoAmI() {
//   const saved = localStorage.getItem("spotify_token");
//   if (!saved) throw new Error("token not found");
//   const { access_token } = JSON.parse(saved);

//   const me = await fetch("https://api.spotify.com/v1/me", {
//     headers: { Authorization: `Bearer ${access_token}` },
//   });
//   if (!me.ok) throw new Error(await me.text());
//   const json = await me.json();
//   console.log("ME =", json);
//   alert(`Hello, ${json.display_name || json.id}!`);
// }



export default function App() {
  // ログイン状態を管理するstate追加
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  // ログイン状態をチェックする関数
  const checkLoginStatus = () => {
    const saved = localStorage.getItem("spotify_token");
    if (saved) {
      try {
        const { access_token, expires_at } = JSON.parse(saved);
        // トークンの有効期限もチェック
           if (access_token && expires_at > Date.now()) {
            setIsLoggedIn(true);
            return;
           }
      } catch {
        // パース失敗時はトークンを削除
        localStorage.removeItem("spotify_token");
      }
    }
    setIsLoggedIn(false);
  };

  // useEffectでマウント時とlocalStorageの変更を監視
  useEffect(() => {
    checkLoginStatus();

    // localStorageの変更を監視（他のタブでログインした場合など）
    const handleStorageChange = () => checkLoginStatus();
    window.addEventListener("storage", handleStorageChange);

    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // JSX部分
  return (
    <div style={{ padding: 16 }}>
      <h1>Spotify App</h1>
      <button onClick={beginLogin}>Spotifyでログイン</button>
      
      {/* ログイン時のみプレイリストを表示 */}
      {isLoggedIn && <Playlists />}
      {!isLoggedIn && <p>Spotifyにログインしてプレイリストを表示してください。</p>}
    </div>
  );
}