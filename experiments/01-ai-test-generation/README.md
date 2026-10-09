# 実験①：AIが生成したテストを、テスト観点表で採点する

Zenn の連載「AI時代にテスト設計を学び直す」第2回のための実験です。
AI（Claude Code）に、この題材アプリのテストを書かせます。そのテストを、テスト設計の技法で作った観点表（17観点）を物差しにして採点し、AIが観点をどこまで拾えるかを確かめます。

- 第1回の記事: https://zenn.dev/a_maru/articles/2b2507342a765c
- 採点の結果（観点表と採点表）は、あとから追加します

## 実験の条件

- AI: Claude Code（モデル: Opus 5.5）
- 対象: 下の表の4箇所。1箇所につき1回、毎回新しいセッションで頼んだ
- 始めた状態: テストの道具（画面側は Vitest・Testing Library・jsdom、backend は Vitest・supertest）を入れただけの状態（コミット `55c67a0`）。どの回も、ほかの回が作ったテストが無い状態から始めた
- 頼み方: 4回とも同じ文面で、違うのは対象ファイルだけ（[prompt.md](prompt.md)）。テスト観点や技法（境界値・異常系など）は、あえて書いていない
- 途中で指示を足していない（AIからの質問は、どの回もなかった）
- AIが書いたテストは、手を加えずにそのままコミットした

## 対象と結果

| 回 | 対象 | テストファイル | 件数と結果 |
|---|---|---|---|
| 1 | `src/components/CreatePlaylistModal.tsx`・`EditPlaylistModal.tsx` | `src/components/*.test.tsx` | 52件、すべて成功 |
| 2 | `src/auth.ts` | `src/auth.test.ts` | 17件（16件成功、1件は想定どおりの失敗＝AIが見つけた不具合の記録） |
| 3 | `backend/src/server.js` | `backend/test/server.test.js` | 134件、すべて成功 |
| 4 | `src/api.ts` | `src/api.test.ts` | 33件、すべて成功 |

くわしい記録は [run-log.md](run-log.md)、AIの最終報告の原文は [reports/](reports/) にあります。

## テストの動かし方

```bash
npm install
npm test        # 画面側（1・2・4回目のテスト）
cd backend
npm install
npm test        # サーバー側（3回目のテスト）
```

## 参考：2回目の最初の実行

2回目（auth.ts）は、最初に実行したとき、1回目のテストがリポジトリに残っていました。ほかの回と条件をそろえるため、テストの道具を入れただけの状態から実行し直し、そちらを正式な結果にしました。
最初の実行の結果は、ブランチ `exp1/r2-first` に残しています。同じ文面でもAIの出力が変わる例として、参考にしてください。
