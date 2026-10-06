import { describe, expect, test } from 'claude-code/testing'

import { ALL_ON, cloak, cloakDeep, cloakText, cloakTree, createMapper, mergeEntries, standInFor } from '../hooks/cloak'
import type { Config } from '../hooks/cloak'

const config: Config = { categories: ALL_ON, terms: ['Acme Corp', 'Jane Rivera'] }

describe('consistent mapping', () => {
  test('stand-in styles', () => {
    expect(standInFor('email', 3)).toBe('email-3@hidden')
    expect(standInFor('phone', 2)).toBe('[phone 2]')
    expect(standInFor('account', 1)).toBe('[acct 1]')
    expect(standInFor('name', 2)).toBe('Client B')
  })

  test('one mapper keeps every original on one stand-in across texts', () => {
    const m = createMapper([])
    const a = cloak('Jane Rivera <jane@acme.com> 415-555-0132', config, m)
    const b = cloak('Later: jane@ACME.com, Acme Corp, 415.555.0132, and bob@x.org', config, m)
    expect(a.text).toBe('Client A <email-1@hidden> [phone 1]')
    expect(b.text).toBe('Later: email-1@hidden, Client B, [phone 1], and email-2@hidden')
    expect(m.entries.map(e => e.standIn)).toEqual(['Client A', 'email-1@hidden', '[phone 1]', 'Client B', 'email-2@hidden'])
  })

  test('numbers count per kind', () => {
    const r = cloakText('a@x.com b@x.com 212-555-0101 Acme Corp 4111 1111 1111 1111', config)
    expect(r.text).toBe('email-1@hidden email-2@hidden [phone 1] Client A [acct 1]')
  })

  test('a mapper starts from earlier entries and reports only what it adds', () => {
    const first = cloakText('a@x.com', config)
    const m = createMapper(first.entries)
    const r = cloak('a@x.com and c@x.com', config, m)
    expect(r.text).toBe('email-1@hidden and email-2@hidden')
    expect(r.added.map(e => e.original)).toEqual(['c@x.com'])
    expect(first.entries).toHaveLength(1) // the input table is not changed
  })

  test('merging keeps the first original and renumbers in step', () => {
    const base = cloakText('a@x.com', config).entries
    const provisionalA = [{ kind: 'email' as const, key: 'b@x.com', original: 'b@x.com', standIn: 'email-2@hidden' }]
    const provisionalB = [{ kind: 'email' as const, key: 'c@x.com', original: 'c@x.com', standIn: 'email-2@hidden' }]
    const merged = mergeEntries(mergeEntries(base, provisionalA), provisionalB)
    expect(merged.map(e => e.standIn)).toEqual(['email-1@hidden', 'email-2@hidden', 'email-3@hidden'])
    expect(mergeEntries(merged, provisionalA)).toEqual(merged)
  })

  test('money and percentages need no table', () => {
    const m = createMapper([])
    cloak('$5,000 and 12%', config, m)
    expect(m.entries).toEqual([])
  })

  test('the stand-ins hold the same shape when text is cloaked twice', () => {
    const once = cloakText('Jane Rivera jane@acme.com $5,000', config)
    expect(cloakText(once.text, config, once.entries).text).toBe(once.text)
  })
})

describe('deep values', () => {
  test('cloaks strings inside objects and arrays, keeps keys, numbers and shape', () => {
    const value = {
      command: 'mail jane@acme.com',
      timeout: 5000,
      flags: ['-v', 'Acme Corp'],
      nested: { note: 'call 415-555-0132', ok: true, none: null },
      'jane@acme.com': 'keys stay',
    }
    const m = createMapper([])
    const r = cloakDeep(value, config, m)
    expect(r.hitCount).toBe(3)
    expect(r.value).toEqual({
      command: 'mail email-1@hidden',
      timeout: 5000,
      flags: ['-v', 'Client A'],
      nested: { note: 'call [phone 1]', ok: true, none: null },
      'jane@acme.com': 'keys stay',
    })
    expect(value.command).toBe('mail jane@acme.com') // the input is not changed
  })

  test('returns the very same object when nothing hides', () => {
    const value = { a: ['x', { b: 'y' }], n: 1 }
    const r = cloakDeep(value, config, createMapper([]))
    expect(r.value).toBe(value)
    expect(r.hitCount).toBe(0)
  })

  test('survives cycles of depth and wide arrays without hanging', () => {
    let deep: any = 'a@x.com'
    for (let i = 0; i < 30; i++) deep = { deep }
    const r = cloakDeep(deep, config, createMapper([]))
    expect(r.hitCount).toBe(0) // past the depth limit it stops rather than recursing forever
    const wide = Array.from({ length: 30000 }, () => 'a@x.com')
    expect(cloakDeep(wide, config, createMapper([])).hitCount).toBeLessThan(30000)
  })
})

describe('foreign trees', () => {
  const tree = {
    type: 'Box',
    children: [
      { type: 'Text', children: ['Mail jane@acme.com'] },
      { type: 'Markdown', props: { text: 'Call 415-555-0132' } },
      { type: 'Code', props: { source: 'const a = "Acme Corp"' } },
      { type: 'Button', props: { key: 'go', label: 'Email jane@acme.com' } },
      { type: 'Input', props: { key: 'q', label: 'Ask Acme Corp', placeholder: 'x@y.com', value: 'typed@here.com' } },
      { type: 'Select', props: { key: 's', options: [{ value: 'a', label: 'Acme Corp' }, { value: 'b' }] } },
      { type: 'Svg', props: { markup: '<svg>jane@acme.com</svg>' } },
      { type: 'engine', ref: 0 },
    ],
  }
  test('masks the text a tree shows and leaves handlers, keys and values', () => {
    const r = cloakTree(tree, config, createMapper([])) as any
    const [text, md, code, button, input, select, svg, engine] = r.tree.children
    expect(text.children[0]).toBe('Mail email-1@hidden')
    expect(md.props.text).toBe('Call [phone 1]')
    expect(code.props.source).toBe('const a = "Client A"')
    expect(button.props).toEqual({ key: 'go', label: 'Email email-1@hidden' })
    expect(input.props.label).toBe('Ask Client A')
    expect(input.props.placeholder).toBe('email-2@hidden')
    expect(input.props.value).toBe('typed@here.com') // what a person typed is not rewritten
    expect(select.props.options).toEqual([{ value: 'a', label: 'Client A' }, { value: 'b' }])
    expect(svg.props.markup).toBe('<svg>jane@acme.com</svg>') // known gap: vector markup
    expect(engine).toEqual({ type: 'engine', ref: 0 })
    expect(r.hitCount).toBe(7)
  })
  test('the same tree back when nothing hides', () => {
    const plain = { type: 'Text', children: ['nothing here'] }
    expect(cloakTree(plain, config, createMapper([])).tree).toBe(plain)
  })
})
