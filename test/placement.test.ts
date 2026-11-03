import { describe, expect, it } from 'vitest'
import { planPlacement, type PlacementInput } from '../src/shared/placement'

const base: PlacementInput = {
  characters: ['Fern'],
  setName: null,
  placeInCharacters: true,
  placeInSet: true,
  roots: { characters: 'C:\\Index\\Characters', sets: 'C:\\Index\\Sets\\' }
}

describe('planPlacement', () => {
  it('moves a character image into its character folder', () => {
    expect(planPlacement(base)).toEqual([
      { kind: 'character', label: 'Fern', directory: 'C:\\Index\\Characters\\Fern', action: 'move' }
    ])
  })

  it('keeps the character folder and copies into the set', () => {
    const targets = planPlacement({ ...base, setName: 'Beach Day' })
    expect(targets.map((t) => [t.directory, t.action])).toEqual([
      ['C:\\Index\\Characters\\Fern', 'move'],
      ['C:\\Index\\Sets\\Beach Day', 'copy']
    ])
  })

  it('copies into each additional character folder', () => {
    const targets = planPlacement({ ...base, characters: ['Fern', 'Stark'] })
    expect(targets.map((t) => t.action)).toEqual(['move', 'copy'])
  })

  it('keeps the set label without placing a file when the set toggle is off', () => {
    expect(planPlacement({ ...base, setName: 'Beach Day', placeInSet: false }).map((t) => t.kind)).toEqual(['character'])
  })

  it('moves into the set when only the set toggle is on', () => {
    const targets = planPlacement({ ...base, setName: 'Beach Day', placeInCharacters: false })
    expect(targets).toEqual([{ kind: 'set', label: 'Beach Day', directory: 'C:\\Index\\Sets\\Beach Day', action: 'move' }])
  })

  it('plans nothing when both toggles are off', () => {
    expect(planPlacement({ ...base, setName: 'Beach Day', placeInCharacters: false, placeInSet: false })).toEqual([])
  })

  it('does not plan the same folder twice', () => {
    expect(planPlacement({ ...base, characters: ['Fern', 'FERN'] })).toHaveLength(1)
  })
})
