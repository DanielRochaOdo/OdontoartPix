const { existsSync, rmSync } = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const distDir = path.join(process.cwd(), ".next-dev");
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}

const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev"], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
