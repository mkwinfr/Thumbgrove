import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { displayName, nameKey } from '../../../../shared/naming'
import { useAppStore, visibleQueue, type ReviewFilter } from '../../store'
import type { ReviewItem } from '../../types'
import { Thumb } from './Thumb'

const FILTERS: Array<{ id: ReviewFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs a character' },
  { id: 'strong', label: 'Strong matches' }
]

interface Group {
  key: string
  title: string
  items: ReviewItem[]
}

export function GridBoard() {
  const queue = useAppStore(useShallow((s) => visibleQueue(s)))
  const names = useAppStore((s) => s.names)
  const filter = useAppStore((s) => s.reviewFilter)
  const setFilter = useAppStore((s) => s.setReviewFilter)
  const selectMany = useAppStore((s) => s.selectMany)
  const selectAll = useAppStore((s) => s.selectAll)
  const selectStrong = useAppStore((s) => s.selectStrong)

  // Groups by the most likely character, so that one action can cover a whole group.
  const groups = useMemo(() => {
    const map = new Map<string, Group>()
    for (const item of queue) {
      const top = item.candidates[0]
      const key = top ? nameKey(displayName(top.tag, names)) : ''
      const group = map.get(key) ?? { key, title: top ? displayName(top.tag, names) : 'No suggestion', items: [] }
      group.items.push(item)
      map.set(key, group)
    }
    return [...map.values()].sort((a, b) => Number(!a.key) - Number(!b.key) || b.items.length - a.items.length || a.title.localeCompare(b.title))
  }, [queue, names])

  return (
    <section className="card grid-board" aria-label="Review queue">
      <div className="grid-board-hint">
        <div className="tabs review-filter" role="tablist" aria-label="Filter the queue">
          {FILTERS.map(({ id, label }) => (
            <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
              {filter === id && <span className="tab-active" />}
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="setting-root-actions">
          <button className="button compact" title="Select every image with a strong match" onClick={selectStrong}>
            Select strong matches
          </button>
          <button className="button compact" title="Select everything showing (Ctrl+A)" onClick={selectAll}>
            Select all
          </button>
        </div>
      </div>
      <div className="grid-board-sections">
        {!groups.length && <div className="grid-empty-static">Nothing matches this filter.</div>}
        {groups.map((group) => (
          <div key={group.key || 'none'} className="grid-group">
            <header>
              <h3>
                {group.title} <small>{group.items.length}</small>
              </h3>
              <button className="button compact ghost" onClick={() => selectMany(group.items.map((item) => item.id))}>
                Select group
              </button>
            </header>
            <div className="grid-board-items">
              {group.items.map((item) => (
                <Thumb key={item.id} item={item} showLabel />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
