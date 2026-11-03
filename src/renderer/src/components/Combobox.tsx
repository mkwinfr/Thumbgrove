import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Plus } from 'lucide-react'

export interface ComboOption {
  value: string
  label: string
  hint?: string
}

interface ComboboxProps {
  id: string
  placeholder: string
  ariaLabel: string
  options: ComboOption[]
  createLabel(text: string): string
  onPick(value: string): void
}

const MAX_VISIBLE = 6

/** A text field with suggestions. Enter picks the highlighted match or creates what was typed. */
export function Combobox({ id, placeholder, ariaLabel, options, createLabel, onPick }: ComboboxProps) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const trimmed = text.trim()
  const matches = useMemo(() => {
    const needle = trimmed.toLowerCase()
    const found = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options
    return found.slice(0, MAX_VISIBLE)
  }, [options, trimmed])
  const exact = matches.some((o) => o.label.toLowerCase() === trimmed.toLowerCase())
  const rows: ComboOption[] = trimmed && !exact ? [...matches, { value: trimmed, label: createLabel(trimmed), hint: 'new' }] : matches

  const pick = (value: string): void => {
    onPick(value)
    setText('')
    setHighlight(0)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (rows.length) {
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setHighlight((h) => (h + delta + rows.length) % rows.length)
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const row = rows[highlight]
      if (open && row) pick(row.value)
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
      setText('')
      inputRef.current?.blur()
    }
  }

  return (
    <div className="combo">
      <input
        ref={inputRef}
        id={id}
        className="input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        maxLength={120}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setHighlight(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <AnimatePresence>
        {open && rows.length > 0 && (
          <motion.ul
            id={listId}
            role="listbox"
            className="combo-list"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
          >
            {rows.map((row, index) => (
              <li
                key={row.value + row.label}
                role="option"
                aria-selected={index === highlight}
                className={`combo-row${index === highlight ? ' active' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  // Keeps focus in the field so the list doesn't close before the pick registers.
                  event.preventDefault()
                  pick(row.value)
                }}
              >
                {row.hint === 'new' && <Plus size={14} />}
                <span className="combo-label">{row.label}</span>
                {row.hint && row.hint !== 'new' && <small>{row.hint}</small>}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
