import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "child_process";
import { readFileSync } from "fs";

const host = process.env.TAURI_DEV_HOST;

function getGitInfo() {
  try {
    const buildNumber = execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim();
    const gitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    return { buildNumber, gitHash };
  } catch {
    return { buildNumber: "0", gitHash: "unknown" };
  }
}

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
// Attribution is NOT app copy: `publisher`/`copyright` are the fields Tauri
// stamps into the bundle itself (Info.plist NSHumanReadableCopyright on macOS,
// installer metadata elsewhere), and `author` is npm's. The About panel reads
// those same manifests so the window and the .app can never disagree.
// `src-tauri/**` is excluded from the dev watcher, so editing tauri.conf.json
// needs a dev-server restart to show up — as with the git hash below.
const tauriConf = JSON.parse(readFileSync("./src-tauri/tauri.conf.json", "utf-8"));
// npm allows a bare string or { name, email, url }.
const author = typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "");
const { buildNumber, gitHash } = getGitInfo();

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  // pdf.js is a 3.4MB pair of fully self-contained ESM files (verified: zero static
  // imports, zero process.env), and it is loaded by a DYNAMIC import so it never
  // enters the main chunk. Excluding it from dep pre-bundling matters in DEV: the
  // first PDF a user drops would otherwise trigger "new dependencies optimized,
  // reloading", and a full page reload destroys every open terminal mid-session.
  // No effect on `vite build`.
  optimizeDeps: {
    exclude: [
      "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_NUMBER__: JSON.stringify(process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || buildNumber),
    __GIT_HASH__: JSON.stringify(gitHash),
    __APP_AUTHOR__: JSON.stringify(author),
    __APP_PUBLISHER__: JSON.stringify(tauriConf.bundle?.publisher ?? ""),
    __APP_COPYRIGHT__: JSON.stringify(tauriConf.bundle?.copyright ?? ""),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
