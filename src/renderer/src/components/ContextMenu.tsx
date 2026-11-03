import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import type { LucideIcon } from 'lucide-react'

export interface ContextMenuItem {
  label: string
  icon: LucideIcon
  danger?: boolean
  separatorBefore?: boolean
  run(): void
}

interface ContextMenuProps {
  x: number
  y: number
  label: string
  items: ContextMenuItem[]
  onClose(): void
}

const EDGE_GAP = 8

export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Keeps the menu on screen when opened near an edge.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - rect.width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - rect.height - EDGE_GAP))
    })
    ref.current?.querySelector('button')?.focus()
  }, [x, y])

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const onKeyDown = (event: KeyboardEvent): void => {
    const buttons = [...(ref.current?.querySelectorAll('button') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') buttons[(index + 1) % buttons.length]?.focus()
    else if (event.key === 'ArrowUp') buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <motion.div
      ref={ref}
      role="menu"
      aria-label={label}
      className="context-menu"
      style={position}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map(({ label: itemLabel, icon: Icon, danger, separatorBefore, run }) => (
        <div key={itemLabel} className={separatorBefore ? 'context-group' : undefined}>
          <button
            role="menuitem"
            className={`context-item${danger ? ' danger' : ''}`}
            onClick={() => {
              onClose()
              run()
            }}
          >
            <Icon size={15} />
            {itemLabel}
          </button>
        </div>
      ))}
    </motion.div>,
    document.body
  )
}
