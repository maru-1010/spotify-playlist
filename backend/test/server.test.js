// @vitest-environment node
/**
 * backend/src/server.js のテスト
 *
 * ■ 技法
 *   デシジョンテーブルテスト。describe ごとに先頭のコメントへ「条件・動作・ルール」の表を書き、
 *   テスト名の先頭の [DT-番号 ルール] で表の列（ルール）と対応づけた。
 *   表の条件の境目や極端な値は、同じ describe に「境界」「極端」として足した。
 *
 * ■ しくみ（対象コードは変えていない）
 *   - Spotify への通信（node-fetch）はモックにした。supertest はテスト用に 127.0.0.1 の空きポートを使うだけで、外へは出ない。
 *   - server.js は app を export せず、読み込むと app.listen() する。そこで express をモックで包み、
 *     listen だけ差し替えて（ポートを開かない）、作られた app を取り出して supertest に渡す。
 *   - server.js は環境変数を読み込み時に読み、セッションをモジュール内の Map に持つ。
 *     そのため、テストごとに vi.resetModules() して読み込み直す（環境変数とセッションを次のテストへ持ち越さない）。
 *   - dotenv もモックにした（手元の .env の有無で結果が変わらないように）。
 *   - 時刻は Date.now を固定した（有効期限の境目を 1 ミリ秒単位で確かめるため）。
 *
 * ■ 今の動きを正としないもの
 *   本来の動きと食い違って見える点・仕様が決まっていない点は、今の値をテストで固めず、
 *   確かめられる部分（エラーになること、Spotify を呼ばないこと など）だけを確かめた。
 *   決めてほしい点は it.todo に「要確認」として残した。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// モック（外部への通信・サーバーの起動・.env の読み込み）
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  fetchMock: vi.fn(), // Spotify への通信（node-fetch）の代わり
  listenMock: vi.fn(), // app.listen の代わり（ポートを開かない）
  dotenvConfig: vi.fn(), // dotenv.config の代わり（手元の .env を読まない）
  apps: [], // server.js が express() で作ったアプリ
}));

vi.mock('node-fetch', () => ({ default: h.fetchMock }));
vi.mock('dotenv', () => ({ default: { config: h.dotenvConfig } }));
vi.mock('express', async (importOriginal) => {
  const actual = await importOriginal();
  const realExpress = actual.default;
  // express() で作ったアプリを記録し、listen だけ差し替える（ほかは本物の express のまま）
  const expressForTest = Object.assign((...args) => {
    const app = realExpress(...args);
    app.listen = h.listenMock;
    h.apps.push(app);
    return app;
  }, realExpress);
  return { ...actual, default: expressForTest };
});

// ---------------------------------------------------------------------------
// 共通の道具
// ---------------------------------------------------------------------------
const ENV_KEYS = ['PORT', 'FRONTEND_URL', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'];
const CLIENT_ID = 'test-client-id';
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0); // テスト中の「今」
const EXPIRES_IN = 3600; // Spotify のアクセストークンの有効秒数
const EXPIRES_AT = T0 + EXPIRES_IN * 1000; // T0 にログインしたセッションの期限
const clock = { now: T0 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPOTIFY_API = 'https://api.spotify.com';
const ACCESS_TOKEN = 'access-token-1';
const BEARER = `Bearer ${ACCESS_TOKEN}`;

/** 環境変数を決めて server.js を読み込み直し、express アプリを返す（env に無いキーは未設定にする） */
async function loadServer(env = { SPOTIFY_CLIENT_ID: CLIENT_ID }) {
  for (const key of ENV_KEYS) vi.stubEnv(key, env[key]);
  vi.resetModules();
  h.apps.length = 0;
  h.listenMock.mockClear();
  h.dotenvConfig.mockClear();
  await import('../src/server.js');
  expect(h.apps).toHaveLength(1);
  return h.apps[0];
}

/** Spotify の応答の代わり（Node 組み込みの Response を使う） */
const spotifyJson = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const spotifyText = (text, status) => new Response(text, { status });
const spotifyEmpty = (status) => new Response(null, { status });

/** 画面（src/auth.ts）がトークン交換で送る本文 */
const TOKEN_REQUEST = {
  code: 'auth-code-123',
  code_verifier: 'verifier-abc',
  redirect_uri: 'http://127.0.0.1:5173/callback',
};

/** トークン交換を通してセッションを作り、session_id を返す（Spotify の呼び出し記録は消しておく） */
async function login(app, tokenData = {}) {
  h.fetchMock.mockResolvedValueOnce(
    spotifyJson({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: EXPIRES_IN, ...tokenData }),
  );
  const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);
  expect(res.status).toBe(200);
  h.fetchMock.mockClear();
  return res.body.session_id;
}

/** Spotify を 1 回だけ呼んだことを確かめ、そのときの URL と options を返す */
function onlySpotifyCall() {
  expect(h.fetchMock).toHaveBeenCalledTimes(1);
  const [rawUrl, options = {}] = h.fetchMock.mock.calls[0];
  return { rawUrl, url: new URL(rawUrl), options };
}

/** API を呼ぶ（sessionId を渡したときだけ x-session-id を付ける） */
function callApi(app, { method, path, body }, sessionId) {
  let req = request(app)[method](path);
  if (sessionId !== undefined) req = req.set('x-session-id', sessionId);
  if (body !== undefined) req = req.send(body);
  return req;
}

/**
 * 認証エラーで止まったことを確かめる。
 * 今のステータスは 500 だが、本来は 401 と思われる（要確認）ので、値は固めず「エラーであること」だけを見る。
 */
function expectAuthRejected(res, message) {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.body).toEqual({ error: message });
  expect(h.fetchMock).not.toHaveBeenCalled();
}

/** Spotify プロキシ 10 本（relay: 成功時に Spotify の JSON を返す json ／ 200・204 なら {} を返す empty） */
const PROXY_ENDPOINTS = [
  { name: 'GET /api/spotify/me/playlists', method: 'get', path: '/api/spotify/me/playlists', relay: 'json' },
  { name: 'GET /api/spotify/playlists/:id/tracks', method: 'get', path: '/api/spotify/playlists/pl1/tracks', relay: 'json' },
  { name: 'GET /api/spotify/search', method: 'get', path: '/api/spotify/search?q=love', relay: 'json' },
  {
    name: 'POST /api/spotify/playlists/:id/tracks',
    method: 'post',
    path: '/api/spotify/playlists/pl1/tracks',
    body: { uris: ['spotify:track:t1'] },
    relay: 'json',
  },
  {
    name: 'DELETE /api/spotify/playlists/:id/tracks',
    method: 'delete',
    path: '/api/spotify/playlists/pl1/tracks',
    body: { uris: ['spotify:track:t1'] },
    relay: 'empty',
  },
  {
    name: 'PUT /api/spotify/playlists/:id/tracks',
    method: 'put',
    path: '/api/spotify/playlists/pl1/tracks',
    body: { range_start: 0, insert_before: 2 },
    relay: 'empty',
  },
  { name: 'PUT /api/spotify/playlists/:id', method: 'put', path: '/api/spotify/playlists/pl1', body: { name: 'New name' }, relay: 'empty' },
  { name: 'DELETE /api/spotify/playlists/:id/followers', method: 'delete', path: '/api/spotify/playlists/pl1/followers', relay: 'empty' },
  { name: 'GET /api/spotify/me', method: 'get', path: '/api/spotify/me', relay: 'json' },
  {
    name: 'POST /api/spotify/users/:userId/playlists',
    method: 'post',
    path: '/api/spotify/users/user1/playlists',
    body: { name: 'New playlist' },
    relay: 'json',
  },
];

beforeEach(() => {
  h.fetchMock.mockReset();
  clock.now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  // server.js のログでテストの出力が埋もれないようにする（DT-0 では中身を確かめる）
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ===========================================================================
// DT-0 起動
// ===========================================================================
describe('DT-0 起動（listen と起動ログ）', () => {
  /*
   * ルール     | PORT   | FRONTEND_URL | CLIENT_ID | CLIENT_SECRET || listen のポート | ログ: Frontend URL     | ログ: ID | ログ: Secret
   * S1         | 未設定 | 未設定       | 未設定    | 未設定        || 3001           | http://localhost:5173 | ❌       | ❌
   * S2         | 4000   | 独自 URL     | 設定      | 設定          || '4000'         | 独自 URL               | ✅       | ✅
   * S3         | 未設定 | 未設定       | 設定      | 未設定        || 3001           | 既定                   | ✅       | ❌
   * S4         | 未設定 | 未設定       | 未設定    | 設定          || 3001           | 既定                   | ❌       | ✅
   * S5（境界） | ''     | ''           | ''        | ''            || 3001           | 既定                   | ❌       | ❌   ← 空文字は未設定と同じ
   * どのルールでも: .env を 1 回読む／ID・Secret の値そのものはログに出さない
   */
  const DEFAULT_FRONTEND = 'http://localhost:5173';
  const SET = '✅ Set';
  const NOT_SET = '❌ Not set';
  const ALL_SET = {
    PORT: '4000',
    FRONTEND_URL: 'https://playlist.example.com',
    SPOTIFY_CLIENT_ID: 'id-value',
    SPOTIFY_CLIENT_SECRET: 'secret-value',
  };

  it.each([
    { rule: 'S1', env: {}, port: 3001, frontend: DEFAULT_FRONTEND, id: NOT_SET, secret: NOT_SET },
    { rule: 'S2', env: ALL_SET, port: '4000', frontend: 'https://playlist.example.com', id: SET, secret: SET },
    { rule: 'S3', env: { SPOTIFY_CLIENT_ID: 'id-value' }, port: 3001, frontend: DEFAULT_FRONTEND, id: SET, secret: NOT_SET },
    { rule: 'S4', env: { SPOTIFY_CLIENT_SECRET: 'secret-value' }, port: 3001, frontend: DEFAULT_FRONTEND, id: NOT_SET, secret: SET },
    {
      rule: 'S5',
      env: { PORT: '', FRONTEND_URL: '', SPOTIFY_CLIENT_ID: '', SPOTIFY_CLIENT_SECRET: '' },
      port: 3001,
      frontend: DEFAULT_FRONTEND,
      id: NOT_SET,
      secret: NOT_SET,
    },
  ])('[DT-0 $rule] ポート $port で listen し、ID「$id」・Secret「$secret」とログに出す', async ({ env, port, frontend, id, secret }) => {
    await loadServer(env);
    expect(h.dotenvConfig).toHaveBeenCalledTimes(1);
    expect(h.listenMock).toHaveBeenCalledTimes(1);
    const [listenPort, onListening] = h.listenMock.mock.calls[0];
    expect(listenPort).toBe(port);

    console.log.mockClear();
    onListening();
    const lines = console.log.mock.calls.map((args) => args.join(' '));
    expect(lines).toEqual([
      `🚀 Backend server running on http://localhost:${port}`,
      `📱 Frontend URL: ${frontend}`,
      `🎵 Spotify Client ID: ${id}`,
      `🔐 Spotify Client Secret: ${secret}`,
    ]);
    expect(lines.join('\n')).not.toMatch(/id-value|secret-value/);
  });
});

// ===========================================================================
// DT-1 CORS
// ===========================================================================
describe('DT-1 CORS（Origin ヘッダーによる許可・拒否）', () => {
  /*
   * ルール | Origin ヘッダー               | FRONTEND_URL                 | 種類      || 処理            | Access-Control-Allow-Origin
   * C1     | なし                          | 未設定（既定 localhost:5173） | 通常      || する            | 付けない
   * C2     | http://localhost:5173         | 未設定                       | 通常      || する            | Origin と同じ値（＋credentials: true）
   * C3     | http://127.0.0.1:5173         | 未設定                       | 通常      || する            | 同上
   * C4     | FRONTEND_URL と同じ           | https://playlist.example.com | 通常      || する            | 同上
   * C5     | http://localhost:5173         | https://playlist.example.com | 通常      || する            | 同上（固定の 2 つは残る）
   * C6     | https://playlist.example.com | 未設定                       | 通常      || しない（拒否）  | 付けない
   * C7     | 上記以外                      | 未設定                       | 通常      || しない（拒否）  | 付けない
   * C8     | 許可する Origin               | 未設定                       | preflight || 204             | 付ける（メソッドと x-session-id ヘッダーを許可）
   * C9     | 上記以外                      | 未設定                       | preflight || しない（拒否）  | 付けない
   * 境界: 完全一致の外側（ポート違い・https・末尾スラッシュ・ポートなし・"null"）→ C7 と同じく拒否
   * 境界: Origin が空文字 → C1 と同じ（Origin なし扱い）
   * ※ 拒否したときのステータスは今 500（Express 既定のエラー HTML）。本来の値は要確認のため固めない。
   */
  const HEALTH_BODY = { status: 'ok', message: 'Backend server is running' };
  const CUSTOM_FRONTEND = 'https://playlist.example.com';

  function expectAllowed(res, origin) {
    expect(res.status).toBe(200);
    expect(res.body).toEqual(HEALTH_BODY);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers.vary).toMatch(/Origin/);
  }

  function expectRejected(res) {
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.body).not.toEqual(HEALTH_BODY); // ルートの処理まで届いていない
  }

  it('[DT-1 C1] Origin なし（curl やサーバー間の呼び出し）は処理し、CORS ヘッダーは付けない', async () => {
    const app = await loadServer();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(HEALTH_BODY);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('[DT-1 C1 境界] Origin が空文字なら、Origin なしと同じに扱う', async () => {
    const app = await loadServer();
    const res = await request(app).get('/health').set('Origin', '');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(HEALTH_BODY);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    ['C2', 'http://localhost:5173'],
    ['C3', 'http://127.0.0.1:5173'],
  ])('[DT-1 %s] 既定で許可する Origin（%s）は処理し、その Origin を許可して返す', async (_rule, origin) => {
    const app = await loadServer();
    expectAllowed(await request(app).get('/health').set('Origin', origin), origin);
  });

  it.each([
    ['C4', CUSTOM_FRONTEND],
    ['C5', 'http://localhost:5173'],
  ])('[DT-1 %s] FRONTEND_URL を設定したとき、Origin %s を許可する', async (_rule, origin) => {
    const app = await loadServer({ SPOTIFY_CLIENT_ID: CLIENT_ID, FRONTEND_URL: CUSTOM_FRONTEND });
    expectAllowed(await request(app).get('/health').set('Origin', origin), origin);
  });

  it('[DT-1 C6] FRONTEND_URL が未設定なら、独自 URL の Origin は拒否する', async () => {
    const app = await loadServer();
    expectRejected(await request(app).get('/health').set('Origin', CUSTOM_FRONTEND));
  });

  it('[DT-1 C7] 許可リスト外の Origin は拒否し、ルートの処理（Spotify の呼び出し）まで進まない', async () => {
    const app = await loadServer();
    const res = await request(app).post('/api/auth/token').set('Origin', 'http://evil.example.com').send(TOKEN_REQUEST);
    expectRejected(res);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ポート違い', 'http://localhost:5174'],
    ['スキーム違い', 'https://localhost:5173'],
    ['末尾スラッシュ', 'http://localhost:5173/'],
    ['ポートなし', 'http://localhost'],
    ['"null"（file:// などから）', 'null'],
  ])('[DT-1 C7 境界] 許可リストと完全一致しない Origin（%s: %s）は拒否する', async (_label, origin) => {
    const app = await loadServer();
    expectRejected(await request(app).get('/health').set('Origin', origin));
  });

  it('[DT-1 C8] 許可する Origin の preflight には 204 で答え、画面が使うメソッドと x-session-id ヘッダーを許可する', async () => {
    const app = await loadServer();
    const res = await request(app)
      .options('/api/spotify/playlists/pl1/tracks')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'content-type,x-session-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods'].split(',')).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'DELETE']),
    );
    expect(res.headers['access-control-allow-headers']).toBe('content-type,x-session-id');
  });

  it('[DT-1 C9] 許可リスト外の Origin の preflight は拒否する', async () => {
    const app = await loadServer();
    const res = await request(app)
      .options('/api/spotify/me')
      .set('Origin', 'http://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });

  it.todo(
    '[DT-1 要確認] 許可しない Origin への応答ステータス（今は 500 と Express 既定のエラー HTML。403 にするか、CORS ヘッダーを付けないだけにするか）',
  );
});

// ===========================================================================
// DT-2 ヘルスチェック
// ===========================================================================
describe('DT-2 GET /health', () => {
  it('[DT-2] セッションなしでも 200 と稼働中の JSON を返す', async () => {
    const app = await loadServer();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', message: 'Backend server is running' });
  });
});

// ===========================================================================
// DT-3 トークン交換
// ===========================================================================
describe('DT-3 POST /api/auth/token（トークン交換）', () => {
  /*
   * 条件                           | T1 | T2 | T3 | T4 | T5 | T6 | T7       | T8 | T9
   * code がある                    | N  | Y  | Y  | N  | Y  | Y  | Y        | Y  | Y
   * code_verifier がある           | -  | N  | Y  | N  | Y  | Y  | Y        | Y  | Y
   * redirect_uri がある            | -  | -  | N  | N  | Y  | Y  | Y        | Y  | Y
   * SPOTIFY_CLIENT_ID が設定済み   | Y  | Y  | Y  | N  | N  | Y  | Y        | Y  | Y
   * Spotify の応答                 | -  | -  | -  | -  | -  | NG | 通信失敗 | OK | OK
   * 応答に refresh_token がある    | -  | -  | -  | -  | -  | -  | -        | Y  | N
   * ---------------------------------------------------------------------------------
   * 400 必須パラメータ不足         | X  | X  | X  | X  |    |    |          |    |
   * 500 CLIENT_ID 未設定           |    |    |    |    | X  |    |          |    |
   * Spotify に PKCE の値を送る     |    |    |    |    |    | X  | X        | X  | X
   * Spotify のステータスで返す     |    |    |    |    |    | X  |          |    |
   * 500 例外メッセージ             |    |    |    |    |    |    | X        |    |
   * 200 セッションを作って返す     |    |    |    |    |    |    |          | X  | X
   * 返す refresh_token             |    |    |    |    |    |    |          | 値 | null
   * 境界: 空文字の code など → 「ない」と同じ（T1〜T3）／CLIENT_ID が空文字 → T5
   * 極端: 値に & = ? が入る／フォーム形式の本文／壊れた JSON
   */
  let app;
  beforeEach(async () => {
    app = await loadServer();
  });

  it.each([
    ['T1', 'code', { code_verifier: 'v', redirect_uri: 'r' }],
    ['T2', 'code_verifier', { code: 'c', redirect_uri: 'r' }],
    ['T3', 'redirect_uri', { code: 'c', code_verifier: 'v' }],
  ])('[DT-3 %s] %s が無ければ 400 を返し、Spotify は呼ばない', async (_rule, _key, body) => {
    const res = await request(app).post('/api/auth/token').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required parameters: code, code_verifier, redirect_uri' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each(['code', 'code_verifier', 'redirect_uri'])(
    '[DT-3 T1〜T3 境界] %s が空文字でも、無いのと同じに 400 を返す',
    async (key) => {
      const res = await request(app).post('/api/auth/token').send({ ...TOKEN_REQUEST, [key]: '' });
      expect(res.status).toBe(400);
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );

  it('[DT-3 T4] 本文が空で CLIENT_ID も未設定なら、設定エラー（500）より先に 400 を返す', async () => {
    app = await loadServer({});
    const res = await request(app).post('/api/auth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required parameters: code, code_verifier, redirect_uri' });
  });

  it.each([
    ['未設定', {}],
    ['空文字', { SPOTIFY_CLIENT_ID: '' }],
  ])('[DT-3 T5] SPOTIFY_CLIENT_ID が%sなら 500 を返し、Spotify は呼ばない', async (_label, env) => {
    app = await loadServer(env);
    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'SPOTIFY_CLIENT_ID not configured' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, '{"error":"invalid_grant","error_description":"Invalid authorization code"}'],
    [401, '{"error":"invalid_client"}'],
    [503, 'Service Unavailable'],
  ])('[DT-3 T6] Spotify が %i を返したら、同じステータスと Spotify の本文を返す', async (status, text) => {
    h.fetchMock.mockResolvedValueOnce(spotifyText(text, status));
    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: `Token exchange failed: ${text}` });
  });

  it('[DT-3 T7] Spotify に届かない（通信エラー）ときは 500 とエラーメッセージを返す', async () => {
    h.fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'connect ECONNREFUSED' });
  });

  it('[DT-3 T8] 成功したら Spotify に PKCE の値を送り、セッションを作って session_id とトークンを返す', async () => {
    h.fetchMock.mockResolvedValueOnce(
      spotifyJson({
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: EXPIRES_IN,
        refresh_token: 'refresh-token-1',
        scope: 'playlist-modify-private',
      }),
    );
    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);

    // Spotify へ送った内容（client_secret は送らない＝PKCE）
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe('https://accounts.spotify.com/api/token');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
      grant_type: 'authorization_code',
      code: TOKEN_REQUEST.code,
      redirect_uri: TOKEN_REQUEST.redirect_uri,
      client_id: CLIENT_ID,
      code_verifier: TOKEN_REQUEST.code_verifier,
    });

    // 画面へ返す内容
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session_id: expect.stringMatching(UUID_RE),
      access_token: ACCESS_TOKEN,
      expires_in: EXPIRES_IN,
      refresh_token: 'refresh-token-1',
    });

    // 作ったセッションが使える（期限は 今 + expires_in 秒）
    const session = await request(app).get(`/api/auth/session/${res.body.session_id}`);
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ access_token: ACCESS_TOKEN, expires_at: EXPIRES_AT });
  });

  it('[DT-3 T9] 応答に refresh_token が無ければ、refresh_token は null で返す', async () => {
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ access_token: ACCESS_TOKEN, expires_in: EXPIRES_IN }));
    const res = await request(app).post('/api/auth/token').send(TOKEN_REQUEST);
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBeNull();
  });

  it('[DT-3 T8] 交換するたびに別の session_id を発行する', async () => {
    const first = await login(app);
    const second = await login(app);
    expect(first).toMatch(UUID_RE);
    expect(second).toMatch(UUID_RE);
    expect(first).not.toBe(second);
  });

  it('[DT-3 T8 極端] 値に & = ? が入っていても 1 つの値として送る（grant_type などを上書きできない）', async () => {
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ access_token: ACCESS_TOKEN, expires_in: EXPIRES_IN }));
    const tricky = {
      code: 'abc&grant_type=client_credentials',
      code_verifier: 'v+/=~日本語',
      redirect_uri: 'http://127.0.0.1:5173/callback?x=1&y=2',
    };
    await request(app).post('/api/auth/token').send(tricky);
    const params = new URLSearchParams(onlySpotifyCall().options.body);
    expect(params.getAll('grant_type')).toEqual(['authorization_code']);
    expect(params.get('code')).toBe(tricky.code);
    expect(params.get('code_verifier')).toBe(tricky.code_verifier);
    expect(params.get('redirect_uri')).toBe(tricky.redirect_uri);
  });

  it('[DT-3 T8 極端] フォーム形式（application/x-www-form-urlencoded）の本文も受け付ける', async () => {
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ access_token: ACCESS_TOKEN, expires_in: EXPIRES_IN }));
    const res = await request(app).post('/api/auth/token').type('form').send(TOKEN_REQUEST);
    expect(res.status).toBe(200);
    expect(new URLSearchParams(onlySpotifyCall().options.body).get('code')).toBe(TOKEN_REQUEST.code);
  });

  it('[DT-3 極端] 本文が壊れた JSON なら 400 で止まり、Spotify は呼ばない', async () => {
    const res = await request(app).post('/api/auth/token').set('Content-Type', 'application/json').send('{"code": ');
    expect(res.status).toBe(400);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.todo(
    '[DT-3 要確認] Spotify の応答に expires_in が無い・数値でないとき（今は expires_at が NaN になり、そのセッションはいつまでも期限切れにならない）',
  );
});

// ===========================================================================
// DT-4 セッションの確認
// ===========================================================================
describe('DT-4 GET /api/auth/session/:sessionId（セッションの確認）', () => {
  /*
   * 条件                               | S1 | S2 | S3
   * セッションがある                   | N  | Y  | Y
   * 期限切れ（expires_at < 今）        | -  | N  | Y
   * -------------------------------------------------
   * 404 Session not found              | X  |    |
   * 200 { access_token, expires_at }   |    | X  |
   * 401 Token expired＋セッションを消す |    |    | X
   * 境界: 今 = expires_at − 1ms → S2 ／ 今 = expires_at + 1ms → S3 ／ 今 = expires_at ちょうど → 要確認（todo）
   */
  let app;
  beforeEach(async () => {
    app = await loadServer();
  });

  it('[DT-4 S1] 発行していない session_id なら 404 を返す', async () => {
    const res = await request(app).get('/api/auth/session/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
  });

  it('[DT-4 S2] 有効なセッションなら access_token と expires_at だけを返す（refresh_token は返さない）', async () => {
    const sessionId = await login(app, { refresh_token: 'refresh-token-1' });
    const res = await request(app).get(`/api/auth/session/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access_token: ACCESS_TOKEN, expires_at: EXPIRES_AT });
  });

  it('[DT-4 S2 境界] 期限の 1 ミリ秒前はまだ有効', async () => {
    const sessionId = await login(app);
    clock.now = EXPIRES_AT - 1;
    const res = await request(app).get(`/api/auth/session/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe(ACCESS_TOKEN);
  });

  it('[DT-4 S3 境界] 期限の 1 ミリ秒後は 401 を返してセッションを消す（次は 404）', async () => {
    const sessionId = await login(app);
    clock.now = EXPIRES_AT + 1;
    const expired = await request(app).get(`/api/auth/session/${sessionId}`);
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ error: 'Token expired' });

    const again = await request(app).get(`/api/auth/session/${sessionId}`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: 'Session not found' });
  });

  it.todo(
    '[DT-4・DT-5 要確認] 今の時刻が expires_at ちょうどのとき（今は有効。画面の App.tsx は expires_at > 今 で判定するので、ちょうどのときは無効扱い）',
  );
});

// ===========================================================================
// DT-5 認証（x-session-id）— Spotify プロキシ 10 本に共通
// ===========================================================================
describe('DT-5 認証（x-session-id）— Spotify プロキシ 10 本に共通', () => {
  /*
   * 条件                                       | A1 | A2 | A3 | A4
   * x-session-id がある                        | N  | Y  | Y  | Y
   * そのセッションがある                       | -  | N  | Y  | Y
   * 期限切れ（expires_at < 今）                | -  | -  | Y  | N
   * ---------------------------------------------------------------
   * 認証エラー "Session ID required"           | X  |    |    |
   * 認証エラー "Session not found"             |    | X  |    |
   * 認証エラー "Token expired"＋セッションを消す |    |    | X  |
   * Spotify を呼ばない                         | X  | X  | X  |
   * そのセッションのトークンで Spotify を呼ぶ  |    |    |    | X（各エンドポイントの DT でも確かめる）
   * 優先順位: 認証は入力チェックより先（A1 かつ 入力不備 → 認証エラー）
   * 境界: x-session-id が空文字 → A1 ／ 今 = expires_at − 1ms → A4
   * ※ 認証エラーのステータスは今 500。本来は 401 と思われる（要確認）ので値は固めず「エラーであること」だけ確かめる。
   */
  let app;
  beforeEach(async () => {
    app = await loadServer();
  });

  describe.each(PROXY_ENDPOINTS)('$name', (endpoint) => {
    it('[DT-5 A1] x-session-id が無ければ認証エラーで止まる', async () => {
      expectAuthRejected(await callApi(app, endpoint), 'Session ID required');
    });

    it('[DT-5 A2] 発行していない session_id なら認証エラーで止まる', async () => {
      expectAuthRejected(await callApi(app, endpoint, 'unknown-session-id'), 'Session not found');
    });

    it('[DT-5 A3] 期限切れなら認証エラーで止まり、セッションを消す（次は Session not found）', async () => {
      const sessionId = await login(app);
      clock.now = EXPIRES_AT + 1;
      expectAuthRejected(await callApi(app, endpoint, sessionId), 'Token expired');
      expectAuthRejected(await callApi(app, endpoint, sessionId), 'Session not found');
    });
  });

  it.each([
    { name: 'GET /api/spotify/search（q なし）', method: 'get', path: '/api/spotify/search' },
    { name: 'POST /api/spotify/playlists/:id/tracks（uris なし）', method: 'post', path: '/api/spotify/playlists/pl1/tracks', body: {} },
    { name: 'DELETE /api/spotify/playlists/:id/tracks（uris なし）', method: 'delete', path: '/api/spotify/playlists/pl1/tracks', body: {} },
    { name: 'PUT /api/spotify/playlists/:id/tracks（range_start なし）', method: 'put', path: '/api/spotify/playlists/pl1/tracks', body: {} },
    { name: 'POST /api/spotify/users/:userId/playlists（name なし）', method: 'post', path: '/api/spotify/users/user1/playlists', body: {} },
  ])('[DT-5 A1 優先順位] $name: 入力の不備より先に認証エラーを返す', async (endpoint) => {
    expectAuthRejected(await callApi(app, endpoint), 'Session ID required');
  });

  it('[DT-5 A1 境界] x-session-id が空文字なら、無いのと同じに扱う', async () => {
    expectAuthRejected(await callApi(app, { method: 'get', path: '/api/spotify/me' }, ''), 'Session ID required');
  });

  it('[DT-5 A4 境界] 期限の 1 ミリ秒前なら、そのトークンで Spotify を呼ぶ', async () => {
    const sessionId = await login(app);
    clock.now = EXPIRES_AT - 1;
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ id: 'user1' }));
    const res = await callApi(app, { method: 'get', path: '/api/spotify/me' }, sessionId);
    expect(res.status).toBe(200);
    expect(onlySpotifyCall().options.headers.Authorization).toBe(BEARER);
  });

  it('[DT-5 A4] セッションが複数あっても、それぞれ自分のトークンで Spotify を呼ぶ', async () => {
    const sessionA = await login(app, { access_token: 'token-A' });
    const sessionB = await login(app, { access_token: 'token-B' });
    h.fetchMock.mockImplementation(async () => spotifyJson({}));
    await callApi(app, { method: 'get', path: '/api/spotify/me' }, sessionB);
    await callApi(app, { method: 'get', path: '/api/spotify/me' }, sessionA);
    expect(h.fetchMock.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual([
      'Bearer token-B',
      'Bearer token-A',
    ]);
  });

  it.todo('[DT-5 要確認] 認証エラー（A1〜A3）のステータスコード（今は 500。/api/auth/session と同じく 401・404 にするか）');
});

// ===========================================================================
// DT-6 Spotify の応答の中継（成功時に Spotify の JSON をそのまま返す 6 本）
// ===========================================================================
describe('DT-6 Spotify の応答の中継（JSON をそのまま返す 6 本）', () => {
  /*
   * 条件                                       | J1  | J2       | J3
   * Spotify の応答                             | 2xx | 2xx 以外 | 通信エラー
   * ---------------------------------------------------------------
   * 200＋Spotify の JSON をそのまま            | X   |          |
   * Spotify と同じステータス＋{ error: 本文 }  |     | X        |
   * 500＋{ error: 例外メッセージ }             |     |          | X
   * 境界（response.ok の境目）: 200・299 → J1 ／ 300・599 → J2
   * 極端: 2xx なのに本文が JSON でない → 500
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  describe.each(PROXY_ENDPOINTS.filter((e) => e.relay === 'json'))('$name', (endpoint) => {
    it('[DT-6 J1] Spotify が成功したら、その JSON を 200 で返す', async () => {
      const data = { items: [{ id: 'x1' }], total: 1 };
      h.fetchMock.mockResolvedValueOnce(spotifyJson(data, endpoint.method === 'post' ? 201 : 200));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(data);
    });

    it('[DT-6 J2] Spotify がエラーなら、同じステータスと Spotify の本文（文字列）を返す', async () => {
      const text = '{"error":{"status":404,"message":"Not found."}}';
      h.fetchMock.mockResolvedValueOnce(spotifyText(text, 404));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: text });
    });

    it('[DT-6 J3] Spotify に届かなければ 500 とエラーメッセージを返す', async () => {
      h.fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.spotify.com'));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'getaddrinfo ENOTFOUND api.spotify.com' });
    });
  });

  describe('境界・極端（GET /api/spotify/me で代表）', () => {
    const me = { method: 'get', path: '/api/spotify/me' };

    it.each([200, 299])('[DT-6 J1 境界] ステータス %i は成功として JSON を返す', async (status) => {
      h.fetchMock.mockResolvedValueOnce(spotifyJson({ id: 'user1' }, status));
      const res = await callApi(app, me, sessionId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'user1' });
    });

    it.each([300, 401, 429, 503, 599])('[DT-6 J2 境界] ステータス %i はエラーとして、同じステータスで返す', async (status) => {
      h.fetchMock.mockResolvedValueOnce(spotifyText(`error ${status}`, status));
      const res = await callApi(app, me, sessionId);
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: `error ${status}` });
    });

    it('[DT-6 極端] 成功なのに本文が JSON でなければ 500 を返す', async () => {
      h.fetchMock.mockResolvedValueOnce(spotifyText('<html>maintenance</html>', 200));
      const res = await callApi(app, me, sessionId);
      expect(res.status).toBe(500);
      expect(res.body.error).toEqual(expect.any(String));
    });
  });
});

// ===========================================================================
// DT-7 Spotify の応答の中継（200・204 なら {} を返す 4 本）
// ===========================================================================
describe('DT-7 Spotify の応答の中継（200・204 なら {} を返す 4 本）', () => {
  /*
   * 条件                                       | E1  | E2  | E3                  | E4       | E5
   * Spotify の応答                             | 200 | 204 | 200・204 以外の 2xx | 2xx 以外 | 通信エラー
   * -------------------------------------------------------------------------------------
   * 200＋{}                                    | X   | X   |                     |          |
   * 200＋Spotify の JSON                       |     |     | X                   |          |
   * Spotify と同じステータス＋{ error: 本文 }  |     |     |                     | X        |
   * 500＋{ error: 例外メッセージ }             |     |     |                     |          | X
   * ※ E1 は本文なしの 200 で確かめた。本文（snapshot_id）付きの 200 をどう返すかは要確認（todo）。
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  describe.each(PROXY_ENDPOINTS.filter((e) => e.relay === 'empty'))('$name', (endpoint) => {
    it('[DT-7 E1] Spotify が 200（本文なし）なら 200 と {} を返す', async () => {
      h.fetchMock.mockResolvedValueOnce(spotifyEmpty(200));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it('[DT-7 E2] Spotify が 204 なら 200 と {} を返す', async () => {
      h.fetchMock.mockResolvedValueOnce(spotifyEmpty(204));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it('[DT-7 E3] Spotify が 201 で JSON を返したら、その JSON を返す', async () => {
      h.fetchMock.mockResolvedValueOnce(spotifyJson({ snapshot_id: 'snap-1' }, 201));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ snapshot_id: 'snap-1' });
    });

    it('[DT-7 E4] Spotify がエラーなら、同じステータスと Spotify の本文を返す', async () => {
      const text = '{"error":{"status":403,"message":"Forbidden"}}';
      h.fetchMock.mockResolvedValueOnce(spotifyText(text, 403));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: text });
    });

    it('[DT-7 E5] Spotify に届かなければ 500 とエラーメッセージを返す', async () => {
      h.fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
      const res = await callApi(app, endpoint, sessionId);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'socket hang up' });
    });
  });

  it.todo(
    '[DT-7 要確認] DELETE・PUT .../tracks で Spotify が 200＋{ snapshot_id } を返したとき（今は本文を捨てて {} を返す。ほかの 2xx なら返すので逆に見える）',
  );
});

// ===========================================================================
// DT-8〜DT-17 各エンドポイントが Spotify へ送る内容
// ===========================================================================
describe('DT-8 GET /api/spotify/me/playlists（自分のプレイリスト一覧）', () => {
  /*
   * 条件            | P1 | P2     | P3     | P4
   * limit の指定    | N  | Y      | N      | Y
   * offset の指定   | N  | Y      | Y      | N
   * ------------------------------------------------
   * Spotify の limit  | 20 | 指定値 | 20     | 指定値
   * Spotify の offset | 0  | 指定値 | 指定値 | 0
   * 境界: limit 0・1・50・51 → 値を変えずに送る（範囲のチェックは Spotify 任せ）
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ items: [] }));
  });

  it.each([
    { rule: 'P1', label: 'なし', query: '', expected: { limit: '20', offset: '0' } },
    { rule: 'P2', label: 'limit=50&offset=40', query: '?limit=50&offset=40', expected: { limit: '50', offset: '40' } },
    { rule: 'P3', label: 'offset=20', query: '?offset=20', expected: { limit: '20', offset: '20' } },
    { rule: 'P4', label: 'limit=5', query: '?limit=5', expected: { limit: '5', offset: '0' } },
  ])('[DT-8 $rule] クエリ「$label」→ Spotify へ limit=$expected.limit, offset=$expected.offset で GET する', async ({ query, expected }) => {
    const res = await callApi(app, { method: 'get', path: `/api/spotify/me/playlists${query}` }, sessionId);
    expect(res.status).toBe(200);
    const { url, options } = onlySpotifyCall();
    expect(url.origin + url.pathname).toBe(`${SPOTIFY_API}/v1/me/playlists`);
    expect(Object.fromEntries(url.searchParams)).toEqual(expected);
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.headers).toEqual({ Authorization: BEARER });
  });

  it.each(['0', '1', '50', '51'])('[DT-8 境界] limit=%s は値を変えずに Spotify へ送る', async (limit) => {
    await callApi(app, { method: 'get', path: `/api/spotify/me/playlists?limit=${limit}` }, sessionId);
    expect(onlySpotifyCall().url.searchParams.get('limit')).toBe(limit);
  });

  it.todo('[DT-8 要確認] limit= のように値が空のとき（今は既定値 20 を使わず、空のまま Spotify へ送る）');
  it.todo(
    '[DT-8・DT-9・DT-10 要確認] limit・offset・type をエンコードせずに URL へ入れている（例: limit=5%26market%3DJP → Spotify へ market=JP が足される）',
  );
});

describe('DT-9 GET /api/spotify/playlists/:id/tracks（プレイリストの曲一覧）', () => {
  /*
   * 条件                   | PT1      | PT2      | PT3                  | PT4
   * limit・offset の指定   | N        | Y        | N                    | N
   * fields の指定          | N        | N        | Y                    | ''（空）
   * -----------------------------------------------------------------------------
   * Spotify の limit・offset | 100・0 | 指定値   | 100・0               | 100・0
   * Spotify の fields      | 付けない | 付けない | エンコードして付ける | 付けない
   * 極端: id に記号・日本語 → 「パスの id（共通）」で確かめる
   */
  // 画面（src/api.ts の fetchPlaylistItems）が送る fields
  const FIELDS =
    'items(added_at,is_local,track(id,name,uri,preview_url,external_urls,artists(id,name),album(id,name,images)))' +
    ',total,next,previous,limit,offset';

  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ items: [] }));
  });

  it.each([
    { rule: 'PT1', label: 'なし', query: '', expected: { limit: '100', offset: '0' } },
    { rule: 'PT2', label: 'limit・offset', query: '?limit=50&offset=100', expected: { limit: '50', offset: '100' } },
    {
      rule: 'PT3',
      label: '画面と同じ fields',
      query: `?limit=100&offset=0&fields=${encodeURIComponent(FIELDS)}`,
      expected: { limit: '100', offset: '0', fields: FIELDS },
    },
    { rule: 'PT4', label: 'fields が空', query: '?fields=', expected: { limit: '100', offset: '0' } },
  ])('[DT-9 $rule] クエリ「$label」→ Spotify へ送るクエリが正しい', async ({ query, expected }) => {
    const res = await callApi(app, { method: 'get', path: `/api/spotify/playlists/pl1/tracks${query}` }, sessionId);
    expect(res.status).toBe(200);
    const { url, options } = onlySpotifyCall();
    expect(url.origin + url.pathname).toBe(`${SPOTIFY_API}/v1/playlists/pl1/tracks`);
    expect(Object.fromEntries(url.searchParams)).toEqual(expected);
    expect(options.headers).toEqual({ Authorization: BEARER });
  });
});

describe('DT-10 GET /api/spotify/search（曲の検索）', () => {
  /*
   * 条件                 | SR1  | SR2      | SR3      | SR4
   * q                    | なし | ''（空） | あり     | あり
   * type・limit の指定   | -    | -        | N        | Y
   * --------------------------------------------------------
   * 400 q が必須（Spotify は呼ばない） | X | X |       |
   * Spotify の type・limit |    |          | track・20 | 指定値
   * Spotify の q           |    |          | そのまま | そのまま
   * 極端: q に & = # + % 空白 日本語 → 1 つの値として送る（type などに化けない）
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  it.each([
    ['SR1', '無い', '/api/spotify/search'],
    ['SR2', '空文字', '/api/spotify/search?q='],
  ])('[DT-10 %s] q が%sなら 400 を返し、Spotify は呼ばない', async (_rule, _label, path) => {
    const res = await callApi(app, { method: 'get', path }, sessionId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Query parameter "q" is required' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { rule: 'SR3', label: 'q だけ', query: '?q=love', expected: { q: 'love', type: 'track', limit: '20' } },
    { rule: 'SR4', label: 'type・limit も', query: '?q=love&type=artist,track&limit=5', expected: { q: 'love', type: 'artist,track', limit: '5' } },
  ])('[DT-10 $rule] クエリ「$label」→ Spotify へ送るクエリが正しい', async ({ query, expected }) => {
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ tracks: { items: [] } }));
    const res = await callApi(app, { method: 'get', path: `/api/spotify/search${query}` }, sessionId);
    expect(res.status).toBe(200);
    const { url, options } = onlySpotifyCall();
    expect(url.origin + url.pathname).toBe(`${SPOTIFY_API}/v1/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual(expected);
    expect(options.headers).toEqual({ Authorization: BEARER });
  });

  it('[DT-10 SR3 極端] q に記号・日本語があっても 1 つの値として送る（type や limit に化けない）', async () => {
    const q = 'AC/DC & Queen + 100% #1 日本語 type=artist&limit=50';
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ tracks: { items: [] } }));
    await callApi(app, { method: 'get', path: `/api/spotify/search?q=${encodeURIComponent(q)}` }, sessionId);
    const { url } = onlySpotifyCall();
    expect([...url.searchParams.keys()]).toEqual(['q', 'type', 'limit']);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q, type: 'track', limit: '20' });
  });
});

describe('DT-11 POST /api/spotify/playlists/:id/tracks（曲の追加）', () => {
  /*
   * 条件   | AD1  | AD2    | AD3          | AD4  | AD5
   * uris   | なし | 文字列 | オブジェクト | null | 配列
   * --------------------------------------------------
   * 400 uris array is required（Spotify は呼ばない） | X | X | X | X |
   * Spotify へ { uris } を POST                      |   |   |   |   | X
   * 境界: 配列 0 件・1 件・100 件・101 件 → 件数を変えず 1 回で送る（上限チェックや分割はしない。画面が 100 件ずつ送る）
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  it.each([
    { rule: 'AD1', label: 'uris が無い', body: {} },
    { rule: 'AD2', label: 'uris が文字列', body: { uris: 'spotify:track:t1' } },
    { rule: 'AD3', label: 'uris がオブジェクト', body: { uris: { 0: 'spotify:track:t1' } } },
    { rule: 'AD4', label: 'uris が null', body: { uris: null } },
  ])('[DT-11 $rule] $labelなら 400 を返し、Spotify は呼ばない', async ({ body }) => {
    const res = await callApi(app, { method: 'post', path: '/api/spotify/playlists/pl1/tracks', body }, sessionId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'uris array is required' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('[DT-11 AD5] uris の配列を、そのまま Spotify へ POST する', async () => {
    const uris = ['spotify:track:t1', 'spotify:track:t2'];
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ snapshot_id: 'snap-1' }, 201));
    const res = await callApi(app, { method: 'post', path: '/api/spotify/playlists/pl1/tracks', body: { uris } }, sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ snapshot_id: 'snap-1' });
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/playlists/pl1/tracks`);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ Authorization: BEARER, 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ uris });
  });

  it.each([0, 1, 100, 101])('[DT-11 AD5 境界] uris が %i 件でも、件数を変えずに 1 回で送る', async (count) => {
    const uris = Array.from({ length: count }, (_, i) => `spotify:track:t${i}`);
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ snapshot_id: 'snap-1' }, 201));
    await callApi(app, { method: 'post', path: '/api/spotify/playlists/pl1/tracks', body: { uris } }, sessionId);
    expect(JSON.parse(onlySpotifyCall().options.body)).toEqual({ uris });
  });
});

describe('DT-12 DELETE /api/spotify/playlists/:id/tracks（曲の削除）', () => {
  /*
   * 条件   | RM1  | RM2    | RM3  | RM4
   * uris   | なし | 文字列 | 配列 | 配列（0 件）
   * -------------------------------------------
   * 400 uris array is required（Spotify は呼ばない）  | X | X |   |
   * Spotify へ DELETE { tracks: [{ uri }, ...] }      |   |   | X | X
   * ※ 画面（src/api.ts）は { tracks: [{ uri }] } を送るので RM1 に当たり、今は 400 になる（要確認・todo）
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  it.each([
    { rule: 'RM1', label: 'uris が無い', body: {} },
    { rule: 'RM2', label: 'uris が文字列', body: { uris: 'spotify:track:t1' } },
  ])('[DT-12 $rule] $labelなら 400 を返し、Spotify は呼ばない', async ({ body }) => {
    const res = await callApi(app, { method: 'delete', path: '/api/spotify/playlists/pl1/tracks', body }, sessionId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'uris array is required' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { rule: 'RM3', uris: ['spotify:track:t1', 'spotify:track:t2'], tracks: [{ uri: 'spotify:track:t1' }, { uri: 'spotify:track:t2' }] },
    { rule: 'RM4', uris: [], tracks: [] },
  ])('[DT-12 $rule] uris（$uris.length 件）を { tracks: [{ uri }] } の形に直して Spotify へ DELETE する', async ({ uris, tracks }) => {
    h.fetchMock.mockResolvedValueOnce(spotifyEmpty(200));
    const res = await callApi(app, { method: 'delete', path: '/api/spotify/playlists/pl1/tracks', body: { uris } }, sessionId);
    expect(res.status).toBe(200);
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/playlists/pl1/tracks`);
    expect(options.method).toBe('DELETE');
    expect(options.headers).toEqual({ Authorization: BEARER, 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ tracks });
  });

  it.todo(
    '[DT-12 要確認] 画面（src/api.ts の removeTracksFromPlaylist）が送る { tracks: [{ uri }] } の形（今は uris が無いので 400 になり、画面から曲を消せない）',
  );
});

describe('DT-13 PUT /api/spotify/playlists/:id/tracks（曲の並び替え）', () => {
  /*
   * 条件           | RO1  | RO2  | RO3  | RO4  | RO5 | RO6
   * range_start    | なし | あり | なし | 0    | 3   | 2
   * insert_before  | あり | なし | なし | 0    | 1   | 5
   * range_length   | -    | -    | -    | なし | 2   | 0
   * ---------------------------------------------------------
   * 400 range_start and insert_before are required（Spotify は呼ばない） | X | X | X |   |   |
   * Spotify へ PUT（range_length は指定が無ければ 1）                    |   |   |   | 1 | 2 | 0
   * 境界: 0 は「指定あり」（偽の値でも必須チェックを通る）／range_length の既定値は「指定なし」のときだけ
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  it.each([
    { rule: 'RO1', label: 'range_start が無い', body: { insert_before: 1 } },
    { rule: 'RO2', label: 'insert_before が無い', body: { range_start: 1 } },
    { rule: 'RO3', label: '両方とも無い', body: {} },
  ])('[DT-13 $rule] $labelなら 400 を返し、Spotify は呼ばない', async ({ body }) => {
    const res = await callApi(app, { method: 'put', path: '/api/spotify/playlists/pl1/tracks', body }, sessionId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'range_start and insert_before are required' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { rule: 'RO4', label: '0・0・指定なし（境界）', body: { range_start: 0, insert_before: 0 }, sent: { range_start: 0, insert_before: 0, range_length: 1 } },
    { rule: 'RO5', label: '3・1・2', body: { range_start: 3, insert_before: 1, range_length: 2 }, sent: { range_start: 3, insert_before: 1, range_length: 2 } },
    { rule: 'RO6', label: '2・5・0（境界）', body: { range_start: 2, insert_before: 5, range_length: 0 }, sent: { range_start: 2, insert_before: 5, range_length: 0 } },
  ])('[DT-13 $rule] range_start・insert_before・range_length が $label → Spotify へ PUT する本文が正しい', async ({ body, sent }) => {
    h.fetchMock.mockResolvedValueOnce(spotifyEmpty(200));
    const res = await callApi(app, { method: 'put', path: '/api/spotify/playlists/pl1/tracks', body }, sessionId);
    expect(res.status).toBe(200);
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/playlists/pl1/tracks`);
    expect(options.method).toBe('PUT');
    expect(options.headers).toEqual({ Authorization: BEARER, 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual(sent);
  });

  it.todo('[DT-13 要確認] range_start・insert_before に null や文字列を送ったとき（今は必須チェックを通り、そのまま Spotify へ送る）');
});

describe('DT-14 PUT /api/spotify/playlists/:id（プレイリスト情報の更新）', () => {
  /*
   * 条件           | UP1      | UP2       | UP3                 | UP4
   * name           | あり     | あり      | なし                | なし
   * description    | あり     | なし      | ''（空）            | なし
   * public         | true     | なし      | false               | なし
   * -----------------------------------------------------------------------
   * Spotify へ PUT する本文 | 3 つとも | name だけ | description と public（偽の値も落とさない） | {}
   * ※ 必須の項目はなく、サーバーでは弾かない。指定が無い項目は送らない（部分更新）。
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  it.each([
    {
      rule: 'UP1',
      label: '3 つとも',
      body: { name: 'My list', description: 'desc', public: true },
      sent: { name: 'My list', description: 'desc', public: true },
    },
    { rule: 'UP2', label: 'name だけ', body: { name: 'My list' }, sent: { name: 'My list' } },
    { rule: 'UP3', label: '空の description と public: false', body: { description: '', public: false }, sent: { description: '', public: false } },
    { rule: 'UP4', label: '何もない', body: {}, sent: {} },
  ])('[DT-14 $rule] 指定が「$label」→ Spotify へ PUT する本文が正しい', async ({ body, sent }) => {
    h.fetchMock.mockResolvedValueOnce(spotifyEmpty(200));
    const res = await callApi(app, { method: 'put', path: '/api/spotify/playlists/pl1', body }, sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/playlists/pl1`);
    expect(options.method).toBe('PUT');
    expect(options.headers).toEqual({ Authorization: BEARER, 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual(sent);
  });
});

describe('DT-15 DELETE /api/spotify/playlists/:id/followers（プレイリストの削除＝フォロー解除）', () => {
  // 入力の条件はない（認証と応答の中継は DT-5・DT-7）
  it('[DT-15] 本文なしで Spotify へ DELETE する', async () => {
    const app = await loadServer();
    const sessionId = await login(app);
    h.fetchMock.mockResolvedValueOnce(spotifyEmpty(200));
    const res = await callApi(app, { method: 'delete', path: '/api/spotify/playlists/pl1/followers' }, sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/playlists/pl1/followers`);
    expect(options.method).toBe('DELETE');
    expect(options.headers).toEqual({ Authorization: BEARER });
    expect(options.body).toBeUndefined();
  });
});

describe('DT-16 GET /api/spotify/me（自分のユーザー情報）', () => {
  // 入力の条件はない（認証と応答の中継は DT-5・DT-6）
  it('[DT-16] Spotify の /v1/me を GET し、結果を返す', async () => {
    const app = await loadServer();
    const sessionId = await login(app);
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ id: 'user1', display_name: 'User 1' }));
    const res = await callApi(app, { method: 'get', path: '/api/spotify/me' }, sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'user1', display_name: 'User 1' });
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/me`);
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.headers).toEqual({ Authorization: BEARER });
  });
});

describe('DT-17 POST /api/spotify/users/:userId/playlists（プレイリストの作成）', () => {
  /*
   * 条件     | CR1  | CR2      | CR3   | CR4  | CR5   | CR6
   * name     | なし | ''（空） | あり  | あり | あり  | あり
   * public   | -    | -        | なし  | true | false | null
   * ---------------------------------------------------------
   * 400 name is required（Spotify は呼ばない） | X | X |   |   |   |
   * Spotify へ送る public                      |   |   | false | true | false | false
   * description: 指定なし → 送らない ／ 指定あり → そのまま送る
   */
  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
  });

  it.each([
    { rule: 'CR1', label: 'name が無い', body: { description: 'd' } },
    { rule: 'CR2', label: 'name が空文字', body: { name: '' } },
  ])('[DT-17 $rule] $labelなら 400 を返し、Spotify は呼ばない', async ({ body }) => {
    const res = await callApi(app, { method: 'post', path: '/api/spotify/users/user1/playlists', body }, sessionId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name is required' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { rule: 'CR3', label: '指定なし', body: { name: 'New' }, sentPublic: false },
    { rule: 'CR4', label: 'true', body: { name: 'New', public: true }, sentPublic: true },
    { rule: 'CR5', label: 'false', body: { name: 'New', public: false }, sentPublic: false },
    { rule: 'CR6', label: 'null', body: { name: 'New', public: null }, sentPublic: false },
  ])('[DT-17 $rule] public が「$label」→ Spotify へ public: $sentPublic で作成を頼む', async ({ body, sentPublic }) => {
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ id: 'pl-new', name: 'New' }, 201));
    const res = await callApi(app, { method: 'post', path: '/api/spotify/users/user1/playlists', body }, sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'pl-new', name: 'New' });
    const { rawUrl, options } = onlySpotifyCall();
    expect(rawUrl).toBe(`${SPOTIFY_API}/v1/users/user1/playlists`);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ Authorization: BEARER, 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ name: 'New', public: sentPublic }); // description は指定なしなので送らない
  });

  it('[DT-17 CR3] description を指定したら、そのまま送る', async () => {
    h.fetchMock.mockResolvedValueOnce(spotifyJson({ id: 'pl-new' }, 201));
    await callApi(
      app,
      { method: 'post', path: '/api/spotify/users/user1/playlists', body: { name: 'New', description: '説明 & メモ' } },
      sessionId,
    );
    expect(JSON.parse(onlySpotifyCall().options.body)).toEqual({ name: 'New', description: '説明 & メモ', public: false });
  });
});

// ===========================================================================
// 極端な値（共通）: パスの id
// ===========================================================================
describe('極端な値（共通）: パスの id・userId に記号や日本語が入るとき', () => {
  // 画面は encodeURIComponent した id を送る。サーバーは受け取った id を、Spotify の URL のパス 1 区切りとしてエンコードし直す。
  const rawId = 'a/b c?d#e&f=日本';
  const enc = encodeURIComponent(rawId);

  let app;
  let sessionId;
  beforeEach(async () => {
    app = await loadServer();
    sessionId = await login(app);
    h.fetchMock.mockImplementation(async () => spotifyJson({}));
  });

  it.each([
    { name: 'GET /playlists/:id/tracks', method: 'get', path: `/api/spotify/playlists/${enc}/tracks`, spotifyPath: `/v1/playlists/${enc}/tracks` },
    { name: 'POST /playlists/:id/tracks', method: 'post', path: `/api/spotify/playlists/${enc}/tracks`, body: { uris: ['spotify:track:t1'] }, spotifyPath: `/v1/playlists/${enc}/tracks` },
    { name: 'DELETE /playlists/:id/tracks', method: 'delete', path: `/api/spotify/playlists/${enc}/tracks`, body: { uris: ['spotify:track:t1'] }, spotifyPath: `/v1/playlists/${enc}/tracks` },
    { name: 'PUT /playlists/:id/tracks', method: 'put', path: `/api/spotify/playlists/${enc}/tracks`, body: { range_start: 0, insert_before: 1 }, spotifyPath: `/v1/playlists/${enc}/tracks` },
    { name: 'PUT /playlists/:id', method: 'put', path: `/api/spotify/playlists/${enc}`, body: { name: 'x' }, spotifyPath: `/v1/playlists/${enc}` },
    { name: 'DELETE /playlists/:id/followers', method: 'delete', path: `/api/spotify/playlists/${enc}/followers`, spotifyPath: `/v1/playlists/${enc}/followers` },
    { name: 'POST /users/:userId/playlists', method: 'post', path: `/api/spotify/users/${enc}/playlists`, body: { name: 'x' }, spotifyPath: `/v1/users/${enc}/playlists` },
  ])('[極端] $name: id「a/b c?d#e&f=日本」をパスの 1 区切りとして Spotify へ送る（別のパスやクエリに化けない）', async (endpoint) => {
    const res = await callApi(app, endpoint, sessionId);
    expect(res.status).toBe(200);
    const { url } = onlySpotifyCall();
    expect(url.origin).toBe(SPOTIFY_API);
    expect(url.pathname).toBe(endpoint.spotifyPath);
    expect(url.hash).toBe('');
  });

  it.todo(
    '[要確認] id が ".." のとき（今は https://api.spotify.com/v1/playlists/../tracks になり、URL が正規化されて Spotify の /v1/tracks を呼ぶ。:id を持つほかのエンドポイントも同じ）',
  );
});
