// All user-facing strings in one flat module so react-i18next can replace it
// mechanically later (v1 is English-only by decision).
export const S = {
  modelMenu: {
    onDevice: "On-device",
    api: "API",
    configure: "Configure models…",
    empty:
      "No model is ready yet. Download an on-device model, add an API key, or add a remote server in Settings.",
    emptyNoEngine:
      "This build has no on-device engine. Add an API key in Settings to use a cloud model.",
  },
  effort: {
    label: "Reasoning effort",
    hint: "How much the model thinks before answering. Deeper is slower and costs more.",
    off: "Off",
    low: "Low",
    medium: "Med",
    high: "High",
    max: "Max",
  },
  app: {
    name: "VTerminal",
  },
  header: {
    newTab: "New tab",
    closeTab: "Close tab",
    sessions: "Past sessions",
    settings: "Settings",
    aiPanel: "AI panel",
    noModel: "No model",
    loadingModel: "Loading…",
    // The second chip: a different model reads images than answers.
    imageReader: (model: string) => `${model} reads attached images — click to manage`,
  },
  empty: {
    title: "No open terminal",
    hint: "Press ⌘T to open a terminal",
  },
  terminal: {
    exited: "process exited",
    pressEnterToClose: "Close tab with ⌘W",
    notConnected: "not connected",
    reconnect: "Reconnect",
    searchPlaceholder: "Search…",
    rendererGpu: "GPU",
    rendererDom: "DOM",
  },
  blocks: {
    copyCommand: "Copy command",
    copyOutput: "Copy output",
    rerun: "Re-run",
    attachContext: "Attach to AI",
    explainError: "Explain error",
    exit: "exit",
    agentBadge: "AI",
    agentRun: "Run by the agent in this terminal",
  },
  composer: {
    placeholder: "Describe the command you need…",
    generating: "Generating…",
    insert: "Insert",
    discard: "Discard",
    // Keyed by aiBlockedReason() so every AI surface names the same cause and
    // the same fix. Getting this wrong is worse than saying nothing: "load a
    // model" in a build with no local engine sends you to a button that errors.
    blocked: {
      load: "Load a model in Settings → Models first",
      key: "Add an API key in Settings → Models first",
      engine: "This build has no on-device engine — pick an API model in Settings → Models",
    },
  },
  aiPanel: {
    usageHint: "Tokens in / out for this exchange",
    collapse: "Collapse AI panel",
    expand: "Expand AI panel",
    titleAsk: "Ask",
    titleExplain: "Explain",
    titleAgent: "Agent",
    placeholder: "Ask about your terminal…",
    agentPlaceholder: "Describe a goal — the agent proposes commands…",
    thinking: "Thinking…",
    thinkingLabel: "Thinking",
    attachedBlock: "Attached block",
    restoredTranscript: "Reopened transcript from",
    newChat: "New chat",
    newChatHint: "New chat — this one is saved to Past sessions",
    newChatDiscard: "Archiving is off — click again to discard this chat",
    newChatFailed: "Could not archive this chat, so it was left in place",
    errorPrefix: "Error",
    // A run that stopped at a guard rail. Both numbers are shown because the
    // reported figure has to be one the user can actually find in Settings —
    // reporting only the steer-extended budget named a limit that appears nowhere.
    pausedStepLimit: (steps: number, limit: number) =>
      steps > limit
        ? `Paused after ${steps} steps — your limit is ${limit}, extended because you sent a message mid-run.`
        : `Paused after ${steps} steps, the limit set in Settings → Agent.`,
    pausedContextLimit: (steps: number) =>
      `Paused after ${steps} steps — the conversation is close to filling the model's context window.`,
    pausedHint: "Nothing was lost. Continue picks up where it stopped, or type to redirect it.",
    pausedContinue: "Continue",
    /** Sent to the MODEL verbatim as the resumed turn's goal, and shown in the
     *  transcript as the user turn it is. Editing this changes what the agent is
     *  told, not just what the panel says. */
    continueGoal: "Continue from where you stopped.",
    cancel: "Cancel",
    run: "Run",
    skip: "Skip",
    stop: "Stop",
    // Permission mode. "Confirm" rather than "Ask" deliberately: the Ask/Agent
    // mode tabs sit a few pixels away and two different "Ask"es in one header is
    // a guessing game.
    permissionLabel: "What runs without asking",
    permission: {
      ask: "Confirm",
      auto_read: "Reads",
      auto_all: "All",
    },
    permissionHint: {
      ask: "Every command waits for your approval",
      auto_read:
        "Commands that only read run straight away. Anything that writes — or reaches the network — still waits for you.",
      auto_all: "Every command runs without asking, including writes and network access",
    },
    autoAllWarning:
      "Auto-accept is ON — commands run in your terminal, on the host it is connected to, without asking",
    autoReadNote:
      "Read-only commands run without asking. Anything that creates, edits, deletes or reaches the network still stops here.",
    // Why a card is up even though an auto mode is armed. Without this the mode
    // just looks broken.
    askedBecause: {
      network: "asking: this reaches the network",
      writes: "asking: this may change files",
    },
    deepThink: "Extended thinking",
    editHint: "click command to edit",
    skipped: "skipped",
    running: "running…",
    stillRunning: "still running",
    notRun: "not run",
    runsIn: "runs in",
    localShell: "this terminal",
    ranAs: "ran as",
    // A stalled command. Only `tui` is handled without asking — see ptyExec.
    stallTui: "A full-screen program took the terminal — closing it",
    stallPassword: "Waiting for your password — type it in the terminal",
    stallInput: "This command is waiting for a keypress",
    stallIdle: "No output for a while — it may be working, or stuck",
    interrupt: "Interrupt",
    interruptHint: "Send Ctrl-C to this command",
    // Steering a run that is already going. Delivery is at the next round
    // boundary, never mid-step, so the wording never promises "now".
    steerPlaceholder: "Redirect the agent — delivered at its next step…",
    steerHint: "Send to the running agent — it picks this up at its next step",
    steerQueued: "Queued — the agent picks this up at its next step",
    steerUndelivered: "Not delivered — the run ended before the agent read this",
    steerSend: "Send as a new message",
    steerWaitingOne: "1 message waiting — answer this step to deliver it",
    steerWaitingMany: "messages waiting — answer this step to deliver them",
    steerSkipAndSend: "Skip & send",
    steerSkipAndSendHint: "Skip this command and deliver your message now",
  },
  visionMenu: {
    title: "Reads attached images",
    empty: "No on-device readers available in this build.",
    wontFit: (gb: number) => `needs about ${gb} GB alongside your chat model`,
    turnOff: "Don't read images on-device",
    manage: "Download or remove readers…",
  },
  vision: {
    title: "Image reading (on-device)",
    hint: "Lets you attach screenshots when your chat model cannot see them. Runs alongside your chat model, so both share your memory.",
    inUse: "in use",
    loaded: "loaded",
    notDownloaded: "not downloaded",
    yourChatModel: "your chat model",
    // Names the PAIR and the number, because "too big" alone sends the user
    // looking for a problem with this model on its own.
    wontFit: (gb: number, chatLabel: string) =>
      `needs about ${gb} GB alongside ${chatLabel}`,
    download: "Download",
    downloading: "Downloading…",
    load: "Load",
    loading: "Loading…",
    unload: "Unload",
    delete: "Delete",
    use: "Use for images",
    stopUsing: "Stop using",
    promptLabel: "What to ask it",
    promptHint: "Leave blank to use this model's own default.",
    autoLoad: "Load at startup",
    autoLoadHint: "Keeps your chosen reader ready. It holds 2–6 GB of memory while loaded.",
    // Shown in the chat while a transcription is running.
    reading: "Reading the image on-device…",
    readFailed: "Could not read the image on-device",
  },
  attachments: {
    attach: "Attach files",
    dropHere: "Drop files to attach",
    remove: "Remove",
    truncated: "trimmed to the last part",
    limit: (dropped: number, max: number) =>
      `${dropped} file${dropped === 1 ? "" : "s"} not added — ${max} is the limit per message`,
    tooLarge: (name: string, limitMb: number) => `${name} is too large — ${limitMb} MB is the limit`,
    unsupported: (name: string) => `${name} is not an image or a text file`,
    decodeFailed: (name: string) => `${name} could not be read as an image`,
    // PDFs fail three distinct ways and the user's next move differs for each.
    pdfLocked: (name: string) => `${name} is password-protected`,
    pdfFailed: (name: string) => `${name} could not be read as a PDF`,
    // A scan. Says what it IS rather than just refusing, and names the fix — this is
    // the case the on-device reader exists for.
    pdfNoText: (name: string, pages: number) =>
      `${name} is a scan (${pages} page${pages === 1 ? "" : "s"}) with no text in it — set up on-device reading to use it`,
    // The active model cannot see images. Deliberately blocking rather than
    // dropping them quietly: an answer about an image the model never received
    // looks exactly like an answer about one it did.
    noVision: (model: string) => `${model} cannot read images`,
    // Two ways out, both named. The second is a real control, not a signpost.
    noVisionFix: "Switch to a model that can see, remove the images, or",
    noVisionSetUp: "set up on-device reading",
    // Honest about what the model will actually receive.
    viaOcr: (model: string) =>
      `${model} cannot see images — they will be read on-device and sent as text`,
    // Stated because it is true and surprising: an image rides only on the turn
    // it was attached to, so a follow-up question about it needs it again.
    oneTurnOnly: "Images are sent with this message only — re-attach to ask again",
    // Folded blocks, shown collapsed. This is machinery the MODEL needed, not
    // something the reader has to work through — the same call `thinking` makes.
    blockTranscript: "Read from image",
    blockFile: "Attached file",
    blockReadBy: (model: string) => `by ${model}`,
    // The archive caps a message at 16KB, so a large attached log loses its tail
    // on the way to disk. Say so rather than presenting a half file as whole.
    blockTruncated: "Cut short when this conversation was saved",
    // Progress for a scanned PDF: several seconds of on-device work per page, and
    // silence after a drop reads as a hang.
    pdfRendering: (name: string) => `Rendering ${name}…`,
    pdfReading: (page: number, total: number) => `Reading page ${page} of ${total} on-device…`,
  },
  palette: {
    placeholder: "Type a command or search…",
    actions: "Actions",
    hosts: "SSH hosts",
    history: "History",
    models: "Models",
    noResults: "No results",
    loadModel: "Load",
    manageModels: "Manage models…",
    manageHosts: "Manage SSH hosts…",
    runHint: "⌘⏎ run · ⏎ insert",
    hostsHint: "⏎ new tab · ⌘⏎ this tab",
  },
  sessions: {
    title: "Past sessions",
    placeholder: "Search past sessions…",
    reopenHint: "⏎ reopen · ⌘⏎ directory only",
    loading: "Loading…",
    empty: "No past sessions yet — closing a tab archives it.",
    noResults: "No matching sessions",
    untitled: "Untitled session",
    reopen: "Reopen",
    reopenFailed: "Could not reopen that session — it may have been pruned.",
    remove: "Remove",
    confirmRemove: "Click again to remove",
    commands: "cmds",
    aiMessages: "AI",
    lines: "lines",
    noOutput: "no output saved",
    crashed: "after an unexpected quit",
    // Placeholders rather than three concatenated keys, so the sentence survives
    // being reordered by a translation later.
    retention: "Keeping the last {sessions} sessions for {days} days",
    manage: "Retention…",
  },
  tabs: {
    connected: "Connected to a remote host",
    disconnected: "Not connected — use Reconnect",
    rename: "Rename",
    renameWithAi: "Rename with AI",
    renameHint: "Double-click to rename",
    renamePlaceholder: "Tab name",
    resetName: "Reset to automatic name",
    naming: "Naming…",
  },
  settings: {
    title: "Settings",
    tabs: {
      models: "Models",
      agent: "Agent",
      appearance: "Appearance",
      terminal: "Terminal",
      hosts: "SSH hosts",
      about: "About",
    },
    restore: {
      title: "Session restore",
      enabled: "Restore tabs on start",
      enabledHint: "Reopen your tabs, in order, in the same directories. The shells are new.",
      scrollback: "Restored scrollback",
      // The disclosure belongs in the control, not a docs page: this is the
      // first time the app writes terminal OUTPUT to disk.
      scrollbackHint:
        "Lines of output saved per tab, for both restore and the archive. Stored unencrypted in the app's local database — this includes anything printed to the screen.",
      scrollbackOff: "Off",
      clear: "Saved session state",
      clearHint: "Delete every stored tab and its captured output",
      clearButton: "Clear now",
    },
    archive: {
      title: "Session archive",
      enabled: "Keep closed sessions",
      // Same disclosure discipline as scrollbackHint above: this is the first
      // time the app writes an AI CONVERSATION to disk, so the control says so.
      enabledHint:
        "A session is archived when you close its tab or quit, and can be reopened from the header. Its captured output and its AI transcript are stored unencrypted in the app's local database.",
      keepSessions: "Keep sessions",
      keepSessionsHint: "The oldest are dropped once the limit is reached",
      keepDays: "Keep for",
      keepDaysHint: "Anything older is deleted — whichever limit is reached first",
      days: "days",
      clear: "Archived sessions",
      clearHint: "Delete every archived session, its output and its transcript",
      clearButton: "Clear archive",
      commandHistory: "Command history",
      commandHistoryHint: "Delete every recorded command and its captured output",
      commandHistoryButton: "Clear history",
    },
    sshHosts: {
      title: "Saved SSH hosts",
      intro: "Connect from the command palette (⌘K) without retyping the ssh line.",
      empty: "No saved hosts yet.",
      // Stated up front rather than buried: there is no safe way to store a
      // password for a command that gets typed into a live terminal.
      keyAuthHint:
        "Password authentication isn't supported — no passwords or passphrases are ever stored. Set up a key with `ssh-copy-id user@host`, or use ssh-agent.",
      add: "Add host",
      edit: "Edit",
      remove: "Remove",
      confirmRemove: "Really remove?",
      connect: "Connect",
      save: "Save",
      cancel: "Cancel",
      preview: "Command",
      previewHint: "This is typed into the terminal exactly as shown.",
      label: "Label",
      labelHint: "Shown on the tab and in the palette",
      hostname: "Host",
      username: "User",
      port: "Port",
      identityFile: "Identity file",
      identityFileHint: "Path to a private key — the key itself is never stored",
      chooseFile: "Choose…",
      jumpHost: "Jump host",
      jumpHostHint: "ProxyJump target, e.g. jump@bastion",
      extraArgs: "Extra ssh options",
      extraArgsHint: "Flags only, e.g. -o ConnectTimeout=5",
      remoteDir: "Remote directory",
      remoteDirHint: "cd here after connecting",
      postConnect: "On connect",
      postConnectHint: "Run after connecting, e.g. tmux attach || tmux new",
      tag: "Tag",
      uses: "uses",
      neverUsed: "never used",
      importOpen: "Import from ~/.ssh/config…",
      importTitle: "Import from ~/.ssh/config",
      importNone:
        "No importable hosts found. Wildcard patterns (Host *) and Match blocks are skipped.",
      importFound: "found",
      importNew: "new",
      importAlready: "already saved",
      importButton: "Import",
      importReadOnly: "Read-only — your ssh config is never modified.",
    },
    models: {
      onDevice: "On-device",
      onDeviceHint: "Runs locally. Nothing leaves your Mac.",
      cloudHint: "Needs an API key. Prompts are sent to the provider.",
      download: "Download",
      cancel: "Cancel",
      load: "Load",
      unload: "Unload",
      loaded: "Loaded",
      delete: "Delete",
      select: "Use",
      selected: "In use",
      fits: "Fits your RAM",
      tooBig: "Needs more RAM",
      notDownloaded: "Not downloaded",
      needsKey: "Add a key to use",
      noEngine:
        "This build was compiled without the on-device engine, so nothing below can be downloaded or loaded. The API models still work — add a key under Anthropic, OpenAI or Mistral.",
      noEngineTag: "Not in this build",
      apiKey: "API key",
      apiKeyStored: "Stored — type to replace, clear to remove",
      hfToken: "Hugging Face token (optional)",
      hfTokenHint:
        "Raises Hugging Face download rate limits, and is the only way in if a model repo later starts requiring sign-in. Not needed for any model listed above.",
      tier: { fast: "Fast", balanced: "Balanced", max: "Max quality" },
      contextTokens: "context",
    },
    remoteServers: {
      title: "Remote servers",
      intro:
        "Point VTerminal at an Ollama, LM Studio, or OpenAI-compatible server you run yourself. Nothing is contacted until you press Test.",
      empty: "No remote servers yet.",
      add: "Add server",
      edit: "Edit",
      remove: "Remove",
      confirmRemove: "Really remove?",
      save: "Save",
      cancel: "Cancel",
      newTitle: "Add a remote server",
      editTitle: "Edit remote server",
      kind: "Kind",
      kindHint: "Decides the default port and which endpoint is asked for details.",
      label: "Label",
      labelHint: "Shown above this server's models.",
      baseUrl: "Address",
      baseUrlHint: (example: string) => `The server root, with no API path — e.g. ${example}`,
      token: "Token",
      tokenHint: "Optional. Most self-hosted servers need none.",
      tokenPlaceholder: "Bearer token (optional)",
      tokenStored: "Stored — type to replace, clear to remove",
      tokenStoredTag: "token stored",
      preview: "Test will send",
      test: "Test",
      refresh: "Refresh models",
      testing: "Testing…",
      noModels: "No models enabled yet — press Test to see what this server offers.",
      pickTitle: "Models on",
      pickFound: (n: number) => `${n} reported`,
      pickEnabled: (n: number) => `${n} enabled`,
      pickNone: "This server reported no models.",
      pickHint:
        "Only ticked models appear in the model picker. Untick everything to turn this server off without removing it.",
      pickSave: "Save selection",
      alreadyEnabled: "enabled",
      assumedContext: "assumed",
      notLoaded: "not loaded",
      role: { embedding: "embeddings", rerank: "reranker", unknown: "not a chat model" },
      noTools: "no tool calling",
      noToolsTag: "No tool calling — agent mode won't work",
    },
    appearance: {
      theme: "Theme",
    },
    terminal: {
      fontSize: "Font size",
      scrollback: "Scrollback lines",
      cursorStyle: "Cursor style",
      cursorBlink: "Cursor blink",
      copyOnSelect: "Copy on select",
      shellPath: "Shell",
      shellPathHint: "Leave empty for /bin/zsh",
      shellIntegration: "Shell integration (command blocks)",
      historyEnabled: "Save command history",
      historyCaptureOutput: "Capture output tails in history",
      aiSessionNaming: "Name tabs with AI",
      aiSessionNamingHint:
        "Runs a second, short inference after each exchange to label the tab. Uses the selected model.",
      sendContext: "Send terminal context to AI",
    },
    agent: {
      title: "Agent",
      intro:
        "Agent commands run in your visible terminal, in whatever shell the selected tab is currently in — including a remote host you are SSH'd into.",
      maxIterations: "Max steps per run",
      // Says "pauses", not "stops": nothing is lost and Continue picks it up. The
      // steer clause is here because a mid-run message re-grants the allowance, so
      // a paused run can legitimately report more steps than this number.
      maxIterationsHint:
        "How many commands the agent may chain before it pauses to check in. Nothing is lost — you can continue from where it stopped. Sending a message mid-run grants a fresh allowance. 1–100 — type a value or step by 5.",
      commandTimeout: "Command timeout",
      commandTimeoutHint:
        "How long to wait for a command before moving on. It is never killed — the agent is told it is still running.",
      webAccess: "Allow internet access",
      // The last sentence is the honesty clause, and it stays. Command blocking
      // recognises tool NAMES; it cannot see inside a script the agent wrote in
      // an earlier step, or through an alias in your own dotfiles.
      webAccessHint:
        "Off: the agent's commands may not reach the network (curl, wget, git fetch/pull/clone, package installs, ssh), and models with a built-in web tool stop being offered one. Chat and models keep working. Command blocking is best-effort — a script the agent wrote earlier can still reach out.",
    },
    about: {
      version: "Version",
      build: "Build",
      description:
        "A lean AI-powered terminal. Local models run in-process (no external daemon) with Metal acceleration; models are pulled directly from Hugging Face.",
      // Labels only. The names behind them (author, publisher, copyright) are
      // build-time constants read from package.json / tauri.conf.json — see
      // vite.config.ts. Attribution is metadata, not UI copy to translate.
      author: "Author",
      publisher: "Publisher",
    },
  },
  statusBar: {
    noModel: "no model",
    generating: "Generating…",
  },
} as const;
