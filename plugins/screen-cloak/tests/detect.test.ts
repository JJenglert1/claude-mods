import { describe, expect, test } from 'claude-code/testing'

import { ALL_ON, cloakText, detect, detectEmails, detectPhones, letters, phoneKey } from '../hooks/cloak'
import type { Categories, Config } from '../hooks/cloak'

const only = (...on: (keyof Categories)[]): Categories => ({
  emails: on.includes('emails'),
  phones: on.includes('phones'),
  money: on.includes('money'),
  accounts: on.includes('accounts'),
  percent: on.includes('percent'),
  names: on.includes('names'),
  personal: on.includes('personal'),
  secrets: on.includes('secrets'),
})

const cfg = (c: Categories, terms: string[] = []): Config => ({ categories: c, terms })
const hide = (text: string, c: Categories, terms: string[] = []) => cloakText(text, cfg(c, terms)).text

describe('detectors', () => {
  test('emails: real addresses hide, package names and code do not', () => {
    const hidden: [string, string][] = [
      ['jane@example.com', 'email-1@hidden'],
      ['Mail Jane.Rivera@Acme-Corp.com now', 'Mail email-1@hidden now'],
      ['<bob_smith@mail.example.org>', '<email-1@hidden>'],
      ['(ann@x.io), (bo@y.dev)', '(email-1@hidden), (email-2@hidden)'],
      ['mailto:help@desk.example.com?subject=hi', 'mailto:email-1@hidden?subject=hi'],
    ]
    for (const [input, expected] of hidden) expect(hide(input, only('emails'))).toBe(expected)
    for (const s of ['lodash@4.17.21', '@types/node', 'git@github.com:org/repo.git', 'user@localhost', 'a @ b.com']) {
      expect(hide(s, only('emails'))).toBe(s)
    }
    expect(detectEmails('a'.repeat(200_000))).toEqual([])
  })

  test('phones: formats share one stand-in, versions, dates and ids do not hide', () => {
    for (const p of ['(415) 555-0132', '415.555.0132', '+1 415 555 0132', '+14155550132', '+44 20 7946 0958', '+91 98765 43210']) {
      expect(hide(`call ${p} today`, only('phones'))).toBe('call [phone 1] today')
    }
    expect(hide('phone 4155550132', only('phones'))).toBe('phone [phone 1]')
    expect(hide('order 4155550132', only('phones'))).toBe('order 4155550132')
    for (const s of ['192.168.100.200', 'v1.2.3', '2024-01-15T10:30:00Z', '1234567890', '550e8400-e29b-41d4-a716-446655440000']) {
      expect(hide(s, only('phones'))).toBe(s)
    }
    const r = cloakText('(415) 555-0132 / +1 415.555.0132 / 212-555-0101', cfg(only('phones')))
    expect(r.text).toBe('[phone 1] / [phone 1] / [phone 2]')
    expect(phoneKey('+1 (415) 555-0132')).toBe('4155550132')
  })

  test('money and percent: amounts hide without a mapping, shell code and plain numbers do not', () => {
    const table: [string, string][] = [
      ['$1,234.56', '$•••'],
      ['€2.5M', '€•••'],
      ['US$40', 'US$•••'],
      ['USD 1,234', 'USD •••'],
      ['1,234 USD', '••• USD'],
      ['5 million dollars', '••• dollars'],
      ['100€', '•••€'],
    ]
    for (const [input, expected] of table) expect(hide(`pay ${input} now`, only('money'))).toBe(`pay ${expected} now`)
    expect(hide('It cost $1,234.56.', only('money'))).toBe('It cost $•••.')
    for (const s of ["awk '{print $1}'", 'echo $5', 'cost: $HOME/bin', '2.5M users', 'price 19.99']) {
      expect(hide(s, only('money'))).toBe(s)
    }
    expect(cloakText('$1 and $20', cfg(only('money'))).entries).toEqual([])
    expect(hide('up 12% and 3.5 % and 12 percent', only('percent'))).toBe('up •••% and •••% and ••• percent')
    for (const s of ['%d%%', '50%20off', 'x12%']) expect(hide(s, only('percent'))).toBe(s)
  })

  test('accounts: cards, IBANs, SSNs and labelled digits hide, bad checksums do not', () => {
    expect(hide('card 4111 1111 1111 1111 ok', only('accounts'))).toBe('card [acct 1] ok')
    expect(hide('4111 1111 1111 1112', only('accounts'))).toBe('4111 1111 1111 1112')
    expect(hide('1700000000000', only('accounts'))).toBe('1700000000000')
    expect(hide('IBAN DE89 3704 0044 0532 0130 00.', only('accounts'))).toBe('IBAN [acct 1].')
    expect(hide('DE00 3704 0044 0532 0130 00', only('accounts'))).toBe('DE00 3704 0044 0532 0130 00')
    expect(hide('SSN 123-45-6789.', only('accounts'))).toBe('SSN [acct 1].')
    expect(hide('routing 021000021 and account 1234-5678-90', only('accounts'))).toBe('routing [acct 1] and account [acct 2]')
    expect(hide('account 12345', only('accounts'))).toBe('account 12345')
    expect(hide('4111 1111 1111 1111 = 4111-1111-1111-1111', only('accounts'))).toBe('[acct 1] = [acct 1]')
  })

  test('names: case, spacing and word edges; stand-ins are numbered by first sight and stay put', () => {
    const terms = ['Acme Corp', 'Jane Rivera']
    expect(hide('acme corp, ACME  CORP and Acme\nCorp', only('names'), terms)).toBe('Client A, Client A and Client A')
    expect(hide('Acme Corporation', only('names'), terms)).toBe('Acme Corporation')
    expect(hide("Acme Corp's invoice", only('names'), terms)).toBe("Client A's invoice")
    expect(hide('a b x', only('names'), ['a', ' ', ''])).toBe('a b x')
    expect(hide('AT&T and C++', only('names'), ['AT&T', 'C++'])).toBe('Client A and Client B')
    expect(cloakText('Acme Corp and Acme', cfg(only('names'), ['Acme', 'Acme Corp'])).text).toBe('Client A and Client B')
    const r1 = cloakText('Jane Rivera met Acme Corp', cfg(only('names'), terms))
    expect(r1.text).toBe('Client A met Client B')
    expect(cloakText('Acme Corp then Jane Rivera', cfg(only('names'), terms), r1.entries).text).toBe('Client B then Client A')
    expect([letters(1), letters(26), letters(27)]).toEqual(['A', 'Z', 'AA'])
  })

  test('categories mix cleanly: no overlaps, switched-off ones are left alone, hits keep the original', () => {
    const all = (text: string, terms: string[] = []) => cloakText(text, cfg(ALL_ON, terms))
    expect(all('ann@acme.com', ['acme']).text).toBe('email-1@hidden')
    expect(all('4111 1111 1111 1111').text).toBe('[acct 1]')
    expect(cloakText('a@b.com $5,000', cfg({ ...ALL_ON, emails: false })).text).toBe('a@b.com $•••')
    expect(cloakText('a@b.com $5 Acme', cfg(only(), ['Acme'])).text).toBe('a@b.com $5 Acme')
    const text = 'Jane Rivera <jane@acme.com> +1 415 555 0132 $5,000 12% Acme Corp 4111 1111 1111 1111'
    const spans = detect(text, cfg(ALL_ON, ['Jane Rivera', 'Acme Corp']))
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start >= spans[i - 1]!.end).toBe(true)
    const r = cloakText('Mail jane@acme.com now', cfg(ALL_ON))
    expect(r.hits).toMatchObject([{ original: 'jane@acme.com', standIn: 'email-1@hidden', category: 'emails' }])
    expect(r.segments.map(s => s.text).join('')).toBe(r.text)
  })

  test('code, versions, dates, ids and counts survive with every switch on', () => {
    const text = [
      'v2.3.1 shipped on 2026-03-14 at 10:30:00',
      'see src/app.ts:120 and line 4096',
      'lodash@4.17.21',
      'IP 192.168.0.1 port 8080',
      'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
      'size 1024 bytes, 512 MB, 2.5M users',
    ].join('\n')
    expect(cloakText(text, cfg(ALL_ON)).text).toBe(text)
  })
})

describe('personal details and secrets', () => {
  test('the demo profile is fully hidden', () => {
    const profile = [
      '- **Name:** Maria Delgado-Whitfield',
      '- **Email:** maria.delgado@example.com',
      '- **Phone:** (555) 010-4477',
      '- **Home address:** 4821 Maple Hollow Lane, Springfield, IL 62704',
      '- **Birthday:** March 14, 1987',
      '- **SSN:** 900-12-3456',
      "- **Driver's license:** D400-7788-2291",
      '- **Passport:** X12345678',
      '- **Credit card:** 4111 1111 1111 1111, exp 08/29, CVV 123',
      '- **Bank account:** routing 021000021, account 000123456789',
      '- **IBAN:** GB82 WEST 1234 5698 7654 32',
      '- **IP address:** 203.0.113.42',
      '- **API key:** sk-test-4f8a1c9e2b7d4a60b3e5f1a9c2d84e07',
      '- **Password:** Summer!Rain2026#',
      '- **Username:** mdelgado87',
      '- **Employer:** Northwind Traders, employee ID NW-004821',
      '- **Medical record #:** MRN-7782145',
      '- **Note:** "Call Maria at (555) 010-4477 or email maria.delgado@example.com. Her SSN is 900-12-3456."',
    ].join('\n')
    const out = hide(profile, ALL_ON)
    for (const secret of [
      'Maria', 'Delgado', 'example.com', '010-4477', 'Maple', '62704', '1987', '3456', 'D400', 'X12345678',
      '1111', '08/29', 'CVV 123', '021000021', '000123456789', 'GB82', '203.0.113', 'sk-test', 'Summer',
      'mdelgado87', 'Northwind', 'NW-004821', 'MRN-7782145',
    ]) {
      expect(out.includes(secret)).toBe(false)
    }
    expect(out).toContain('Person A')
    expect(out).toContain('Call Person A at [phone 1]')
  })

  test('code and dev values stay visible', () => {
    for (const s of ['password: string', 'token = null', 'name: my-plugin', 'listen on 127.0.0.1:3000', 'Apache License 2.0', 'v1.2.3.4']) {
      expect(hide(s, ALL_ON)).toBe(s)
    }
  })
})
