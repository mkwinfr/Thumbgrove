export interface CharacterName {
  raw: string
  name: string
  series?: string
}

const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function normalize(raw: string): string {
  return raw.replaceAll('_', ' ').trim().replace(/\s+/g, ' ')
}

/** Comparison key that ignores case, underscores, and extra spaces. */
export function nameKey(raw: string): string {
  return normalize(raw).toLocaleLowerCase()
}

/** Title-cases a name: "frieren_the-mage" becomes "Frieren The-Mage". */
export function canonical(raw: string): string {
  return nameKey(raw)
    .replace(/(^|[\s-])(\p{L})/gu, (_m, gap: string, letter: string) => gap + letter.toLocaleUpperCase())
    .replace(/\b(\d+)([a-z])\b/gi, (_m, digits: string, letter: string) => digits + letter.toLocaleUpperCase())
}

function findEntry(raw: string, names: CharacterName[]): CharacterName | undefined {
  const key = nameKey(raw)
  return names.find((entry) => nameKey(entry.raw) === key)
}

/** Preferred name if one is saved, otherwise the tag without its "(series)" suffix. */
export function displayName(raw: string, names: CharacterName[] = []): string {
  const preferred = findEntry(raw, names)?.name
  return canonical(preferred ?? raw.replace(/\s*\([^()]*\)\s*$/, '').trim())
}

/** Saved series label if one exists, otherwise the "(series)" suffix of the tag. */
export function seriesLabel(raw: string, names: CharacterName[] = []): string {
  const saved = findEntry(raw, names)?.series
  if (saved !== undefined) return saved
  const match = normalize(raw).match(/\(([^()]*)\)\s*$/)
  return match?.[1] ? canonical(match[1]) : ''
}

/** Base filename: "Frieren & Fern - Beach Day". A set takes priority over the series label. */
export function namingBase(raws: string[], names: CharacterName[] = [], setName = ''): string {
  const unique = new Map<string, string>()
  for (const raw of raws) {
    const shown = displayName(raw, names)
    if (shown) unique.set(nameKey(shown), shown)
  }
  if (!unique.size) return ''
  const context = setName || [...new Set(raws.map((raw) => seriesLabel(raw, names)).filter(Boolean))].join(' & ')
  return [...unique.values()].join(' & ') + (context ? ` - ${context}` : '')
}

function safeSegment(value: string, maxLength: number): string {
  return value.replace(UNSAFE_CHARS, '-').trim().replace(/[. ]+$/, '').slice(0, maxLength).replace(/[. ]+$/, '')
}

/**
 * Adds the lowest unused number: "Frieren - 001.png". Comparison ignores case, as Windows does.
 * A Set must already be lowercase, which avoids rebuilding it for every name in a large batch.
 */
export function imageName(base: string, extension: string, existing: Iterable<string> = []): string {
  let clean = safeSegment(base, 180) || 'Image'
  if (RESERVED_NAME.test(clean)) clean = `Image ${clean}`
  const used = existing instanceof Set ? (existing as Set<string>) : new Set([...existing].map((name) => name.toLowerCase()))
  for (let n = 1; n < 1_000_000; n++) {
    const name = `${clean} - ${String(n).padStart(3, '0')}${extension}`
    if (!used.has(name.toLowerCase())) return name
  }
  throw new Error('Unable to choose a unique image name.')
}

/** Makes a name safe to use as a Windows folder. */
export function folderName(name: string, fallbackPrefix: 'Character' | 'Set' | 'Catalogue'): string {
  const value = safeSegment(name, 120)
  if (!value || value === '.' || value === '..' || RESERVED_NAME.test(value)) {
    return `${fallbackPrefix} - ${value || 'Unnamed'}`
  }
  return value
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot) : ''
}
