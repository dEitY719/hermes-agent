import { PassThrough } from 'stream'

import { renderSync } from '@hermes/ink'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetOverlayState } from '../app/overlayStore.js'
import { resetUiState } from '../app/uiStore.js'
import { StatusRule } from '../components/appChrome.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

type StatusRuleProps = React.ComponentProps<typeof StatusRule>
type IntervalSpy = ReturnType<typeof vi.spyOn<typeof globalThis, 'setInterval'>>

// Fixed wall clock so the elapsed read-out is an exact string.
const T0 = 1_800_000_000_000

const mounted: Array<() => void> = []

/**
 * Mount a real StatusRule through Ink so FaceTicker's effects — and therefore
 * its `setInterval` calls — actually run.  Calling `StatusRule(...)` as a
 * plain function only builds the element tree and never mounts the leaf, so it
 * can observe neither the rendered mark nor the armed timers.
 */
const mount = (props: StatusRuleProps) => {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()

  let output = ''

  Object.assign(stdout, { columns: 120, isTTY: false, rows: 20 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = renderSync(<StatusRule {...props} />, {
    patchConsole: false,
    stderr: stderr as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream
  })

  mounted.push(() => {
    instance.unmount()
    instance.cleanup()
  })

  return { output: () => stripAnsi(output) }
}

const busyProps = (status: string): StatusRuleProps => ({
  bgCount: 0,
  busy: true,
  cols: 120,
  cwdLabel: '~/repo',
  indicatorStyle: 'symbols',
  lastTurnEndedAt: null,
  liveSessionCount: 0,
  model: 'opus-4.8',
  // No session clock: SessionDuration would arm a second 1s interval and blur
  // the FaceTicker timer assertions below.
  sessionStartedAt: null,
  status,
  statusColor: DEFAULT_THEME.color.ok,
  t: DEFAULT_THEME,
  turnStartedAt: T0 - 30_000,
  usage: { context_max: 200_000, context_percent: 25, context_used: 50_000, total: 50_000 },
  voiceLabel: ''
})

// Give React's scheduler a turn so the first frame is actually written to the
// stdout stub before we read it back.
const flush = () => new Promise(resolve => setTimeout(resolve, 20))

/**
 * The mark FaceTicker actually painted, read straight off the frame so the
 * assertion doesn't depend on how the phase label was truncated.
 */
const markOf = async (status: string) => {
  const rule = mount(busyProps(status))

  await flush()

  return /[●◆■◌]/.exec(rule.output())?.[0] ?? ''
}

/** Delays of every interval armed while the spy was installed. */
const armedDelays = (spy: IntervalSpy) => spy.mock.calls.map(call => call[1])

let intervalSpy: IntervalSpy
let nowSpy: ReturnType<typeof vi.spyOn<DateConstructor, 'now'>>

beforeEach(() => {
  resetUiState()
  resetOverlayState()
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0)
  intervalSpy = vi.spyOn(globalThis, 'setInterval')
})

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()!()
  }

  intervalSpy.mockRestore()
  nowSpy.mockRestore()
  resetOverlayState()
  resetUiState()
})

describe('symbols indicator — static status marks', () => {
  it('renders the working mark, the live phase and the elapsed tail', async () => {
    const rule = mount(busyProps('running…'))

    await flush()

    expect(rule.output()).toContain('● running… · 30s')
  })

  it('marks a turn that is waiting on the human with ◆', async () => {
    const rule = mount(busyProps('approval needed'))

    await flush()

    expect(rule.output()).toContain('◆ approval needed')
  })

  it('marks a turn that is waiting for input with ◆', async () => {
    const rule = mount(busyProps('waiting for input…'))

    await flush()

    expect(rule.output()).toContain('◆ waiting for input…')
  })

  it('marks an interrupt in flight with ■', async () => {
    const rule = mount(busyProps('interrupting…'))

    await flush()

    expect(rule.output()).toContain('■ interrupting…')
  })

  it('marks session start-up with ◌', async () => {
    const rule = mount(busyProps('forging session…'))

    await flush()

    expect(rule.output()).toContain('◌ forging session…')
  })

  it('falls back to the working mark for an unrecognised phase', async () => {
    const rule = mount(busyProps('grepping…'))

    await flush()

    expect(rule.output()).toContain('● grepping…')
  })

  it('renders the bare mark when the phase is empty', async () => {
    const rule = mount(busyProps(''))

    await flush()

    expect(rule.output()).toContain('● · 30s')
  })

  it('arms only the one-second elapsed clock — no glyph or verb rotation', () => {
    mount(busyProps('running…'))

    // The whole point of the style: nothing re-renders the rule per frame.
    expect(armedDelays(intervalSpy)).toEqual([1000])
  })

  it('arms no clock at all when the turn is not timed', () => {
    mount({ ...busyProps('running…'), turnStartedAt: null })

    expect(armedDelays(intervalSpy)).toEqual([])
  })

  it('truncates a long phase so the mark segment stays bounded', async () => {
    const rule = mount(busyProps('reticulating splines across every last shard of the corpus'))

    await flush()

    expect(rule.output()).toContain('●')
    expect(rule.output()).not.toContain('corpus')
  })
})

describe('symbols indicator — mark matching is anchored, not substring', () => {
  // The phase slot also carries tool briefs verbatim, so a mark must not fire
  // on a word that merely appears somewhere inside arbitrary English.
  it.each([
    ['installing needed deps', '●'],
    ['approval workflow docs', '●'],
    ['password rotation run', '●'],
    ['reading interrupt_handler', '●'],
    ['reading pkg setup notes', '●'],
    ['grep resuming in logs', '●']
  ])('leaves %j on the working mark', async (phase, expected) => {
    expect(await markOf(phase)).toBe(expected)
  })

  // …while every phase the gateway and turn controller actually author still
  // lands on the mark that describes it.
  it.each([
    ['approval needed', '◆'],
    ['sudo password needed', '◆'],
    ['secret input needed', '◆'],
    ['waiting for input…', '◆'],
    ['interrupting…', '■'],
    ['interrupted', '■'],
    ['forging session…', '◌'],
    ['recovering session…', '◌'],
    ['resuming…', '◌'],
    ['resuming most recent…', '◌'],
    ['summoning hermes…', '◌'],
    ['setup running…', '◌'],
    ['setup required', '◌'],
    ['running…', '●'],
    ['ready', '●']
  ])('marks the authored phase %j', async (phase, expected) => {
    expect(await markOf(phase)).toBe(expected)
  })
})
