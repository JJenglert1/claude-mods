import { expect, test } from 'claude-code/testing'

import {
  SURFACES,
  callAgent,
  end,
  inner,
  mountPane,
  setup,
  showBand,
  texts,
} from './support'

const WIDE = { columns: 160, rows: 50, isFullscreen: true }

/** The "stats" lines of the pane, one per agent row, in drawing order. */
const details = (lines: string[]) => lines.filter(line => /· \d+ tools?/.test(line))

test('one agent: start, tools, done', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, { agentId: 'a1', description: 'Find auth code', type: 'Explore' })
  expect(w.status()).toBe('agents: 1 running, 0 done')

  await w.clock.advance(2000)
  await inner($, 'a1', 'Read', { file_path: '/repo/src/auth.ts' })
  await inner($, 'a1', 'Bash', { command: 'npm test --silent' })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)

    expect(lines).toContain('Explore')
    expect(lines).toContain('Find auth code')
    expect(details(lines)).toEqual(['running · 2s · 2 tools  ↳ Bash npm test --silent'])
    await ui.unmount()
  }

  await w.clock.advance(3000)
  await end($, 'a1', 'answer', 12_300)
  expect(w.status()).toBe(undefined)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)

    expect(details(lines)).toEqual([
      'done · 5s · 2 tools · 12k tok  ↳ Bash npm test --silent',
    ])
    expect(lines).toContain('✓')
    // A finished row is drawn dim.
    const done = await ui.find({ type: 'Text', text: 'Find auth code' })

    expect(done?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('three agents in parallel: inner tool calls land on the right rows', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, { agentId: 'a1', description: 'Scan routes', type: 'Explore' })
  await callAgent($, w, { agentId: 'a2', description: 'Write tests' })
  await callAgent($, w, { agentId: 'a3', description: 'Plan migration', type: 'Plan' })
  expect(w.status()).toBe('agents: 3 running, 0 done')

  await inner($, 'a2', 'Edit', { file_path: '/repo/x.test.ts' })
  await inner($, 'a1', 'Read', { file_path: '/repo/routes.ts' })
  await inner($, 'a3', 'Grep', { pattern: 'TODO' })
  await inner($, 'a1', 'Grep', { pattern: 'router' })
  await inner($, 'a2', 'Bash', { command: 'npm test' })
  await inner($, 'a1', 'Read', { file_path: '/repo/index.ts' })
  // The main thread's own tool calls are not an agent's.
  await $.tool.call({ tool: 'Read', file_path: '/repo/main.ts' })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, 80)
    const lines = await texts(ui)

    expect(lines.filter(line => ['Scan routes', 'Write tests', 'Plan migration'].includes(line))).toEqual([
      'Scan routes',
      'Write tests',
      'Plan migration',
    ])
    expect(details(lines)).toEqual([
      'running · 0s · 3 tools  ↳ Read index.ts',
      'running · 0s · 2 tools  ↳ Bash npm test',
      'running · 0s · 1 tool  ↳ Grep TODO',
    ])
    await ui.unmount()
  }

  // One finishes: running rows stay first, the finished one drops below them.
  await end($, 'a2')
  expect(w.status()).toBe('agents: 2 running, 1 done')

  const ui = await mountPane($, 'terminal', 80)
  const lines = await texts(ui)

  expect(lines.filter(line => ['Scan routes', 'Write tests', 'Plan migration'].includes(line))).toEqual([
    'Scan routes',
    'Plan migration',
    'Write tests',
  ])
  expect(details(lines)[2]).toContain('done · 0s · 2 tools')

  await end($, 'a1')
  await end($, 'a3')
  expect(w.status()).toBe(undefined)
})

test('a failed agent: by its turn and by a refused Agent call', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, { agentId: 'a1', description: 'Flaky job' })
  await callAgent($, w, { agentId: 'a2', description: 'Steady job' })
  await end($, 'a1', 'error')
  expect(w.status()).toBe('agents: 1 running, 0 done, 1 failed')

  await callAgent($, w, { agentId: 'a3', description: 'Bad type', mode: 'refused' })
  expect(w.status()).toBe('agents: 1 running, 0 done, 2 failed')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)

    expect(lines.filter(line => line === '✗')).toHaveLength(2)
    expect(details(lines).filter(line => line.startsWith('failed'))).toHaveLength(2)
    expect(lines[0]).toBe('1 running · 0 done · 2 failed')
    await ui.unmount()
  }

  await end($, 'a2')
  expect(w.status()).toBe(undefined)
})

test('a stopped agent: interrupted, or killed from the engine list', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, { agentId: 'a1', description: 'Interrupted job' })
  await callAgent($, w, { agentId: 'a2', description: 'Killed job' })
  await callAgent($, w, { agentId: 'a3', description: 'Still going' })
  await end($, 'a1', 'aborted')
  expect(w.status()).toBe('agents: 2 running, 0 done, 1 stopped')

  // a2 never raised a turn.complete we saw; the engine's own list says it was killed.
  w.listed = [
    { id: 'a2', description: 'Killed job', type: 'general-purpose', status: 'killed' },
    { id: 'a3', description: 'Still going', type: 'general-purpose', status: 'running' },
  ]
  await w.clock.advance(3000)
  expect(w.status()).toBe('agents: 1 running, 0 done, 2 stopped')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)

    expect(lines.filter(line => line === '■')).toHaveLength(2)
    expect(details(lines).filter(line => line.startsWith('stopped'))).toHaveLength(2)
    await ui.unmount()
  }
})

test('selecting a row shows its last tool calls', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, { agentId: 'a1', description: 'Dig around' })

  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']) {
    await inner($, 'a1', 'Read', { file_path: `/repo/${name}` })
  }

  await inner($, 'a1', 'mcp__docs__search', { query: 'retry policy' })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)

    expect(await texts(ui)).not.toContain('· Read g.ts')
    await ui.press({ key: 'row:1' })

    const open = await texts(ui)

    // The last five calls, oldest first; older ones are gone.
    expect(open.filter(line => line.startsWith('· '))).toEqual([
      '· Read d.ts',
      '· Read e.ts',
      '· Read f.ts',
      '· Read g.ts',
      '· docs:search retry policy',
    ])
    expect((await ui.find({ key: 'row:1' }))?.props.label).toBe('▾')
    await ui.press({ key: 'row:1' })
    expect((await texts(ui)).filter(line => line.startsWith('· '))).toHaveLength(0)
    expect((await ui.find({ key: 'row:1' }))?.props.label).toBe('▸')
    await ui.unmount()
  }
})

test('nested agents sit under their parent', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, { agentId: 'a1', description: 'Parent job' })
  await callAgent($, w, { agentId: 'c1', description: 'Child job', inside: 'a1' })
  await callAgent($, w, { agentId: 'a2', description: 'Other job' })
  await inner($, 'c1', 'Read', { file_path: '/repo/deep.ts' })
  await end($, 'c1')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)

    expect(lines.filter(line => ['Parent job', 'Child job', 'Other job'].includes(line))).toEqual([
      'Parent job',
      'Child job',
      'Other job',
    ])

    const heads = (await ui.findAll({ type: 'Box' })).filter(box => box.props.gap === 1)

    expect(heads.map(box => box.props.paddingLeft)).toEqual([0, 2, 0])
    await ui.unmount()
  }

  // The parent's own Agent tool call is one of its tool calls; the child's Read is the child's.
  const ui = await mountPane($, 'terminal')

  expect(details(await texts(ui))).toEqual([
    'running · 0s · 1 tool  ↳ Agent Child job',
    'done · 0s · 1 tool  ↳ Read deep.ts',
    'running · 0s · 0 tools',
  ])
})

test('empty pane', async ($, on) => {
  setup($, on)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)

    expect(await texts(ui)).toEqual([
      'No helper agents yet.',
      'They show up here when Claude starts one.',
    ])
    expect(await ui.find({ key: 'clear' })).toBeUndefined()
    await ui.unmount()
  }
})

test('narrow and wide panes fit their width on both surfaces', async ($, on) => {
  const w = setup($, on)

  await callAgent($, w, {
    agentId: 'a1',
    description: 'Investigate the flaky checkout test in the payments service',
    type: 'general-purpose',
  })
  await inner($, 'a1', 'Bash', {
    command: 'pnpm --filter payments test -- --runInBand checkout.spec.ts',
  })

  for (const surface of SURFACES) {
    for (const columns of [28, 40, 100]) {
      const ui = await mountPane($, surface, columns)
      const lines = await texts(ui)
      const heads = (await ui.findAll({ type: 'Box' })).filter(box => box.props.gap === 1)
      const [glyph, type, desc] = (await ui.findAll({ type: 'Text' })).slice(1, 4).map(one => one.text)
      // chevron, glyph, type, description and the gaps between them.
      const header = 1 + 1 + 1 + 1 + type!.length + 1 + desc!.length

      expect(glyph).toBe('●')
      expect(heads).toHaveLength(1)
      expect(header).toBeLessThanOrEqual(columns)

      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(columns)
      }

      const rows = details(lines)

      if (columns >= 100) {
        // Wide: stats and the latest tool share one line.
        expect(rows).toHaveLength(1)
        expect(rows[0]).toContain('↳ Bash pnpm --filter payments test')
      } else {
        // Narrow: the latest tool gets a line of its own.
        expect(lines.some(line => line.startsWith('↳ Bash'))).toBe(true)
        expect(rows[0]).not.toContain('↳')
      }

      await ui.unmount()
    }
  }
})

test('auto-open: only where a pane is a sidebar, only once', async ($, on) => {
  const w = setup($, on)

  // No surface has told us its size yet: do not guess.
  await callAgent($, w, { agentId: 'a1', description: 'Too early' })
  expect(w.opens).toHaveLength(0)
  await end($, 'a1')

  await showBand($, 'terminal', WIDE)
  await callAgent($, w, { agentId: 'a2', description: 'First sidebar agent' })
  expect(w.opens).toEqual([{ id: 'agentpane', title: 'Agents' }])
  await callAgent($, w, { agentId: 'a3', description: 'Second agent' })
  expect(w.opens).toHaveLength(1)

  // Closed by hand: a later agent does not bring it back.
  w.isPaneOpen = false
  await callAgent($, w, { agentId: 'a4', description: 'Third agent' })
  expect(w.opens).toHaveLength(1)
})

test('/agentpane opens and closes the pane, and is registered at session start', async ($, on) => {
  const w = setup($, on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(w.commands).toEqual(['agentpane'])

  const first = await $.command.run({ command: 'agentpane' })

  expect(first.text).toBe('Agent pane opened.')
  expect(w.opens).toEqual([{ id: 'agentpane', title: 'Agents' }])

  const second = await $.command.run({ command: 'agentpane' })

  expect(second.text).toBe('Agent pane closed.')
  expect(w.closes).toEqual(['agentpane'])

  // Opened by hand once: a later agent does not open it on its own.
  await showBand($, 'terminal', WIDE)
  await callAgent($, w, { agentId: 'a1', description: 'After manual use' })
  expect(w.opens).toHaveLength(1)
})

test('broken bookkeeping never blocks, fails or repeats a real tool or Agent call', async ($, on) => {
  const w = setup($, on)
  // Everything the plugin writes to its own state is refused from here on.
  on('state.set', () => ({ deny: 'state is down' }))

  // A tool call inside a subagent, and one in the main loop.
  const innerRan = await inner($, 'a1', 'Read', { file_path: '/repo/a.ts' })
  const mainRan = await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })

  expect(w.runs).toEqual(['Read', 'Read'])
  expect(innerRan).toMatchObject({ result: { ok: true }, text: 'ok' })
  expect(mainRan).toMatchObject({ result: { ok: true }, text: 'ok' })

  // The Agent tool itself: runs once, result unchanged.
  const { done } = await callAgent($, w, { agentId: 'a1', description: 'x' })
  const agentRan = await done

  expect(w.runs).toEqual(['Read', 'Read', 'Agent'])
  expect(agentRan).toMatchObject({ text: 'launched' })

  // agent.spawn answers as the engine did, and a turn.complete still passes through.
  const spawned = await $.agent.spawn({ prompt: 'p', description: 'x', planned: 'a1' } as never)

  expect(spawned).toMatchObject({ agentId: 'a1' })
  expect((await end($, 'a1')) as unknown).toMatchObject({ text: 'done' })

  // The bookkeeping really was broken: nothing was recorded, and nothing was announced.
  expect(w.status()).toBeUndefined()
  expect(w.opens).toHaveLength(0)
})
