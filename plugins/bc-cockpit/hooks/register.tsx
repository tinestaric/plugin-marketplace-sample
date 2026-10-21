import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { attentionItems, boardToCompact, boardToText, buildFixPrompt, createCockpit, firstError, GLYPH, pipelineKey, prKey, sprintEnds, summarise } from '../core/index.js'
import type { Attention, Board, Detail, Pipeline } from '../types'

const PANE = 'cockpit'
const HIGHLIGHT_MS = 20_000
const PREFETCH = 3 // failures whose error is fetched ahead, so the row can show it without a click

const boardAtom = atom({ plugin: 'bc-cockpit', key: 'board' } as const, null)
const refreshing = atom({ plugin: 'bc-cockpit', key: 'isRefreshing' } as const, false)
const changedAtom = atom({ plugin: 'bc-cockpit', key: 'changed' } as const, {})
const detailsAtom = atom({ plugin: 'bc-cockpit', key: 'details' } as const, {})
const expandedAtom = atom({ plugin: 'bc-cockpit', key: 'expanded' } as const, null)
const sectionsAtom = atom({ plugin: 'bc-cockpit', key: 'sections' } as const, {})
const showErrors = atom({ plugin: 'bc-cockpit', key: 'showErrors' } as const, false)

// Build ids repeat across organisations (and projects): every cache, expansion and button is keyed by all three.
const bkey = (p: { org: string; project: string; buildId: number }) => `${p.org}/${p.project}/${p.buildId}`
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const ago = (iso: string | number | undefined, now: number) => {
  const t = typeof iso === 'number' ? iso : Date.parse(iso ?? '')
  if (!t) return ''
  const m = Math.max(0, Math.round((now - t) / 60000))
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}
const text = (value: string) => ({ result: { content: [{ type: 'text', text: value }], isError: false } })

let cockpit: ReturnType<typeof createCockpit> | undefined
let timer: { cancel: () => void } | undefined

// ── data ─────────────────────────────────────────────────────────────────

async function refresh($: any, force: boolean): Promise<Board> {
  if (!cockpit) throw new Error('cockpit is not started')
  await update($, refreshing, () => true)
  try {
    const board: Board = await cockpit.getBoard({ force })
    const now = await $.clock.now()
    await update($, boardAtom, () => board)
    if (board.changed?.length) {
      await update($, changedAtom, (m: Record<string, number>) => ({
        ...m,
        ...Object.fromEntries(board.changed!.map(k => [k, now + HIGHLIGHT_MS])),
      }))
      const nowFailing = board.pipelines.filter(p => p.state === 'failed' && board.changed!.includes(pipelineKey(p)))
      if (nowFailing.length) $.ui.toast(`Pipeline red: ${nowFailing.map(p => p.definition).join(', ')}`)
      $.clock.after(HIGHLIGHT_MS + 500, () => void update($, changedAtom, (m: Record<string, number>) => m))
    }
    void prefetch($, board, now).catch(() => {}) // a convenience: never let it become an unhandled rejection
    return board
  } finally {
    await update($, refreshing, () => false)
  }
}

/** Fetch the error of the first few failures quietly, so their rows can show it. */
async function prefetch($: any, board: Board, now: number) {
  for (const it of attentionItems(board as any, { now }).filter(i => i.kind === 'pipeline').slice(0, PREFETCH)) {
    await loadDetail($, it.pipeline as Pipeline)
  }
}

async function loadDetail($: any, p: Pipeline): Promise<Detail> {
  const key = bkey(p)
  const existing = (await read($, detailsAtom))[key]
  if (existing) return existing
  let detail: Detail
  try {
    detail = { failure: await cockpit!.getFailureDetails({ org: p.org, project: p.project, buildId: p.buildId }) }
  } catch (e) {
    detail = { error: e instanceof Error ? e.message : String(e) }
  }
  await update($, detailsAtom, (m: Record<string, Detail>) => ({ ...m, [key]: detail }))
  return detail
}

/** Open the pane on one item (its log, or its link). The band's digits and the pane's digits mean the same item. */
async function toggleItem($: any, it: Attention) {
  await update($, expandedAtom, (cur: string | null) => (cur === it.key ? null : it.key))
  await $.ui.open({ id: PANE, title: 'Cockpit', focus: true })
  if (it.pipeline) await loadDetail($, it.pipeline)
}

async function toggleSection($: any, name: string) {
  await update($, sectionsAtom, (m: Record<string, boolean>) => ({ ...m, [name]: !m[name] }))
}

async function fix($: any, p: Pipeline, background: boolean) {
  const detail = await loadDetail($, p)
  if ('error' in detail) return $.ui.toast(`Cannot prepare fix: ${detail.error}`)
  const f = detail.failure
  if (!f.localPath) return $.ui.toast('No local clone found under repoRoots')
  const prompt = buildFixPrompt(f as any)
  if (background) {
    await $.agent.spawn({ prompt, description: `Fix ${f.pipeline}`, cwd: f.localPath })
    $.ui.toast(`Fixing ${f.pipeline} in the background`)
  } else {
    void $.prompt.submit({ text: prompt })
  }
}

export const register: Register = on => {
  // ── lifecycle ───────────────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    cockpit = createCockpit({
      home,
      now: () => Date.now(),
      env: async () => $.env.get('AZDO_PAT'), // the one variable core asks for
      fetch: (url: string, init?: object) => $.http.fetch(url, init as any),
      run: (argv: string[], init?: object) => $.process.run(argv, init as any),
      fs: {
        read: (p: string) => $.fs.read(p),
        write: (p: string, t: string) => $.fs.write(p, t),
        list: (p: string) => $.fs.list(p),
        exists: (p: string) => $.fs.exists(p),
      },
      store: { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v) },
    } as any)

    await $.command.register({ name: 'cockpit', description: 'What needs you across Azure DevOps: failed pipelines, PRs, and your sprint' })

    const tools: [string, string, Record<string, unknown>?][] = [
      ['cockpit_get_board', 'Returns what needs the person (failed pipelines, PRs in trouble or waiting on review), their current sprint work, PRs and pipelines across Azure DevOps, as compact JSON. Read-only.'],
      [
        'cockpit_get_failure',
        'Returns the trimmed failure details of a failed build (failed steps, compiler/test errors, local clone path, commit). Read-only.',
        {
          type: 'object',
          properties: { buildId: { type: 'number' }, org: { type: 'string' }, project: { type: 'string' } },
          required: ['buildId', 'org', 'project'],
        },
      ],
      ['cockpit_refresh', 'Forces a refresh of the Azure DevOps board and returns it as compact JSON. Read-only.'],
    ]
    for (const [name, description, inputSchema] of tools) {
      await $.tool.register({ name, description, inputSchema, isDeferred: false })
    }

    // Paint from the cache at once, then refresh in the background.
    void (async () => {
      try {
        const cached = await cockpit!.getBoard()
        await update($, boardAtom, () => cached)
        const config = await cockpit!.loadConfig()
        timer = $.clock.every(config.refreshMinutes * 60_000, () => void refresh($, true).catch(() => {}))
        await refresh($, true)
      } catch (err) {
        $.ui.log(`bc-cockpit: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      }
    })()

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    return next(e)
  })

  // ── command ─────────────────────────────────────────────────────────────

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const wantsRefresh = /\brefresh\b/.test(e.args)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Cockpit' })
    const board = await refresh($, wantsRefresh || (await read($, boardAtom)) === null)
    return { text: isPlaced ? `Cockpit opened. ${summarise(board as any)}` : boardToText(board as any) }
  })

  // ── agent tools (read-only) ─────────────────────────────────────────────

  on('tool.call', { tool: 'mcp__bc-cockpit__cockpit_get_board' }, async () => text(JSON.stringify(boardToCompact((await cockpit!.getBoard()) as any))))
  on('tool.call', { tool: 'mcp__bc-cockpit__cockpit_refresh' }, async $ => text(JSON.stringify(boardToCompact((await refresh($, true)) as any))))
  on('tool.call', { tool: 'mcp__bc-cockpit__cockpit_get_failure' }, async (_$, e) => {
    const { buildId, org, project } = (e as any).input as { buildId: number; org: string; project: string }
    try {
      return text(JSON.stringify(await cockpit!.getFailureDetails({ org, project, buildId })))
    } catch (err) {
      return { result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } }
    }
  })

  // ── band above the prompt: only when something needs you ────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const board = await read($, boardAtom)
    if (e.props.hasSurvey || !board) return next(e)
    const now = await $.clock.now()
    const items = attentionItems(board as any, { now }) as Attention[]
    // Quiet when there is nothing to do. A board that could not be loaded is not "nothing to do", so it speaks.
    if (items.length === 0 && board.errors.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexWrap="wrap" columnGap={1}>
        <Text color={items.length ? 'red' : 'yellow'}>{summarise(board as any, { now })}</Text>
        {items.slice(0, 5).map((it, i) => (
          <Button key={`band-${it.key}`} hotkey={String(i + 1)} label={`${i + 1} ${clip(it.title, 16)}`} onPress={() => toggleItem($, it)} />
        ))}
        {items.length > 5 && <Text dimColor>+{items.length - 5} more</Text>}
        <Button key="open" plain dimColor label="/cockpit" onPress={() => $.ui.open({ id: PANE, title: 'Cockpit', focus: true })} />
      </Box>
    )
  })

  // ── pane: what needs you, then your sprint, then the rest folded away ───

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const board: Board | null = await read($, boardAtom)
    const now = await $.clock.now()
    const changed: Record<string, number> = await read($, changedAtom)
    const details: Record<string, Detail> = await read($, detailsAtom)
    const expanded = await read($, expandedAtom)
    const sections: Record<string, boolean> = await read($, sectionsAtom)
    const isRefreshing = await read($, refreshing)
    const errorsOpen = await read($, showErrors)
    const hot = (key: string) => (changed[key] ?? 0) > now

    if (!board) return <Text dimColor>Loading the board…</Text>

    const items = attentionItems(board as any, { now }) as Attention[]
    const needs = new Set(items.map(i => i.key))
    const age = ago(board.fetchedAt, now)

    const header = (
      <Box flexDirection="column">
        <Box columnGap={1} flexWrap="wrap">
          <Text bold>BC Cockpit</Text>
          <Text dimColor>{isRefreshing ? 'refreshing…' : age === 'now' || !age ? 'updated just now' : `updated ${age} ago`}</Text>
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => refresh($, true)} />
        </Box>
        {board.errors.slice(0, errorsOpen ? board.errors.length : 2).map((er, i) => (
          <Text key={`er-${i}`} color="yellow">
            {clip(`⚠ ${er.org} ${er.scope}: ${er.message}`, cols - 2)}
          </Text>
        ))}
        {board.errors.length > 2 && (
          <Button key="errors" plain dimColor label={errorsOpen ? '▾ fewer errors' : `▸ ${board.errors.length - 2} more errors`} onPress={() => update($, showErrors, (v: boolean) => !v)} />
        )}
      </Box>
    )

    // ── what needs you ──
    const row = (it: Attention, i: number) => {
      const p = it.pipeline
      const d = p ? details[bkey(p)] : undefined
      const failure = d && 'failure' in d ? d.failure : null
      // the error itself, so most of the time there is no need to open anything
      const why = p ? (failure ? firstError(failure.trimmedLog) || 'failed' : d && 'error' in d ? 'failed (details unavailable)' : 'failed') : it.reason
      const isOpen = expanded === it.key
      return (
        <Box key={`row-${it.key}`} flexDirection="column" backgroundColor={hot(it.key) ? 'yellow' : undefined}>
          <Box columnGap={1}>
            <Button key={`att-${it.key}`} plain hotkey={i < 9 ? String(i + 1) : undefined} label={`${GLYPH[it.kind]} ${clip(it.title, Math.max(12, cols - 26))}`} onPress={() => toggleItem($, it)} />
            <Text dimColor>{ago(it.at, now)}</Text>
            {p ? (
              p.localPath ? <Button key={`fix-${it.key}`} variant="primary" label="Fix" onPress={() => fix($, p, false)} /> : <Text dimColor>no clone</Text>
            ) : (
              <Link key={`open-${it.key}`} href={it.url} label="open" />
            )}
          </Box>
          <Text color={it.kind === 'pr-ready' ? 'green' : it.kind === 'pr-review' ? 'cyan' : 'red'}>{`    ${clip(`${it.where} · ${it.branch ?? ''} — ${why}`, cols - 5)}`}</Text>
          {isOpen && p && (
            <Box flexDirection="column" paddingLeft={4}>
              {!d && <Text dimColor>Fetching the failure…</Text>}
              {d && 'error' in d && <Text color="red">{d.error}</Text>}
              {failure && (
                <Box flexDirection="column">
                  <Text dimColor>
                    Failed: {failure.failedSteps.join(', ') || '—'} · {failure.localPath ? `clone: ${failure.localPath}` : 'no local clone under repoRoots'}
                  </Text>
                  <Markdown text={'```\n' + clip(failure.trimmedLog, 2500) + '\n```'} />
                  <Box columnGap={1}>
                    {failure.localPath && <Button key={`bg-${it.key}`} label="Fix in background" onPress={() => fix($, p, true)} />}
                    <Link key={`build-${it.key}`} href={it.url} label="open build" />
                  </Box>
                </Box>
              )}
            </Box>
          )}
          {isOpen && it.pr && (
            <Text dimColor>{`    ${it.pr.source} → ${it.pr.target} · vote: ${it.pr.vote} · merge: ${it.pr.mergeStatus} · build: ${it.pr.build ?? '—'}`}</Text>
          )}
        </Box>
      )
    }

    const needsYou =
      items.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            NEEDS YOU <Text dimColor>({items.length})</Text>
          </Text>
          {items.map(row)}
        </Box>
      ) : board.errors.length === 0 ? (
        <Box marginTop={1}>
          <Text color="green">✓ All clear: nothing needs you.</Text>
        </Box>
      ) : null

    // ── your sprint: open work first, finished work folded ──
    const sprintBlocks = (board.sprints ?? []).map(s => {
      const mine = board.workItems.filter(w => w.org === s.org && w.project === s.project && w.sprint === s.name)
      const open = mine.filter(w => !w.isClosed)
      const done = mine.filter(w => w.isClosed)
      const ends = sprintEnds(s as any, now)
      const doneKey = `done:${s.org}/${s.project}`
      return (
        <Box key={`sp-${s.org}/${s.project}/${s.name}`} flexDirection="column" marginTop={1}>
          <Text bold>
            {clip(s.name, 30)}{' '}
            <Text dimColor>
              · {s.project}
              {ends ? ` · ${ends}` : ''}
            </Text>
          </Text>
          {open.map(w => (
            <Link key={`wi-${w.org}-${w.id}`} href={w.url}>
              {clip(`${/doing|active|progress/i.test(w.state) ? '▶' : '○'} ${w.type} #${w.id}  ${w.title}`, cols - 6)}
              {`  P${w.priority}`}
            </Link>
          ))}
          {done.length > 0 && (
            <Button key={doneKey} plain dimColor label={`${sections[doneKey] ? '▾' : '▸'} ${done.length} done`} onPress={() => toggleSection($, doneKey)} />
          )}
          {sections[doneKey] &&
            done.map(w => (
              <Link key={`wd-${w.org}-${w.id}`} href={w.url}>
                {clip(`✓ ${w.type} #${w.id}  ${w.title}`, cols - 6)}
              </Link>
            ))}
        </Box>
      )
    })

    // ── the rest, folded away ──
    const otherPrs = board.pullRequests.filter(p => !needs.has(prKey(p)))
    const otherPipes = board.pipelines.filter(p => !(p.state === 'failed' && needs.has(pipelineKey(p))))
    const running = otherPipes.filter(p => p.state === 'running' || p.state === 'queued').length
    const prBadge = (p: (typeof otherPrs)[number]) => (p.isDraft ? 'draft' : p.vote === 'approved' ? '✓ approved' : p.isMine ? 'in review' : 'reviewing')
    const glyph = (s: Pipeline['state']) => ({ succeeded: '✓', failed: '✗', running: '⟳', queued: '⟳', canceled: '○' })[s]
    const folded = (
      <Box flexDirection="column" marginTop={1}>
        {otherPrs.length > 0 && (
          <Button key="sec-prs" plain dimColor label={`${sections.prs ? '▾' : '▸'} Other PRs (${otherPrs.length})`} onPress={() => toggleSection($, 'prs')} />
        )}
        {sections.prs &&
          otherPrs.map(p => (
            <Link key={`pr-${p.org}-${p.project}-${p.id}`} href={p.url}>
              {clip(`  !${p.id} ${p.title} · ${prBadge(p)}`, cols - 4)}
            </Link>
          ))}
        {otherPipes.length > 0 && (
          <Button
            key="sec-pipes"
            plain
            dimColor
            label={`${sections.pipelines ? '▾' : '▸'} Pipelines (${running ? `${running} running · ` : ''}${otherPipes.length - running} finished)`}
            onPress={() => toggleSection($, 'pipelines')}
          />
        )}
        {sections.pipelines &&
          otherPipes.map(p => (
            <Link key={`pl-${bkey(p)}`} href={p.url}>
              {clip(`  ${glyph(p.state)} ${p.definition} @ ${p.branch} · ${p.project} ${ago(p.finished, now)}`, cols - 4)}
            </Link>
          ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {needsYou}
        {sprintBlocks}
        {folded}
      </Box>
    )
  })
}
