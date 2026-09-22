# dsh-offpeak-inbox — an off-peak inbox for DeepSeek Harness

**English** | [中文](README.zh.md)

Write down a thought, a task, or a thread you want to pick up later. The plugin runs it as a real DSH session **only while the DeepSeek API bills at its off-peak rate**.

The point is simple: **don't burn money at peak prices; do the work when it's cheap.**

## What it does

- A sidebar entry (the off-peak inbox) opens a panel where you capture an item: an optional title plus the body.
- Each item gets an *earliest runnable time* the moment you capture it:
  - captured **inside** an off-peak window → it joins that window and runs shortly;
  - captured **during peak hours**, or in the gap between two peak ranges → it waits for the next off-peak window to open.
- When that time arrives, the host creates a new DSH session, hands it the captured text, and leaves the result in that session for you to read later.
- Status is visible at a glance: `waiting / running / done / failed`, with **run now**, **delete**, and **retry after failure**.

## When the list gets long: folded history and search

A working inbox accumulates rows. The panel therefore splits the list in two:

- **Still moving** rows (waiting / running / failed) stay in the list. A failure in particular is never folded away — it is the row still asking you to retry or delete it.
- **Settled** rows (done / cancelled) move under a `History (N)` bar that is **collapsed by default**. Click it to expand: the open group paints the 20 most recent rows, and "show earlier" adds another 20 per click. The fold is remembered in the browser (`dsh.offpeak.historyOpen` in `localStorage`).

Folding is presentation only; nothing is deleted. Every row stays in `$DSH_HOME/offpeak-inbox/inbox.json`, and the **search box** above the history bar reads the whole record rather than the visible row:

- title, prompt, failure text, session id, status, capture date, and the "planned …" instant that only waiting rows print all match;
- **folded history is searchable** — hits are listed whatever the fold state is, and a long hit list is paged 20 at a time behind "show more matches";
- clearing the box returns to the "visible rows plus folded history" view.

## Deferring into an existing session

If you would rather not open another session — "I'll write this down now and have it delivered to the conversation I'm already in once it gets cheap" — use the **Off-peak** button next to the composer:

- Click it **during peak hours** and the text is held until the next off-peak window opens, then delivered automatically into the **current session**; nothing goes out early at peak prices.
- Click it **inside an open off-peak window** and the message is sent immediately, because it is already cheap (the panel and its notice say so).
- The content is whatever you have already typed in the composer; it is captured **only when you click**, and normal sends are never intercepted.
- After delivery the item shows "delivered to existing session <session id>" in the inbox and settles as **done** — the evidence is the host's acceptance receipt, not whether that session is still running (it goes on to run your own turns afterwards).
- The panel's item list also has a **Send to** selector that addresses **any existing session** (subagent sessions are not listed), which is how you hold an item for a session other than this one.

The button identifies the current session only through **the value the browser itself persisted** (`dsh.sessions.current` in `localStorage`). If the page has just opened and there is no session yet, or that value cannot be read, it says plainly that it could not identify the current session rather than guessing one and delivering somewhere wrong.

## How the off-peak calendar is computed

Following DeepSeek's published pricing calendar (peak costs twice the off-peak rate):

| | Hours (UTC) |
|---|---|
| Peak (expensive) | Monday–Friday 01:00–04:00 and 06:00–10:00 |
| Off-peak (half price) | Everything else, including all weekend |

The panel header shows whether the current moment is peak or off-peak, the bounds of the open window, and when the next window starts — you never convert time zones by hand.

## Boundaries worth knowing

- **The host must be running.** The plugin lives inside the `dsh web` process; when that stops, nothing runs.
- **A missed window is not replayed.** But each item's earliest runnable time is fixed at capture, so something you write at midnight is never lost — it simply waits for the next window.
- **It does not wake a sleeping machine.** If the computer is asleep, nothing happens at the scheduled time.
- **Executions spend real API credit**, exactly like a normal session. What you save is the difference in rate (off-peak is about half of peak), not the cost itself.

## Install

Every route below writes a row into a profile, and the profile is read at startup — restart `dsh web` afterwards.

**From the prebuilt tarball.** Nothing of this package runs at install time, so there is no build step and no build authorization to grant:

```sh
dsh plugin --profile web add https://github.com/Tungpeng/dsh-offpeak-inbox/releases/latest/download/dsh-offpeak-inbox.tgz
```

**Straight from this repository.** This installs source, so pnpm runs the package's `prepare` build, and pnpm 10 refuses a git dependency's build scripts until you allow them. The first `dsh plugin add` fails and prints the exact key to copy into the profile's `pnpm-workspace.yaml` — under `allowBuilds`, the package name as the key and `true` as the value. Run the command again after that. Treat that authorization as permission for this package's code to run on your machine at install time, and pin a commit (`github:Tungpeng/dsh-offpeak-inbox#<sha>`) if you want later pushes to stay out of what you run.

```sh
dsh plugin --profile web add github:Tungpeng/dsh-offpeak-inbox
```

**From npm**, once the package is on the registry — it is not yet published, so use one of the two routes above for now:

```sh
dsh plugin --profile web add dsh-offpeak-inbox
```

For development you can mount a local checkout instead, and a rebuild is enough:

```sh
dsh plugin --profile web add link:<path to this repository>
```

**Build before you mount.** A `link:` mount points straight at the source tree, and `lib/` is a build artifact that is deliberately not committed. If `lib/client.js` is missing when the host starts, `dsh web` fails *while loading plugins* and exits; a supervisor then retries with backoff, so the symptom is a hang rather than a clear error. Run `npm install` (which builds through `prepare`) or `npm run build` once before mounting.

## Configuration

Configuration keys in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. When off, the inbox still captures but never launches. |
| `timeZone` | `UTC` | IANA zone the peak ranges are evaluated in; UTC is DeepSeek's published frame. |
| `ranges` | 01:00–04:00, 06:00–10:00 | Weekday peak ranges; replace them to match your own billing frame. |
| `announceToAgent` | `true` | Whether to announce the plugin to agents through a system-prompt section. |
| `launchIntervalSeconds` | `10` | Seconds between launch attempts, floor 2. Each attempt starts **at most one** session, so this value sets how fast a backlog drains (smaller means more executions in flight at once), not how many run per round. The older name `tickSeconds` is still accepted. |
| `executionTimeoutSeconds` | `14400` | Abandon an execution that never settles after this long, marking it failed and pointing at the session. |

## Where the data lives

`$DSH_HOME/offpeak-inbox/inbox.json` (`~/.dsh` when `$DSH_HOME` is unset).

Item fields are `title` / `prompt` / `createdAt` / `runAfter` / `status`, alongside three mutually exclusive ownership facts: `targetSessionId` (an existing session the user picked, with `deliveredAt` written once the delivery is accepted), `sessionId` + `startedAt` (a session the plugin created and is watching run), and `settledAt` / `error` (the terminal state and the reason for it).

Writes are atomic (temporary file + rename). If the file cannot be parsed it is renamed to `inbox.json.corrupt-<timestamp>` to preserve the evidence, the scheduler starts from an empty ledger, and the failure is reported on the console — data is never dropped silently.

## Developer overview

```
src/calendar.ts   off-peak arithmetic: isPeak / currentWindow / nextWindowStartMs (pure, tested)
src/ledger.ts     persistence and the item state machine
src/runner.ts     launches real DSH sessions (gateway create/rename/prompt) and delivers into existing ones
src/service.ts    scheduling loop, launch decisions, execution reconciliation
src/routes.ts     same-origin HTTP surface (state / sessions / action / events)
src/index.ts      the Cordis plugin entry (wiring, settings, system-prompt section)
src/client.ts     browser half source (vanilla TS, Shadow DOM panel plus the off-peak button beside the composer, no dependencies)
lib/index.mjs     build output: host half
lib/client.js     build output: browser half, must be a __ModuleLoader__.load wrapper
```

A few design notes:

- **The host half has no runtime dependencies.** Every harness service arrives through Cordis injection and session RPC goes through the injected gateway; configuration validation implements the Standard Schema interface directly, and the serialized schema the settings page renders from is built by hand, so no schema library is needed.
- **Delivery goes through `session/prompt`, never a direct write into the live agent.** A message in the harness inbox is a complete `UserMessage` (identity, role, `content`, `source`); one hand-built without `source` kills the next turn with `Cannot read properties of undefined (reading 'kind')`. Asking the gateway to build it keeps the plugin out of internal message fields, and the live agent handle is read only for its running status. An item addressed to an existing session takes the same method, with the destination fixed at capture time.
- **A targeted item never overloads the `sessionId` field.** `sessionId` means "the session the plugin created and is watching to completion"; the destination the user picked lives on `targetSessionId`, and acceptance of the delivery settles the item, so later turns of your own in that session are never mistaken for this execution.
- **The current session comes from the browser's own persisted value.** The button reads `dsh.sessions.current` out of `localStorage` (the host's `sessions` service persists the selection there); it does not parse the URL or guess from a title, and it reports clearly when the value cannot be read.
- **A reported execution error settles the item as failed.** Reconciliation sees only whether a session is still running, so a turn that died before producing anything would otherwise settle as `done`; `api-session/error` supplies the reason.
- **Optional services are read through `ctx.get`.** Cordis's context property proxy **throws** for a service name that is not declared in `inject` rather than returning `undefined` (an optional clock service once kept the whole plugin from starting). Only the four required services are declared.
- **Clock injection for tests:** if the host provides a service named `now` (a function returning milliseconds), the scheduler reads time through it; otherwise it uses `Date.now`.
- **The acceptance rule lives in calendar.ts.** Boundary handling was corrected for instants that do not sit on the 15-minute grid (03:10 used to be computed as 01:10), and the regression test is kept in `test/calendar.test.ts`.
- **`test/runtime.test.ts` runs against the build output** (`lib/index.mjs`) so an activation break fails here rather than at the user's next `dsh web` start. `test/client.test.ts` evaluates `lib/client.js` as the classic script the browser module loader would run, then calls the pure decision functions it exports — a build that drops `internals`, or a wrapper that stops exporting it, fails in the suite instead of in the browser. `npm test` builds first (via `pretest`).

```sh
npm install          # install development dependencies
npm run build        # build the host half and produce lib/client.js
npm run typecheck    # both type checks: host (Node) and browser (DOM)
npm test             # builds, then runs unit tests + the runtime check
```

## Deployment notes (pitfalls we hit)

- **How a browser-half change actually reaches the page.** The client module registry reads bundle bytes into memory at startup, so refreshing the browser alone cannot replace the old code. The standard web composition also mounts an always-on `@deepseek-ai/dsh-client-hmr` row (`packages/bundle/web-app/cordis.patch.yml` says so): it compares every client artifact on `pollIntervalMs` (500 ms by default), recomposes the row whose content changed, and tells the browser to reload that plugin over the `/plugins/events` SSE channel. Rebuilding `lib/client.js` therefore normally needs **no host restart**; if the panel does not change, refresh the page first and restart `dsh web` only after that.
- **The panel tree carries a version, and the mounts carry an epoch — because hot reload really happens.** The panel hides instead of unmounting, so after a reload the page still holds the tree the **previous** half built: a `PANEL_VERSION` mismatch discards it whole, because the newer code would otherwise read parts (the search box, the count slot) that the older tree does not have. The sidebar entry and the composer button work the same way through `window.__dshOffpeakEpoch`: an older half's MutationObserver sees the epoch is no longer its own and stops re-inserting its nodes. Neither is decoration.
- **`lib/client.js` must be a `__ModuleLoader__.load` wrapper, never a copy of `src/client.js`.** `package.json`'s `./client` points at it, `tsdown` only produces the host half, and `scripts/publish-client.mjs` wraps it and validates the result with `vm.Script`. The registry merges every dynamic client half into one bundle loaded by a classic `<script>`: a single top-level `export` makes that whole bundle a SyntaxError, and the browser reports `Failed to load plugins … via __ModuleLoader__.load` as though every plugin had broken.
- **Don't capture a child process's output through a pipe in the build.** A confined sandbox can refuse to open the pipe (EPERM) and the failure masquerades as "tsc emitted nothing"; use inherited descriptors (`stdio: 'inherit'`).
- **`tsdown` without `--out-dir` writes to `dist/`** while the package entry points at `lib/` — the build script must pass the output directory explicitly.
- **The browser half may only use real DOM elements.** React internals (for example component functions inside `props.children`) end up in `children`; without an `instanceof HTMLElement` assertion the injection logic throws `button.closest is not a function` and the entry point disappears.
- **Panel refreshes must be incremental, never a subtree rebuild.** An early implementation cleared the shadow tree on every poll, which replaced the textarea node and **lost both the text being typed and the caret**. The skeleton is now built once, refreshes update only mutable parts, and "close" hides instead of destroying. An execution-level test asserts that the textarea is the same object across a refresh and keeps its text.
- **Diagnostic hook:** before opening the panel the client POSTs `clientLoaded` once. A `state.view.clientLoads` of 0 means the browser half never executed at all — the quickest way to tell "the script didn't run" from "it ran but couldn't attach to the DOM".
- **The composer button must be inserted into the `trailing` group, never attached to the composer card.** The card is a column flex container, so a button attached there becomes **a second row** below the control row; the correct anchor is the send button itself (`sendButtonOf`), with `insertBefore(button, send)`. The "already placed" test feeds the check that decides whether to insert, and that check must come out false on the next DOM mutation once the button is in place — otherwise every mutation re-inserts the button and the insertion triggers its own MutationObserver.
- **A DOM-mutation observer can trigger itself.** This button's observer shares the sidebar entry's `queueMicrotask` coalescing strategy: one attempt per microtask round, and no DOM write while the button is already in place.
- **A registered settings schema must be serializable, or the whole settings page fails.** The host answers the settings page by calling `schema.toJSON()` on **every** registered namespace (`SettingsProvider.describe()`), with no per-namespace guard, so one schema without that method throws for the entire RPC — every plugin's card, not just the one at fault. The shipped 0.1.0 registered a bare function and produced exactly that; `test/runtime.test.ts` now makes its fake host read the schema the same way so the defect cannot come back unnoticed.

## License

MIT
