import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { boardToCompact, boardToText, buildFixPrompt, createCockpit, pipelineKey, prKey, summarise } from '../core/index.js'
import type { Board, Detail, Pipeline, PullRequest } from '../types'

const PANE = 'cockpit'
const HIGHLIGHT_MS = 20_000

const boardAtom = atom({ plugin: 'bc-cockpit', key: 'board' } as const, null)
const refreshing = atom({ plugin: 'bc-cockpit', key: 'isRefreshing' } as const, false)
const changedAtom = atom({ plugin: 'bc-cockpit', key: 'changed' } as const, {})
const detailsAtom = atom({ plugin: 'bc-cockpit', key: 'details' } as const, {})
const expandedAtom = atom({ plugin: 'bc-cockpit', key: 'expanded' } as const, null)
const showSucceeded = atom({ plugin: 'bc-cockpit', key: 'showSucceeded' } as const, false)
const showErrors = atom({ plugin: 'bc-cockpit', key: 'showErrors' } as const, false)

// Build ids repeat across organisations (and projects): every cache, expansion and button is keyed by all three.
const bkey = (p: { org: string; project: string; buildId: number }) => `${p.org}/${p.project}/${p.buildId}`
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const ago = (iso: string | number | undefined, now: number) => {
  const t = typeof iso === 'number' ? iso : Date.parse(iso ?? '')
  if (!t) return ''
  const m = Math.max(0, Math.round((now - t) / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
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
    return board
  } finally {
    await update($, refreshing, () => false)
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

async function showDetails($: any, p: Pipeline) {
  await update($, expandedAtom, (cur: string | null) => (cur === bkey(p) ? null : bkey(p)))
  await $.ui.open({ id: PANE, title: 'Cockpit', focus: true })
  await loadDetail($, p)
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

    await $.command.register({ name: 'cockpit', description: 'Show work items, PRs and pipelines across Azure DevOps projects' })

    const tools: [string, string, Record<string, unknown>?][] = [
      ['cockpit_get_board', 'Returns the current Azure DevOps board (my work items, PRs, pipelines) as compact JSON. Read-only.'],
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
    return { text: isPlaced ? `Cockpit opened. ${summarise(board)}` : boardToText(board) }
  })

  // ── agent tools (read-only) ─────────────────────────────────────────────

  on('tool.call', { tool: 'mcp__bc-cockpit__cockpit_get_board' }, async () => text(JSON.stringify(boardToCompact(await cockpit!.getBoard()))))
  on('tool.call', { tool: 'mcp__bc-cockpit__cockpit_refresh' }, async $ => text(JSON.stringify(boardToCompact(await refresh($, true)))))
  on('tool.call', { tool: 'mcp__bc-cockpit__cockpit_get_failure' }, async (_$, e) => {
    const { buildId, org, project } = (e as any).input as { buildId: number; org: string; project: string }
    try {
      return text(JSON.stringify(await cockpit!.getFailureDetails({ org, project, buildId })))
    } catch (err) {
      return { result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } }
    }
  })

  // ── band above the prompt ───────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const board = await read($, boardAtom)
    if (e.props.hasSurvey || !board) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const failed = board.pipelines.filter(p => p.state === 'failed').slice(0, 9)
    const hasFailures = failed.length > 0
    return (
      <Box flexWrap="wrap" columnGap={1}>
        <Text color={hasFailures ? 'red' : 'green'}>{summarise(board)}</Text>
        {failed.map((p, i) => (
          <Button key={`fail-${bkey(p)}`} hotkey={String(i + 1)} label={`${i + 1} ${clip(p.definition, 18)}`} onPress={() => showDetails($, p)} />
        ))}
        <Button key="open" plain dimColor label="/cockpit" onPress={() => $.ui.open({ id: PANE, title: 'Cockpit', focus: true })} />
      </Box>
    )
  })

  // ── pane ────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const board: Board | null = await read($, boardAtom)
    const now = await $.clock.now()
    const changed: Record<string, number> = await read($, changedAtom)
    const details: Record<string, Detail> = await read($, detailsAtom)
    const expanded = await read($, expandedAtom)
    const isRefreshing = await read($, refreshing)
    const succeededOpen = await read($, showSucceeded)
    const errorsOpen = await read($, showErrors)
    const hot = (key: string) => (changed[key] ?? 0) > now

    if (!board) return <Text dimColor>Loading the board…</Text>

    const Section = ({ title, count, children }: { title: string; count: number; children?: any }) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          {title} <Text dimColor>({count})</Text>
        </Text>
        {children}
      </Box>
    )

    const header = (
      <Box columnGap={1} flexWrap="wrap">
        <Text bold>BC Cockpit</Text>
        <Text dimColor>{isRefreshing ? 'refreshing…' : `updated ${ago(board.fetchedAt, now) || 'now'} ago`}</Text>
        <Button key="refresh" hotkey="r" label="Refresh" onPress={() => refresh($, true)} />
        {board.errors.length > 0 && (
          <Button key="errors" plain dimColor label={`⚠ ${board.errors.length}`} onPress={() => update($, showErrors, (v: boolean) => !v)} />
        )}
      </Box>
    )

    // work items, grouped by project (core already sorted by project, priority, changed)
    const projects = [...new Set(board.workItems.map(w => `${w.org}/${w.project}`))]
    const work = (
      <Section title="My work" count={board.workItems.length}>
        {board.workItems.length === 0 && <Text dimColor>Nothing assigned to you.</Text>}
        {projects.map(proj => (
          <Box key={proj} flexDirection="column">
            <Text dimColor>{proj}</Text>
            {board.workItems
              .filter(w => `${w.org}/${w.project}` === proj)
              .map(w => (
                <Link key={`wi-${w.org}-${w.id}`} href={w.url}>
                  {clip(`  ${w.type} #${w.id} [${w.state}] ${w.title}`, cols - 1)}
                </Link>
              ))}
          </Box>
        ))}
      </Section>
    )

    // pull requests
    const waiting = board.pullRequests.filter(p => p.isReviewer && !p.isMine && p.myVote === 0)
    const mine = board.pullRequests.filter(p => p.isMine)
    const voteBadge = (p: PullRequest) =>
      ({ approved: '✓ approved', partial: '✓ suggestions', rejected: '✗ rejected', waiting: '… waiting', none: '○ no votes' })[p.vote]
    const prRow = (p: PullRequest) => {
      const bad = p.mergeStatus === 'conflicts' || p.build === 'failed'
      return (
        <Box key={prKey(p)} flexDirection="column" backgroundColor={hot(prKey(p)) ? 'yellow' : undefined}>
          <Link href={p.url}>{clip(`  !${p.id} ${p.isDraft ? '[draft] ' : ''}${p.title}`, cols - 1)}</Link>
          <Text dimColor={!bad}>
            {'    '}
            {clip(`${p.repo} ${p.source}→${p.target}`, Math.max(10, cols - 40))}{' '}
            <Text>{voteBadge(p)}</Text>
            {p.build && <Text color={p.build === 'failed' ? 'red' : undefined}> build:{p.build}</Text>}
            {p.mergeStatus === 'conflicts' && <Text color="red" bold> ⚠ merge conflicts</Text>}
          </Text>
        </Box>
      )
    }
    const prs = (
      <Section title="My PRs" count={waiting.length + mine.length}>
        {waiting.length + mine.length === 0 && <Text dimColor>No open PRs.</Text>}
        {waiting.length > 0 && <Text color="cyan">Waiting on me</Text>}
        {waiting.map(prRow)}
        {mine.length > 0 && <Text color="cyan">Mine</Text>}
        {mine.map(prRow)}
      </Section>
    )

    // pipelines: failures first, then running, succeeded collapsed
    const failed = board.pipelines.filter(p => p.state === 'failed')
    const running = board.pipelines.filter(p => p.state === 'running' || p.state === 'queued')
    const ok = board.pipelines.filter(p => p.state === 'succeeded' || p.state === 'canceled')
    const pipeLine = (p: Pipeline, icon: string, color?: string) => (
      <Text color={color as any} backgroundColor={hot(pipelineKey(p)) ? 'yellow' : undefined}>
        {clip(`  ${icon} ${p.definition} @ ${p.branch} · ${p.project} · ${ago(p.finished, now)}`, cols - 1)}
      </Text>
    )
    const pipelines = (
      <Section title="Pipelines" count={board.pipelines.length}>
        {board.pipelines.length === 0 && <Text dimColor>No pipelines in scope.</Text>}
        {failed.map(p => {
          const key = bkey(p)
          const detail = details[key]
          return (
            <Box key={`pl-${key}`} flexDirection="column">
              {pipeLine(p, '✗', 'red')}
              <Box columnGap={1} paddingLeft={4}>
                <Button key={`det-${key}`} label={expanded === key ? 'Hide' : 'Details'} onPress={() => showDetails($, p)} />
                {p.localPath ? (
                  <Box columnGap={1}>
                    <Button key={`fix-${key}`} variant="primary" label="Fix with agent" onPress={() => fix($, p, false)} />
                    <Button key={`bg-${key}`} label="Fix in background" onPress={() => fix($, p, true)} />
                  </Box>
                ) : (
                  <Text dimColor>Fix with agent unavailable: no local clone of {p.repo} under repoRoots</Text>
                )}
              </Box>
              {expanded === key && (
                <Box paddingLeft={4} flexDirection="column">
                  {!detail && <Text dimColor>Fetching failure…</Text>}
                  {detail && 'error' in detail && <Text color="red">{detail.error}</Text>}
                  {detail && 'failure' in detail && (
                    <Box flexDirection="column">
                      <Text dimColor>Failed: {detail.failure.failedSteps.join(', ') || '—'}</Text>
                      <Markdown text={'```\n' + clip(detail.failure.trimmedLog, 3000) + '\n```'} />
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
        {running.map(p => pipeLine(p, '⟳', 'yellow'))}
        {ok.length > 0 && (
          <Button
            key="ok-toggle"
            plain
            dimColor
            label={`${succeededOpen ? '▾' : '▸'} ${ok.length} succeeded`}
            onPress={() => update($, showSucceeded, (v: boolean) => !v)}
          />
        )}
        {succeededOpen && ok.map(p => pipeLine(p, '✓', 'green'))}
      </Section>
    )

    return (
      <Box flexDirection="column">
        {header}
        {errorsOpen && (
          <Box flexDirection="column">
            {board.errors.map((er, i) => (
              <Text key={`er-${i}`} dimColor>
                {clip(`${er.org} ${er.scope}: ${er.message}`, cols - 1)}
              </Text>
            ))}
          </Box>
        )}
        {work}
        {prs}
        {pipelines}
      </Box>
    )
  })
}
