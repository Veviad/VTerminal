import { isWindows, shortcutGlyph } from "./platform";

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
    hint: `Press ${shortcutGlyph("T")} to open a terminal`,
    openTerminal: "Open a terminal",
  },
  terminal: {
    exited: "process exited",
    pressEnterToClose: `Close tab with ${shortcutGlyph("W")}`,
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
    sidecar: {
      label: "Sidecar",
      title: "Local + SSH sidecar",
      localTerminal: "Local terminal",
      sshTerminal: "SSH terminal",
      chooseLocal: "Choose a local terminal",
      chooseRemote: "Choose a live SSH terminal",
      safety:
        "The agent can use context and propose commands in both terminals. Each target keeps its own approval mode.",
      noLocal: "Open a local terminal before starting Sidecar.",
      noRemote: "Connect an SSH terminal before starting Sidecar.",
      openHosts: "Open SSH hosts",
      start: "Start sidecar",
      end: "End sidecar",
      swap: "Swap panes",
      replace: "Replace targets",
      example: "Try: Check the GitHub issue locally, then update the Compose service remotely.",
      local: "Local",
      remote: "SSH",
      connected: "Ready",
      degraded: "Target unavailable",
      degradedHint: "Reconnect or replace this target before continuing the combined run.",
      reconnect: "Reconnect",
      reconnecting: "Reconnecting…",
      remoteAuto: (host: string) =>
        `Standard commands for ${host} run without asking. Protected commands still require approval.`,
      remoteFull: (host: string) =>
        `Full access is on for ${host}. Every executable command runs without approval.`,
      divider: "Resize local and SSH terminals",
    },
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
    send: "Send",
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
      auto_smart: "Smart",
      auto_all: "Auto",
      full: "Full",
    },
    permissionHint: {
      ask: "Every command waits for your approval",
      auto_read:
        "Commands proven to only read run straight away, including network-backed reads. Writes and uncertain commands still wait for you.",
      auto_smart:
        "Known reads and commands independently assessed as semantic reads run straight away. Uncertain, sensitive, privileged, and opaque commands still wait.",
      auto_all:
        "Standard commands, including writes and network access, run without asking. Sensitive, privileged, opaque, private-output, and saved always-ask operations still wait.",
      full:
        "Every executable command runs without approval, including protected and saved always-ask operations. Deny rules and disabled capabilities remain blocked.",
    },
    // Document buckets. Deliberately says the agent "can search" rather than "will
    // read": attaching a bucket grants a lookup tool, it does not put the documents
    // into the conversation.
    docsLabel: "Docs",
    docsHint:
      "Buckets the agent can search this session. Passages it finds are quoted to it as reference material, not as instructions.",
    docsChipHint: (label: string, chunks: number) =>
      `${label} — ${chunks} passage${chunks === 1 ? "" : "s"} the agent can search`,
    docsDetach: (label: string) => `Detach ${label}`,
    autoAllWarning:
      "Auto mode is ON. Standard commands run without asking, while protected commands still require approval.",
    fullWarning:
      "Full access is ON. Every executable command runs in your terminal without approval.",
    autoReadNote:
      "Proven read-only commands run without asking, including network-backed reads. Writes and uncertain commands still stop here.",
    autoSmartNote:
      "Unknown commands receive an isolated AI safety review. Sensitive, privileged, opaque, and uncertain commands still stop here.",
    // Why a card is up even though an auto mode is armed. Without this the mode
    // just looks broken.
    askedBecause: {
      writes: "asking: this may change state or could not be verified as read-only",
    },
    deepThink: "Extended thinking",
    editHint: "click command to edit",
    skipped: "skipped",
    running: "running…",
    privateOutput: "Private output.",
    privateOutputHint: "Standard output and errors are discarded and cannot be sent to the agent.",
    completionUnknown: "completion unknown",
    interrupted: "interrupted",
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
    orphanedCommand:
      "Completion unknown: the agent run ended before the terminal reported a completion pulse or confirmed an interrupt.",
    restoredRunningCommand:
      "Completion unknown: this archived command was still marked running when the session was saved.",
    resultSubmitFailed:
      "VTerminal could not report this terminal outcome to the agent. The run was stopped before another command could start.",
    completionUnknownRun:
      "Terminal completion could not be confirmed. The agent run was stopped before another command could start.",
    completionUnknownNote:
      "Completion unknown: the terminal did not report a completion pulse or confirm an interrupt.",
    interruptedCommand: "The command was interrupted before completion.",
    interruptUnknownNote:
      "The interrupt was sent, but no completion signal was observed. The exit status is unknown.",
    interruptFailedRun:
      "VTerminal could not confirm that the terminal accepted the interrupt. The agent run was stopped before another command could start.",
    interruptUnconfirmedRun:
      "The interrupt was sent, but terminal completion could not be confirmed. The agent run was stopped before another command could start.",
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
    removeNamed: (name: string) => `Remove ${name}`,
    showAsText: "Show as text",
    showAsTextNamed: (name: string) => `Show ${name} as text`,
    pastedTextAttached: (name: string, lines: number) =>
      `${name} attached from pasted text, ${lines} line${lines === 1 ? "" : "s"}`,
    pastedTextInserted: (name: string) => `${name} inserted into the message as text`,
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
    // Retired: a passage block carries no text label at all. These labels render
    // uppercase with `tracking-widest`, so even one word cost ~75px, and a passage row
    // already has three things competing for the width — icon, source filename, page.
    // The book icon distinguishes it from a file or a transcript on its own.
    // Kept out of the object rather than left unused; if a label is ever wanted back,
    // the icon is at AiPanel's FoldedBlockSection.
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
    runHint: `${shortcutGlyph("Enter")} run · Enter insert`,
    hostsHint: `Enter new tab · ${shortcutGlyph("Enter")} this tab`,
  },
  sessions: {
    title: "Past sessions",
    placeholder: "Search past sessions…",
    reopenHint: `⏎ reopen · ${shortcutGlyph("Enter")} directory only`,
    loading: "Loading…",
    empty: "No past sessions yet — closing a tab archives it.",
    noResults: "No matching sessions",
    untitled: "Untitled session",
    reopenWithChat: "Reopen with chat",
    reopenTerminal: "Reopen terminal",
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
    allOpen: "All open terminals",
    allOpenHint: (count: number) => `All open terminals (${count})`,
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
      statistics: "Statistics",
      agent: "Agent",
      instructions: "Instructions",
      mcp: "MCP",
      docs: "Knowledge",
      updates: "Updates",
      runbooks: "Runbooks",
      appearance: "Appearance",
      terminal: "Terminal",
      hosts: "SSH hosts",
      about: "About",
    },
    statistics: {
      title: "Token usage",
      intro:
        "Lifetime provider-reported token usage on this device, split between in-process llama.cpp models and every other provider.",
      refresh: "Refresh token statistics",
      loading: "Loading token statistics…",
      error: "Token statistics could not be loaded",
      allTime: "All-time total",
      tokens: "tokens",
      input: "Input",
      output: "Output",
      calls: "Model calls",
      inShort: "in",
      outShort: "out",
      local: "Local",
      localHint: "In-process llama.cpp models on this machine",
      cloud: "Cloud",
      cloudHint: "All other providers and configured servers",
      byProvider: "By provider",
      byModel: "By model",
      empty: "No provider has reported token usage yet. Complete a model response and refresh this page.",
      note:
        "Counts include only provider calls that reported usage. Deleting chats does not reset these lifetime totals. Existing standalone chat usage is imported when available.",
      since: "Tracked since",
      providers: {
        local: "On-device llama.cpp",
        remote: "Configured server",
        other: "Other provider",
      },
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
      intro: `Connect from the command palette (${shortcutGlyph("K")}) without retyping the ssh line.`,
      empty: "No saved hosts yet.",
      keyAuthHint:
        "Passwords are kept in the operating-system credential vault and submitted only at this host's SSH password prompt. SSH keys and ssh-agent remain the recommended option.",
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
      password: "Password",
      passwordHint:
        "Stored in the operating-system credential vault. The saved value is never shown again.",
      passwordStored: "Password stored, type to replace",
      passwordUnavailable: "The operating-system credential vault is unavailable.",
      removePassword: "Remove stored password",
      keepPassword: "Keep stored password",
      originPasswordWarning:
        "Changing the host, user, or port removes the stored password unless you enter a replacement.",
      passwordBadge: "Password stored",
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
      onDeviceHint: "Runs locally. Nothing leaves this device.",
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
      mtpUpgrade: "Upgrade to MTP",
      mtpUpgradeHint: "Download the MTP artifact for faster compatible local generation.",
      mtpUnloadFirst: "Unload this Qwen model before replacing its weights.",
      needsKey: "Add a key to use",
      noEngine:
        "This build was compiled without the on-device engine, so nothing below can be downloaded or loaded. The API models still work — add a key under Anthropic, OpenAI or Mistral.",
      noEngineTag: "Not in this build",
      apiKey: "API key",
      apiKeyStored: `Stored in ${isWindows() ? "Windows Credential Manager" : "Keychain"} — type to replace`,
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
      shellPathHint: isWindows()
        ? "Fixed to Bash in the default WSL2 distribution"
        : "Leave empty for /bin/zsh",
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
        "How long to wait for a terminal completion signal. The command is never killed. If completion cannot be confirmed, the Agent stops and asks you to verify the terminal.",
      webAccess: "Allow internet access",
      // The last sentence is the honesty clause, and it stays. Command blocking
      // recognises tool NAMES; it cannot see inside a script the agent wrote in
      // an earlier step, or through an alias in your own dotfiles.
      webAccessHint:
        "Off: the agent's commands may not reach the network (curl, wget, git fetch/pull/clone, package installs, ssh), and models with a built-in web tool stop being offered one. Chat and models keep working. Command blocking is best-effort — a script the agent wrote earlier can still reach out.",
    },
    instructions: {
      title: "Custom instructions",
      // The first sentence is the whole mental model: this is ADDED to the
      // built-in prompt, not a replacement for it. Users who have met a
      // "system prompt" box elsewhere expect replacement, and quietly deleting
      // the rules that keep the agent from hanging a real terminal is not a
      // failure they could diagnose.
      intro:
        "Text you write here is added to the end of the model's built-in instructions — it never replaces them. Use it for standing preferences: conventions to keep, tools to prefer, the language to answer in.",
      // The honesty clause, in the same spirit as `agent.webAccessHint`. Prose
      // in a prompt cannot move a gate that is enforced in Rust, and a settings
      // field that looks like it might is worse than one that says it cannot.
      limits:
        "Instructions cannot grant permissions, approve commands, or lift the internet block — those are enforced in code, outside the conversation. They are also left out of tab naming, command suggestions, error explanations and Runbook authoring, whose output the app parses.",
      global: "All AI",
      globalHint: "Applied everywhere below — Agent, Ask and Chat.",
      globalPlaceholder:
        "e.g. This fleet runs Debian 12 with systemd. Prefer POSIX sh over bashisms.",
      agent: "Agent only",
      agentHint: "Added after the shared text when the Agent runs commands.",
      agentPlaceholder: "e.g. Show me `git status` before and after anything that writes.",
      chat: "Chat and Ask only",
      chatHint: "Added after the shared text in the Chat workspace and the Ask panel.",
      chatPlaceholder: "e.g. Answer in German. Lead with the command, then one line of why.",
      // Saving is on blur rather than per keystroke: every save is a Rust store
      // write, and a 4000-character field would make one per character.
      saveHint: "Saved when you click away.",
      saved: "Saved",
      charCount: (used: number, max: number) => `${used.toLocaleString()} / ${max.toLocaleString()}`,
      tooLong: (max: number) => `Too long — the limit is ${max.toLocaleString()} characters.`,
      clear: "Clear",
    },
    docs: {
      title: "Knowledge",
      // The honesty clause, in the same spirit as `webAccessHint` above: the fencing
      // and labelling of retrieved passages are real and tested, but no framing forces
      // a model to obey them, and saying otherwise would be a promise the app cannot
      // keep.
      intro:
        "Index your own PDFs, markdown, HTML and images into local buckets or permitted Qdrant collections, then attach any compatible mix to a chat. Retrieved passages are quoted to the model as reference material, clearly marked as data rather than instructions — that marking is best-effort, so attach only knowledge you trust.",
      enable: "Enable document buckets",
      enableHint:
        "Experimental. While this is off there is no document search: the agent is offered no such tool, nothing is indexed, and no index file exists on disk.",
      disabledNotice:
        "Turn this on to create buckets. Nothing is indexed and no index file is written until you do.",
      addBucket: "New bucket",
      bucketNamePlaceholder: "e.g. Runbooks, API reference",
      addFiles: "Add files…",
      addFolder: "Add folder…",
      reindex: "Re-index",
      reindexHint: "Re-reads every file. Unchanged files cost nothing.",
      indexNow: "Index now",
      cancel: "Stop",
      remove: "Remove",
      rename: "Rename",
      deleteBucket: "Delete bucket",
      deleteBucketConfirm: (label: string) =>
        `Delete "${label}"? The indexed text is removed. Your original files are not touched.`,
      empty: "No buckets yet.",
      noFiles: "No files in this bucket yet — add a folder or pick files.",
      // Counts, phrased so zero reads naturally.
      fileCount: (n: number) => (n === 1 ? "1 file" : `${n} files`),
      chunkCount: (n: number) => (n === 1 ? "1 passage" : `${n} passages`),
      neverIndexed: "not indexed yet",
      indexing: (done: number, total: number, current: string | null) =>
        current
          ? `Indexing ${done + 1} of ${total} — ${current}`
          : `Indexing ${done} of ${total}…`,
      indexed: (r: { indexed: number; unchanged: number; failed: number }) =>
        [
          r.indexed > 0 ? `${r.indexed} indexed` : null,
          r.unchanged > 0 ? `${r.unchanged} unchanged` : null,
          r.failed > 0 ? `${r.failed} failed` : null,
        ]
          .filter(Boolean)
          .join(", ") || "nothing to do",
      cancelled: "Stopped. Files already indexed were kept.",
      // Per-file state labels.
      state: {
        pending: "not indexed",
        indexed: "indexed",
        stale: "changed on disk",
        missing: "file not found",
        failed: "could not be read",
      } as Record<string, string>,
      // What a scan refused, and why. Reported rather than silently dropped: a skip
      // the user cannot see reads as "everything was indexed".
      scanSummary: (s: {
        added: number;
        skipped_secret: number;
        skipped_noise: number;
        skipped_unsupported: number;
        skipped_symlink: number;
        skipped_too_large: number;
        truncated: number;
      }) =>
        [
          `Added ${s.added}.`,
          s.skipped_secret > 0
            ? `Skipped ${s.skipped_secret} as private keys or credentials.`
            : null,
          s.skipped_symlink > 0 ? `Skipped ${s.skipped_symlink} symlinks.` : null,
          s.skipped_unsupported > 0
            ? `Skipped ${s.skipped_unsupported} of unsupported types.`
            : null,
          s.skipped_noise > 0
            ? `Skipped ${s.skipped_noise} hidden or generated items.`
            : null,
          s.skipped_too_large > 0 ? `Skipped ${s.skipped_too_large} as too large.` : null,
          s.truncated > 0 ? `${s.truncated} beyond the per-scan limit were not examined.` : null,
        ]
          .filter(Boolean)
          .join(" "),
      testSearch: "Try a search",
      testSearchPlaceholder: "What would you ask?",
      noResults: "No passages matched.",
      // Extraction failures, written so each names something the user can act on.
      pdfLocked: "this PDF is password-protected",
      pdfInvalid: "this file could not be read as a PDF",
      pdfNoText: (pages: number) =>
        `this PDF has no text layer (${pages} page${pages === 1 ? "" : "s"}) — it is a scan`,
      imageNeedsReader: "images need an on-device reader — set one up under Settings → Models",
      imageEmpty: "the on-device reader found no text in this image",
      notText: "this file is not UTF-8 text",
      noTextInFile: "this file has no text in it",
    },
    updates: {
      title: "Application updates",
      experimental: "Experimental",
      intro:
        "Signed updates come from published VTerminal releases on GitHub. Stable versions and prereleases are both included.",
      automatic: "Automatic updates",
      automaticHint:
        "Checks after startup and every 24 hours. You always choose when to install and restart.",
      currentVersion: "Current version",
      channel: "Release channel",
      channelValue: "Stable and prerelease",
      status: "Status",
      statusIdle: "Not checked yet",
      statusChecking: "Checking…",
      statusCurrent: "Up to date",
      statusAvailable: "Update available",
      statusDownloading: "Downloading update…",
      statusVerifying: "Verifying download…",
      statusCancelling: "Cancelling download…",
      statusSaving: "Saving workspace…",
      statusInstalling: "Installing update…",
      statusRestarting: "Restarting VTerminal…",
      statusError: "Update failed",
      lastChecked: "Last checked",
      never: "Never",
      checkNow: "Check now",
      checkAgain: "Check again",
      available: (version: string) => `VTerminal ${version} is available`,
      prerelease: "Prerelease",
      published: "Published",
      releaseNotes: "Release notes",
      noNotes: "No release notes were provided.",
      install: "Install & Restart",
      cancelDownload: "Cancel download",
      later: "Later",
      restartWarning:
        "Installing restarts VTerminal. Running terminal processes will stop; saved tabs return with new shells.",
      progress: (downloaded: string, total: string, percent: number) =>
        `${downloaded} of ${total} · ${percent}%`,
      progressUnknown: (downloaded: string) => `${downloaded} downloaded`,
    },
    runbooks: {
      title: "Runbooks",
      intro:
        "Run a reusable, versioned checklist against the visible terminal. Checks, approved changes, verification, evidence and operator decisions are retained in a durable report.",
      enable: "Enable Runbooks",
      enableHint:
        "Experimental. Runbooks may execute commands in the selected terminal. Every visible-terminal shell action and every model action requires explicit approval.",
      disabledNotice:
        "While disabled, Rust refuses every Runbooks command and the workspace is hidden.",
      enabledNotice:
        "Definitions are imported from local folders and edited outside the app. Runs keep an immutable snapshot even if the source changes later.",
      recording: "Record terminal output",
      recordingHint:
        "The least a run keeps as an audit record. A run can be raised above this before it starts, never lowered. Output is redacted and capped before it is stored, and only what the terminal still holds in scrollback can be captured.",
      recordingOptions: {
        none: "Never",
        runbook: "As the runbook asks",
        all: "Always, in full",
      },
      recordingDescriptions: {
        none: "Nothing is kept unless you raise a single run before starting it. Results, timestamps, approvals and operator comments are still recorded.",
        runbook:
          "Each package decides. A package that asks for nothing gets an 8 KiB redacted tail per attempt — the behaviour before this setting existed.",
        all: "Every attempt keeps a redacted artifact of up to 1 MiB in protected app data, and no run can opt out.",
      },
      recordingRetention:
        "Recorded output is kept until the run is deleted. Deleting a run removes its artifacts from disk.",
    },
    about: {
      version: "Version",
      build: "Build",
      description:
        `A lean AI-powered terminal. Local models run in-process (no external daemon) with ${isWindows() ? "Vulkan acceleration and CPU fallback" : "Metal acceleration"}; models are pulled directly from Hugging Face.`,
      // Attribution values and the SPDX identifier are build-time constants read
      // from package.json / tauri.conf.json. Labels and explanatory copy stay here.
      author: "Author",
      publisher: "Publisher",
      license: "License",
      licenseName: "GNU General Public License version 3",
      licenseNotice:
        "VTerminal is free software. You may redistribute and modify it under GPLv3. There is no warranty, to the extent permitted by law.",
    },
  },
  statusBar: {
    noModel: "no model",
    generating: "Generating…",
  },
} as const;
