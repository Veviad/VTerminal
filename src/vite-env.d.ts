/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_NUMBER__: string;
declare const __GIT_HASH__: string;
declare const __APP_AUTHOR__: string;
declare const __APP_LICENSE__: string;
declare const __APP_PUBLISHER__: string;
declare const __APP_COPYRIGHT__: string;

// Nothing in the production app touches a node builtin, so @types/node is
// deliberately not a dependency. Tests use readFileSync to verify checked-in
// styles and project metadata without duplicating values that can drift. Only
// the signatures those tests use are declared. Shell protocol tests also run
// available local shells with a bounded, synthetic command.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:child_process" {
  export function spawnSync(
    executable: string,
    args: string[],
    options: { encoding: "utf8"; timeout: number; env: Record<string, string> },
  ): { error?: Error; status: number | null; stdout: string; stderr: string };
}

// pdfjs-dist ships no `.d.mts` for its worker entry (verified: `build/pdf.d.mts`
// is absent entirely and `legacy/build/pdf.worker.d.mts` too), so the deep import
// needed to install the main-thread message handler is untyped and fails `strict`.
// Only `WorkerMessageHandler` is ever read off it — see `lib/pdfText.ts`.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
