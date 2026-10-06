// Trees Screen Cloak draws. Pure: each takes the surface's element table `t`
// and plain data, and gets its handlers as callbacks. No engine, no state.

import type { Categories, Category } from './cloak'
import { CATEGORIES } from './cloak'
import type { SampleLine } from './sample'

type Table = any

export const CATEGORY_LABEL: Record<Category, string> = {
  emails: 'Emails',
  phones: 'Phone numbers',
  money: 'Money amounts',
  accounts: 'Account numbers',
  percent: 'Percentages',
  names: 'Names and terms',
  personal: 'Personal details',
  secrets: 'Passwords and keys',
}

const HOVER_CARD_LIMIT = 400

function card(original: string) {
  return original.length > HOVER_CARD_LIMIT ? `${original.slice(0, HOVER_CARD_LIMIT)}...` : original
}

// ------------------------------------------------------------------- message

export type MessageData = {
  /** What to draw as the message: the cloaked text, or the original while revealed. */
  shown: string
  isFirstOfReply: boolean
  id: string
  /** True while this message is revealed. */
  isRevealed: boolean
  hitCount: number
  /** Set only where hover reveal is allowed: the original, drawn in a card. */
  hoverOriginal?: string
  onReveal: () => void
  onHide: () => void
}

/** An assistant text block: the engine's bullet, the (cloaked) markdown, a small reveal control. */
export function messageTree(t: Table, d: MessageData) {
  const { Box, Text, Markdown, Button } = t
  return (
    <Box key={`cloak-msg:${d.id}`} flexDirection="row">
      <Box width={2}>
        <Text>{d.isFirstOfReply ? '●' : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown text={d.shown} />
        <Box gap={1}>
          {d.isRevealed ? (
            <Button key="cloak-hide" label="Hide again" plain dimColor onPress={d.onHide} />
          ) : (
            <Button key="cloak-reveal" label="Reveal" plain dimColor onPress={d.onReveal} />
          )}
          <Text dimColor>
            {d.isRevealed ? 'shown for a moment' : `${d.hitCount} hidden`}
          </Text>
        </Box>
        {d.hoverOriginal !== undefined && !d.isRevealed && (
          <Box
            position="absolute"
            top={-1}
            left={0}
            display="none"
            hover={{ display: 'flex' }}
            borderStyle="round"
            paddingX={1}
          >
            <Text>{card(d.hoverOriginal)}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------- band

export type BandData = {
  isOn: boolean
  isRecording: boolean
  isRevealing: boolean
  revealSeconds: number
  hiddenKinds: number
  onToggle: () => void
  onReveal: () => void
  onHide: () => void
  onRecord: () => void
  onSettings: () => void
  onPreview: () => void
}

/** The always-visible switch above the prompt. */
export function bandTree(t: Table, d: BandData) {
  const { Box, Text, Button } = t
  return (
    <Box key="cloak-band" flexWrap="wrap" columnGap={1}>
      {d.isOn ? (
        <Text bold color="red">
          {d.isRevealing ? ' CLOAK ON (details shown) ' : ' CLOAK ON '}
        </Text>
      ) : (
        <Text bold dimColor>
          {' CLOAK OFF '}
        </Text>
      )}
      {d.isOn && d.isRecording && (
        <Text bold color="red">
          REC
        </Text>
      )}
      <Button
        key="toggle"
        label={d.isOn ? 'Turn off' : 'Turn on'}
        hotkey="c"
        variant="primary"
        onPress={d.onToggle}
      />
      {d.isOn &&
        (d.isRevealing ? (
          <Button key="hide" label="Hide again" hotkey="h" onPress={d.onHide} />
        ) : (
          <Button key="reveal" label={`Reveal ${d.revealSeconds}s`} hotkey="r" onPress={d.onReveal} />
        ))}
      <Button key="record" label={d.isRecording ? 'Recording: on' : 'Recording: off'} hotkey="m" onPress={d.onRecord} />
      <Button key="settings" label="Settings" hotkey="s" onPress={d.onSettings} />
      <Button key="preview" label="Preview" hotkey="p" onPress={d.onPreview} />
      {d.isOn && <Text dimColor>{`hiding ${d.hiddenKinds} kinds of detail; Claude still sees all`}</Text>}
    </Box>
  )
}

// ------------------------------------------------------------- settings pane

export type TermRow = {
  index: number
  /** What the row shows: the stand-in, or the original while revealed. */
  shown: string
  isRevealed: boolean
  /** Set only where hover reveal is allowed. */
  hoverOriginal?: string
}

export type PaneData = {
  isOn: boolean
  isRecording: boolean
  isHoverAllowed: boolean
  isRevealing: boolean
  revealSeconds: number
  categories: Categories
  terms: TermRow[]
  hasInput: boolean
  onToggle: () => void
  onRecord: () => void
  onCategory: (c: Category) => void
  onRevealAll: () => void
  onHideAll: () => void
  onRevealTerm: (index: number) => void
  onHideTerm: (index: number) => void
  onRemoveTerm: (index: number) => void
  onAdd: (text: string) => void
  onPreview: () => void
}

export function settingsPane(t: Table, d: PaneData) {
  const { Box, Text, Button, Input } = t
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>Screen Cloak</Text>
        {d.isOn ? (
          <Text bold color="red">
            ON
          </Text>
        ) : (
          <Text dimColor>off</Text>
        )}
        {d.isRecording && (
          <Text bold color="red">
            RECORDING
          </Text>
        )}
      </Box>
      <Text dimColor>Hides details on screen only. Claude still reads and saves the real text.</Text>
      <Text> </Text>
      <Box gap={1}>
        <Button
          key="toggle"
          label={d.isOn ? 'Turn Cloak off' : 'Turn Cloak on'}
          hotkey="c"
          variant="primary"
          onPress={d.onToggle}
        />
        <Button
          key="record"
          label={d.isRecording ? 'Recording mode: on' : 'Recording mode: off'}
          hotkey="m"
          onPress={d.onRecord}
        />
        {d.isOn &&
          (d.isRevealing ? (
            <Button key="hide-all" label="Hide again" hotkey="h" onPress={d.onHideAll} />
          ) : (
            <Button key="reveal-all" label={`Reveal everything ${d.revealSeconds}s`} hotkey="r" onPress={d.onRevealAll} />
          ))}
        <Button key="preview" label="Preview" hotkey="p" onPress={d.onPreview} />
      </Box>
      <Text dimColor>
        {d.isRecording
          ? 'Recording mode: details show only after a click. Nothing shows on hover.'
          : d.isHoverAllowed
            ? 'Click Reveal to show a detail, or hover over one.'
            : 'Click Reveal to show a detail.'}
      </Text>
      <Text> </Text>
      <Text bold>Hide these</Text>
      {CATEGORIES.map(c => (
        <Button
          key={`cat:${c}`}
          label={`${CATEGORY_LABEL[c]}: ${d.categories[c] ? 'on' : 'off'}`}
          plain
          onPress={() => d.onCategory(c)}
        />
      ))}
      <Text> </Text>
      <Text bold>{`Names and terms (${d.terms.length})`}</Text>
      {d.terms.length === 0 && <Text dimColor>None yet. Add one below or use /cloak add.</Text>}
      {d.terms.map(row => (
        <Box key={`term:${row.index}`} gap={1}>
          <Text>{row.shown}</Text>
          {row.isRevealed ? (
            <Button key={`hide-term:${row.index}`} label="Hide" plain dimColor onPress={() => d.onHideTerm(row.index)} />
          ) : (
            <Button key={`show-term:${row.index}`} label="Reveal" plain dimColor onPress={() => d.onRevealTerm(row.index)} />
          )}
          <Button key={`remove-term:${row.index}`} label="Remove" plain dimColor onPress={() => d.onRemoveTerm(row.index)} />
          {row.hoverOriginal !== undefined && !row.isRevealed && (
            <Box position="absolute" top={-1} left={2} display="none" hover={{ display: 'flex' }} borderStyle="round" paddingX={1}>
              <Text>{row.hoverOriginal}</Text>
            </Box>
          )}
        </Box>
      ))}
      {d.hasInput && (
        <Input
          key="add"
          label="Add a name or term:"
          placeholder="type it, then press Enter"
          submitLabel="add"
          onSubmit={d.onAdd}
        />
      )}
      <Text dimColor>Add names before you start sharing: what you type shows as you type it.</Text>
    </Box>
  )
}

// -------------------------------------------------------------- preview pane

export type PreviewLine = { who: SampleLine['who']; original: string; cloaked: string }

export type PreviewData = {
  view: 'cloaked' | 'original' | 'side'
  lines: PreviewLine[]
  /** Counts per category of what the sample hid. */
  summary: string
  isHoverAllowed: boolean
  isRecording: boolean
  columns: number
  onView: (v: 'cloaked' | 'original' | 'side') => void
}

export function previewPane(t: Table, d: PreviewData) {
  const { Box, Text, Button } = t
  const half = Math.max(16, Math.floor((d.columns - 3) / 2))
  const line = (l: PreviewLine, text: string, i: number, withCard: boolean) => (
    <Box key={`line:${i}`} flexDirection="column">
      <Box>
        <Text bold>{`${l.who}: `}</Text>
        <Text>{text}</Text>
      </Box>
      {withCard && (
        <Box position="absolute" top={-1} left={4} display="none" hover={{ display: 'flex' }} borderStyle="round" paddingX={1}>
          <Text>{card(l.original)}</Text>
        </Box>
      )}
    </Box>
  )
  return (
    <Box flexDirection="column">
      <Text bold>Screen Cloak preview</Text>
      <Text dimColor>Made-up sample. Check what would be hidden before you share.</Text>
      <Box gap={1}>
        <Button key="view:cloaked" label="Cloaked" variant={d.view === 'cloaked' ? 'primary' : 'secondary'} hotkey="c" onPress={() => d.onView('cloaked')} />
        <Button key="view:original" label="Original" variant={d.view === 'original' ? 'primary' : 'secondary'} hotkey="o" onPress={() => d.onView('original')} />
        <Button key="view:side" label="Side by side" variant={d.view === 'side' ? 'primary' : 'secondary'} hotkey="s" onPress={() => d.onView('side')} />
      </Box>
      <Text dimColor>{d.summary}</Text>
      <Text dimColor>
        {d.isRecording
          ? 'Recording mode: hover reveals nothing.'
          : d.isHoverAllowed && d.view === 'cloaked'
            ? 'Hover over a line to see its original.'
            : ' '}
      </Text>
      <Text> </Text>
      {d.view === 'cloaked' && d.lines.map((l, i) => line(l, l.cloaked, i, d.isHoverAllowed && !d.isRecording))}
      {d.view === 'original' && d.lines.map((l, i) => line(l, l.original, i, false))}
      {d.view === 'side' && (
        <Box flexDirection="column">
          <Box gap={3}>
            <Box width={half}>
              <Text bold>Original</Text>
            </Box>
            <Box width={half}>
              <Text bold>Cloaked</Text>
            </Box>
          </Box>
          {d.lines.map((l, i) => (
            <Box key={`row:${i}`} gap={3}>
              <Box key={`o:${i}`} width={half}>
                <Text>{`${l.who}: ${l.original}`}</Text>
              </Box>
              <Box key={`c:${i}`} width={half}>
                <Text>{`${l.who}: ${l.cloaked}`}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
