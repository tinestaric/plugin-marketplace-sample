import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Artifacts, PhaseState, Workflow, WorkflowSummary } from '../types'
import { PHASES } from './phases'
import type { Phase } from './phases'

const PANE = 'dev-workflow'
const TITLE = 'Dev workflow'

const workflowAtom = atom({ plugin: 'dev-workflow', key: 'workflow' } as const, null)
const othersAtom = atom({ plugin: 'dev-workflow', key: 'others' } as const, [])
const artifactsAtom = atom({ plugin: 'dev-workflow', key: 'artifacts' } as const, null)
const branchAtom = atom({ plugin: 'dev-workflow', key: 'branch' } as const, null)
const busyAtom = atom({ plugin: 'dev-workflow', key: 'isBusy' } as const, false)
const armedAtom = atom({ plugin: 'dev-workflow', key: 'armed' } as const, '')

const FIRST = PHASES[0] as Phase
const phaseOf = (id: string): Phase => PHASES.find(p => p.id === id) ?? FIRST
/** The state of a phase; a workflow written by an older version may lack one. */
const stateOf = (wf: Workflow, id: string): PhaseState => wf.phases[id] ?? { status: 'todo', checks: {}, notes: '' }
const phaseAt = (i: number): Phase => PHASES[i] ?? FIRST
const indexOf = (id: string) => PHASES.findIndex(p => p.id === id)

function freshPhases(): Workflow['phases'] {
  return Object.fromEntries(
    PHASES.map((p, i) => [p.id, { status: i === 0 ? 'active' : 'todo', checks: {}, notes: '' }]),
  ) as Workflow['phases']
}

function isOpen(wf: Workflow, id: string): number {
  return phaseOf(id).checklist.filter((_, i) => !wf.phases[id]?.checks[i]).length
}

function pathsOf(dir: string, id: string) {
  return { dir: `${dir}/${id}`, spec: `${dir}/${id}/spec.md`, design: `${dir}/${id}/design.md` }
}

function renderPrompt(wf: Workflow, dir: string, phase: Phase): string {
  const p = pathsOf(dir, wf.id)
  const vars: Record<string, string | undefined> = {
    feature: wf.feature,
    specPath: p.spec,
    designPath: p.design,
    notes: wf.phases[phase.id]?.notes ?? '',
  }
  const text = phase.prompt.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (vars[k] ?? m))
  const notes = vars.notes ? `\n\nNotes for this phase: ${vars.notes}` : ''
  return `${text}${notes}`.replace(/\n{3,}/g, '\n\n').trim()
}

// Where this repo's workflows live: <git-common-dir>/dev-workflow, shared by every worktree.
let storeDir = ''
let current: Workflow | null = null

  const git = async ($: Engine, args: string[]): Promise<string> => {
    const r = await $.process.run(['git', ...args])
    if (r.exitCode !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }

  const detect = async ($: Engine) => {
    const cwd = await $.session.cwd()
    let common = await git($, ['rev-parse', '--git-common-dir'])
    if (!/^([a-zA-Z]:)?[\\/]/.test(common)) common = `${cwd}/${common}`
    storeDir = `${common.replace(/\\/g, '/')}/dev-workflow/workflows`
    const branch = await git($, ['branch', '--show-current']).catch(() => '')
    return branch || 'detached'
  }

  const writeWorkflow = async ($: Engine, wf: Workflow) => {
    wf.updatedAt = await $.clock.now()
    await $.fs.write(`${storeDir}/${wf.id}/workflow.json`, JSON.stringify(wf, null, 2))
  }

  const refreshArtifacts = async ($: Engine) => {
    if (!current) {
      await update($, artifactsAtom, () => null)
      return
    }
    const p = pathsOf(storeDir, current.id)
    const a: Artifacts = {
      dir: p.dir,
      spec: await $.fs.exists(p.spec),
      design: await $.fs.exists(p.design),
    }
    await update($, artifactsAtom, () => a)
  }

  /** Reads every workflow of the repo and picks the one linked to this branch. */
  const load = async ($: Engine) => {
    let branch: string
    try {
      branch = await detect($)
    } catch {
      await update($, branchAtom, () => null)
      return
    }
    const all: Workflow[] = []
    const entries = await $.fs.list(storeDir).catch(() => [])
    for (const entry of entries) {
      try {
        all.push(JSON.parse(await $.fs.read(`${storeDir}/${entry.name}/workflow.json`)) as Workflow)
      } catch {
        // not a workflow folder
      }
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    current = all.find(w => w.branch === branch) ?? null
    const others: WorkflowSummary[] = all
      .filter(w => w.id !== current?.id)
      .map(w => ({ id: w.id, feature: w.feature, currentPhase: w.currentPhase, branch: w.branch }))
    await update($, branchAtom, () => branch)
    await update($, othersAtom, () => others)
    await update($, workflowAtom, () => current)
    await refreshArtifacts($)
  }

  const mutate = async ($: Engine, fn: (wf: Workflow) => void) => {
    if (!current) return
    const wf = structuredClone(current)
    fn(wf)
    await writeWorkflow($, wf)
    current = wf
    await update($, workflowAtom, () => wf)
  }

  const log = (wf: Workflow, text: string) => {
    wf.history = [{ at: Date.now(), phase: wf.currentPhase, text }, ...wf.history].slice(0, 30)
  }

  const goTo = (wf: Workflow, id: string) => {
    const from = wf.phases[wf.currentPhase]
    if (from) from.status = indexOf(id) > indexOf(wf.currentPhase) ? 'done' : 'todo'
    wf.currentPhase = id
    wf.phases[id] = { ...stateOf(wf, id), status: 'active' }
    log(wf, `Moved to ${phaseOf(id).title}`)
  }

  const create = async ($: Engine, feature: string) => {
    const name = feature.trim()
    if (!name) return
    const branch = await detect($).catch(() => 'detached')
    const stamp = (await $.clock.now()).toString(36)
    const wf: Workflow = {
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feature'}-${stamp}`,
      feature: name,
      branch,
      currentPhase: FIRST.id,
      autoSendOnNext: false,
      phases: freshPhases(),
      history: [],
      updatedAt: 0,
    }
    log(wf, `Workflow started on ${branch}`)
    await writeWorkflow($, wf)
    await load($)
    $.ui.toast(`Workflow started: ${name}`)
  }

  const send = async ($: Engine, text: string, note: string) => {
    void $.prompt.submit({ text })
    await mutate($, wf => log(wf, note))
  }

  const sendPhase = (
    $: Engine,
    wf: Workflow,
    phase: Phase,
    how: 'here' | 'worktree',
  ): Promise<void> => {
    const prompt = renderPrompt(wf, storeDir, phase)
    if (how === 'here') return send($, prompt, `Sent ${phase.title} instructions`)
    const wrapped = [
      `[Dev workflow] Run the ${phase.title.toUpperCase()} phase of "${wf.feature}" in a separate agent.`,
      `Call the Agent tool once with isolation: "worktree", description: ${JSON.stringify(`${wf.feature}: ${phase.title}`)}, and exactly this prompt (do not do the work yourself):`,
      '',
      prompt,
      '',
      "When it finishes, summarize its outcome. If its branch has commits, ask me whether to merge them into this branch or keep it as a separate stacked branch.",
    ].join('\n')
    return send($, wrapped, `Spun up a worktree agent for ${phase.title}`)
  }

  const advance = async ($: Engine, withSend: boolean) => {
    if (!current) return
    const wf = current
    const i = indexOf(wf.currentPhase)
    await update($, armedAtom, () => '')
    if (i >= PHASES.length - 1) {
      await mutate($, w => {
        stateOf(w, w.currentPhase).status = 'done'
        log(w, 'Workflow complete')
      })
      $.ui.toast('Workflow complete')
      return
    }
    await mutate($, w => goTo(w, phaseAt(i + 1).id))
    if (withSend && current) await sendPhase($, current, phaseAt(i + 1), 'here')
  }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dev-workflow',
      description: 'Open the dev workflow pane (optionally start one: /dev-workflow <feature>)',
      argumentHint: '[feature]',
    })
    await load($).catch(() => undefined)
    if (current) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'dev-workflow' }, async ($, e) => {
    await load($).catch(() => undefined)
    if (e.args.trim() && !current) await create($, e.args)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: current ? `Dev workflow: ${current.feature}` : 'Dev workflow pane opened.' }
  })

  // Every prompt on a linked branch carries the phase it belongs to.
  on('prompt.submit', async ($, e, next) => {
    if (!current) return next(e)
    const phase = phaseOf(current.currentPhase)
    const p = pathsOf(storeDir, current.id)
    const line = `[Dev workflow] Feature: "${current.feature}". Current phase: ${phase.title} (${phase.goal}) Spec: ${p.spec}. Design: ${p.design}. Stay within this phase unless asked otherwise.`

    return next({ ...e, context: [...(e.context ?? []), line] })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, busyAtom, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, busyAtom, () => false)
      await load($).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const wf = await read($, workflowAtom)
    const others = await read($, othersAtom)
    const artifacts = await read($, artifactsAtom)
    const branch = await read($, branchAtom)
    const isBusy = await read($, busyAtom)
    const armed = await read($, armedAtom)

    if (branch === null) {
      return <Text dimColor>Not a git repository: the dev workflow is tied to a branch.</Text>
    }

    if (!wf) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No workflow on {branch}</Text>
          {Input ? (
            <Input
              key="feature"
              label="Feature"
              placeholder="What are we building?"
              submitLabel="start"
              onSubmit={(value: string) => void create($, value)}
            />
          ) : (
            <Text dimColor>Start one with /dev-workflow &lt;feature&gt;</Text>
          )}
          {others.length > 0 && <Text dimColor>Existing workflows in this repo</Text>}
          {others.map(o => (
            <Button
              key={`link-${o.id}`}
              onPress={() => {
                void (async () => {
                  const target = JSON.parse(await $.fs.read(`${storeDir}/${o.id}/workflow.json`)) as Workflow
                  target.branch = branch
                  log(target, `Branch ${branch} linked`)
                  await writeWorkflow($, target)
                  await load($)
                })()
              }}
            >
              Link {o.feature} <Text dimColor>({phaseOf(o.currentPhase).title}, was {o.branch})</Text>
            </Button>
          ))}
        </Box>
      )
    }

    const phase = phaseOf(wf.currentPhase)
    const ps = stateOf(wf, phase.id)
    const idx = indexOf(phase.id)
    const open = isOpen(wf, phase.id)
    const last = idx === PHASES.length - 1
    const mark = (s: string) => (s === 'done' ? '✓' : s === 'active' ? '●' : '○')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            {wf.feature} <Text dimColor>on {branch}{isBusy ? ' · working…' : ''}</Text>
          </Text>
        </Box>

        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {PHASES.map(p => (
            <Button
              key={`phase-${p.id}`}
              variant={p.id === phase.id ? 'primary' : 'secondary'}
              onPress={() => void mutate($, w => p.id !== w.currentPhase && goTo(w, p.id))}
            >
              {mark(stateOf(wf, p.id).status)} {p.title}
            </Button>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>
            Phase {idx + 1}/{PHASES.length}: {phase.title}
          </Text>
          <Text dimColor>{phase.goal}</Text>
          {artifacts && (
            <Text dimColor>
              {artifacts.spec ? '✓' : '○'} spec.md  {artifacts.design ? '✓' : '○'} design.md
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>
            Exit criteria <Text dimColor>{phase.checklist.length - open}/{phase.checklist.length}</Text>
          </Text>
          {phase.checklist.map((item, i) => (
            <Button
              key={`check-${phase.id}-${i}`}
              plain
              dimColor={!!ps.checks[i]}
              onPress={() => void mutate($, w => (stateOf(w, phase.id).checks[i] = !stateOf(w, phase.id).checks[i]))}
            >
              {ps.checks[i] ? '[x]' : '[ ]'} {item}
            </Button>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Run this phase</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button variant="primary" onPress={() => void sendPhase($, wf, phase, 'here')}>
              Send to this chat
            </Button>
            <Button
              onPress={() => void $.prompt.fill({ text: renderPrompt(wf, storeDir, phase) })}
            >
              Edit first
            </Button>
            <Button onPress={() => void sendPhase($, wf, phase, 'worktree')}>
              Run in worktree agent
            </Button>
          </Box>
          {phase.writesCode && (
            <Text dimColor>This phase changes code; a worktree agent lands on its own branch.</Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>Quick prompts</Text>
          {phase.snippets.map((s, i) => (
            <Button
              key={`snip-${phase.id}-${i}`}
              plain
              onPress={() => void $.prompt.fill({ text: s })}
            >
              {s}
            </Button>
          ))}
        </Box>

        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key="back"
            onPress={() => void mutate($, w => idx > 0 && goTo(w, phaseAt(idx - 1).id))}
          >
            Back
          </Button>
          <Button
            key="next"
            variant={armed === 'next' ? 'primary' : 'secondary'}
            onPress={() => {
              if (open > 0 && armed !== 'next') void update($, armedAtom, () => 'next')
              else void advance($, false)
            }}
          >
            {armed === 'next' ? `${open} open, move on anyway?` : last ? 'Finish' : 'Next phase'}
          </Button>
          {!last && (
            <Button
              key="nextSend"
              variant="primary"
              onPress={() => {
                if (open > 0 && armed !== 'nextSend') void update($, armedAtom, () => 'nextSend')
                else void advance($, true)
              }}
            >
              {armed === 'nextSend' ? `${open} open, move on anyway?` : 'Next & send instructions'}
            </Button>
          )}
        </Box>

        {wf.history.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Activity</Text>
            {wf.history.slice(0, 5).map(entry => (
              <Text dimColor wrap="truncate">
                {phaseOf(entry.phase).title}: {entry.text.split('\n')[0]}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
