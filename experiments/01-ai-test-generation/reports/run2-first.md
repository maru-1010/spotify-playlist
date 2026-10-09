# 参考：2回目の最初の実行（auth.ts）— Claude Code の最終報告（原文）

- 対象: `src/auth.ts`
- 時刻: 2026-10-09 10:54〜11:09（Opus 5.5）
- 1回目のテストがリポジトリに残った状態で実行したため、参考扱い（正式な2回目は run2.md）
- テストのコミット: `7591473`（ブランチ `exp1/r2-first`）

---

実行結果（npm test）
全体では3ファイル・69件のうち、68件が成功し1件が失敗しました（終了コード 1）
src/auth.test.ts は17件中16件が成功しました。既存のモーダルのテスト52件はすべて成功です
型チェック（tsc -b）と ESLint はどちらも通っています
FAIL  handleCallback > トークン交換に失敗した場合 > エラーの応答が JSON でなければ（…）、本文のテキストを示してエラーにする
Expected: "token exchange failed: 502 Bad Gateway"
Received: "Body is unusable: Body has already been read"
見つかった不具合

src/auth.ts:68 のエラー処理は、まず res.json() で本文を読み、失敗したら res.text() で読み直そうとします。しかし fetch の応答本文は1回しか読めないため、res.text() が TypeError で失敗します。

影響: プロキシの 502 ページなど、JSON でないエラー応答が返ったときに起きます。ステータスもサーバーのメッセージも失われ、画面の alert には「body stream already read」のような分かりにくい文言が出ます。ブラウザでも同じ動きです
テスト方法: json と text を何度でも読める手作りのモックだと、この不具合は見逃されます。そのため応答はすべて本物の Response で作りました
同じ書き方の箇所: src/api.ts:78 にもあります（今回は対象外なのでテストは書いていません）
直し方: 本文を res.text() で1回だけ読み、そのあと JSON.parse を試す形が素直です。修正は別タスクとして提案を出しておきました
テストの中身
対象	確かめていること
beginLogin（3件）	認可URLのパラメータ（client_id・redirect_uri・S256・challenge・scope・state）／verifier を URL に載せない／redirect_uri を保存し、認可時のものと一致させる／PKCE の生成に失敗したら何も保存せず遷移もしない
handleCallback 成功時（7件）	POST の宛先・ヘッダー・ボディ／トークンの保存形式と expires_at（ミリ秒）／refresh_token が無いときは null／sessionStorage に無いときは localStorage を使う／両方にあるときは sessionStorage を優先／VITE_API_BASE_URL が未設定・空のときの既定値
handleCallback 失敗時（7件）	code が無い（認可拒否）／verifier・redirect_uri が無い／バックエンドに接続できない／JSON のエラー応答／error の無い応答／JSON でないエラー応答（失敗中の1件）。どの場合もトークンを保存しないこと

モックの方針は次のとおりです。

通信: fetch は vi.stubGlobal で差し替えており、実際の通信は発生しません
遷移: Spotify 認可画面への遷移は jsdom が実装していないため、location を遷移先を記録するだけのオブジェクトに差し替えました
固定値: pkcePair の乱数、Date.now、環境変数を固定値にしたので、各自の .env の内容に結果が左右されません
読み込み直し: API_BASE_URL は auth.ts を読み込んだ時点で決まるため、テストごとに環境変数を設定してから読み込み直しています
テストが効いているかの確認

src/auth.ts のコピーを一時フォルダに作って試しました。確認後に一時フォルダは削除しています。

修正版のコピー: 上記の直し方を入れると17件すべて成功しました。失敗中のテストは、コードを直せばそのまま通ります
誤り入りのコピー: 修正版にわざと誤りを1つずつ入れた12種類（S256→plain、* 1000 の書き忘れ、|| と ?? の取り違えなど）は、すべて狙ったテストが失敗して検出できました
補足
失敗する1件は、it.fails（失敗を想定済みとする書き方）にせず、普通のテストのまま残しました。修正までスイートを成功させておきたい場合は、it.fails に変えます
テスト以外で気づいた点があります。beginLogin は state を送っていますが、コールバック側で照合していません。CSRF 対策は PKCE で効いているので、急ぎではありません
