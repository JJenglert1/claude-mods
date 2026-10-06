// A made-up client conversation for the preview. Every name, number and
// address here is fictional. The IBAN and card number are published test values.

/** Names the preview always hides (when the names switch is on), so it works even before you list real ones. */
export const SAMPLE_TERMS = ['Acme Corp', 'Jane Rivera', 'Northwind Traders'] as const

export type SampleLine = { who: 'You' | 'Claude'; text: string }

export const SAMPLE_LINES: readonly SampleLine[] = [
  {
    who: 'You',
    text: 'Draft a reply to Jane Rivera at Acme Corp. Her email is jane.rivera@acmecorp.com and her cell is +1 (415) 555-0132.',
  },
  {
    who: 'Claude',
    text: 'Done. I addressed it to Jane Rivera and copied accounts@acmecorp.com. I also mentioned the $48,500.00 retainer and the 12% late fee from the March invoice.',
  },
  {
    who: 'You',
    text: 'Northwind Traders wants to wire EUR 2.5M. Their IBAN is DE89 3704 0044 0532 0130 00 and the account number: 000123456789.',
  },
  {
    who: 'Claude',
    text: 'Noted. For the deposit I will use the card 4111 1111 1111 1111 on file. Call Jane Rivera on 415-555-0132 if the transfer is held. Build v2.3.1 shipped on 2026-03-14, see line 120 of invoice.ts.',
  },
]
