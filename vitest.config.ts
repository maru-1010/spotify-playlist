import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      // backend は別のパッケージ（backend フォルダで npm test）
      exclude: [...configDefaults.exclude, "backend/**"],
    },
  }),
);
