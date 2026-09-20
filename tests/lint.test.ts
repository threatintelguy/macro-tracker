/**
 * The banned-word rule.
 *
 * Streaks, cheat days, burning off and earning back are absent by
 * construction rather than shipped disabled. This scans every user-facing
 * string in the UI for them.
 *
 * Cheap, and it prevents drift as the app gets extended later by someone who
 * has forgotten why.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BANNED = ['streak', 'cheat', 'burn off', 'burned off', 'earn back', 'earned back']

/** Evaluative food language the guidance rules out. */
const BANNED_PHRASES = [
  'clean eating',
  'bad food',
  'good food',
  'guilt',
  'cheat meal',
  'cheat day',
]

function sourceFiles(dir: string, exts = ['.ts', '.tsx', '.css']): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/**
 * Extract the strings and JSX text a user could actually read, so a comment
 * explaining why a word is banned does not trip the rule that bans it.
 */
function userFacingText(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLineComments = withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, '$1')

  const chunks: string[] = []
  // Quoted strings and template literals.
  const strings = withoutLineComments.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []
  chunks.push(...strings)
  // JSX text between tags.
  const jsxText = withoutLineComments.match(/>[^<>{}]{3,}</g) ?? []
  chunks.push(...jsxText)
  return chunks.join('\n').toLowerCase()
}

describe('absent by construction', () => {
  const files = sourceFiles('src')

  it('finds no banned word in any user-facing string', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = userFacingText(readFileSync(file, 'utf8'))
      for (const word of [...BANNED, ...BANNED_PHRASES]) {
        if (text.includes(word)) offenders.push(`${file}: "${word}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no gamification vocabulary in the UI layer', () => {
    const uiFiles = files.filter((f) => f.includes('ui'))
    const offenders: string[] = []
    for (const file of uiFiles) {
      const text = userFacingText(readFileSync(file, 'utf8'))
      for (const word of ['badge', 'points earned', 'level up', 'congratulations']) {
        if (text.includes(word)) offenders.push(`${file}: "${word}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('scans a meaningful number of files', () => {
    // Guards the guard: a broken glob that matches nothing would pass above.
    expect(files.length).toBeGreaterThan(15)
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true)
  })

  it('would catch a banned word if one were added', () => {
    const sample = `const label = 'Keep your streak going'`
    expect(userFacingText(sample)).toContain('streak')
  })

  it('does not trip on a comment that explains the rule', () => {
    const sample = `// No streak mechanics anywhere in this app.\nconst label = 'Day 9 of 24'`
    const text = userFacingText(sample)
    expect(text).not.toContain('streak')
    expect(text).toContain('day 9 of 24')
  })
})

describe('no third-party runtime references', () => {
  it('has no CDN URL anywhere in the source', () => {
    // No CDN references anywhere: necessary for offline behaviour, and it
    // avoids leaking usage timing to a third party.
    const offenders: string[] = []
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8')
      for (const cdn of ['cdn.jsdelivr', 'unpkg.com', 'cdnjs.', 'fonts.googleapis', 'fonts.gstatic']) {
        if (source.includes(cdn)) offenders.push(`${file}: ${cdn}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('makes exactly one outbound host reachable from the source', () => {
    const hosts = new Set<string>()
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
        hosts.add(m[1]!.toLowerCase())
      }
    }
    // Open Food Facts, and nothing else.
    expect([...hosts].sort()).toEqual(['world.openfoodfacts.org'])
  })
})
