# 実験②：頼み方を工夫したら、AIは観点をどこまで拾えるようになるか

Zenn の連載「AI時代にテスト設計を学び直す」第3回のための実験です。
[実験①](../01-ai-test-generation/)と同じ題材・同じ4箇所で、頼み方だけを工夫した文面（after）で、AI（Claude Code）にテストを書かせます。実験①（before）と同じ観点表（17観点）で採点し、拾える観点がどう変わるかを比べます。

- 第2回の記事（実験①）: https://zenn.dev/a_maru/articles/9772ee99aee3d1
- 物差しにした観点表（17観点・実験①と同じ）: [../01-ai-test-generation/viewpoints.md](../01-ai-test-generation/viewpoints.md)
- 採点の結果: 採点の後に追加します

## 実験の条件

- AI: Claude Code（モデル: Opus 5.5）
- 対象: 実験①と同じ4箇所。1箇所につき1回、毎回新しいセッションで頼んだ
- 始めた状態: 実験①と同じ、テストの道具を入れただけの状態（コミット `55c67a0`）。4回それぞれ、`55c67a0` から切ったブランチと作業フォルダで、同時に実行した。どの回も、ほかの回や実験①のテストが無い状態から始めた
- 頼み方: 4回とも同じ型の文面で、違うのは対象ファイルと使う技法だけ（[prompt.md](prompt.md)）。CT-GenAI 2章のプロンプトの組み立て方に沿って組み、実験①で漏れたことに効く指示を足した。観点表は渡していない
- 途中で指示を足していない（AIからの質問は、どの回もなかった）
- AIが書いたテストは、手を加えずにそのままコミットした

## 対象と結果

| 回 | 対象 | 使う技法 | テストファイル（ブランチ） | 件数と結果 |
|---|---|---|---|---|
| 1 | `src/components/CreatePlaylistModal.tsx`・`EditPlaylistModal.tsx` | 同値分割と境界値分析 | `src/components/__tests__/*.test.tsx`（共通部品 `testUtils.ts` を含む）（`exp2/r1`） | 130件：成功113、skip 4、todo 13 |
| 2 | `src/auth.ts` | 状態遷移テスト | `src/auth.test.ts`（`exp2/r2`） | 87件：成功74、失敗5、todo 8 |
| 3 | `backend/src/server.js` | デシジョンテーブルテスト | `backend/test/server.test.js`（`exp2/r3`） | 194件：成功184、todo 10 |
| 4 | `src/api.ts` | エラー推測 | `src/api.test.ts`（`exp2/r4`） | 109件：成功104、skip 5 |

- テストは回ごとのブランチ（`exp2/r1`〜`exp2/r4`）にあります。実験①のテストと同じ場所に作られた回があるため、main には入れていません
- skip・todo・失敗の意味と、くわしい記録は [run-log.md](run-log.md)、AIの最終報告の原文は [reports/](reports/) にあります

## テストの動かし方

```bash
git switch exp2/r1   # 回ごとに exp2/r1〜exp2/r4 を切り替える
npm install
npm test            # 画面側（1・2・4回目のテスト）
cd backend
npm install
npm test            # サーバー側（3回目のテスト）
```
