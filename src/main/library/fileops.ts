import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { PlacementTarget } from '../../shared/placement'

export interface PlacementJournal {
  /** Where the original file was and where it ended up. Equal when it stayed put. */
  from: string
  to: string
  copies: string[]
  createdDirs: string[]
  /** Size and time of the file when it was placed, to spot later edits before undoing. */
  size: number
  mtimeMs: number
}

const UNSAFE_NAME = /[<>:"/\\|?*\x00-\x1f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function assertSafeFileName(name: string, sourceName: string): void {
  if (!name || UNSAFE_NAME.test(name) || /[. ]$/.test(name) || RESERVED_NAME.test(name) || name.length > 240) {
    throw new Error(`“${name}” can't be used as a filename.`)
  }
  if (path.extname(name).toLowerCase() !== path.extname(sourceName).toLowerCase()) {
    throw new Error('Keep the original image extension.')
  }
}

export function assertSafeFolderName(name: string): void {
  if (!name || name === '.' || name === '..' || UNSAFE_NAME.test(name) || /[. ]$/.test(name) || RESERVED_NAME.test(name) || name.length > 120) {
    throw new Error(`“${name}” can't be used as a folder name.`)
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

async function exists(file: string): Promise<boolean> {
  return fsp.lstat(file).then(() => true, () => false)
}

/** Finds a name that's free in this folder. An existing file is never overwritten. */
async function freePath(directory: string, name: string, planned: Set<string>, allowed?: string): Promise<string> {
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let n = 1; n < 100_000; n++) {
    const candidate = path.join(directory, n === 1 ? name : `${stem} (${n})${extension}`)
    const key = candidate.toLowerCase()
    if (planned.has(key)) continue
    if ((allowed && samePath(candidate, allowed)) || !(await exists(candidate))) {
      planned.add(key)
      return candidate
    }
  }
  throw new Error(`No free filename for ${name}.`)
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // Different drives can't rename, so copy, confirm the size, and only then remove the original.
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    const [source, copy] = await Promise.all([fsp.stat(from), fsp.stat(to)])
    if (source.size !== copy.size) {
      await fsp.rm(to, { force: true })
      throw new Error('The copy was incomplete, so the original was kept.')
    }
    await fsp.rm(from)
  }
}

async function removeEmptyDirs(dirs: string[]): Promise<void> {
  for (const dir of [...dirs].reverse()) await fsp.rmdir(dir).catch(() => undefined)
}

async function makeDir(directory: string, created: string[]): Promise<void> {
  const missing: string[] = []
  let current = directory
  while (!(await exists(current))) {
    missing.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const dir of missing) {
    await fsp.mkdir(dir)
    created.push(dir)
  }
}

/**
 * Places one image as a single unit: the original goes to the first target and every other target
 * gets a copy. With no targets the file is only renamed. If any step fails, everything done for this
 * image is reversed. No existing file is ever overwritten.
 */
export async function placeFile(source: string, name: string, targets: PlacementTarget[]): Promise<PlacementJournal> {
  assertSafeFileName(name, path.basename(source))
  const sourceDir = path.dirname(source)
  // An image already sitting in one of its folders stays there and the others get copies.
  const ordered = [...targets]
  const current = ordered.findIndex((target) => samePath(target.directory, sourceDir))
  if (current > 0) ordered.unshift(...ordered.splice(current, 1))

  const journal: PlacementJournal = { from: source, to: source, copies: [], createdDirs: [], size: 0, mtimeMs: 0 }
  const planned = new Set<string>()
  try {
    const primaryDir = ordered[0]?.directory ?? sourceDir
    await makeDir(primaryDir, journal.createdDirs)
    const destination = await freePath(primaryDir, name, planned, source)
    if (destination !== source) {
      await moveFile(source, destination)
      journal.to = destination
    }
    for (const target of ordered.slice(1)) {
      await makeDir(target.directory, journal.createdDirs)
      const copy = await freePath(target.directory, name, planned)
      await fsp.copyFile(journal.to, copy, fs.constants.COPYFILE_EXCL)
      journal.copies.push(copy)
    }
    const stat = await fsp.stat(journal.to)
    journal.size = stat.size
    journal.mtimeMs = stat.mtimeMs
    return journal
  } catch (error) {
    await reversePlacement(journal).catch(() => undefined)
    throw error
  }
}

async function reversePlacement(journal: PlacementJournal): Promise<void> {
  for (const copy of journal.copies) await fsp.rm(copy, { force: true })
  if (journal.to !== journal.from) await moveFile(journal.to, journal.from)
  await removeEmptyDirs(journal.createdDirs)
}

/** Undoes a placement, refusing if the file has since been edited or something took its old place. */
export async function undoPlacement(journal: PlacementJournal): Promise<void> {
  const stat = await fsp.stat(journal.to).catch(() => null)
  if (!stat) throw new Error(`${path.basename(journal.to)} has since been moved or deleted.`)
  if (stat.size !== journal.size || stat.mtimeMs !== journal.mtimeMs) throw new Error(`${path.basename(journal.to)} has changed since it was applied.`)
  if (journal.to !== journal.from && !samePath(journal.to, journal.from) && (await exists(journal.from))) {
    throw new Error(`Something else now uses the name ${path.basename(journal.from)}.`)
  }
  await reversePlacement(journal)
}
