import type { Candidate } from '../../shared/api'
import { displayName, type CharacterName } from '../../shared/naming'

export interface TagLabel {
  index: number
  tag: string
  category: number
}

const CHARACTER_CATEGORY = 4
const MIN_SCORE = 0.1
const MAX_SUGGESTIONS = 5
const FILENAME_BOOST = 0.12
const FILENAME_ONLY_RANK = 0.6

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (c === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some(Boolean)) rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (quoted) throw new Error('Invalid tag vocabulary.')
  return rows
}

export function characterLabels(csv: string): TagLabel[] {
  const rows = parseCsv(csv)
  const header = rows.shift() ?? []
  const nameColumn = header.indexOf('name')
  const categoryColumn = header.indexOf('category')
  if (nameColumn < 0 || categoryColumn < 0) throw new Error('Invalid tag vocabulary.')
  const labels = rows.map((row, index) => ({
    index,
    tag: (row[nameColumn] ?? '').replaceAll('_', ' '),
    category: Number(row[categoryColumn])
  }))
  if (!labels.some((label) => label.category === CHARACTER_CATEGORY)) throw new Error('Character vocabulary is missing.')
  return labels
}

export function predictions(scores: ArrayLike<number>, labels: TagLabel[]): Candidate[] {
  if (scores.length !== labels.length) throw new Error('The model and tag vocabulary do not match.')
  return labels
    .filter((label) => label.category === CHARACTER_CATEGORY && label.tag.length <= 120 && Number.isFinite(scores[label.index]) && scores[label.index]! >= MIN_SCORE)
    .map((label) => ({ tag: label.tag, score: Number(scores[label.index]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
}

function normalize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export interface FilenamePhrase {
  tags: Set<string>
  /**
   * A single common-looking word like "Red" or "Fern" could just be a word in the filename, so it can
   * support a suggestion from the model but can't create one by itself.
   */
  weak: boolean
}

/** Maps every way of writing a character's name to their tags. */
export function buildFilenameIndex(labels: TagLabel[], names: CharacterName[] = []): Map<string, FilenamePhrase> {
  const saved = new Set(names.map((entry) => normalize(entry.name)))
  const phrases = new Map<string, FilenamePhrase>()
  for (const { tag, category } of labels) {
    if (category !== CHARACTER_CATEGORY) continue
    for (const value of [tag, displayName(tag), displayName(tag, names)]) {
      const phrase = normalize(value)
      if (phrase.length < 3 && !/\d/.test(phrase)) continue
      const weak = !phrase.includes(' ') && !saved.has(phrase)
      const entry = phrases.get(phrase) ?? { tags: new Set<string>(), weak }
      entry.tags.add(tag)
      phrases.set(phrase, entry)
    }
  }
  return phrases
}

/** Blends what the filename says with what the model saw. A name in the filename raises its rank. */
export function combineFilename(filename: string, candidates: Candidate[], index: Map<string, FilenamePhrase>): Candidate[] {
  const text = ` ${normalize(filename.replace(/\.[^.]+$/, ''))} `
  const hints = new Set<string>()
  for (const [phrase, { tags, weak }] of index) {
    if (!text.includes(` ${phrase} `)) continue
    // A weak or shared name only counts if the model suggested one of its characters.
    if (tags.size === 1 && !weak) hints.add([...tags][0]!)
    else for (const candidate of candidates) if (tags.has(candidate.tag)) hints.add(candidate.tag)
  }
  const ranked = candidates.map((candidate) => ({
    candidate: hints.has(candidate.tag) ? { ...candidate, filenameMatch: true } : candidate,
    rank: hints.has(candidate.tag) ? Math.min(1, candidate.score + FILENAME_BOOST) : candidate.score
  }))
  for (const tag of hints) {
    if (!candidates.some((candidate) => candidate.tag === tag)) {
      ranked.push({ candidate: { tag, score: 0, filenameMatch: true, filenameOnly: true }, rank: FILENAME_ONLY_RANK })
    }
  }
  return ranked
    .sort((a, b) => b.rank - a.rank || b.candidate.score - a.candidate.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.candidate)
}
