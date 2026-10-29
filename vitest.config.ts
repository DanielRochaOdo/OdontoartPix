import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  test: {
    environment: "node",
    // Testes de integração compartilham o mesmo PostgreSQL e executam TRUNCATE/DDL.
    // Evita deadlocks entre arquivos rodando em paralelo no CI.
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/.codex-main-process-batches/**"]
  }
});
