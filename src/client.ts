/**
 * Browser half of the off-peak inbox.
 *
 * The panel is plain DOM inside a shadow root, so it cannot disturb the shell's
 * React tree and the shell's stylesheets cannot restyle it. All item text is
 * written as text nodes, never as markup: the stored prompts are user data.
 */
/** Base path of the inbox API; mirrors the host route module. */
const API = '/api/offpeak-inbox';
/** Attribute identifying the injected sidebar row. */
const ROW_ATTRIBUTE = 'data-dsh-offpeak-entry';
/** Attribute identifying the composer button. */
const DEFER_ATTRIBUTE = 'data-dsh-offpeak-defer';
/** localStorage key the shell persists the open session under. */
const CURRENT_SESSION_KEY = 'dsh.sessions.current';
/** How long the composer notice stays visible. */
const NOTICE_MS = 8000;
/** Marker attribute on the panel host element. */
const PANEL_ATTRIBUTE = 'data-dsh-offpeak-panel';
/**
 * Version of the panel tree this half builds.
 *
 * The panel is hidden rather than unmounted, so it survives a client hot reload
 * that installs a newer bundle. The stored tree is then from the previous half
 * and lacks whatever the newer one added, so a version mismatch discards it
 * whole instead of reading `undefined` out of it.
 */
const PANEL_VERSION = 2;
/** Window slot holding the live mount epoch. */
const EPOCH_KEY = '__dshOffpeakEpoch';
/** Poll interval for the panel while it is open. */
const POLL_MS = 5000;
/** Statuses the folded history group owns; everything else stays visible. */
const HISTORY_STATUS = ['done', 'cancelled'];
/** Rows the list paints per page, in both the history group and a search. */
const PAGE_SIZE = 20;
/** localStorage key holding whether the history group is expanded. */
const HISTORY_FOLD_KEY = 'dsh.offpeak.historyOpen';
/** Status labels, in the plugin's own copy. */
const STATUS_TEXT = {
    queued: '等待错峰',
    running: '执行中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
};
const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h12v9H2z"/><path d="M2 9h3.5l1 2h3l1-2H14"/></svg>';
const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; z-index: 2147483000;
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6e8ee;
}
.dialog {
  width: min(720px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
  background: #1b1d24; border: 1px solid #33363f; border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0,0,0,.5); overflow: hidden;
}
header { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #2b2e37; }
header h2 { margin: 0; font-size: 15px; font-weight: 600; }
header .when { margin-left: auto; font-size: 12px; color: #9aa0ad; }
header button.close { background: none; border: 0; color: #9aa0ad; font-size: 20px; cursor: pointer; line-height: 1; padding: 0 4px; }
header button.close:hover { color: #e6e8ee; }
.window { padding: 8px 16px; font-size: 12px; color: #9aa0ad; border-bottom: 1px solid #2b2e37; }
.window.peak { color: #e0b25c; }
.window.offpeak { color: #6fcf8f; }
.form { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-bottom: 1px solid #2b2e37; }
.form input, .form textarea {
  width: 100%; background: #15171d; border: 1px solid #33363f; border-radius: 7px;
  color: #e6e8ee; padding: 8px 10px; font: inherit; resize: vertical;
}
.form textarea { min-height: 64px; }
.form select {
  background: #15171d; border: 1px solid #33363f; border-radius: 7px; color: #e6e8ee;
  padding: 5px 8px; font: inherit; max-width: 46%;
}
.form .row { display: flex; align-items: center; gap: 10px; }
.form .hint { font-size: 12px; color: #7d8391; }
button.primary {
  margin-left: auto; background: #3b6df0; border: 0; color: #fff; border-radius: 7px;
  padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer;
}
button.primary:disabled { background: #2c3550; color: #7d8391; cursor: default; }
.toolbar { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid #2b2e37; }
.toolbar input {
  flex: 1; min-width: 0; background: #15171d; border: 1px solid #33363f; border-radius: 7px;
  color: #e6e8ee; padding: 6px 9px; font: inherit;
}
.toolbar .count { font-size: 12px; color: #7d8391; white-space: nowrap; }
.list { overflow: auto; padding: 4px 0 8px; }
.note { padding: 14px 16px; text-align: center; color: #7d8391; }
.fold {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 9px 16px; background: #191b21; border: 0; border-top: 1px solid #23262e;
  border-bottom: 1px solid #23262e; color: #9aa0ad; font: inherit; font-size: 12px; cursor: pointer;
}
.fold:hover { background: #1f2229; color: #e6e8ee; }
.fold .chev { flex: 0 0 auto; width: 10px; }
.more {
  display: block; margin: 10px auto 4px; background: #23262e; border: 1px solid #33363f;
  color: #c3c8d2; border-radius: 6px; padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer;
}
.more:hover { background: #2b2f39; color: #fff; }
.item { display: flex; gap: 10px; padding: 10px 16px; border-bottom: 1px solid #23262e; }
.item:last-child { border-bottom: 0; }
.item .body { flex: 1; min-width: 0; }
.item .title { font-weight: 600; word-break: break-word; }
.item .prompt { margin-top: 2px; color: #a7adba; white-space: pre-wrap; word-break: break-word; max-height: 68px; overflow: hidden; }
.item .meta { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: #7d8391; }
.badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 1px solid #3a3e4a; }
.badge.queued { color: #8fa7e8; border-color: #3a4a72; }
.badge.running { color: #6fcf8f; border-color: #2f5c40; }
.badge.done { color: #9aa0ad; }
.badge.failed { color: #e5737a; border-color: #63353a; }
.badge.cancelled { color: #9aa0ad; }
.item .actions { display: flex; flex-direction: column; gap: 4px; }
.item .actions button {
  background: #23262e; border: 1px solid #33363f; color: #c3c8d2; border-radius: 6px;
  padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.item .actions button:hover:not(:disabled) { background: #2b2f39; color: #fff; }
.item .actions button:disabled { opacity: .45; cursor: default; }
.error { margin: 0 16px 10px; padding: 8px 10px; border-radius: 7px; background: #3a2126; color: #f0a9ae; font-size: 12px; }
`;
/** Draft text survives a re-render triggered by polling. */
const draft = { title: '', prompt: '' };
let panelHost;
let shadow;
let open = false;
let timer;
let lastError = '';
/** Guards against a second deferral while the first request is in flight. */
let deferInFlight = false;
/** Last placement outcome reported to the host, so only changes are sent. */
let reportedButton = '';
/** Cached selectable sessions, refreshed when their staleness window expires. */
const targets = { sessions: [], loadedAt: 0, loading: false, confirmed: false };
/** How long the session list stays usable before the panel re-reads it. */
const TARGET_TTL_MS = 30000;
/** Read a stored panel preference; absent storage or no browser means the default. */
function readFlag(key) {
    try {
        return window.localStorage.getItem(key) === '1';
    }
    catch {
        // No storage (private mode, or the artifact imported outside a browser):
        // the fold keeps its default rather than failing the whole panel.
        return false;
    }
}
/** Persist a panel preference; a rejected write only costs the preference. */
function storeFlag(key, value) {
    try {
        window.localStorage.setItem(key, value ? '1' : '0');
    }
    catch {
        // Same as reading: the fold is a view preference, never a failure.
    }
}
/** Panel-local view state that survives every re-render: search text and fold. */
const panel = { query: '', historyOpen: readFlag(HISTORY_FOLD_KEY), pageLimit: PAGE_SIZE };
/** Last state the panel painted, so the search box re-filters without a fetch. */
let lastState;
/** Signature of the last painted list; an unchanged one skips the rebuild. */
let lastListKey = '';
function formatTime(instantMs, timeZone) {
    try {
        return new Intl.DateTimeFormat(undefined, {
            timeZone,
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(new Date(instantMs));
    }
    catch {
        return new Date(instantMs).toLocaleString();
    }
}
/** One captured item as the host sends it. */
interface PanelItem {
    id: string;
    title: string;
    prompt: string;
    createdAt: number;
    runAfter: number;
    status: string;
    targetSessionId?: string;
    sessionId?: string;
    startedAt?: number;
    settledAt?: number;
    deliveredAt?: number;
    error?: string;
}
/** Calendar date of an instant in the zone the panel renders, empty when unusable. */
function isoDate(instantMs, timeZone) {
    try {
        // en-CA formats as YYYY-MM-DD, which is the form a reader types.
        return new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date(instantMs));
    }
    catch {
        try {
            return new Date(instantMs).toISOString().slice(0, 10);
        }
        catch {
            return '';
        }
    }
}
/**
 * Whether one item answers the search box.
 *
 * The search reads the whole item rather than the painted row: a folded entry
 * must stay findable by everything its row shows, including the planned instant
 * that only waiting rows print, because the fold is a view state and never a
 * filter on the data.
 * @param item - the candidate item.
 * @param query - raw search box text; blank matches everything.
 * @param timeZone - zone the row renders its times in.
 * @returns whether the item matches.
 */
function matchesQuery(item: PanelItem, query: string, timeZone: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '')
        return true;
    const haystack = [
        item.title,
        item.prompt,
        item.error ?? '',
        item.sessionId ?? '',
        item.targetSessionId ?? '',
        STATUS_TEXT[item.status] ?? item.status,
        formatTime(item.createdAt, timeZone),
        isoDate(item.createdAt, timeZone),
        formatTime(item.runAfter, timeZone),
        isoDate(item.runAfter, timeZone),
    ].join('\n').toLowerCase();
    return haystack.includes(needle);
}
/**
 * Split items into the rows that stay visible and the folded history.
 * @param items - every item the host reported.
 * @returns both lists, newest first.
 */
function splitItems(items: PanelItem[]): { active: PanelItem[]; history: PanelItem[] } {
    const active: PanelItem[] = [];
    const history: PanelItem[] = [];
    for (const item of [...items].sort((left, right) => right.createdAt - left.createdAt)) {
        if (HISTORY_STATUS.includes(item.status))
            history.push(item);
        else
            active.push(item);
    }
    return { active, history };
}
/** What one list render paints. */
interface ListPlan {
    /** Every search hit, newest first; empty unless the search box has text. */
    hits: PanelItem[];
    /** Rows to paint, in order. */
    rows: PanelItem[];
    /** How many leading rows are attention rows; the fold bar follows them. */
    activeCount: number;
    /** Every settled row, newest first, painted or not. */
    history: PanelItem[];
    /** Rows the current page leaves behind the "more" step. */
    hidden: number;
    /** Whether the search box narrowed the list. */
    searching: boolean;
}
/**
 * Decide what the list shows for the panel's current view state.
 *
 * A search hit is shown whether or not it sits in the folded history, and both
 * the open group and the hit list are capped: an uncapped list would put back
 * the unbounded screen the fold exists to remove.
 * @param input - items, search text, fold state, page size, and render zone.
 * @returns the rows to paint plus the counts the toolbar reports.
 */
function listPlan(input: { items: PanelItem[]; query: string; historyOpen: boolean; pageLimit: number; timeZone: string }): ListPlan {
    const { active, history } = splitItems(input.items);
    const page = Math.max(0, input.pageLimit);
    if (input.query.trim() !== '') {
        const hits = input.items
            .filter(item => matchesQuery(item, input.query, input.timeZone))
            .sort((left, right) => right.createdAt - left.createdAt);
        const rows = hits.slice(0, page);
        return { hits, rows, activeCount: 0, history, hidden: hits.length - rows.length, searching: true };
    }
    const shown = input.historyOpen ? history.slice(0, page) : [];
    return {
        hits: [],
        rows: [...active, ...shown],
        activeCount: active.length,
        history,
        hidden: history.length - shown.length,
        searching: false,
    };
}
/** Test seams for the panel's pure list decisions, mirroring the host half. */
export const internals = { matchesQuery, splitItems, listPlan, claimEpoch, epochIsCurrent };
async function requestState() {
    const response = await fetch(`${API}/state`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body.state === undefined)
        throw new Error(body.error ?? `state failed: ${response.status}`);
    return body.state;
}
async function post(action) {
    const response = await fetch(`${API}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
    });
    const body = await response.json();
    if (body.state !== undefined)
        return body.state;
    throw new Error(body.error ?? `action failed: ${response.status}`);
}
/** Read the sessions a deferred message can be addressed to. */
async function fetchTargets() {
    const response = await fetch(`${API}/sessions`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.sessions))
        throw new Error(body.error ?? `sessions failed: ${response.status}`);
    return body.sessions;
}
/** Refresh the cached session list when it has gone stale. */
function loadTargets() {
    if (targets.loading)
        return;
    if (targets.sessions.length > 0 && Date.now() - targets.loadedAt < TARGET_TTL_MS)
        return;
    targets.loading = true;
    void fetchTargets()
        .then(sessions => {
        targets.sessions = sessions;
        targets.loadedAt = Date.now();
        targets.confirmed = true;
        fillTargets();
    })
        .catch((error) => {
        // The panel still works without the list: an empty selection means a
        // new session, which is the behaviour every existing item already has.
        targets.loadedAt = Date.now();
        console.warn('[offpeak-inbox] session targets unavailable', error);
    })
        .finally(() => { targets.loading = false; });
}
/** Render the options of the "send to" selector, keeping the current choice. */
function fillTargets() {
    const ui = shadow === undefined ? undefined : skeletonOf(shadow);
    if (ui === undefined)
        return;
    const chosen = ui.targetSelect.value;
    ui.targetSelect.replaceChildren();
    const fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = '新会话';
    ui.targetSelect.append(fresh);
    for (const session of targets.sessions) {
        const option = document.createElement('option');
        option.value = session.sessionId;
        const label = session.title.trim() !== '' ? session.title.trim() : session.sessionId;
        option.textContent = session.running ? `${label}（执行中）` : label;
        ui.targetSelect.append(option);
    }
    if (targets.sessions.some(session => session.sessionId === chosen))
        ui.targetSelect.value = chosen;
    else
        ui.targetSelect.value = '';
}
/** The add button's label and enabled state follow the chosen destination. */
function syncAddButton(ui) {
    const targeted = ui.targetSelect.value !== '';
    ui.addButton.textContent = targeted ? '攒到该会话' : '存起来';
    ui.addButton.disabled = draft.prompt.trim() === '';
}
/** Build the panel tree for one state. */
function render(state) {
    if (shadow === undefined)
        return;
    const view = state.view;
    // The panel skeleton is built once and then only updated. Rebuilding it on
    // every poll replaced the inputs and stole focus mid-typing, which is the
    // defect this structure exists to prevent.
    const ui = ensureSkeleton();
    ui.when.textContent = `${formatTime(view.now, view.displayTimeZone)} · ${view.displayTimeZone}`;
    ui.status.className = `window ${view.peak ? 'peak' : 'offpeak'}`;
    // Times render in the deployment's own zone, so the label says what the
    // user's clock will say. nextWindowStartMs is the boundary new captures
    // wait for, which is the running window's start while one is open.
    ui.status.textContent = view.peak
        ? `当前是高峰时段（贵），下一个平价窗口 ${formatTime(view.nextWindowStartMs, view.displayTimeZone)} 开始`
        : `当前是平价时段（半价），本窗口 ${formatTime(view.windowStartMs ?? view.now, view.displayTimeZone)} → ${formatTime(view.windowEndMs ?? view.nextPeakStartMs, view.displayTimeZone)}`;
    const queuedCount = state.items.filter(item => item.status === 'queued').length;
    ui.hint.textContent = state.items.length === 0
        ? '收件箱是空的'
        : (queuedCount === 0 ? '没有待执行的条目' : `已攒 ${queuedCount} 条等待执行`);
    syncAddButton(ui);
    // Only the error row and the list change per refresh.
    ui.error.replaceChildren();
    if (lastError !== '') {
        const error = document.createElement('div');
        error.className = 'error';
        error.textContent = lastError;
        ui.error.append(error);
    }
    lastState = state;
    // The rows are rebuilt only when something they paint changed. A poll that
    // repeats the same revision must not repaint the list under the reader.
    const key = [state.revision, state.items.length, panel.query, panel.historyOpen, panel.pageLimit, view.displayTimeZone].join('|');
    if (key !== lastListKey) {
        lastListKey = key;
        renderList();
    }
}
/** Paint the list from the last state: attention rows, folded history, or hits. */
function renderList(): void {
    const state = lastState;
    if (shadow === undefined || state === undefined)
        return;
    const ui = ensureSkeleton();
    const view = state.view;
    const plan = listPlan({
        items: state.items,
        query: panel.query,
        historyOpen: panel.historyOpen,
        pageLimit: panel.pageLimit,
        timeZone: view.displayTimeZone,
    });
    ui.count.textContent = plan.searching
        ? `${plan.hits.length} 条匹配`
        : (plan.history.length === 0 ? '' : `历史 ${plan.history.length} 条${panel.historyOpen ? '' : '，已折叠'}`);
    // A poll replaces the rows; the reader's scroll position is not part of the
    // data, so it is carried over by hand.
    const scrollTop = ui.list.scrollTop;
    ui.list.replaceChildren();
    const anyRow = plan.searching ? plan.hits.length > 0 : plan.activeCount > 0 || plan.history.length > 0;
    if (!anyRow) {
        ui.list.append(note(plan.searching
            ? `没有匹配「${panel.query.trim()}」的条目。`
            : '还没有攒下任何东西。'));
    }
    else if (plan.searching) {
        for (const item of plan.rows)
            ui.list.append(renderItem(item, view));
    }
    else {
        for (const item of plan.rows.slice(0, plan.activeCount))
            ui.list.append(renderItem(item, view));
        if (plan.activeCount === 0)
            ui.list.append(note('没有待执行的条目。'));
        if (plan.history.length > 0)
            ui.list.append(foldRow(plan.history.length));
        for (const item of plan.rows.slice(plan.activeCount))
            ui.list.append(renderItem(item, view));
    }
    if (anyRow && plan.hidden > 0)
        ui.list.append(moreButton(plan.hidden, plan.searching));
    ui.list.scrollTop = scrollTop;
}
/** One muted line of text inside the list. */
function note(text: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = 'note';
    element.textContent = text;
    return element;
}
/** The history group's toggle row, which carries the fold state. */
function foldRow(total: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fold';
    button.setAttribute('aria-expanded', panel.historyOpen ? 'true' : 'false');
    const chevron = document.createElement('span');
    chevron.className = 'chev';
    chevron.textContent = panel.historyOpen ? '▾' : '▸';
    const label = document.createElement('span');
    label.textContent = panel.historyOpen
        ? `历史记录（${total} 条）—— 点这里折叠`
        : `历史记录（${total} 条）—— 已收起，上面的搜索框仍能找到其中任意一条`;
    button.append(chevron, label);
    button.addEventListener('click', () => {
        panel.historyOpen = !panel.historyOpen;
        storeFlag(HISTORY_FOLD_KEY, panel.historyOpen);
        renderList();
    });
    return button;
}
/** Paint one more page, of the folded history or of the search hits. */
function moreButton(hidden: number, searching: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'more';
    const step = Math.min(hidden, PAGE_SIZE);
    button.textContent = searching
        ? `再看更多匹配 ${step} 条（还剩 ${hidden} 条）`
        : `再看更早的 ${step} 条（还剩 ${hidden} 条）`;
    button.addEventListener('click', () => {
        panel.pageLimit += PAGE_SIZE;
        renderList();
    });
    return button;
}
/** Persistent panel parts: created once, then only updated. */
interface PanelUi {
    backdrop: HTMLDivElement;
    when: HTMLSpanElement;
    status: HTMLDivElement;
    titleInput: HTMLInputElement;
    promptInput: HTMLTextAreaElement;
    targetSelect: HTMLSelectElement;
    hint: HTMLSpanElement;
    addButton: HTMLButtonElement;
    searchInput: HTMLInputElement;
    count: HTMLSpanElement;
    error: HTMLDivElement;
    list: HTMLDivElement;
}
/** The panel tree stored on the shadow root, tagged with the version that built it. */
interface StoredPanel {
    version: number;
    ui: PanelUi;
}
/** The built skeleton, kept on the shadow root so it dies with the panel. */
function skeletonOf(root: ShadowRoot): PanelUi | undefined {
    const stored = (root as unknown as { __offpeakUi?: StoredPanel }).__offpeakUi;
    return stored !== undefined && stored.version === PANEL_VERSION ? stored.ui : undefined;
}
/**
 * Claim the live mount epoch, retiring whatever an earlier client half mounted.
 *
 * A hot reload evaluates this module again while the previous half's DOM and
 * mutation observers are still in the page; without an epoch both halves keep
 * re-inserting their own sidebar row and composer button.
 * @returns the epoch this half owns.
 */
function claimEpoch(): number {
    const store = window;
    const next = (typeof store[EPOCH_KEY] === 'number' ? store[EPOCH_KEY] : 0) + 1;
    store[EPOCH_KEY] = next;
    return next;
}
/** Whether this half is still the one that owns the page's mounts. */
function epochIsCurrent(epoch: number): boolean {
    return window[EPOCH_KEY] === epoch;
}
/**
 * Build the panel skeleton on first use and return it thereafter.
 *
 * Inputs are never recreated, so focus and the caret survive every poll. `draft`
 * is the single source of truth for their contents; `show()` re-seeds it so a
 * reopened panel reflects the current draft.
 */
function ensureSkeleton(): PanelUi {
    const host = shadow;
    const existing = skeletonOf(host);
    if (existing !== undefined)
        return existing;
    // A tree from an earlier version of this half is discarded whole: its parts
    // are what the newer version reads, and a missing one would throw on the
    // first refresh. Before this half tagged its tree, the slot held the parts
    // themselves, so both layouts are read here.
    const stored = (host as unknown as { __offpeakUi?: StoredPanel | PanelUi }).__offpeakUi;
    const previous = stored === undefined ? undefined : ((stored as StoredPanel).ui ?? (stored as PanelUi));
    const wasOpen = previous !== undefined && previous.backdrop.style.display !== 'none';
    const style = document.createElement('style');
    style.textContent = STYLE;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('click', event => {
        if (event.target === backdrop)
            close();
    });
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    const header = document.createElement('header');
    const heading = document.createElement('h2');
    heading.textContent = '错峰收件箱';
    const when = document.createElement('span');
    when.className = 'when';
    const closeButton = document.createElement('button');
    closeButton.className = 'close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', '关闭');
    closeButton.addEventListener('click', () => close());
    header.append(heading, when, closeButton);
    const status = document.createElement('div');
    status.className = 'window';
    const form = document.createElement('div');
    form.className = 'form';
    const titleInput = document.createElement('input');
    titleInput.placeholder = '标题（可选）';
    titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
    const promptInput = document.createElement('textarea');
    promptInput.placeholder = '记下要聊的事、想法或待办。到了平价时段会自动开一个新会话交给 DSH 处理；也可以选择发到下面列出的已有会话。';
    promptInput.addEventListener('input', () => { draft.prompt = promptInput.value; });
    const targetSelect = document.createElement('select');
    targetSelect.className = 'target';
    const fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = '新会话';
    targetSelect.append(fresh);
    targetSelect.addEventListener('change', () => { syncAddButton(ui); });
    targetSelect.addEventListener('focus', () => { loadTargets(); });
    const row = document.createElement('div');
    row.className = 'row';
    const targetLabel = document.createElement('span');
    targetLabel.className = 'hint';
    targetLabel.textContent = '发到';
    const hint = document.createElement('span');
    hint.className = 'hint';
    const addButton = document.createElement('button');
    addButton.className = 'primary';
    addButton.type = 'button';
    addButton.textContent = '存起来';
    promptInput.addEventListener('input', () => { syncAddButton(ui); });
    addButton.addEventListener('click', () => {
        const target = targetSelect.value;
        const action = target === ''
            ? { kind: 'create', title: draft.title, prompt: draft.prompt }
            : { kind: 'defer', sessionId: target, prompt: draft.prompt };
        void mutate(action, () => {
            draft.title = '';
            draft.prompt = '';
            titleInput.value = '';
            promptInput.value = '';
        });
    });
    row.append(targetLabel, targetSelect, hint, addButton);
    form.append(titleInput, promptInput, row);
    // The search box is part of the persistent skeleton like the inputs above,
    // so typing in it survives the poll that repaints the rows below.
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'search';
    searchInput.placeholder = '搜标题、正文、报错或日期——折叠起来的历史也能搜到';
    searchInput.addEventListener('input', () => {
        panel.query = searchInput.value;
        renderList();
    });
    const count = document.createElement('span');
    count.className = 'count';
    toolbar.append(searchInput, count);
    const error = document.createElement('div');
    error.className = 'error-slot';
    const list = document.createElement('div');
    list.className = 'list';
    dialog.append(header, status, form, toolbar, error, list);
    backdrop.append(dialog);
    const ui: PanelUi = { backdrop, when, status, titleInput, promptInput, targetSelect, hint, addButton, searchInput, count, error, list };
    // Replacing rather than appending is what removes a previous version's tree.
    host.replaceChildren(style, backdrop);
    (host as unknown as { __offpeakUi?: StoredPanel }).__offpeakUi = { version: PANEL_VERSION, ui };
    // The rows the new tree has not painted yet are painted by the next refresh,
    // whatever the state signature says.
    lastListKey = '';
    if (previous !== undefined) {
        // Whether the panel was on screen was the user's last choice, not ours:
        // a closed panel stays closed across a reload, an open one stays open.
        backdrop.style.display = wasOpen ? '' : 'none';
        if (wasOpen)
            show();
    }
    return ui;
}
/** Copy the draft into the inputs; used when the panel opens. */
function seedDraft(ui: PanelUi): void {
    if (ui.titleInput.value !== draft.title)
        ui.titleInput.value = draft.title;
    if (ui.promptInput.value !== draft.prompt)
        ui.promptInput.value = draft.prompt;
    if (ui.searchInput.value !== panel.query)
        ui.searchInput.value = panel.query;
    syncAddButton(ui);
}
/** One item row. */
function renderItem(item, view) {
    const element = document.createElement('div');
    element.className = 'item';
    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title.trim() !== '' ? item.title : '（无标题）';
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = item.prompt;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const badge = document.createElement('span');
    badge.className = `badge ${item.status}`;
    badge.textContent = STATUS_TEXT[item.status];
    const captured = document.createElement('span');
    captured.textContent = `记于 ${formatTime(item.createdAt, view.displayTimeZone)}`;
    meta.append(badge, captured);
    if (item.status === 'queued') {
        const planned = document.createElement('span');
        planned.textContent = `计划 ${formatTime(item.runAfter, view.displayTimeZone)} 起可执行`;
        meta.append(planned);
    }
    if (item.targetSessionId !== undefined) {
        const destination = document.createElement('span');
        destination.textContent = item.status === 'done'
            ? `已发到已有会话 ${item.targetSessionId}`
            : `将发到已有会话 ${item.targetSessionId}`;
        meta.append(destination);
    }
    if (item.status === 'running' && item.sessionId !== undefined) {
        const running = document.createElement('span');
        running.textContent = '已在新会话中执行';
        meta.append(running);
    }
    if (item.error !== undefined) {
        const failure = document.createElement('span');
        failure.textContent = item.error;
        meta.append(failure);
    }
    body.append(title, prompt, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const addAction = (label: string, name: string, run: () => void): void => {
        actions.appendChild(actionButton(label, name, run));
    };
    if (item.status === 'queued') {
        addAction('立即执行', 'run', () => mutate({ kind: 'runNow', id: item.id }));
    }
    if (item.status === 'failed' || item.status === 'cancelled') {
        addAction('重试', 'retry', () => mutate({ kind: 'retry', id: item.id }));
    }
    if (item.status !== 'running') {
        addAction('删除', 'remove', () => mutate({ kind: 'remove', id: item.id }));
    }
    element.append(body, actions);
    return element;
}
function actionButton(label: string, name: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = name;
    button.addEventListener('click', run);
    return button;
}
/** Send one action then repaint from the authoritative host state. */
function mutate(action: Record<string, unknown>, onSuccess?: () => void) {
    return post(action)
        .then(state => {
        lastError = '';
        onSuccess?.();
        render(state);
    })
        .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        void refresh();
    });
}
function refresh() {
    return requestState()
        .then(state => { render(state); })
        .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        if (shadow !== undefined)
            render({ revision: 0, items: [], view: emptyView() });
    });
}
/** Placeholder view used only when the host cannot be reached. */
function emptyView() {
    const now = Date.now();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return { enabled: false, peak: false, nextWindowStartMs: now, nextPeakStartMs: now, now, timeZone: zone, displayTimeZone: zone, clientLoads: 0 };
}
function close() {
    open = false;
    if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
    }
    // Hide rather than unmount: recreating the panel on every open would
    // discard the built inputs along with the caret state inside them.
    const ui = skeletonOf(shadow);
    if (ui !== undefined)
        ui.backdrop.style.display = 'none';
}
function show() {
    open = true;
    ensurePanel();
    const ui = ensureSkeleton();
    ui.backdrop.style.display = '';
    seedDraft(ui);
    // The destination list only matters while the panel is open, so it is read
    // when the panel appears rather than by a background poll.
    loadTargets();
    // Re-read the state the panel is about to show.
    void refresh();
    if (timer === undefined) {
        timer = window.setInterval(() => {
            if (open)
                void refresh();
        }, POLL_MS);
    }
}
function toggle() {
    if (open)
        close();
    else
        show();
}
/** Create the shadow host once and keep it attached. */
function ensurePanel() {
    if (panelHost !== undefined && panelHost.isConnected)
        return;
    panelHost = document.querySelector < HTMLDivElement > (`[${PANEL_ATTRIBUTE}]`) ?? document.createElement('div');
    panelHost.setAttribute(PANEL_ATTRIBUTE, '');
    shadow = panelHost.shadowRoot ?? panelHost.attachShadow({ mode: 'open' });
    if (!panelHost.isConnected)
        document.body.append(panelHost);
}
/** Whether a value is a real DOM element (not a React component or child). */
function element(value) {
    return value instanceof HTMLElement ? value : undefined;
}
/** The sidebar root that owns the New Session button. */
function sidebarRoot() {
    const column = element(document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]'));
    if (column === undefined)
        return undefined;
    const logo = element(column.querySelector('[class*="logoRow"]'));
    if (logo?.parentElement != null)
        return logo.parentElement;
    return element(column.firstElementChild) ?? column;
}
/**
 * The New Session button the entry row is inserted after.
 *
 * Every branch is guarded: React internals can surface as non-elements through
 * `children`, and an unguarded value made the placement throw.
 */
function newSessionButton(root: HTMLElement): HTMLElement | undefined {
    const nested = element(root.querySelector('button[class*="newSession"]'));
    if (nested !== undefined)
        return nested;
    const kids = root.children;
    if (kids === undefined || typeof kids.length !== 'number')
        return undefined;
    for (const child of Array.from(kids)) {
        const candidate = element(child);
        if (candidate?.tagName === 'BUTTON')
            return candidate;
    }
    return undefined;
}
/** Insert the row after the New Session control; report what was found. */
function placeRow(row) {
    if (document.body.contains(row))
        return 'placed';
    const root = sidebarRoot();
    if (root === undefined)
        return 'no-sidebar-root';
    if (row.parentElement !== root) {
        // Prefer the New Session control the shell keeps in that row; fall back
        // to the brand row and finally to the top of the sidebar, so the entry
        // still appears when a layout renames its controls.
        const button = newSessionButton(root);
        const brand = element(root.querySelector('[class*="logoRow"]'));
        const anchor = button !== undefined
            ? button.nextElementSibling
            : (brand?.nextElementSibling ?? element(root.firstElementChild)?.nextElementSibling ?? null);
        root.insertBefore(row, anchor);
    }
    return document.body.contains(row) ? 'placed' : 'insert-failed';
}
function createRow() {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute(ROW_ATTRIBUTE, '');
    row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:8px 10px', 'margin:2px 0', 'background:none', 'border:0',
        'border-radius:8px', 'color:inherit', 'font:inherit', 'cursor:pointer',
        'text-align:left', 'opacity:.85',
    ].join(';');
    const icon = document.createElement('span');
    icon.style.cssText = 'display:flex;align-items:center;flex:0 0 auto';
    icon.innerHTML = ICON;
    const label = document.createElement('span');
    label.textContent = '错峰收件箱';
    row.append(icon, label);
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(127,127,127,.14)'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
    row.addEventListener('click', toggle);
    return row;
}
/** Mount the sidebar entry and keep it placed across shell re-renders. */
function mountRow(epoch: number) {
    const row = createRow();
    let lastReason = '';
    const attempt = () => {
        // A newer client half owns the page: this half's observer stops
        // re-inserting a row the newer one has already replaced.
        if (!epochIsCurrent(epoch))
            return;
        const reason = placeRow(row);
        if (reason !== lastReason) {
            lastReason = reason;
            if (reason === 'placed')
                console.info('[offpeak-inbox] sidebar entry mounted');
            else
                console.warn(`[offpeak-inbox] sidebar entry not placed yet: ${reason}`);
        }
    };
    // The shell mounts its sidebar after this plugin runs and rebuilds it on
    // layout changes, so placement is retried on any body mutation and the row
    // re-inserts itself if React drops it.
    let scheduled = false;
    const schedule = () => {
        if (scheduled)
            return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; attempt(); });
    };
    const observer = new MutationObserver(schedule);
    if (document.body !== null)
        observer.observe(document.body, { childList: true, subtree: true });
    attempt();
    return () => {
        observer.disconnect();
        row.remove();
    };
}
/** Tell the host that the browser half actually executed. */
function reportLoaded() {
    try {
        void fetch(`${API}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'clientLoaded' }),
        }).catch(() => { });
    }
    catch {
        // Reporting is diagnostic only; never let it break mounting.
    }
}
/** Tell the host whether the composer button is placed. */
function reportButtonState(mounted, reason) {
    const key = `${mounted ? 'mounted' : 'missing'}:${reason}`;
    if (key === reportedButton)
        return;
    reportedButton = key;
    try {
        void fetch(`${API}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'buttonState', mounted, reason }),
        }).catch(() => { });
    }
    catch {
        // Same as the load report: diagnostic only, never fatal to mounting.
    }
}
/** The session the shell currently has open, as persisted by its own store. */
function currentSessionId() {
    try {
        const raw = localStorage.getItem(CURRENT_SESSION_KEY);
        if (raw === null)
            return undefined;
        const parsed = JSON.parse(raw);
        const id = parsed?.sessionId;
        return typeof id === 'string' && id !== '' ? id : undefined;
    }
    catch {
        // A missing, unreadable, or foreign value means no session is known;
        // the button reports that instead of deferring into the wrong one.
        return undefined;
    }
}
/** The composer's text, read out of whatever nodes the editor holds. */
function composerText(input: HTMLElement): string {
    const parts: string[] = [];
    for (const node of Array.from(input.childNodes)) {
        if (typeof node.textContent === 'string')
            parts.push(node.textContent);
    }
    // contenteditable substitutes non-breaking spaces; the model reads the text
    // as the user typed it.
    return parts.join('').replace(/\u00a0/g, ' ').trim();
}
/** The composer card owning an element, or undefined outside a composer. */
function composerCardOf(node: Element | null | undefined): HTMLElement | undefined {
    const element = node instanceof HTMLElement ? node : undefined;
    return element?.closest('[data-composer-card]') ?? undefined;
}
/**
 * The composer card's send control: the last button of its control group.
 *
 * The card can hold more than one `trailing` group — the slash menu's drillable
 * rows use that class inside the input overlay, above the composer's own row —
 * so the first group with a button wins, not the first group in document order.
 */
function sendButtonOf(card: HTMLElement): HTMLButtonElement | undefined {
    for (const group of Array.from(card.querySelectorAll('[class*="trailing"]'))) {
        const buttons = Array.from(group.querySelectorAll('button'));
        const last = buttons[buttons.length - 1];
        if (last !== undefined)
            return last;
    }
    return undefined;
}
/** Format a planned instant in the browser's own zone. */
function formatLocal(instantMs: number): string {
    try {
        return new Intl.DateTimeFormat(undefined, {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(instantMs));
    }
    catch {
        return new Date(instantMs).toLocaleString();
    }
}
/** Show one line of feedback above the composer, replacing any previous line. */
function notifyComposer(card, text, level) {
    const existing = card.querySelector('[data-dsh-offpeak-notice]');
    existing?.remove();
    const notice = document.createElement('div');
    notice.setAttribute('data-dsh-offpeak-notice', '');
    notice.setAttribute('role', 'status');
    notice.textContent = text;
    notice.style.cssText = [
        'margin:6px 0', 'padding:6px 10px', 'border-radius:8px', 'font:12px/1.5 system-ui, sans-serif',
        level === 'error' ? 'background:rgba(190,60,70,.18)' : 'background:rgba(60,120,200,.16)',
        level === 'error' ? 'color:#f0a9ae' : 'color:#9db8e8',
    ].join(';');
    card.append(notice);
    window.setTimeout(() => { notice.remove(); }, NOTICE_MS);
}
/** Build the composer button once. */
function createDeferButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(DEFER_ATTRIBUTE, '');
    button.textContent = '错峰';
    button.title = '把输入框里的内容攒到平价（错峰）时段，再发到这个会话';
    button.setAttribute('aria-label', button.title);
    button.style.cssText = [
        'background:none', 'border:1px solid rgba(127,127,127,.45)', 'border-radius:999px',
        'color:inherit', 'opacity:.85', 'font:12px/1 system-ui, sans-serif', 'padding:6px 10px',
        'cursor:pointer', 'white-space:nowrap',
    ].join(';');
    button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
    button.addEventListener('mouseleave', () => { button.style.opacity = '.85'; });
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void deferDraft(button);
    });
    return button;
}
/** Capture the composer draft for the next off-peak window. */
async function deferDraft(button) {
    if (deferInFlight)
        return;
    const card = composerCardOf(button);
    if (card === undefined) {
        lastError = '没找到输入框，无法攒下这条内容。';
        return;
    }
    const input = card.querySelector<HTMLElement>('[data-composer-input]');
    const prompt = input === null ? '' : composerText(input);
    if (prompt === '') {
        notifyComposer(card, '输入框是空的，先写下要发的内容。', 'error');
        return;
    }
    const sessionId = currentSessionId();
    if (sessionId === undefined) {
        notifyComposer(card, '没认出当前会话（可能刚打开、还没有会话），这条没有攒下。', 'error');
        return;
    }
    // The selection is one origin-wide key, so another tab on a different
    // conversation overwrites it. Refusing an id the host cannot list turns a
    // silent misdelivery into a retry, which is the only recovery available
    // without a per-tab session identity. A list that never loaded proves
    // nothing, so an unconfirmed cache lets the attempt through.
    if (targets.confirmed && !targets.sessions.some(session => session.sessionId === sessionId)) {
        targets.loadedAt = 0;
        loadTargets();
        notifyComposer(card, '这个会话不在可选的会话列表里（可能是较早的会话或已被删除），这条没有攒下。', 'error');
        return;
    }
    deferInFlight = true;
    try {
        const response = await fetch(`${API}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'defer', sessionId, prompt }),
        });
        const body = await response.json();
        if (!response.ok || body.ok !== true)
            throw new Error(body.error ?? `defer failed: ${response.status}`);
        // Naming the destination is the only cross-check the user gets: the
        // selection key is shared by every tab, so the text states where the
        // message actually went rather than trusting "this session".
        const session = targets.sessions.find(entry => entry.sessionId === sessionId);
        const where = session === undefined || session.title.trim() === ''
            ? `这个会话（${sessionId}）`
            : `「${session.title.trim()}」（${sessionId}）`;
        // The host reports the instant the capture is actually due at, so the
        // two cases are read from that rather than from the calendar: inside a
        // window the instant is now and the next scheduler tick hands it over,
        // while a waiting capture is due at the boundary.
        if (body.deferredWait === true && typeof body.deliverAt === 'number') {
            notifyComposer(card, `已攒下，将在平价窗口 ${formatLocal(body.deliverAt)} 发到 ${where}。`, 'info');
        }
        else {
            notifyComposer(card, `已攒下，马上发到 ${where}。`, 'info');
        }
    }
    catch (error) {
        notifyComposer(card, error instanceof Error ? error.message : String(error), 'error');
    }
    finally {
        deferInFlight = false;
    }
}
/**
 * The composer card a button should sit in.
 *
 * The shell renders one composer per active conversation; the button is placed
 * in whichever card currently holds an editor, so it follows the user between
 * sessions instead of pinning to the first card that appeared.
 */
function activeComposerCard() {
    const inputs = document.querySelectorAll('[data-composer-input]');
    for (const input of Array.from(inputs)) {
        const card = composerCardOf(input);
        if (card !== undefined)
            return card;
    }
    return undefined;
}
/** Insert the composer button beside Send, re-inserting it after re-renders. */
function mountDeferButton(epoch: number) {
    const button = createDeferButton();
    const attempt = () => {
        // Same as the sidebar row: an earlier half's observer must not fight the
        // newer half over the composer's control group.
        if (!epochIsCurrent(epoch))
            return;
        const card = activeComposerCard();
        if (card === undefined) {
            button.remove();
            reportButtonState(false, 'no-composer');
            return;
        }
        const send = sendButtonOf(card);
        if (send === undefined || send.parentElement === null) {
            button.remove();
            reportButtonState(false, 'no-send-control');
            return;
        }
        // Beside Send inside the trailing group: a card-level child would be a
        // second flex row under the controls instead of a neighbour of Send. Any
        // position before Send inside that group counts as placed, because an
        // older half still holding the slot right before Send would otherwise
        // re-insert its node on our every write, and we ours on its every write.
        const sameGroup = button.parentElement === send.parentElement;
        const beforeSend = (button.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        if (!sameGroup || !beforeSend) {
            send.parentElement.insertBefore(button, send);
        }
        reportButtonState(true, 'placed');
    };
    let scheduled = false;
    const schedule = () => {
        if (scheduled)
            return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; attempt(); });
    };
    const observer = new MutationObserver(schedule);
    if (document.body !== null)
        observer.observe(document.body, { childList: true, subtree: true });
    attempt();
    return () => {
        observer.disconnect();
        button.remove();
    };
}
/**
 * Neutralize the mounts an earlier half left in the page.
 *
 * They are hidden rather than deleted: the previous half's mutation observers
 * re-insert any node of theirs they no longer find in the document, so a removal
 * would be undone on the next microtask and the two halves would trade the same
 * slot forever. A node left in place but invisible satisfies that observer.
 */
function retireForeignMounts(): void {
    for (const node of Array.from(document.querySelectorAll(`[${ROW_ATTRIBUTE}], [${DEFER_ATTRIBUTE}]`))) {
        const element = node as HTMLElement;
        element.style.display = 'none';
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('tabindex', '-1');
    }
}
/** Cordis client plugin entry point. */
export function apply(ctx?: { effect?: (run: () => () => void, label?: string) => void }) {
    try {
        console.info('[offpeak-inbox] client half loaded');
        reportLoaded();
        // A hot reload runs this entry again beside the previous half's DOM. The
        // epoch retires that half's observers and its nodes are hidden, so the
        // page keeps exactly one sidebar row and one composer button.
        const epoch = claimEpoch();
        retireForeignMounts();
        const mount = () => {
            const disposeButton = mountDeferButton(epoch);
            const disposeRow = mountRow(epoch);
            return () => {
                disposeButton();
                disposeRow();
            };
        };
        // A reload disposes the previous fiber's effects, which is what removes
        // this half's observers and nodes before the next half mounts.
        if (typeof ctx?.effect === 'function')
            ctx.effect(mount, 'offpeak-inbox: client mounts');
        else
            mount();
    }
    catch (error) {
        console.error('[offpeak-inbox] client half failed to mount', error);
    }
}
