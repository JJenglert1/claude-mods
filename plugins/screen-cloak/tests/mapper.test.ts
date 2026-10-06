import { describe, expect, test } from 'claude-code/testing'

import { ALL_ON, cloak, cloakDeep, cloakText, cloakTree, createMapper, mergeEntries, standInFor } from '../hooks/cloak'
import type { Config } from '../hooks/cloak'

const config: Config = { categories: ALL_ON, terms: ['Acme Corp', 'Jane Rivera'] }

describe('consistent mapping', () => {

  test('one mapper keeps every original on one stand-in across texts', () => {
    const m = createMapper([])
    const a = cloak('Jane Rivera <jane@acme.com> 415-555-0132', config, m)
    const b = cloak('Later: jane@ACME.com, Acme Corp, 415.555.0132, and bob@x.org', config, m)
    expect(a.text).toBe('Client A <email-1@hidden> [phone 1]')
    expect(b.text).toBe('Later: email-1@hidden, Client B, [phone 1], and email-2@hidden')
    expect(m.entries.map(e => e.standIn)).toEqual(['Client A', 'email-1@hidden', '[phone 1]', 'Client B', 'email-2@hidden'])
  })

})

describe('deep values', () => {

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
})
