/**
 * AI tab naming.
 *
 * Two entry points, one code path: an explicit "Rename with AI" (force) and an
 * opportunistic auto-name after the first AI exchange in a tab. The rules that
 * matter:
 *
 *  - A human's rename is final. `userTitle` set → we never touch that tab again.
 *  - Never compete with the user's own request. The local model serves one
 *    generation at a time, so a naming call while that tab is streaming would
 *    make the visible answer slower. We SKIP rather than queue.
 *  - Own request-id namespace, so cancelling the visible stream (or this) cannot
 *    cancel the other.
 */
import * as api from "./tauri";
import { useAppStore } from "../stores/appStore";
import { cwdLabel } from "./sessionTitle";

/** Enough context to name a session without shipping a transcript. */
const MAX_COMMANDS = 8;
const MAX_DIGEST_CHARS = 600;

/** Auto-naming waits for this much of a lull, so a burst of activity produces
 *  one call rather than one per event. */
const DEBOUNCE_MS = 2_000;

/** Below this, an unnamed tab has not shown us enough to name it. Bypassed by
 *  an explicit request. */
const MIN_COMMANDS_FOR_AUTO = 3;

const inFlight = new Set<string>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Sessions already auto-named once. An explicit request ignores this. */
const autoNamed = new Set<string>();
let requestSeq = 0;

/** Drives the per-tab spinner. */
export function isNaming(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

/** Compact, model-facing description of what this tab has been doing. */
function buildDigest(sessionId: string): string | null {
  const state = useAppStore.getState();
  const ui = state.sessionUi[sessionId];
  if (!ui) return null;

  const parts: string[] = [];
  // While nested, the local cwd describes another machine — same rule the AI
  // context builder follows.
  if (ui.remote) {
    parts.push(`Connected to: ${ui.remote.target ?? ui.remote.kind}`);
  } else {
    const dir = cwdLabel(ui.cwd);
    if (dir) parts.push(`Directory: ${dir}`);
  }

  const commands = ui.blocks
    .map((b) => b.command.trim())
    .filter(Boolean)
    .slice(-MAX_COMMANDS);
  if (commands.length > 0) parts.push(`Commands:\n${commands.join("\n")}`);

  // The user's own words are the strongest signal available, so include the
  // first thing they asked in this tab.
  const firstAsk = state.aiStreams[sessionId]?.messages.find((m) => m.role === "user")?.content;
  if (firstAsk) parts.push(`Asked: ${firstAsk.slice(0, 200)}`);

  const digest = parts.join("\n");
  return digest.trim() ? digest.slice(0, MAX_DIGEST_CHARS) : null;
}

function canName(sessionId: string, force: boolean): boolean {
  const state = useAppStore.getState();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return false;
  // A human already named this tab; that decision stands.
  if (session.userTitle) return false;
  // Naming costs a second inference per exchange, billed on whatever model is
  // selected. It is opt-out-able for exactly that reason.
  if (!state.aiSessionNaming) return false;
  // Not modelState: an API model is ready without anything being "loaded".
  if (!state.aiReady()) return false;
  if (inFlight.has(sessionId)) return false;
  // Don't make the user's own generation wait behind a cosmetic one.
  const status = state.aiStreams[sessionId]?.status;
  if (status && status !== "idle" && status !== "error") return false;
  if (force) return true;
  if (autoNamed.has(sessionId) || session.aiTitle) return false;
  const commands = state.sessionUi[sessionId]?.blocks.filter((b) => b.command.trim()).length ?? 0;
  return commands >= MIN_COMMANDS_FOR_AUTO;
}

async function run(sessionId: string, force: boolean): Promise<void> {
  if (!canName(sessionId, force)) return;
  const digest = buildDigest(sessionId);
  if (!digest) return;

  inFlight.add(sessionId);
  // The spinner lives in module state, which zustand does not track — nudge the
  // store so TabStrip re-renders. A no-op patch is enough to notify subscribers.
  useAppStore.getState().updateSession(sessionId, {});
  try {
    const title = await api.aiNameSession(`title-${sessionId}-${++requestSeq}`, digest);
    autoNamed.add(sessionId);
    const store = useAppStore.getState();
    // The tab may have been closed, or renamed by hand, while we were waiting.
    const live = store.sessions.find((s) => s.id === sessionId);
    if (!live || live.userTitle) return;
    if (title.trim()) store.updateSession(sessionId, { aiTitle: title.trim() });
  } catch (err) {
    // A failed cosmetic rename is not worth interrupting anyone over; the tab
    // keeps its derived label.
    console.warn(`naming tab ${sessionId} failed:`, err);
  } finally {
    inFlight.delete(sessionId);
    useAppStore.getState().updateSession(sessionId, {});
  }
}

/**
 * Name a tab from its context.
 * @param force explicit user request — bypasses the "already named" and
 *              "enough history" gates, but never the `userTitle` rule.
 */
export function nameSession(sessionId: string, opts: { force?: boolean } = {}): void {
  const force = opts.force ?? false;
  const existing = debounceTimers.get(sessionId);
  if (existing !== undefined) clearTimeout(existing);
  // An explicit click should feel immediate; auto-naming coalesces.
  if (force) {
    debounceTimers.delete(sessionId);
    void run(sessionId, true);
    return;
  }
  debounceTimers.set(
    sessionId,
    setTimeout(() => {
      debounceTimers.delete(sessionId);
      void run(sessionId, false);
    }, DEBOUNCE_MS),
  );
}

/** Called on tab close so a pending timer cannot fire against a dead session. */
export function cancelNaming(sessionId: string): void {
  const timer = debounceTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    debounceTimers.delete(sessionId);
  }
  inFlight.delete(sessionId);
  autoNamed.delete(sessionId);
}

/** Test seam. */
export function __resetNamingForTests(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  inFlight.clear();
  autoNamed.clear();
  requestSeq = 0;
}
