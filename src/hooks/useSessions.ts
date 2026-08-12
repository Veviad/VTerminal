import { useCallback } from "react";
import * as api from "../lib/tauri";
import { useAppStore } from "../stores/appStore";
import {
  disposeTerm,
  emitTerm,
  getOrCreateTerm,
  getTerm,
  releaseWebgl,
  acquireWebgl,
} from "../lib/termRegistry";
import { detectNesting } from "../lib/nesting";
import { abortSession, resetSessionMode } from "../lib/ptyExec";
import { sanitizeCommand } from "../lib/ptyExecShell";
import { clearPendingConnect, takePendingConnect } from "../lib/sshConnect";
import { replayScrollback, subscribeTerm } from "../lib/termRegistry";
import { trackSession } from "../lib/sessionPersistence";
import { archiveOnClose } from "../lib/sessionArchive";
import { replayBanner } from "../lib/replayBanner";
import { nextOrdinal, shortenCommand } from "../lib/sessionTitle";
import { cancelNaming } from "../lib/sessionNaming";
import type {
  Block,
  LaunchSpec,
  Session,
  SessionSnapshotMeta,
  WorkspaceRestore,
} from "../lib/types";

let sessionCounter = 1;

/** How long to wait for a freshly spawned shell to draw its first prompt before
 *  typing an initial command into it anyway. `zsh -il` sourcing nvm/rbenv/p10k
 *  can take a while; typing early usually survives (the tty buffers it) but the
 *  OSC 6973;CMD echo can be missed, which costs the whole nesting/title path. */
const FIRST_PROMPT_WAIT_MS = 8_000;

/** How long a command must run before the tab is named after it. Short enough to
 *  catch a dev server or a build, long enough that `ls` and `git status` never
 *  flicker the label. */
const LONG_RUNNING_MS = 1_500;

/** Pending "name the tab after this command" timers, keyed by session. Module
 *  level for the same reason xterm instances are: these outlive renders and must
 *  be cancellable from the block callbacks. */
const longRunningTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearLongRunningTimer(sessionId: string): void {
  const timer = longRunningTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    longRunningTimers.delete(sessionId);
  }
}

/** Resolve once the shell reaches its input phase (OSC 133;B), or on timeout /
 *  teardown. Never rejects — a missed prompt must not sink the tab. */
function waitForFirstPrompt(sessionId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeTerm(sessionId, (e) => {
      if (e.type === "disposed" || (e.type === "phase" && e.phase === "input")) finish();
    });
  });
}

// Session creation wires everything together exactly once (NOT per React
// mount): xterm instance, BlockTracker callbacks → store, PTY spawn, raw data
// channel with ack-based flow control, keystroke forwarding.
export function useSessions() {
  const createSession = useCallback(async (spec: LaunchSpec = {}): Promise<string> => {
    const store = useAppStore.getState();
    const sessionId = `sess-${Date.now()}-${sessionCounter++}`;
    const shell = spec.shell?.trim() || store.shellPath || "/bin/zsh";

    const session: Session = {
      id: sessionId,
      shell,
      cwd: spec.cwd ?? null,
      createdAt: new Date().toISOString(),
      exited: false,
      exitCode: null,
      hostId: spec.hostId ?? null,
      hostLabel: spec.title ?? null,
      userTitle: spec.userTitle ?? null,
      aiTitle: null,
      ordinal: nextOrdinal(store.sessions),
      archivedFrom: spec.archivedFrom ?? null,
    };
    // addSession and getOrCreateTerm must stay in the SAME tick: React cannot
    // render between them, so TerminalView's effect always finds the entry.
    store.addSession(session, spec.activate ?? true);

    const entry = getOrCreateTerm(
      sessionId,
      {
        fontSize: store.fontSize,
        scrollback: store.scrollbackLines,
        cursorStyle: store.cursorStyle,
        cursorBlink: store.cursorBlink,
        themeId: store.theme,
      },
      {
        onBlockStart: (blockId, command, startMarker) => {
          // Keep the LIVE marker — marker.line shifts with scrollback trimming
          // and reflow; static snapshots would drift (gutter/off-buffer reads).
          getTerm(sessionId)?.blockMarkers.set(blockId, { start: startMarker, end: null });
          const block: Block = {
            id: blockId,
            sessionId,
            command,
            state: "running",
            exitCode: null,
            startLine: startMarker.line,
            endLine: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
            origin: "user",
          };
          useAppStore.getState().startBlock(sessionId, block);
          // `ssh host` opening means every OSC after this describes a DIFFERENT
          // machine — until this block ends, the local cwd is not the truth.
          const nested = detectNesting(command);
          if (nested) {
            // Claimed only on an exact command match, so a connect the user
            // typed by hand still gets `remote` but no saved-host identity.
            const connect = takePendingConnect(sessionId, command);
            useAppStore.getState().updateSessionUi(sessionId, {
              remote: nested,
              nestedBlockId: blockId,
              remoteHost: connect
                ? { id: connect.hostId, label: connect.label, color: connect.color }
                : null,
            });
            // Frecency counts commands that actually reached a shell, not
            // palette clicks that were never typed.
            if (connect) void api.sshHostsTouch(connect.hostId).catch(() => {});
          }
          // Name the tab after this command, but only once it has proven itself
          // slow. A nested session gets its label from `remote` instead.
          clearLongRunningTimer(sessionId);
          if (!nested) {
            const label = shortenCommand(command);
            if (label) {
              longRunningTimers.set(
                sessionId,
                setTimeout(() => {
                  longRunningTimers.delete(sessionId);
                  const live = useAppStore.getState();
                  // Still the same command? A fast block that finished and was
                  // replaced must not hand its label to its successor.
                  if (live.sessionUi[sessionId]?.runningBlockId !== blockId) return;
                  live.updateSessionUi(sessionId, { longRunningCommand: label });
                }, LONG_RUNNING_MS),
              );
            }
          }
          emitTerm(sessionId, { type: "blockStart", blockId, command });
        },
        onBlockEnd: (blockId, exitCode, endMarker) => {
          const s = useAppStore.getState();
          const markers = getTerm(sessionId)?.blockMarkers.get(blockId);
          if (markers && endMarker) markers.end = endMarker;
          const block = s.sessionUi[sessionId]?.blocks.find((b) => b.id === blockId);
          s.finishBlock(sessionId, blockId, exitCode, endMarker?.line ?? null);
          clearLongRunningTimer(sessionId);
          if (s.sessionUi[sessionId]?.longRunningCommand) {
            s.updateSessionUi(sessionId, { longRunningCommand: null });
          }
          // `ssh` returned — we are back on the local shell, so local cwd is
          // trustworthy again and any remote exec mode must be forgotten.
          if (s.sessionUi[sessionId]?.nestedBlockId === blockId) {
            s.updateSessionUi(sessionId, { remote: null, nestedBlockId: null, remoteHost: null });
            resetSessionMode(sessionId);
          }
          emitTerm(sessionId, {
            type: "blockEnd",
            blockId,
            exitCode,
            endLine: endMarker?.line ?? null,
          });
          // Persist to history (fire-and-forget; backend checks the setting too)
          if (block && s.historyEnabled && block.command.trim()) {
            const startedAt = new Date(block.startedAt);
            void api
              .historyRecord({
                session_id: sessionId,
                cwd: s.sessionUi[sessionId]?.cwd ?? "",
                command: block.command,
                exit_code: exitCode,
                duration_ms: Date.now() - startedAt.getTime(),
                output_tail: null,
                git_branch: s.sessionUi[sessionId]?.gitBranch ?? null,
                started_at: block.startedAt,
              })
              .catch(() => {});
          }
        },
        onBlockTrimmed: (blockId) => {
          getTerm(sessionId)?.blockMarkers.delete(blockId);
          useAppStore.getState().trimBlock(sessionId, blockId);
          emitTerm(sessionId, { type: "blockTrimmed", blockId });
        },
        onCwdChange: (cwd, host) => {
          const s = useAppStore.getState();
          // While nested, OSC 7 describes a DIFFERENT machine. Our own remote
          // hook deliberately emits only OSC 6973;RD, but plenty of distros
          // ship their own (VTE's __vte_osc7 in /etc/bash.bashrc, iTerm2's
          // remote integration). Recording that path would rename the tab
          // after a remote directory and — once sessions are persisted — hand
          // a remote path to the next spawn as a local cwd.
          if (s.sessionUi[sessionId]?.remote) {
            s.updateSessionUi(sessionId, { host, integrationActive: true });
            return;
          }
          s.updateSessionUi(sessionId, { cwd, host, integrationActive: true });
          // Only the cwd is recorded — the label is derived from it by
          // `resolveSessionTitle`. Writing a title here is what named every
          // fresh tab `maholick`: basename($HOME) is the username.
          s.updateSession(sessionId, { cwd });
        },
        onPhaseChange: (phase) => {
          useAppStore.getState().updateSessionUi(sessionId, { phase, integrationActive: true });
          emitTerm(sessionId, { type: "phase", phase });
        },
        onOscPrivate: (payload) => emitTerm(sessionId, { type: "osc", payload }),
      },
      // "#" at an empty prompt opens the AI composer
      () => useAppStore.getState().updateSessionUi(sessionId, { composerOpen: true }),
    );

    // Seed the status bar before the first OSC 7 arrives. Legal only here:
    // withSessionUi no-ops for ids not in `sessions`, and addSession ran above.
    if (spec.cwd) store.updateSessionUi(sessionId, { cwd: spec.cwd });

    // A restored tab's container is not laid out yet (inactive panes render
    // `hidden`, so fit() bails on offsetParent). Seed the caller's dims so the
    // shell spawns at the right size instead of 80x24 and reflowing on first view.
    if (spec.dims) entry.term.resize(spec.dims.cols, spec.dims.rows);

    // Replay BEFORE the spawn and await the parse: the shell's first bytes then
    // cannot interleave with the payload, and the new prompt lands cleanly
    // below the separator. This ordering is the real replay guard — the
    // tracker suspension inside replayScrollback is defence in depth.
    if (spec.replay) await replayScrollback(sessionId, spec.replay);

    // Keystrokes → PTY
    entry.term.onData((d) => void api.ptyWrite(sessionId, d));

    // Copy-on-select (checked live so the setting applies without recreating)
    entry.term.onSelectionChange(() => {
      const s = useAppStore.getState();
      if (s.copyOnSelect && entry.term.hasSelection()) {
        void navigator.clipboard.writeText(entry.term.getSelection());
      }
    });

    // PTY output → xterm, with write-callback ack flow control (~256 KB)
    try {
      await api.ptySpawn(
      sessionId,
      {
        cols: entry.term.cols,
        rows: entry.term.rows,
        cwd: spec.cwd ?? null,
        shell: spec.shell ?? null,
      },
      (buf) => {
        const bytes = new Uint8Array(buf);
        entry.term.write(bytes, () => {
          entry.unackedBytes += bytes.byteLength;
          if (entry.unackedBytes >= 262_144) {
            const n = entry.unackedBytes;
            entry.unackedBytes = 0;
            void api.ptyAck(sessionId, n);
          }
        });
      },
      (event) => {
        if (event.type === "Exit") {
          api.releasePtyChannels(sessionId);
          useAppStore.getState().updateSession(sessionId, {
            exited: true,
            exitCode: event.exit_code,
          });
        } else if (event.type === "Error") {
          console.error(`PTY error (${sessionId}):`, event.message);
        }
      },
      );
    } catch (err) {
      // Spawn failed (bad shell path etc.) — keep the tab visible but mark it
      // exited with the error written into the terminal, instead of leaving a
      // silent zombie.
      console.error(`pty_spawn failed (${sessionId}):`, err);
      entry.term.write(`\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`);
      useAppStore.getState().updateSession(sessionId, { exited: true, exitCode: null });
      return sessionId;
    }

    // Resize forwarding is wired only AFTER the spawn — the seed resize above
    // would otherwise fire pty_resize at a session Rust has never heard of.
    entry.term.onResize(({ cols, rows }) => {
      void api.ptyResize(sessionId, cols, rows).catch(() => {});
      if (useAppStore.getState().activeSessionId === sessionId) {
        useAppStore.getState().setTermDims(cols, rows);
      }
    });

    // An initial command is user-authored (a saved host, a Reconnect click) and
    // still goes through the same gate the agent's commands use — one chokepoint
    // for turning a string into an executed command line.
    if (spec.initialCommand) {
      const gated = sanitizeCommand(spec.initialCommand);
      if (gated.ok) {
        void waitForFirstPrompt(sessionId, FIRST_PROMPT_WAIT_MS).then(() => {
          void api.ptyWrite(sessionId, `${gated.command}\r`).catch(() => {});
        });
      } else {
        console.error(`initial command rejected (${sessionId}): ${gated.reason}`);
      }
    }

    // Flush any bytes below the ack threshold on a timer so long-idle sessions
    // don't hold back the backend's outstanding counter.
    const ackFlush = setInterval(() => {
      if (entry.disposed) {
        clearInterval(ackFlush);
        return;
      }
      if (entry.unackedBytes > 0) {
        const n = entry.unackedBytes;
        entry.unackedBytes = 0;
        void api.ptyAck(sessionId, n);
      }
    }, 1000);

    trackSession(sessionId);
    return sessionId;
  }, []);

  /**
   * Rebuild last run's tabs. Never throws and never rejects — a failed restore
   * must degrade to "one fresh tab", not to a dead app. Returns how many tabs
   * were actually created so App can decide whether to open a default one.
   */
  const restoreSessions = useCallback(async (): Promise<number> => {
    let ws: WorkspaceRestore;
    try {
      ws = await api.workspaceRestore();
    } catch (err) {
      console.warn("session restore failed:", err);
      return 0;
    }
    if (ws.sessions.length === 0) return 0;

    const ordered = [...ws.sessions].sort((a, b) => a.tab_index - b.tab_index);
    const activeIdx = Math.max(
      0,
      ordered.findIndex((s) => s.session_id === ws.active_session_id),
    );
    const ids: (string | undefined)[] = new Array(ordered.length);

    const createOne = async (
      snap: SessionSnapshotMeta,
      extra: Pick<LaunchSpec, "activate" | "dims">,
    ): Promise<string> => {
      let replay: string | null = null;
      if (snap.scrollback_lines > 0) {
        try {
          const stored = await api.workspaceScrollback(snap.session_id);
          if (stored) replay = stored + restoreBanner(snap, extra.dims?.cols ?? 80, ws.crashed);
        } catch (err) {
          console.warn(`scrollback fetch failed (${snap.session_id}):`, err);
        }
      }
      // A FRESH session id, deliberately: reusing the old one would merge two
      // runs in command_history and make the timestamp baked into the id a lie.
      // The snapshot carries one sticky label. Which field it belongs in is
      // decided by `host_id`: a host tab's label is its host identity, anything
      // else was named by the user (or by the model, which the user kept).
      // Derived labels are persisted as "" precisely so they do NOT come back
      // pinned — that is what used to make `maholick` survive a restart.
      const sticky = snap.title || null;
      return createSession({
        cwd: snap.cwd,
        shell: snap.shell,
        hostId: snap.host_id,
        title: snap.host_id ? sticky : null,
        userTitle: snap.host_id ? null : sticky,
        replay,
        ...extra,
      });
    };

    // 1. The active tab first, alone and awaited: it is the only pane React
    //    renders visible, hence the only one whose container has an
    //    offsetParent and can be fit() to real dimensions.
    try {
      ids[activeIdx] = await createOne(ordered[activeIdx], { activate: true });
    } catch (err) {
      console.warn("restoring the active tab failed:", err);
    }

    // 2. Let React commit and the font-ready re-fit land, then read real dims.
    await nextFrame();
    const activeEntry = ids[activeIdx] ? getTerm(ids[activeIdx]) : undefined;
    if (activeEntry?.container.offsetParent) {
      try {
        activeEntry.fit.fit();
      } catch {
        // Mid-layout; the ResizeObserver will fit again shortly.
      }
    }
    // Every pane in this app has identical geometry, so the active tab's fitted
    // size is correct for all of them.
    const dims = {
      cols: activeEntry?.term.cols ?? 80,
      rows: activeEntry?.term.rows ?? 24,
    };

    // 3. The rest concurrently — their scrollback fetches overlap and xterm
    //    queues the writes. activate:false keeps WebGL on the active tab only.
    await Promise.all(
      ordered.map(async (snap, i) => {
        if (i === activeIdx) return;
        try {
          ids[i] = await createOne(snap, { activate: false, dims });
        } catch (err) {
          console.warn(`restoring ${snap.session_id} failed:`, err);
        }
      }),
    );

    // 4. Promise.all resolves out of order — reassert the saved tab order.
    const created = ids.filter((id): id is string => Boolean(id));
    useAppStore.getState().reorderSessions(created);
    const activeId = ids[activeIdx];
    if (activeId) useAppStore.getState().setActiveSession(activeId);

    return created.length;
  }, [createSession]);

  const closeSession = useCallback(async (sessionId: string) => {
    // Cancel any in-flight AI work scoped to this session — otherwise the
    // stream callbacks resurrect store entries for the dead session and the
    // local model keeps generating for nobody.
    const state = useAppStore.getState();
    const streamReq = state.aiStreams[sessionId]?.requestId;
    if (streamReq) void api.aiCancel(streamReq).catch(() => {});
    const composerReq = state.sessionUi[sessionId]?.composerRequestId;
    if (composerReq) void api.aiCancel(composerReq).catch(() => {});
    // A command the agent typed into this terminal is still being awaited —
    // release it now, or its poll keeps running against a disposed xterm.
    abortSession(sessionId, "closed");
    // Only cleared on nested-block end otherwise, so a tab closed while inside
    // ssh leaks its negotiated exec mode for the life of the app.
    resetSessionMode(sessionId);
    clearPendingConnect(sessionId);
    clearLongRunningTimer(sessionId);
    cancelNaming(sessionId);

    const entry = getTerm(sessionId);
    if (entry) releaseWebgl(entry);
    try {
      await api.ptyKill(sessionId);
    } catch {
      // Session may already be gone (shell exited) — still clean up the UI.
    }
    // Ordering here is load-bearing and easy to break:
    //   after ptyKill  — so the shell's final bytes are in the buffer
    //   before disposeTerm — which destroys the buffer we serialize
    //   before removeSession — which drops aiStreams[id] UNREAD, and the AI
    //                          transcript exists nowhere else in the app
    await archiveOnClose(sessionId);
    disposeTerm(sessionId);
    useAppStore.getState().removeSession(sessionId);
    // Re-acquire WebGL on the newly active tab
    const nextActive = useAppStore.getState().activeSessionId;
    if (nextActive) {
      const nextEntry = getTerm(nextActive);
      if (nextEntry) acquireWebgl(nextEntry);
    }
  }, []);

  return { createSession, closeSession, restoreSessions };
}

/**
 * Two frames — one for React's commit, one for the document.fonts.ready re-fit
 * — but never more than `timeoutMs`.
 *
 * The timeout is not belt-and-braces: WKWebView stops servicing rAF entirely
 * while the window is occluded or minimized, so an unguarded wait here hangs
 * the whole boot sequence (persistence never starts, the health marker never
 * fires) for anyone who launches the app behind another window. Losing the
 * fitted dimensions is a cosmetic reflow; hanging boot is not.
 */
function nextFrame(timeoutMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

/** Restore's wording of the replay separator — see lib/replayBanner.ts. */
function restoreBanner(snap: SessionSnapshotMeta, cols: number, crashed: boolean): string {
  return replayBanner(
    {
      kind: "restored",
      when: snap.updated_at,
      remoteKind: snap.remote_kind,
      remoteTarget: snap.remote_target,
      crashed,
    },
    cols,
  );
}
