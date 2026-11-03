import { folderName } from './naming'

export interface PlacementRoots {
  characters: string
  sets: string
}

export interface PlacementInput {
  /** Display names of the image's characters. */
  characters: string[]
  setName: string | null
  placeInCharacters: boolean
  placeInSet: boolean
  roots: PlacementRoots
}

export interface PlacementTarget {
  kind: 'character' | 'set'
  label: string
  directory: string
  /** The first target receives the original file. Every other target receives a copy. */
  action: 'move' | 'copy'
}

function join(root: string, child: string): string {
  return `${root.replace(/[\\/]+$/, '')}\\${child}`
}

/**
 * Decides where an image lands when a review is applied.
 *
 * Every character image belongs in its character folders. A set is an addition, so an image in both
 * lives in the character folder and has a copy in the set folder. With no targets, the file stays
 * where it is and is only renamed.
 */
export function planPlacement(input: PlacementInput): PlacementTarget[] {
  const targets: PlacementTarget[] = []
  const add = (kind: PlacementTarget['kind'], label: string, directory: string): void => {
    const seen = targets.some((t) => t.directory.toLowerCase() === directory.toLowerCase())
    if (!seen) targets.push({ kind, label, directory, action: targets.length ? 'copy' : 'move' })
  }
  if (input.placeInCharacters) {
    for (const name of input.characters) add('character', name, join(input.roots.characters, folderName(name, 'Character')))
  }
  if (input.placeInSet && input.setName) {
    add('set', input.setName, join(input.roots.sets, folderName(input.setName, 'Set')))
  }
  return targets
}
