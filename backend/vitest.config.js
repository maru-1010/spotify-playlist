import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // it.each でテスト名に埋め込む URL などを「…」で省略させない（既定は 40 文字）
    taskTitleValueFormatTruncate: 200,
  },
});
