/**
 * Browser-half list behaviour.
 *
 * The panel paints plain DOM, so what is exercised here is the decision that
 * painting follows: which rows stay visible, which are folded into history, how
 * a page is capped, and what the search box finds. The shipped browser bundle
 * (`lib/client.js`) is loaded exactly as the harness loads it — through
 * `window.__ModuleLoader__` — so a build step that drops the helpers, or a
 * wrapper that stops exporting them, fails here instead of in the browser.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

/** One captured item as the panel receives it. */
interface Item {
  id: string
  title: string
  prompt: string
  createdAt: number
  runAfter: number
  status: string
  targetSessionId?: string
  sessionId?: string
  error?: string
}

/** One list render's plan. */
interface Plan {
  hits: Item[]
  rows: Item[]
  activeCount: number
  history: Item[]
  hidden: number
  searching: boolean
}

/** The browser bundle's exports, narrowed to what this suite reads. */
interface ClientModule {
  apply(ctx?: unknown): void
  internals: {
    matchesQuery(item: Item, query: string, timeZone: string): boolean
    splitItems(items: Item[]): { active: Item[]; history: Item[] }
    listPlan(input: {
      items: Item[]
      query: string
      historyOpen: boolean
      pageLimit: number
      timeZone: string
    }): Plan
    claimEpoch(): number
    epochIsCurrent(epoch: number): boolean
  }
}

/** The loader handoff the bundle performs on load. */
type Factory = (require: (id: string) => unknown) => ClientModule

/** A loaded browser half plus the `window` it was evaluated against. */
interface Loaded {
  client: ClientModule
  page: Record<string, unknown>
}

/** One element exposing exactly the members the browser half touches. */
interface FakeElement {
  style: Record<string, string>
  attributes: Record<string, string>
  textContent: string
  innerHTML: string
  title: string
  type: string
  className: string
  placeholder: string
  value: string
  disabled: boolean
  isConnected: boolean
  parentElement: unknown
  nextElementSibling: unknown
  append(): void
  remove(): void
  setAttribute(name: string, value: string): void
  addEventListener(): void
  querySelector(): unknown
  querySelectorAll(): unknown[]
  closest(): unknown
  compareDocumentPosition(): number
}

/** A fresh fake element. */
function fakeElement(): FakeElement {
  const attributes: Record<string, string> = {}
  return {
    style: {},
    attributes,
    textContent: '',
    innerHTML: '',
    title: '',
    type: '',
    className: '',
    placeholder: '',
    value: '',
    disabled: false,
    isConnected: false,
    parentElement: null,
    nextElementSibling: null,
    append(): void {},
    remove(): void {},
    setAttribute(name: string, value: string): void { attributes[name] = value },
    addEventListener(): void {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    compareDocumentPosition: () => 0,
  }
}

/**
 * Load the shipped browser bundle the way the shell's module loader does.
 *
 * `foreign` stands in for nodes an earlier half of this plugin left in the page;
 * a bare page has no composer, which is the state the entry point must survive.
 */
function loadClient(foreign: FakeElement[] = []): Loaded {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let factory: Factory | undefined
  const page: Record<string, unknown> = {
    __ModuleLoader__: {
      load(options: { factory: Factory }): void { factory = options.factory },
    },
  }
  // The bundle is a classic script that hands its factory to the shell's module
  // loader, so it is evaluated with the loader stub in place rather than
  // imported as a module of its own.
  runInNewContext(source, {
    window: page,
    console: { info(): void {}, warn(): void {}, error(): void {} },
    HTMLElement: class {},
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    document: {
      body: { contains: () => false },
      createElement: () => fakeElement(),
      querySelector: () => null,
      querySelectorAll: () => foreign,
    },
  })
  if (factory === undefined)
    throw new Error('the browser bundle never registered with the module loader')
  return {
    client: factory(() => {
      throw new Error('the browser half must not require a module')
    }),
    page,
  }
}

/** One item with only the fields a case cares about. */
function item(overrides: Partial<Item> & { id: string }): Item {
  return {
    title: '',
    prompt: '',
    createdAt: Date.UTC(2026, 8, 21, 10, 0),
    runAfter: Date.UTC(2026, 8, 21, 10, 0),
    status: 'done',
    ...overrides,
  }
}

/** The plan for one set of items under a given view state. */
function plan(
  items: Item[],
  view: { query?: string; historyOpen?: boolean; pageLimit?: number },
  listPlan: ClientModule['internals']['listPlan'],
): Plan {
  return listPlan({
    items,
    query: view.query ?? '',
    historyOpen: view.historyOpen ?? false,
    pageLimit: view.pageLimit ?? 20,
    timeZone: 'UTC',
  })
}

describe('panel list', () => {
  it('folds settled rows and keeps rows that still want attention visible', () => {
    const { client } = loadClient()
    const items = [
      item({ id: 'done-old', status: 'done', createdAt: 1000 }),
      item({ id: 'cancelled', status: 'cancelled', createdAt: 2000 }),
      item({ id: 'failed', status: 'failed', createdAt: 3000 }),
      item({ id: 'running', status: 'running', createdAt: 4000 }),
      item({ id: 'queued', status: 'queued', createdAt: 5000 }),
    ]
    const { active, history } = client.internals.splitItems(items)
    // Newest first, and a failure is never folded away: it is the one settled
    // row that still asks the user for something.
    expect(active.map(entry => entry.id)).toEqual(['queued', 'running', 'failed'])
    expect(history.map(entry => entry.id)).toEqual(['cancelled', 'done-old'])
  })

  it('searches folded rows by title, prompt, session, status, and date', () => {
    const { client } = loadClient()
    const folded = item({
      id: 'folded',
      title: '整理旧清单与归档脚本',
      prompt: '给两个样例站点写一个自动备份脚本，并核对 SampleFeed 的导出格式',
      status: 'done',
      targetSessionId: 'session-abc',
      createdAt: Date.UTC(2026, 8, 21, 10, 0),
    })
    const matches = client.internals.matchesQuery
    expect(matches(folded, '整理旧清单', 'UTC')).toBe(true)
    expect(matches(folded, 'samplefeed 的导出', 'UTC')).toBe(true)
    expect(matches(folded, 'session-abc', 'UTC')).toBe(true)
    expect(matches(folded, '已完成', 'UTC')).toBe(true)
    expect(matches(folded, '2026-09-21', 'UTC')).toBe(true)
    expect(matches(folded, '09/21', 'UTC')).toBe(true)
    expect(matches(folded, '   ', 'UTC')).toBe(true)
    expect(matches(folded, '无关的条目', 'UTC')).toBe(false)
  })

  it('searches the planned instant a waiting row prints', () => {
    const { client } = loadClient()
    const queued = item({
      id: 'queued',
      status: 'queued',
      prompt: 'nothing searchable here',
      createdAt: Date.UTC(2026, 8, 21, 2, 0),
      runAfter: Date.UTC(2026, 8, 22, 9, 0),
    })
    const matches = client.internals.matchesQuery
    // The row prints "计划 09/22 16:00 起可执行" in Asia/Jakarta, and the search
    // must find what the row shows, not only what the fields hold.
    expect(matches(queued, '2026-09-22', 'Asia/Jakarta')).toBe(true)
    expect(matches(queued, '09/22', 'Asia/Jakarta')).toBe(true)
    // The zone decides the printed date: 09:00 UTC is still 09-22 in Jakarta but
    // 09-21 in UTC−12, and the search follows what the row shows.
    expect(matches(queued, '2026-09-21', 'Etc/GMT+12')).toBe(true)
    expect(matches(queued, '2026-09-22', 'Etc/GMT+12')).toBe(false)
  })

  it('searches a failure by its own reported text', () => {
    const { client } = loadClient()
    const failed = item({
      id: 'failed',
      status: 'failed',
      error: '投递到会话 session-abc 失败：session/not-found',
    })
    expect(client.internals.matchesQuery(failed, 'not-found', 'UTC')).toBe(true)
    expect(client.internals.matchesQuery(failed, '投递到会话', 'UTC')).toBe(true)
  })

  it('caps the open history group instead of restoring the unbounded list', () => {
    const { client } = loadClient()
    const listPlan = client.internals.listPlan
    const items = [
      item({ id: 'queued', status: 'queued', createdAt: 100_000 }),
      ...Array.from({ length: 45 }, (_unused, index) => item({ id: `done-${index}`, createdAt: index })),
    ]
    const folded = plan(items, {}, listPlan)
    // Folded: only the attention row is painted, and the bar reports the rest.
    expect(folded.rows.map(entry => entry.id)).toEqual(['queued'])
    expect(folded.activeCount).toBe(1)
    expect(folded.hidden).toBe(45)

    const opened = plan(items, { historyOpen: true, pageLimit: 20 }, listPlan)
    expect(opened.rows).toHaveLength(21)
    expect(opened.activeCount).toBe(1)
    expect(opened.hidden).toBe(25)
    // Newest first: the cap keeps the rows a reader is most likely to want.
    expect(opened.rows[1]?.id).toBe('done-44')
  })

  it('pages search hits rather than painting every match at once', () => {
    const { client } = loadClient()
    const listPlan = client.internals.listPlan
    const items = Array.from({ length: 45 }, (_unused, index) => item({
      id: `match-${index}`,
      prompt: '核对样例条目并更新索引',
      createdAt: index,
    }))
    const firstPage = plan(items, { query: '样例条目' }, listPlan)
    expect(firstPage.searching).toBe(true)
    expect(firstPage.hits).toHaveLength(45)
    expect(firstPage.rows).toHaveLength(20)
    expect(firstPage.rows[0]?.id).toBe('match-44')
    expect(firstPage.hidden).toBe(25)

    const secondPage = plan(items, { query: '样例条目', pageLimit: 40 }, listPlan)
    expect(secondPage.rows).toHaveLength(40)
    expect(secondPage.hidden).toBe(5)
  })

  it('shows search hits whether or not their group is folded', () => {
    const { client } = loadClient()
    const items = [
      item({ id: 'visible', status: 'queued', prompt: 'nothing here' }),
      item({ id: 'buried', status: 'done', prompt: '核对样例条目并更新索引' }),
    ]
    const found = plan(items, { query: '样例条目' }, client.internals.listPlan)
    expect(found.searching).toBe(true)
    expect(found.hits.map(entry => entry.id)).toEqual(['buried'])
    expect(found.rows.map(entry => entry.id)).toEqual(['buried'])
    expect(found.activeCount).toBe(0)
    // The counts the toolbar reports stay complete while searching.
    expect(found.history).toHaveLength(1)

    const empty = plan(items, { query: '找不到的东西' }, client.internals.listPlan)
    expect(empty.hits).toEqual([])
    expect(empty.rows).toEqual([])
    expect(empty.searching).toBe(true)
  })

  it('keeps an empty inbox searching-free', () => {
    const { client } = loadClient()
    const empty = plan([], {}, client.internals.listPlan)
    expect(empty.searching).toBe(false)
    expect(empty.rows).toEqual([])
    expect(empty.activeCount).toBe(0)
    expect(empty.history).toEqual([])
    expect(empty.hidden).toBe(0)
  })

  it('arbitrates the page mounts by epoch so a newer half retires the older', () => {
    const { client, page } = loadClient()
    const first = client.internals.claimEpoch()
    expect(client.internals.epochIsCurrent(first)).toBe(true)
    const second = client.internals.claimEpoch()
    expect(second).toBe(first + 1)
    // The earlier half's observers see this and stop re-inserting their nodes.
    expect(client.internals.epochIsCurrent(first)).toBe(false)
    expect(client.internals.epochIsCurrent(second)).toBe(true)
    expect(page['__dshOffpeakEpoch']).toBe(second)
  })

  it('exports the browser entry point the module loader calls', () => {
    const { client } = loadClient()
    expect(typeof client.apply).toBe('function')
    // The entry point takes the Cordis context the client runner passes it, and
    // must also survive a page with no composer and no context at all.
    expect(() => client.apply()).not.toThrow()
  })

  it('hides the mounts an earlier half left behind instead of deleting them', () => {
    // Deleting them makes the older half's observer insert them again on the
    // next microtask, so the two halves would trade the same slot forever.
    const foreign = fakeElement()
    const { client } = loadClient([foreign])
    client.apply()
    expect(foreign.style.display).toBe('none')
    expect(foreign.attributes['aria-hidden']).toBe('true')
    expect(foreign.attributes['tabindex']).toBe('-1')
  })
})
