import { describe, expect, it } from 'vitest'
import { canonical, displayName, extensionOf, folderName, imageName, nameKey, namingBase, seriesLabel } from '../src/shared/naming'

describe('names', () => {
  it('compares names without case, underscores, or extra spaces', () => {
    expect(nameKey('  Frieren_the   MAGE ')).toBe('frieren the mage')
  })

  it('title-cases names, including after hyphens and in number suffixes', () => {
    expect(canonical('anna-marie_smith')).toBe('Anna-Marie Smith')
    expect(canonical('unit 2b')).toBe('Unit 2B')
  })

  it('strips the series suffix from a tag', () => {
    expect(displayName('frieren (sousou no frieren)')).toBe('Frieren')
    expect(seriesLabel('frieren_(sousou_no_frieren)')).toBe('Sousou No Frieren')
  })

  it('prefers saved names and series, including an intentionally empty series', () => {
    const names = [{ raw: 'frieren (sousou no frieren)', name: 'frieren the mage', series: '' }]
    expect(displayName('Frieren_(Sousou_No_Frieren)', names)).toBe('Frieren The Mage')
    expect(seriesLabel('frieren (sousou no frieren)', names)).toBe('')
  })
})

describe('namingBase', () => {
  it('returns nothing without characters', () => {
    expect(namingBase([], [], 'Beach Day')).toBe('')
  })

  it('uses the series when there is no set', () => {
    expect(namingBase(['fern (sousou no frieren)'])).toBe('Fern - Sousou No Frieren')
  })

  it('lets the set replace the series', () => {
    expect(namingBase(['fern (sousou no frieren)'], [], 'Beach Day')).toBe('Fern - Beach Day')
  })

  it('joins characters and removes duplicates', () => {
    expect(namingBase(['fern (a)', 'FERN (b)', 'stark (a)'], [], 'Set')).toBe('Fern & Stark - Set')
  })
})

describe('imageName', () => {
  it('uses the lowest free number and ignores case', () => {
    expect(imageName('Fern', '.png', ['fern - 001.PNG', 'Fern - 003.png'])).toBe('Fern - 002.png')
  })

  it('removes characters Windows does not allow and trailing dots', () => {
    expect(imageName('a:b/c?. ', '.jpg')).toBe('a-b-c- - 001.jpg')
  })

  it('avoids reserved Windows names', () => {
    expect(imageName('con', '.png')).toBe('Image con - 001.png')
  })
})

describe('folderName', () => {
  it('cleans unsafe characters', () => {
    expect(folderName('Re:Zero?', 'Set')).toBe('Re-Zero-')
  })

  it('falls back for empty and reserved names', () => {
    expect(folderName('...', 'Character')).toBe('Character - Unnamed')
    expect(folderName('nul', 'Set')).toBe('Set - nul')
  })
})

describe('extensionOf', () => {
  it('reads the final extension only', () => {
    expect(extensionOf('a.b.png')).toBe('.png')
    expect(extensionOf('noextension')).toBe('')
  })
})
