import { memo, useEffect, useRef, type MouseEvent } from 'react'
import { thumbUrl } from '../../../../shared/api'
import { displayName } from '../../../../shared/naming'
import { useAppStore } from '../../store'
import type { ReviewItem } from '../../types'

function onThumbClick(event: MouseEvent, id: number): void {
  const store = useAppStore.getState()
  if (event.shiftKey) store.selectRange(id)
  else if (event.ctrlKey || event.metaKey) store.toggleSelect(id)
  else store.focus(id)
}

/** A queue thumbnail. Subscribes only to its own state, so one change doesn't redraw the whole queue. */
export const Thumb = memo(function Thumb({ item, showLabel = false }: { item: ReviewItem; showLabel?: boolean }) {
  const isFocused = useAppStore((s) => s.focusId === item.id)
  const isSelected = useAppStore((s) => s.selection.includes(item.id))
  const characterCount = useAppStore((s) => s.drafts[item.id]?.characters.length ?? 0)
  const hasSet = useAppStore((s) => Boolean(s.drafts[item.id]?.setName))
  const label = useAppStore((s) => {
    const draft = s.drafts[item.id]
    if (!showLabel || !draft) return ''
    const shown = draft.characters.map((raw) => displayName(raw, s.names)).join(', ')
    return draft.setName ? (shown ? `${shown} · ${draft.setName}` : draft.setName) : shown
  })
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isFocused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [isFocused])

  const status = item.error ? 'error' : characterCount || hasSet ? 'ready' : 'needs'
  const statusText = { error: 'Could not be read', ready: 'Ready to apply', needs: 'Needs a character' }[status]

  return (
    <button
      ref={ref}
      className={`thumb${isFocused ? ' focused' : ''}${isSelected ? ' selected' : ''}`}
      aria-label={`${item.name}, ${statusText}`}
      aria-pressed={isSelected}
      title={`${item.name} · ${statusText}`}
      onClick={(event) => onThumbClick(event, item.id)}
    >
      <img src={thumbUrl(item.id, item.mtimeMs)} alt="" loading="lazy" decoding="async" draggable={false} />
      <span className={`thumb-status ${status}`} />
      {showLabel && <span className="thumb-label">{label || 'No character yet'}</span>}
    </button>
  )
})
