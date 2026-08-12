/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_NUMBER__: string;
declare const __GIT_HASH__: string;
declare const __APP_AUTHOR__: string;
declare const __APP_PUBLISHER__: string;
declare const __APP_COPYRIGHT__: string;

// Nothing in the app touches a node builtin, so @types/node is deliberately not a
// dependency. `src/test/themeContrast.test.ts` is the sole exception: it reads
// `app.css` to parse the `@theme` baseline that the default theme falls through
// to, rather than mirroring those 20 values into a second place that can drift.
// A vite `?raw` import would avoid this, but vitest stubs CSS imports to an empty
// string. Only the one signature that test uses is declared.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

// pdfjs-dist ships no `.d.mts` for its worker entry (verified: `build/pdf.d.mts`
// is absent entirely and `legacy/build/pdf.worker.d.mts` too), so the deep import
// needed to install the main-thread message handler is untyped and fails `strict`.
// Only `WorkerMessageHandler` is ever read off it — see `lib/pdfText.ts`.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
