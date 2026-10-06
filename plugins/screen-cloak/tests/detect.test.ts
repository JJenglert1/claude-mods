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
})

const cfg = (c: Categories, terms: string[] = []): Config => ({ categories: c, terms })
const hide = (text: string, c: Categories, terms: string[] = []) => cloakText(text, cfg(c, terms)).text

describe('emails', () => {
  const table: [string, string][] = [
    ['jane@example.com', 'email-1@hidden'],
    ['Mail Jane.Rivera@Acme-Corp.com now', 'Mail email-1@hidden now'],
    ['a+tag@sub.example.co.uk.', 'email-1@hidden.'],
    ['<bob_smith@mail.example.org>', '<email-1@hidden>'],
    ['(ann@x.io), (bo@y.dev)', '(email-1@hidden), (email-2@hidden)'],
    ['first.last@university.edu;', 'email-1@hidden;'],
    ['x@y.museum', 'email-1@hidden'],
    ['mailto:help@desk.example.com?subject=hi', 'mailto:email-1@hidden?subject=hi'],
  ]
  for (const [input, expected] of table) {
    test(`hides ${input}`, () => {
      expect(hide(input, only('emails'))).toBe(expected)
    })
  }

  const untouched = [
    'lodash@4.17.21',
    '@types/node',
    '@Override',
    'user@localhost',
    'git@github.com:org/repo.git',
    'a @ b.com',
    'foo@bar',
    'foo@.com',
    'email me at @home',
    'pkg@1.2.3-beta.1',
  ]
  for (const input of untouched) {
    test(`leaves ${input} alone`, () => {
      expect(hide(input, only('emails'))).toBe(input)
    })
  }

  test('the same address in any case is one stand-in', () => {
    const r = cloakText('A@x.com a@X.COM b@x.com', cfg(only('emails')))
    expect(r.text).toBe('email-1@hidden email-1@hidden email-2@hidden')
  })

  test('a long run with no @ is fast', () => {
    const big = 'a'.repeat(200_000)
    const t = Date.now()
    expect(detectEmails(big)).toEqual([])
    expect(Date.now() - t).toBeLessThan(500)
  })
})

describe('phones', () => {
  const hidden = [
    '(415) 555-0132',
    '(415)555-0132',
    '415-555-0132',
    '415.555.0132',
    '415 555 0132',
    '+1 415 555 0132',
    '+1-415-555-0132',
    '+1 (415) 555-0132',
    '1-800-555-0199',
    '1 (800) 555 0199',
    '+14155550132',
    '+44 20 7946 0958',
    '+44 (0)20 7946 0958',
    '+49 30 123456',
    '+61 4 1234 5678',
    '+33 1 23 45 67 89',
    '+91 98765 43210',
    '+81 3-1234-5678',
  ]
  for (const p of hidden) {
    test(`hides ${p}`, () => {
      expect(hide(`call ${p} today`, only('phones'))).toBe('call [phone 1] today')
    })
  }

  test('a bare number is a phone only after a phone word', () => {
    expect(hide('phone 4155550132', only('phones'))).toBe('phone [phone 1]')
    expect(hide('Mobile: 14155550132!', only('phones'))).toBe('Mobile: [phone 1]!')
    expect(hide('tel 4155550132', only('phones'))).toBe('tel [phone 1]')
    expect(hide('order 4155550132', only('phones'))).toBe('order 4155550132')
    expect(hide('4155550132', only('phones'))).toBe('4155550132')
  })

  const untouched = [
    '192.168.100.200',
    '255.255.255.0',
    'v1.2.3',
    '2024-01-15',
    '2024-01-15T10:30:00Z',
    '10:30:00',
    'line 120',
    '1234567890',
    '123-45-6789x',
    'abc415-555-0132',
    '415-555-01329',
    '10.415.555.0132',
    '+5 5',
    'x +123 -456',
    '550e8400-e29b-41d4-a716-446655440000',
    '1,234,567',
  ]
  for (const p of untouched) {
    test(`leaves ${p} alone`, () => {
      expect(hide(p, only('phones'))).toBe(p)
    })
  }

  test('different formats of one number share a stand-in', () => {
    const r = cloakText('(415) 555-0132 / +1 415.555.0132 / 14155550132?', cfg(only('phones')))
    expect(r.text).toContain('[phone 1] / [phone 1]')
    expect(phoneKey('+1 (415) 555-0132')).toBe('4155550132')
    expect(phoneKey('+44 (0)20 7946 0958')).toBe(phoneKey('+44 20 7946 0958'))
  })

  test('two numbers get two stand-ins in order', () => {
    expect(hide('415-555-0132 then 212-555-0101', only('phones'))).toBe('[phone 1] then [phone 2]')
  })

  test('spans cover exactly the number', () => {
    const text = 'x (415) 555-0132.'
    const [span] = detectPhones(text)
    expect(text.slice(span!.start, span!.end)).toBe('(415) 555-0132')
  })
})

describe('money', () => {
  const table: [string, string][] = [
    ['$1,234.56', '$•••'],
    ['$1234', '$•••'],
    ['$10', '$•••'],
    ['$99.99', '$•••'],
    ['$ 250', '$•••'],
    ['€2.5M', '€•••'],
    ['£3k', '£•••'],
    ['¥50000', '¥•••'],
    ['$1.2B', '$•••'],
    ['$5 million', '$•••'],
    ['US$40', 'US$•••'],
    ['R$99,90', 'R$•••'],
    ['€1.234,56', '€•••'],
    ['USD 1,234', 'USD •••'],
    ['EUR2.5M', 'EUR •••'],
    ['1,234 USD', '••• USD'],
    ['2.5M EUR', '••• EUR'],
    ['5 million dollars', '••• dollars'],
    ['100 dollars', '••• dollars'],
    ['100€', '•••€'],
    ['1.234,56 €', '•••€'],
    ['0.5 BTC', '••• BTC'],
  ]
  for (const [input, expected] of table) {
    test(`hides ${input}`, () => {
      expect(hide(`pay ${input} now`, only('money'))).toBe(`pay ${expected} now`)
    })
  }

  test('keeps a sentence full stop and a negative sign', () => {
    expect(hide('It cost $1,234.56.', only('money'))).toBe('It cost $•••.')
    expect(hide('Refund of -$50 issued', only('money'))).toBe('Refund of -$••• issued')
    expect(hide('Loss ($1,200)', only('money'))).toBe('Loss ($•••)')
    expect(hide('Range $100-$200', only('money'))).toBe('Range $•••-$•••')
  })

  const untouched = [
    'awk \'{print $1}\'',
    'echo $5',
    'cost: $HOME/bin',
    '${price}',
    '$$',
    'sed s/a/$2/',
    '2.5M users',
    'price 19.99',
    '1,234 rows',
    '10 pounds of flour',
    'v2.5M',
    'cost\\$100',
    'abc$100',
    'US 100',
  ]
  for (const p of untouched) {
    test(`leaves ${p} alone`, () => {
      expect(hide(p, only('money'))).toBe(p)
    })
  }

  test('the amounts do not need a mapping', () => {
    const r = cloakText('$1 and $20 and $20', cfg(only('money')))
    expect(r.entries).toEqual([])
    expect(r.text).toBe('$1 and $••• and $•••')
  })
})

describe('percent', () => {
  test('hides percentages', () => {
    expect(hide('up 12% and 3.5 % and .5%', only('percent'))).toBe('up •••% and •••% and •••%')
    expect(hide('12 percent, 7 pct', only('percent'))).toBe('••• percent, ••• percent')
    expect(hide('(12%)', only('percent'))).toBe('(•••%)')
  })
  test('leaves format strings and url escapes alone', () => {
    for (const s of ['%d%%', '50%20off', 'x12%', '100%a', '%']) expect(hide(s, only('percent'))).toBe(s)
  })
})

describe('accounts', () => {
  test('cards need the Luhn check and a card prefix', () => {
    expect(hide('card 4111 1111 1111 1111 ok', only('accounts'))).toBe('card [acct 1] ok')
    expect(hide('card 4111-1111-1111-1111', only('accounts'))).toBe('card [acct 1]')
    expect(hide('card 4111111111111111', only('accounts'))).toBe('card [acct 1]')
    expect(hide('amex 3782 822463 10005', only('accounts'))).toBe('amex [acct 1]')
    expect(hide('Card 4111 1111 1111 1111 exp 12/26', only('accounts'))).toBe('Card [acct 1] exp 12/26')
    expect(hide('4111 1111 1111 1112', only('accounts'))).toBe('4111 1111 1111 1112') // fails Luhn
    expect(hide('1700000000000', only('accounts'))).toBe('1700000000000') // a timestamp
  })
  test('IBANs need a good checksum', () => {
    expect(hide('IBAN DE89 3704 0044 0532 0130 00.', only('accounts'))).toBe('IBAN [acct 1].')
    expect(hide('GB82WEST12345698765432', only('accounts'))).toBe('[acct 1]')
    expect(hide('DE00 3704 0044 0532 0130 00', only('accounts'))).toBe('DE00 3704 0044 0532 0130 00')
  })
  test('social security numbers', () => {
    expect(hide('SSN 123-45-6789.', only('accounts'))).toBe('SSN [acct 1].')
    expect(hide('1123-45-67890', only('accounts'))).toBe('1123-45-67890')
  })
  test('digits after "account" or "routing"', () => {
    expect(hide('account number: 000123456789', only('accounts'))).toBe('account number: [acct 1]')
    expect(hide('Acct # 123456789', only('accounts'))).toBe('Acct # [acct 1]')
    expect(hide('routing 021000021 and account 1234-5678-90', only('accounts'))).toBe(
      'routing [acct 1] and account [acct 2]',
    )
    expect(hide('account 12345', only('accounts'))).toBe('account 12345') // too short to be sure
    expect(hide('account 2024-01-15', only('accounts'))).toBe('account 2024-01-15')
    expect(hide('account id 123456789', only('accounts'))).toBe('account id 123456789')
  })
  test('the same number is one stand-in', () => {
    expect(hide('4111 1111 1111 1111 = 4111-1111-1111-1111', only('accounts'))).toBe('[acct 1] = [acct 1]')
  })
})

describe('names', () => {
  const terms = ['Acme Corp', 'Jane Rivera']
  test('case does not matter and whitespace is flexible', () => {
    expect(hide('acme corp, ACME  CORP and Acme\nCorp', only('names'), terms)).toBe('Client A, Client A and Client A')
  })
  test('word boundaries', () => {
    expect(hide('Acme Corporation', only('names'), terms)).toBe('Acme Corporation')
    expect(hide('Pacme Corp', only('names'), terms)).toBe('Pacme Corp')
    expect(hide('acme_corp', only('names'), terms)).toBe('acme_corp')
    expect(hide('Acme Corp3', only('names'), terms)).toBe('Acme Corp3')
    expect(hide("Acme Corp's invoice", only('names'), terms)).toBe("Client A's invoice")
    expect(hide('(Acme Corp)', only('names'), terms)).toBe('(Client A)')
    expect(hide('Acme Corp-Europe', only('names'), terms)).toBe('Client A-Europe')
    expect(hide('Réné Acme Corp', only('names'), terms)).toBe('Réné Client A')
    expect(hide('éAcme Corp', only('names'), terms)).toBe('éAcme Corp')
  })
  test('the longest term wins where terms overlap', () => {
    const r = cloakText('Acme Corp and Acme', cfg(only('names'), ['Acme', 'Acme Corp']))
    expect(r.text).toBe('Client A and Client B')
  })
  test('stand-ins number by first sight and stay put', () => {
    const r1 = cloakText('Jane Rivera met Acme Corp', cfg(only('names'), terms))
    expect(r1.text).toBe('Client A met Client B')
    const r2 = cloakText('Acme Corp then Jane Rivera', cfg(only('names'), terms), r1.entries)
    expect(r2.text).toBe('Client B then Client A')
  })
  test('terms with symbols and regex characters are literal', () => {
    expect(hide('AT&T and C++ and a.b (x)', only('names'), ['AT&T', 'C++', 'a.b', '(x)'])).toBe(
      'Client A and Client B and Client C Client D',
    )
    expect(hide('aXb', only('names'), ['a.b'])).toBe('aXb')
  })
  test('too short or empty terms are ignored', () => {
    expect(hide('a b x', only('names'), ['a', ' ', ''])).toBe('a b x')
  })
  test('unicode names', () => {
    expect(hide('Müller GmbH und 田中 san', only('names'), ['müller gmbh', '田中'])).toBe('Client A und Client B san')
    // No word breaks in Japanese or Chinese: a term glued to other letters is not found.
    expect(hide('田中さん', only('names'), ['田中'])).toBe('田中さん')
  })
  test('letters run past Z', () => {
    expect(letters(1)).toBe('A')
    expect(letters(26)).toBe('Z')
    expect(letters(27)).toBe('AA')
    expect(letters(52)).toBe('AZ')
    expect(letters(53)).toBe('BA')
  })
})

describe('overlaps and categories', () => {
  const all = (text: string, terms: string[] = []) => cloakText(text, cfg(ALL_ON, terms))
  test('an email containing a listed name stays one email', () => {
    expect(all('ann@acme.com', ['acme']).text).toBe('email-1@hidden')
  })
  test('a name inside a longer amount phrase does not split it', () => {
    expect(all('$5 million from Acme', ['Acme']).text).toBe('$••• from Client A')
  })
  test('a card is never also a phone', () => {
    expect(all('4111 1111 1111 1111').text).toBe('[acct 1]')
  })
  test('a switched-off category is left alone', () => {
    const c = { ...ALL_ON, emails: false }
    expect(cloakText('a@b.com $5,000', cfg(c)).text).toBe('a@b.com $•••')
    expect(cloakText('a@b.com', cfg({ ...ALL_ON, emails: false })).hits).toEqual([])
  })
  test('everything off hides nothing', () => {
    const none = only()
    expect(cloakText('a@b.com +1 415 555 0132 $5,000 12% Acme', cfg(none, ['Acme'])).text).toBe(
      'a@b.com +1 415 555 0132 $5,000 12% Acme',
    )
  })
  test('spans never overlap and sit in order', () => {
    const text = 'Jane Rivera <jane@acme.com> +1 415 555 0132 $5,000 12% Acme Corp 4111 1111 1111 1111'
    const spans = detect(text, cfg(ALL_ON, ['Jane Rivera', 'Acme Corp']))
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start >= spans[i - 1]!.end).toBe(true)
    expect(spans.map(s => s.kind)).toEqual(['name', 'email', 'phone', 'money', 'percent', 'name', 'account'])
  })
  test('hits carry the original and the segments rebuild the text', () => {
    const r = cloakText('Mail jane@acme.com now', cfg(ALL_ON))
    expect(r.hits).toMatchObject([{ original: 'jane@acme.com', standIn: 'email-1@hidden', category: 'emails' }])
    expect(r.segments.map(s => s.original ?? s.text).join('')).toBe('Mail jane@acme.com now')
    expect(r.segments.map(s => s.text).join('')).toBe(r.text)
  })
})

describe('what is not hidden (tradeoffs)', () => {
  const text = [
    'v2.3.1 shipped on 2026-03-14 at 10:30:00',
    'see src/app.ts:120 and line 4096',
    'git@github.com:org/repo.git',
    'lodash@4.17.21',
    'IP 192.168.0.1 port 8080',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'uuid 550e8400-e29b-41d4-a716-446655440000',
    'build 20260314123045',
    'width: 3 and height: 4',
    'node -e "console.log(1+1)"',
    'size 1024 bytes, 512 MB, 2.5M users',
  ].join('\n')
  test('code, versions, dates, ids and counts survive with every switch on', () => {
    expect(cloakText(text, cfg(ALL_ON)).text).toBe(text)
  })
  test('known misses: a lone $5, bare 10 digits, a number with no currency mark', () => {
    for (const s of ['$5', '4155550132', 'price 19.99', 'revenue was 2.5M']) {
      expect(cloakText(s, cfg(ALL_ON)).text).toBe(s)
    }
  })
  test('known over-hides: CSS percentages and a bare 3-3-4 digit run', () => {
    expect(cloakText('width: 100%', cfg(ALL_ON)).text).toBe('width: •••%')
    expect(cloakText('100 200 3000', cfg(ALL_ON)).text).toBe('[phone 1]')
  })
})
