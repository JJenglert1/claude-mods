/** What each switch hides. */
export type ScreenCloakCategories = {
  emails: boolean
  phones: boolean
  /** Currency amounts such as $1,234.56 or EUR 2.5M. */
  money: boolean
  /** Card numbers, IBANs, social security numbers, numbers after "account". */
  accounts: boolean
  /** 12% and 12 percent. */
  percent: boolean
  /** The names and terms the person listed. */
  names: boolean
  /** People after a "Name:" label, employers, street addresses, birthdays, ids, public IPs. */
  personal: boolean
  /** Passwords, API keys, tokens, card CVV and expiry. */
  secrets: boolean
}

/** One original and the stand-in drawn for it. Kept in memory for the session only. */
export type ScreenCloakEntry = {
  kind: 'email' | 'phone' | 'account' | 'name' | 'person' | 'org' | 'address' | 'date' | 'id' | 'ip'
  /** Normalised form used for lookup. */
  key: string
  /** The real text. Never written to disk. */
  original: string
  /** What the screen shows: "Client A", "email-1@hidden", "[phone 1]", "[acct 1]". */
  standIn: string
}

export type ScreenCloakPreviewView = 'cloaked' | 'original' | 'side'

declare module 'claude-code' {
  interface PluginState {
    'screen-cloak': {
      /** The master switch. */
      isOn: boolean
      categories: ScreenCloakCategories
      /** Names and terms to hide (session only; the real text). */
      terms: string[]
      /** Recording mode: reveal needs a click and nothing reveals on hover. */
      isRecording: boolean
      /** The consistent original -> stand-in table (session only). */
      entries: ScreenCloakEntry[]
      /** Everything shows until the reveal timer ends. */
      isRevealingAll: boolean
      /** Transcript messages (render ids) revealed one by one. */
      revealedIds: string[]
      /** Pane rows revealed one by one. */
      revealedKeys: string[]
      previewView: ScreenCloakPreviewView
    }
  }
}
