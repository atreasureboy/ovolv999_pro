import { describe, it, expect } from 'vitest'
import { ThinkingTagFilter } from '../src/core/thinkingTagFilter.js'

// ThinkingTagFilter strips content between <think>...</think> tags while
// streaming across chunk boundaries. It retains a possible tag prefix at the
// tail of a chunk (since a tag may be split) in an internal buffer, so a single
// push() may not emit all visible text immediately. The behavioral contract we
// test: tag content is hidden from visible output, and reset() clears partial
// state between turns.
//
// NOTE: the filter recognizes the short <think> tag (not <thinking>). Build the
// tag from parts so the literal in this test cannot be silently corrupted.

const OPEN = '<' + 'think' + '>'
const CLOSE = '</' + 'think' + '>'

describe('ThinkingTagFilter', () => {
  it('passes through plain visible text', () => {
    const f = new ThinkingTagFilter()
    expect(f.push('hello world')).toBe('hello world')
  })

  it('hides thinking tag content from visible output', () => {
    const f = new ThinkingTagFilter()
    const out = f.push(`hello ${OPEN}secret${CLOSE} world`)
    expect(out).not.toContain('secret')
    expect(out).toContain('hello')
    expect(out).toContain('world')
  })

  it('reset() clears partial thinking state so a new turn is not swallowed', () => {
    // Regression: a turn interrupted mid-open-tag left insideThinking=true,
    // so the next turn's leading content was swallowed as "thinking".
    const f = new ThinkingTagFilter()
    // Open a thinking tag that never closes within this turn.
    f.push(`start ${OPEN}some reasoning that never closes`)
    // Without reset, subsequent output would be consumed as thinking content.
    f.reset()
    expect(f.push('next turn visible text')).toBe('next turn visible text')
  })

  it('drainThinking returns accumulated thinking content and clears it', () => {
    const f = new ThinkingTagFilter()
    f.push(`before ${OPEN}hidden reasoning${CLOSE} after`)
    const drained = f.drainThinking()
    expect(drained.length).toBeGreaterThan(0)
    expect(drained).toContain('hidden reasoning')
    // The thinking content was captured, not emitted as visible.
    // Second drain returns nothing.
    expect(f.drainThinking()).toBe('')
  })
})
