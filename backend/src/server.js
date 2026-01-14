import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ミドルウェア
// CORS設定: localhost と 127.0.0.1 の両方を許可（開発環境）
app.use(cors({
  origin: (origin, callback) => {
    // 許可するオリジンのリスト
    const allowedOrigins = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      FRONTEND_URL
    ].filter(Boolean); // undefinedを除外
    
    // オリジンが指定されていない場合（Postman等）や、許可リストに含まれている場合
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy: Origin not allowed'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// セッション管理（簡易版：本番環境ではRedis等を使用推奨）
const sessions = new Map();

// ヘルスチェックエンドポイント
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend server is running' });
});

// ============================================
// 認証エンドポイント
// ============================================

// トークン交換エンドポイント
app.post('/api/auth/token', async (req, res) => {
  try {
    const { code, code_verifier, redirect_uri } = req.body;

    if (!code || !code_verifier || !redirect_uri) {
      return res.status(400).json({ 
        error: 'Missing required parameters: code, code_verifier, redirect_uri' 
      });
    }

    if (!SPOTIFY_CLIENT_ID) {
      return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID not configured' });
    }

    // Spotifyトークンエンドポイントにリクエスト
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      client_id: SPOTIFY_CLIENT_ID,
      code_verifier,
    });

    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', tokenResponse.status, errorText);
      return res.status(tokenResponse.status).json({ 
        error: `Token exchange failed: ${errorText}` 
      });
    }

    const tokenData = await tokenResponse.json();

    // セッションIDを生成
    const sessionId = crypto.randomUUID();
    
    // セッションにトークンを保存
    sessions.set(sessionId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: Date.now() + (tokenData.expires_in * 1000),
    });

    res.json({
      session_id: sessionId,
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      refresh_token: tokenData.refresh_token || null,
    });
  } catch (error) {
    console.error('Token exchange error:', error);
    res.status(500).json({ error: error.message });
  }
});

// トークン取得エンドポイント（セッションIDから）
app.get('/api/auth/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // 有効期限チェック
  if (session.expires_at < Date.now()) {
    sessions.delete(sessionId);
    return res.status(401).json({ error: 'Token expired' });
  }

  res.json({
    access_token: session.access_token,
    expires_at: session.expires_at,
  });
});

// ============================================
// Spotify API プロキシエンドポイント
// ============================================

// 認証ミドルウェア（トークン取得）
async function getAccessToken(req) {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    throw new Error('Session ID required');
  }

  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // 有効期限チェック
  if (session.expires_at < Date.now()) {
    sessions.delete(sessionId);
    throw new Error('Token expired');
  }

  return session.access_token;
}

// プレイリスト一覧取得
app.get('/api/spotify/me/playlists', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { limit = 20, offset = 0 } = req.query;

    const url = `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Playlists fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリスト内トラック取得
app.get('/api/spotify/playlists/:id/tracks', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { id } = req.params;
    const { limit = 100, offset = 0, fields } = req.query;

    let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}/tracks?limit=${limit}&offset=${offset}`;
    if (fields) {
      url += `&fields=${encodeURIComponent(fields)}`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Playlist tracks fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 楽曲検索
app.get('/api/spotify/search', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { q, type = 'track', limit = 20 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリストにトラックを追加
app.post('/api/spotify/playlists/:id/tracks', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { id } = req.params;
    const { uris } = req.body;

    if (!uris || !Array.isArray(uris)) {
      return res.status(400).json({ error: 'uris array is required' });
    }

    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}/tracks`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Add tracks error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリストからトラックを削除
app.delete('/api/spotify/playlists/:id/tracks', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { id } = req.params;
    const { uris } = req.body;

    if (!uris || !Array.isArray(uris)) {
      return res.status(400).json({ error: 'uris array is required' });
    }

    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}/tracks`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tracks: uris.map(uri => ({ uri })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    if (response.status === 200 || response.status === 204) {
      res.json({});
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Remove tracks error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリスト内のトラックを並び替え
app.put('/api/spotify/playlists/:id/tracks', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { id } = req.params;
    const { range_start, insert_before, range_length = 1 } = req.body;

    if (range_start === undefined || insert_before === undefined) {
      return res.status(400).json({ 
        error: 'range_start and insert_before are required' 
      });
    }

    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}/tracks`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range_start,
        insert_before,
        range_length,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    if (response.status === 200 || response.status === 204) {
      res.json({});
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Reorder tracks error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリスト情報を更新
app.put('/api/spotify/playlists/:id', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { id } = req.params;
    const { name, description, public: isPublic } = req.body;

    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description,
        public: isPublic,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    if (response.status === 200 || response.status === 204) {
      res.json({});
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Update playlist error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリストを削除（フォロー解除）
app.delete('/api/spotify/playlists/:id/followers', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { id } = req.params;

    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}/followers`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    if (response.status === 200 || response.status === 204) {
      res.json({});
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Delete playlist error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 現在のユーザー情報を取得
app.get('/api/spotify/me', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);

    const url = 'https://api.spotify.com/v1/me';
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// プレイリストを作成
app.post('/api/spotify/users/:userId/playlists', async (req, res) => {
  try {
    const access_token = await getAccessToken(req);
    const { userId } = req.params;
    const { name, description, public: isPublic } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const url = `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description,
        public: isPublic ?? false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Create playlist error:', error);
    res.status(500).json({ error: error.message });
  }
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📱 Frontend URL: ${FRONTEND_URL}`);
  console.log(`🎵 Spotify Client ID: ${SPOTIFY_CLIENT_ID ? '✅ Set' : '❌ Not set'}`);
  console.log(`🔐 Spotify Client Secret: ${SPOTIFY_CLIENT_SECRET ? '✅ Set' : '❌ Not set'}`);
});
