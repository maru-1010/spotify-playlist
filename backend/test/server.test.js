import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spotify への通信（node-fetch）はすべてモックにする
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

// .env は読ませない（テスト結果を開発者のローカル設定に左右させないため）。
// 環境変数は loadServer() で明示的に設定する
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// テスト中の現在時刻。Date だけを固定し、タイマーは本物のまま動かす
const NOW = Date.UTC(2026, 0, 1);
const ACCESS_TOKEN = 'test-access-token';
const EXPIRES_IN = 3600; // 秒
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TOKEN_REQUEST = {
  code: 'auth-code',
  code_verifier: 'code-verifier',
  redirect_uri: 'http://localhost:5173/callback',
};

// Spotify API プロキシの全エンドポイント。
// body は入力チェックを通る最小限の本文、forwardsTo は Spotify への転送として期待するリクエスト。
// emptyOnSuccess のものは、成功時（200/204）に Spotify の本文を返さず {} を返す。
const PROXY_ENDPOINTS = [
  {
    route: 'GET /api/spotify/me/playlists',
    forwardsTo: 'GET https://api.spotify.com/v1/me/playlists?limit=20&offset=0',
  },
  {
    route: 'GET /api/spotify/playlists/pl1/tracks',
    forwardsTo: 'GET https://api.spotify.com/v1/playlists/pl1/tracks?limit=100&offset=0',
  },
  {
    route: 'GET /api/spotify/search?q=jazz',
    forwardsTo: 'GET https://api.spotify.com/v1/search?q=jazz&type=track&limit=20',
  },
  {
    route: 'POST /api/spotify/playlists/pl1/tracks',
    body: { uris: ['spotify:track:t1'] },
    forwardsTo: 'POST https://api.spotify.com/v1/playlists/pl1/tracks',
  },
  {
    route: 'DELETE /api/spotify/playlists/pl1/tracks',
    body: { uris: ['spotify:track:t1'] },
    forwardsTo: 'DELETE https://api.spotify.com/v1/playlists/pl1/tracks',
    emptyOnSuccess: true,
  },
  {
    route: 'PUT /api/spotify/playlists/pl1/tracks',
    body: { range_start: 0, insert_before: 2 },
    forwardsTo: 'PUT https://api.spotify.com/v1/playlists/pl1/tracks',
    emptyOnSuccess: true,
  },
  {
    route: 'PUT /api/spotify/playlists/pl1',
    body: { name: 'Renamed' },
    forwardsTo: 'PUT https://api.spotify.com/v1/playlists/pl1',
    emptyOnSuccess: true,
  },
  {
    route: 'DELETE /api/spotify/playlists/pl1/followers',
    forwardsTo: 'DELETE https://api.spotify.com/v1/playlists/pl1/followers',
    emptyOnSuccess: true,
  },
  {
    route: 'GET /api/spotify/me',
    forwardsTo: 'GET https://api.spotify.com/v1/me',
  },
  {
    route: 'POST /api/spotify/users/user1/playlists',
    body: { name: 'New playlist' },
    forwardsTo: 'POST https://api.spotify.com/v1/users/user1/playlists',
  },
];
// 上の表でパスに埋め込まれている ID
const ID_IN_PATH = /pl1|user1/;

/**
 * 環境変数を指定して server.js を読み込み直し、express の app と listen のスパイを返す。
 *
 * server.js は app を export せず、読み込んだ時点で app.listen() を呼ぶ。
 * そこで全 app 共通の listen（express.application.listen）を差し替え、
 * ポートを開かずに、listen を呼んだ app を受け取る。
 * 読み込み直すたびにセッション（モジュール内の Map）も空になる。
 */
async function loadServer(env = {}) {
  vi.resetModules();
  const vars = {
    PORT: undefined,
    FRONTEND_URL: undefined,
    SPOTIFY_CLIENT_ID: 'test-client-id',
    SPOTIFY_CLIENT_SECRET: 'test-client-secret',
    ...env,
  };
  for (const [name, value] of Object.entries(vars)) {
    vi.stubEnv(name, value);
  }

  const { default: express } = await import('express');
  let app;
  const listen = vi.spyOn(express.application, 'listen').mockImplementation(function () {
    app = this;
  });
  await import('../src/server.js');
  return { app, listen };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Spotify のトークンエンドポイントの成功レスポンス */
function tokenResponse(overrides = {}) {
  return jsonResponse(200, {
    access_token: ACCESS_TOKEN,
    token_type: 'Bearer',
    scope: 'playlist-read-private playlist-modify-private',
    expires_in: EXPIRES_IN,
    refresh_token: 'test-refresh-token',
    ...overrides,
  });
}

/** トークン交換を通してセッションを作り、そのセッション ID を返す */
async function login(app, tokenOverrides) {
  fetchMock.mockResolvedValueOnce(tokenResponse(tokenOverrides));
  const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);
  expect(res.status).toBe(200);
  fetchMock.mockClear(); // トークン交換の呼び出しを、この後のアサーションに混ぜない
  return res.body.session_id;
}

/** プロキシのエンドポイントを呼ぶ。sessionId を渡すと x-session-id ヘッダーを付ける */
function callProxy(app, { route, body }, sessionId) {
  const [method, path] = route.split(' ');
  const req = request(app)[method.toLowerCase()](path);
  if (sessionId) req.set('x-session-id', sessionId);
  if (body) req.send(body);
  return req;
}

/** Spotify へ転送されたリクエスト（1 件だけのはず）。body は JSON をパースして返す */
function forwardedRequest() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, { method = 'GET', headers, body }] = fetchMock.mock.calls[0];
  return { method, url, headers, body: body && JSON.parse(body) };
}

let app;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {}); // エラー系のテストで出るログを抑える
  ({ app } = await loadServer());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('起動', () => {
  /** listen 完了時のコールバックを実行し、出力された起動ログを返す */
  async function startupLog(env) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { listen } = await loadServer(env);
    const onListening = listen.mock.lastCall[1];
    onListening();
    return log.mock.calls.flat().join('\n');
  }

  it('PORT が未設定なら 3001 番ポートで待ち受ける', async () => {
    const { listen } = await loadServer({ PORT: undefined });
    expect(listen).toHaveBeenLastCalledWith(3001, expect.any(Function));
  });

  it('環境変数 PORT のポートで待ち受ける', async () => {
    const { listen } = await loadServer({ PORT: '4000' });
    expect(listen).toHaveBeenLastCalledWith('4000', expect.any(Function));
  });

  it('起動ログには Client ID / Secret の設定有無だけを出し、値そのものは出さない', async () => {
    const output = await startupLog({
      SPOTIFY_CLIENT_ID: 'my-client-id',
      SPOTIFY_CLIENT_SECRET: 'my-client-secret',
    });

    expect(output).toContain('Spotify Client ID: ✅ Set');
    expect(output).toContain('Spotify Client Secret: ✅ Set');
    expect(output).not.toContain('my-client-id');
    expect(output).not.toContain('my-client-secret');
  });

  it('Client ID / Secret が未設定なら、そのことを起動ログに出す', async () => {
    const output = await startupLog({
      SPOTIFY_CLIENT_ID: undefined,
      SPOTIFY_CLIENT_SECRET: undefined,
    });

    expect(output).toContain('Spotify Client ID: ❌ Not set');
    expect(output).toContain('Spotify Client Secret: ❌ Not set');
  });
});

describe('GET /health', () => {
  it('稼働中であることを返す', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', message: 'Backend server is running' });
  });
});

describe('CORS', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
    '%s からのリクエストを許可する（credentials 付き）',
    async (origin) => {
      const res = await request(app).get('/health').set('Origin', origin);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    },
  );

  it('環境変数 FRONTEND_URL のオリジンも許可する', async () => {
    ({ app } = await loadServer({ FRONTEND_URL: 'https://playlist.example.com' }));

    const res = await request(app).get('/health').set('Origin', 'https://playlist.example.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://playlist.example.com');
  });

  it('Origin ヘッダーのないリクエスト（curl などブラウザ以外から）は許可する', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
  });

  it('許可していないオリジンからのリクエストはエラーにし、API の処理を実行しない', async () => {
    const res = await request(app)
      .post('/api/auth/token')
      .set('Origin', 'https://evil.example.com')
      .send(TOKEN_REQUEST);

    // cors に Error を渡しているため、Express 既定のエラーハンドラーで 500 になる
    expect(res.status).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('プリフライトリクエストに応答し、x-session-id ヘッダーの送信を許可する', async () => {
    const res = await request(app)
      .options('/api/spotify/playlists/pl1/tracks')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'content-type,x-session-id');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
    expect(res.headers['access-control-allow-headers']).toContain('x-session-id');
  });
});

describe('POST /api/auth/token', () => {
  it.each(['code', 'code_verifier', 'redirect_uri'])(
    '%s がないと 400 を返し、Spotify に問い合わせない',
    async (param) => {
      const res = await request(app)
        .post('/api/auth/token')
        .send({ ...TOKEN_REQUEST, [param]: undefined });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Missing required parameters: code, code_verifier, redirect_uri',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('SPOTIFY_CLIENT_ID が未設定なら 500 を返し、Spotify に問い合わせない', async () => {
    ({ app } = await loadServer({ SPOTIFY_CLIENT_ID: undefined }));

    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'SPOTIFY_CLIENT_ID not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('認可コードを PKCE で Spotify のトークンエンドポイントに送る（client_secret は送らない）', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());

    await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: 'http://localhost:5173/callback',
      client_id: 'test-client-id',
      code_verifier: 'code-verifier',
    });
  });

  it('交換に成功するとセッションを作り、セッション ID とトークンを返す', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());

    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session_id: expect.stringMatching(UUID_V4),
      access_token: ACCESS_TOKEN,
      expires_in: EXPIRES_IN,
      refresh_token: 'test-refresh-token',
    });
    const session = await request(app).get(`/api/auth/session/${res.body.session_id}`);
    expect(session.body.access_token).toBe(ACCESS_TOKEN);
  });

  it('Spotify が refresh_token を返さなければ null を返す', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ refresh_token: undefined }));

    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBeNull();
  });

  it('ログインのたびに別のセッションを作り、互いのトークンが混ざらない', async () => {
    const first = await login(app, { access_token: 'token-A' });
    const second = await login(app, { access_token: 'token-B' });

    expect(first).not.toBe(second);
    const sessionA = await request(app).get(`/api/auth/session/${first}`);
    const sessionB = await request(app).get(`/api/auth/session/${second}`);
    expect(sessionA.body.access_token).toBe('token-A');
    expect(sessionB.body.access_token).toBe('token-B');
  });

  it('フォーム形式（application/x-www-form-urlencoded）の本文も受け付ける', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());

    const res = await request(app).post('/api/auth/token').type('form').send(TOKEN_REQUEST);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toMatch(UUID_V4);
  });

  it('Spotify がエラーを返したら、そのステータスとエラー内容を返す', async () => {
    const spotifyError = { error: 'invalid_grant', error_description: 'Invalid authorization code' };
    fetchMock.mockResolvedValueOnce(jsonResponse(400, spotifyError));

    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Token exchange failed: ${JSON.stringify(spotifyError)}` });
  });

  it('Spotify との通信に失敗したら 500 を返す', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND accounts.spotify.com'));

    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'getaddrinfo ENOTFOUND accounts.spotify.com' });
  });
});

describe('GET /api/auth/session/:sessionId', () => {
  it('アクセストークンと有効期限（ログイン時刻 + expires_in 秒）を返し、refresh_token は返さない', async () => {
    const sessionId = await login(app);

    const res = await request(app).get(`/api/auth/session/${sessionId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access_token: ACCESS_TOKEN, expires_at: NOW + EXPIRES_IN * 1000 });
  });

  it('存在しないセッションには 404 を返す', async () => {
    const res = await request(app).get('/api/auth/session/unknown-session');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
  });

  it('有効期限ちょうどの時刻まではトークンを返す', async () => {
    const sessionId = await login(app);
    vi.setSystemTime(NOW + EXPIRES_IN * 1000);

    const res = await request(app).get(`/api/auth/session/${sessionId}`);

    expect(res.status).toBe(200);
  });

  it('有効期限を過ぎると 401 を返し、セッションを破棄する', async () => {
    const sessionId = await login(app);
    vi.setSystemTime(NOW + EXPIRES_IN * 1000 + 1);

    const res = await request(app).get(`/api/auth/session/${sessionId}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Token expired' });
    // 破棄されたので 2 回目は 404（残っていれば再び 401 になる）
    const again = await request(app).get(`/api/auth/session/${sessionId}`);
    expect(again.status).toBe(404);
  });
});

describe('Spotify API プロキシ', () => {
  let sessionId;

  beforeEach(async () => {
    sessionId = await login(app);
    // テストで指定しない限り、Spotify は 200 と空の JSON を返す
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
  });

  describe('セッション認証（全エンドポイント共通）', () => {
    // 現状の実装では、セッションの問題も 401 ではなく 500 として返る
    describe.each([
      { when: 'x-session-id ヘッダーがないとき', header: undefined, error: 'Session ID required' },
      { when: 'セッション ID が存在しないとき', header: 'unknown-session', error: 'Session not found' },
    ])('$when', ({ header, error }) => {
      it.each(PROXY_ENDPOINTS)('$route は 500 を返し、Spotify に転送しない', async (endpoint) => {
        const res = await callProxy(app, endpoint, header);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    it('有効期限ちょうどの時刻までは Spotify に転送する', async () => {
      vi.setSystemTime(NOW + EXPIRES_IN * 1000);

      const res = await request(app).get('/api/spotify/me').set('x-session-id', sessionId);

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe('有効期限を過ぎたとき', () => {
      it.each(PROXY_ENDPOINTS)('$route は 500 を返し、セッションを破棄する', async (endpoint) => {
        vi.setSystemTime(NOW + EXPIRES_IN * 1000 + 1);

        const res = await callProxy(app, endpoint, sessionId);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Token expired' });
        expect(fetchMock).not.toHaveBeenCalled();
        const session = await request(app).get(`/api/auth/session/${sessionId}`);
        expect(session.status).toBe(404);
      });
    });
  });

  describe('Spotify への転送（全エンドポイント共通）', () => {
    it.each(PROXY_ENDPOINTS)('$route → $forwardsTo（Bearer トークン付き）', async (endpoint) => {
      await callProxy(app, endpoint, sessionId);

      const { method, url, headers } = forwardedRequest();
      expect(`${method} ${url}`).toBe(endpoint.forwardsTo);
      expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    });

    // ID が "../../me"（..%2F..%2Fme）でも、エンコードし直して埋め込むので
    // Spotify の別の API を指すことはない
    it.each(PROXY_ENDPOINTS.filter(({ route }) => ID_IN_PATH.test(route)))(
      '$route: パスの ID は URL エンコードして埋め込む',
      async (endpoint) => {
        const withTraversalId = (s) => s.replace(ID_IN_PATH, '..%2F..%2Fme');

        await callProxy(app, { ...endpoint, route: withTraversalId(endpoint.route) }, sessionId);

        const { method, url } = forwardedRequest();
        expect(`${method} ${url}`).toBe(withTraversalId(endpoint.forwardsTo));
      },
    );

    it.each(PROXY_ENDPOINTS.filter((e) => !e.emptyOnSuccess))(
      '$route: Spotify の JSON をそのまま返す',
      async (endpoint) => {
        const spotifyBody = { items: [{ id: 'item-1' }], total: 1 };
        fetchMock.mockResolvedValueOnce(jsonResponse(200, spotifyBody));

        const res = await callProxy(app, endpoint, sessionId);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(spotifyBody);
      },
    );

    describe.each(PROXY_ENDPOINTS.filter((e) => e.emptyOnSuccess))('$route の成功時', (endpoint) => {
      it('Spotify が 200 を返したら、本文（snapshot_id など）は返さず {} を返す', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { snapshot_id: 'snapshot-1' }));

        const res = await callProxy(app, endpoint, sessionId);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
      });

      it('Spotify が 204 を返したら {} を返す', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

        const res = await callProxy(app, endpoint, sessionId);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
      });

      it('200・204 以外の成功ステータスなら、Spotify の本文をそのまま返す', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(201, { snapshot_id: 'snapshot-1' }));

        const res = await callProxy(app, endpoint, sessionId);

        expect(res.body).toEqual({ snapshot_id: 'snapshot-1' });
      });
    });

    it.each(PROXY_ENDPOINTS)(
      '$route: Spotify のエラーはステータスと本文をそのまま返す',
      async (endpoint) => {
        const spotifyError = { error: { status: 403, message: 'Insufficient client scope' } };
        fetchMock.mockResolvedValueOnce(jsonResponse(403, spotifyError));

        const res = await callProxy(app, endpoint, sessionId);

        expect(res.status).toBe(403);
        // 本文は JSON としてパースせず、文字列のまま error に入る
        expect(res.body).toEqual({ error: JSON.stringify(spotifyError) });
      },
    );

    it.each(PROXY_ENDPOINTS)('$route: Spotify との通信に失敗したら 500 を返す', async (endpoint) => {
      fetchMock.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

      const res = await callProxy(app, endpoint, sessionId);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'connect ETIMEDOUT' });
    });
  });

  describe('GET /api/spotify/me/playlists', () => {
    it('limit と offset を指定できる', async () => {
      await request(app)
        .get('/api/spotify/me/playlists')
        .query({ limit: 50, offset: 100 })
        .set('x-session-id', sessionId);

      expect(forwardedRequest().url).toBe(
        'https://api.spotify.com/v1/me/playlists?limit=50&offset=100',
      );
    });
  });

  describe('GET /api/spotify/playlists/:id/tracks', () => {
    it('limit・offset・fields を指定できる（fields は URL エンコードする）', async () => {
      await request(app)
        .get('/api/spotify/playlists/pl1/tracks')
        .query({ limit: 50, offset: 100, fields: 'items(track(name,uri)),total' })
        .set('x-session-id', sessionId);

      expect(forwardedRequest().url).toBe(
        'https://api.spotify.com/v1/playlists/pl1/tracks?limit=50&offset=100&fields=items(track(name%2Curi))%2Ctotal',
      );
    });
  });

  describe('GET /api/spotify/search', () => {
    it.each([
      ['q がないと', {}],
      ['q が空文字だと', { q: '' }],
    ])('%s 400 を返し、Spotify に転送しない', async (_, query) => {
      const res = await request(app)
        .get('/api/spotify/search')
        .query(query)
        .set('x-session-id', sessionId);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Query parameter "q" is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('検索語は URL エンコードして渡す（& で別のパラメータを紛れ込ませられない）', async () => {
      await request(app)
        .get('/api/spotify/search')
        .query({ q: 'rock & roll' })
        .set('x-session-id', sessionId);

      expect(forwardedRequest().url).toBe(
        'https://api.spotify.com/v1/search?q=rock%20%26%20roll&type=track&limit=20',
      );
    });

    it('type と limit を指定できる', async () => {
      await request(app)
        .get('/api/spotify/search')
        .query({ q: 'jazz', type: 'artist', limit: 5 })
        .set('x-session-id', sessionId);

      expect(forwardedRequest().url).toBe(
        'https://api.spotify.com/v1/search?q=jazz&type=artist&limit=5',
      );
    });
  });

  describe('POST /api/spotify/playlists/:id/tracks', () => {
    it.each([
      ['uris がないと', {}],
      ['uris が配列でないと', { uris: 'spotify:track:t1' }],
    ])('%s 400 を返し、Spotify に転送しない', async (_, body) => {
      const res = await request(app)
        .post('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'uris array is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uris を JSON で Spotify に送る', async () => {
      const uris = ['spotify:track:t1', 'spotify:track:t2'];

      await request(app)
        .post('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send({ uris });

      const { headers, body } = forwardedRequest();
      expect(headers['Content-Type']).toBe('application/json');
      expect(body).toEqual({ uris });
    });
  });

  describe('DELETE /api/spotify/playlists/:id/tracks', () => {
    it.each([
      ['uris がないと', {}],
      ['uris が配列でないと', { uris: 'spotify:track:t1' }],
    ])('%s 400 を返し、Spotify に転送しない', async (_, body) => {
      const res = await request(app)
        .delete('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'uris array is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uris を Spotify の形式 { tracks: [{ uri }] } に変換して送る', async () => {
      await request(app)
        .delete('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send({ uris: ['spotify:track:t1', 'spotify:track:t2'] });

      const { headers, body } = forwardedRequest();
      expect(headers['Content-Type']).toBe('application/json');
      expect(body).toEqual({
        tracks: [{ uri: 'spotify:track:t1' }, { uri: 'spotify:track:t2' }],
      });
    });
  });

  describe('PUT /api/spotify/playlists/:id/tracks', () => {
    it.each([
      ['range_start がないと', { insert_before: 2 }],
      ['insert_before がないと', { range_start: 0 }],
    ])('%s 400 を返し、Spotify に転送しない', async (_, body) => {
      const res = await request(app)
        .put('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'range_start and insert_before are required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('range_length を省略すると 1 で送る（range_start が 0 でも受け付ける）', async () => {
      await request(app)
        .put('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send({ range_start: 0, insert_before: 2 });

      expect(forwardedRequest().body).toEqual({ range_start: 0, insert_before: 2, range_length: 1 });
    });

    it('range_length を指定できる（insert_before が 0 でも受け付ける）', async () => {
      await request(app)
        .put('/api/spotify/playlists/pl1/tracks')
        .set('x-session-id', sessionId)
        .send({ range_start: 2, insert_before: 0, range_length: 3 });

      expect(forwardedRequest().body).toEqual({ range_start: 2, insert_before: 0, range_length: 3 });
    });
  });

  describe('PUT /api/spotify/playlists/:id', () => {
    it('name・description・public を Spotify に送る', async () => {
      await request(app)
        .put('/api/spotify/playlists/pl1')
        .set('x-session-id', sessionId)
        .send({ name: 'Drive', description: 'for the road', public: true });

      expect(forwardedRequest().body).toEqual({
        name: 'Drive',
        description: 'for the road',
        public: true,
      });
    });

    it('指定しなかった項目は送らない（Spotify 側の既存の値を消さない）', async () => {
      await request(app)
        .put('/api/spotify/playlists/pl1')
        .set('x-session-id', sessionId)
        .send({ public: false });

      expect(forwardedRequest().body).toEqual({ public: false });
    });
  });

  describe('POST /api/spotify/users/:userId/playlists', () => {
    it.each([
      ['name がないと', { description: 'desc' }],
      ['name が空文字だと', { name: '' }],
    ])('%s 400 を返し、Spotify に転送しない', async (_, body) => {
      const res = await request(app)
        .post('/api/spotify/users/user1/playlists')
        .set('x-session-id', sessionId)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'name is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('public を省略すると非公開（public: false）で作成する', async () => {
      await request(app)
        .post('/api/spotify/users/user1/playlists')
        .set('x-session-id', sessionId)
        .send({ name: 'Drive', description: 'for the road' });

      expect(forwardedRequest().body).toEqual({
        name: 'Drive',
        description: 'for the road',
        public: false,
      });
    });

    it('public: true を指定すると公開で作成する', async () => {
      await request(app)
        .post('/api/spotify/users/user1/playlists')
        .set('x-session-id', sessionId)
        .send({ name: 'Drive', public: true });

      expect(forwardedRequest().body).toEqual({ name: 'Drive', public: true });
    });
  });
});
