import { defineConfig } from "vite";
import base from "./vite.config";

export default defineConfig(async (env) => {
  const config = await base(env);
  return {
    ...config,
    define: { ...config.define, "import.meta.env.VITE_DBX_CODEX_APP": "true" },
    build: {
      ...config.build,
      outDir: "../../target/codex-ui",
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      modulePreload: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
    worker: { format: "es", rollupOptions: { output: { inlineDynamicImports: true } } },
  };
});
