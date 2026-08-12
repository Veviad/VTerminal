import React from "react";
import ReactDOM from "react-dom/client";
import { error as logError } from "@tauri-apps/plugin-log";
import App from "./App";
import "./app.css";

// A blank window is the worst failure mode this app has: React unmounts the
// whole tree on a render throw, and because nothing here writes to the Rust
// log, `tauri dev` shows a clean build and a black rectangle. Nobody can debug
// that without opening devtools.
//
// So: keep the message on screen, and forward it through tauri-plugin-log so it
// also lands in the terminal that launched the app.
function reportFatal(context: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const message = `${context}: ${detail}`;
  // eslint-disable-next-line no-console
  console.error(message);
  // Fire-and-forget: this path is already broken, a failed log must not mask it.
  void logError(message).catch(() => {});
}

window.addEventListener("error", (e) => reportFatal("Uncaught error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportFatal("Unhandled rejection", e.reason));

interface BoundaryState {
  message: string | null;
}

/** Last resort: render the error instead of nothing. */
class FatalBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { message: null };

  static getDerivedStateFromError(err: unknown): BoundaryState {
    return { message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: React.ErrorInfo): void {
    reportFatal("React render failed", `${String(err)}\n${info.componentStack ?? ""}`);
  }

  render(): React.ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div
        style={{
          padding: "24px",
          fontFamily: "ui-monospace, monospace",
          fontSize: "12px",
          lineHeight: 1.6,
          color: "#f87171",
          whiteSpace: "pre-wrap",
        }}
      >
        {`VTerminal failed to render.\n\n${this.state.message}\n\nThe full stack is in the terminal that started the app.`}
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FatalBoundary>
      <App />
    </FatalBoundary>
  </React.StrictMode>,
);
