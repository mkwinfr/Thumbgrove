import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, CornerDownLeft, History, Layers, Sparkles, Pencil, RotateCcw, Send, Trash2, UserRound, X } from 'lucide-react'
import { displayName, nameKey } from '../../../../shared/naming'
import { planPlacement } from '../../../../shared/placement'
import { Combobox, type ComboOption } from '../../components/Combobox'
import { Toggle } from '../../components/Toggle'
import { previewNames, targetIds, useAppStore } from '../../store'
import type { Candidate, Draft, ReviewItem } from '../../types'

/** Everything the panel shows about the images being edited, whether one or many. */
function useTargets(): { items: ReviewItem[]; drafts: Draft[]; ids: number[] } {
  const queue = useAppStore((s) => s.queue)
  const allDrafts = useAppStore((s) => s.drafts)
  const selection = useAppStore((s) => s.selection)
  const focusId = useAppStore((s) => s.focusId)
  return useMemo(() => {
    const ids = targetIds({ selection, focusId })
    const items = ids.flatMap((id) => queue.find((i) => i.id === id) ?? [])
    return { ids, items, drafts: items.flatMap((i) => allDrafts[i.id] ?? []) }
  }, [queue, allDrafts, selection, focusId])
}

function bestScores(items: ReviewItem[]): Candidate[] {
  const best = new Map<string, Candidate>()
  for (const item of items) {
    for (const candidate of item.candidates) {
      const key = nameKey(candidate.tag)
      const current = best.get(key)
      if (!current || candidate.score > current.score) best.set(key, candidate)
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

function CharactersCard({ items, drafts }: { items: ReviewItem[]; drafts: Draft[] }) {
  const names = useAppStore((s) => s.names)
  const known = useAppStore((s) => s.knownCharacters)
  const toggle = useAppStore((s) => s.toggleCharacter)
  const add = useAppStore((s) => s.addCharacter)
  const edit = useAppStore((s) => s.setEditingCharacter)
  const shake = useAppStore((s) => s.shake)

  const candidates = bestScores(items)
  const candidateKeys = new Set(candidates.map((c) => nameKey(c.tag)))
  const count = (raw: string): number => drafts.filter((d) => d.characters.some((c) => nameKey(c) === nameKey(raw))).length
  const typed = [...new Set(drafts.flatMap((d) => d.characters))].filter((raw) => !candidateKeys.has(nameKey(raw)))
  const anyChosen = drafts.some((d) => d.characters.length)
  const strongFrom = useAppStore((s) => s.settings.preselectThreshold)
  const weak = !items.some((i) => i.error) && !candidates.some((c) => !c.filenameOnly && c.score >= strongFrom)
  const failure = items.find((i) => i.error)?.error

  const options: ComboOption[] = known.map((raw) => ({ value: raw, label: displayName(raw, names) }))

  const chip = (raw: string, candidate?: Candidate) => {
    const matched = count(raw)
    const on = matched === drafts.length && matched > 0
    const partial = matched > 0 && !on
    return (
      <motion.div
        layout="position"
        key={nameKey(raw)}
        className={`chip${on ? ' on' : ''}${partial ? ' partial' : ''}`}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 520, damping: 32 }}
      >
        <button className="chip-main" aria-pressed={on} onClick={() => toggle(raw)}>
          <span className="chip-check">{on && <Check size={13} strokeWidth={3} />}</span>
          <span className="chip-name">{displayName(raw, names)}</span>
          {candidate && (
            <small title={candidate.learnedFrom ? `You usually choose this over ${displayName(candidate.learnedFrom, names)}` : undefined}>{candidate.filenameOnly ? 'filename' : candidate.learnedFrom ? 'learned' : `${Math.round(candidate.score * 100)}%`}</small>
          )}
          {partial && <small>{matched}/{drafts.length}</small>}
        </button>
        <button className="chip-edit" aria-label={`Edit ${displayName(raw, names)}`} title="Edit name and series" onClick={() => edit(raw)}>
          <Pencil size={12} />
        </button>
      </motion.div>
    )
  }

  return (
    <motion.section
      key={shake}
      className={`card panel${anyChosen ? ' panel-teal' : ''}`}
      animate={shake ? { x: [0, -7, 6, -4, 3, 0] } : {}}
      transition={{ duration: 0.34 }}
    >
      <h2>
        <UserRound size={15} /> Characters
      </h2>
      {failure && (
        <p className="panel-warning">
          <AlertTriangle size={14} /> {failure}
        </p>
      )}
      {!failure && weak && (
        <p className="panel-warning">
          <AlertTriangle size={14} /> No strong match. Choose or type a character.
        </p>
      )}
      {(candidates.length > 0 || typed.length > 0) && (
        <div className="chips">
          {candidates.map((c) => chip(c.tag, c))}
          {typed.map((raw) => chip(raw))}
        </div>
      )}
      <Combobox
        id="review-character-input"
        ariaLabel="Add a character"
        placeholder="Add a character"
        options={options}
        createLabel={(text) => `Add “${text}”`}
        onPick={add}
      />
    </motion.section>
  )
}

function SetCard({ drafts, items }: { drafts: Draft[]; items: ReviewItem[] }) {
  const sets = useAppStore((s) => s.sets)
  const choose = useAppStore((s) => s.chooseSet)
  const values = new Set(drafts.map((d) => d.setName))
  const value = values.size === 1 ? (drafts[0]?.setName ?? null) : null
  const mixed = values.size > 1
  // Offered only when every selected image points to the same set.
  const suggestions = new Set(items.map((item) => item.suggestedSet))
  const suggestion = suggestions.size === 1 ? items[0]?.suggestedSet : null

  return (
    <section className={`card panel${value ? ' panel-violet' : ''}`}>
      <h2>
        <Layers size={15} /> Set <em>optional</em>
      </h2>
      {value && (
        <motion.div className="set-value" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
          <span>{value}</span>
          <button className="icon-button small" aria-label="Remove set" onClick={() => choose(null)}>
            <X size={14} />
          </button>
        </motion.div>
      )}
      {!value && suggestion && (
        <button className="button compact set-suggestion" title="Use the suggested set" onClick={() => choose(suggestion)}>
          <Sparkles size={14} />
          <span>Suggested: {suggestion}</span>
        </button>
      )}
      {!value && (
        <Combobox
          id="review-set-input"
          ariaLabel="Choose a set"
          placeholder={mixed ? 'Different sets selected' : 'Choose or create a set'}
          options={sets.map((name) => ({ value: name, label: name }))}
          createLabel={(text) => `Create “${text}”`}
          onPick={choose}
        />
      )}
    </section>
  )
}

function FilenameCard({ ids, drafts }: { ids: number[]; drafts: Draft[] }) {
  const queue = useAppStore((s) => s.queue)
  const allDrafts = useAppStore((s) => s.drafts)
  const names = useAppStore((s) => s.names)
  const usedNames = useAppStore((s) => s.usedNames)
  const setCustomName = useAppStore((s) => s.setCustomName)
  const [editing, setEditing] = useState(false)

  const preview = useMemo(
    () => previewNames({ queue, drafts: allDrafts, names, usedNames }, ids),
    [queue, allDrafts, names, usedNames, ids]
  )
  const list = [...preview.values()]
  const batch = ids.length > 1
  const first = list[0] ?? ''
  const custom = drafts[0]?.customName ?? null

  return (
    <section className="card panel">
      <h2>
        Filename
        {!batch && (
          <button className="link-button" onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </h2>
      {editing && !batch ? (
        <div className="filename-edit">
          <input
            className="input"
            aria-label="Filename"
            autoFocus
            maxLength={250}
            spellCheck={false}
            value={custom ?? first}
            onChange={(event) => setCustomName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.stopPropagation()
                setEditing(false)
              }
            }}
          />
          {custom !== null && (
            <button className="icon-button small" aria-label="Use the generated name" title="Use the generated name" onClick={() => setCustomName(null)}>
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={first}
            className="filename"
            title={first}
            initial={{ opacity: 0, filter: 'blur(4px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            {first}
            {batch && list.length > 1 && <small>and {list.length - 1} more, numbered in order</small>}
          </motion.p>
        </AnimatePresence>
      )}
    </section>
  )
}

function PlacementCard({ drafts }: { drafts: Draft[] }) {
  const names = useAppStore((s) => s.names)
  const roots = useAppStore((s) => s.roots)
  const setPlaceInCharacters = useAppStore((s) => s.setPlaceInCharacters)
  const setPlaceInSet = useAppStore((s) => s.setPlaceInSet)

  const summary = useMemo(() => {
    const folders = new Map<string, { label: string; kind: 'character' | 'set'; count: number; action: 'move' | 'copy' }>()
    for (const draft of drafts) {
      const targets = planPlacement({
        characters: draft.characters.map((raw) => displayName(raw, names)),
        setName: draft.setName,
        placeInCharacters: draft.placeInCharacters,
        placeInSet: draft.placeInSet,
        roots
      })
      for (const target of targets) {
        const entry = folders.get(target.directory)
        if (entry) entry.count++
        else folders.set(target.directory, { label: target.label, kind: target.kind, count: 1, action: target.action })
      }
    }
    return [...folders.values()]
  }, [drafts, names, roots])

  const inCharacters = drafts.every((d) => d.placeInCharacters)
  const inSet = drafts.every((d) => d.placeInSet)
  const hasCharacters = drafts.some((d) => d.characters.length)
  const hasSet = drafts.some((d) => d.setName)
  const batch = drafts.length > 1

  const rows = (kind: 'character' | 'set') =>
    summary
      .filter((f) => f.kind === kind)
      .map((f) => (
        <motion.li key={f.label} layout="position" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}>
          <span className="place-path" title={f.label}>
            {f.label}
          </span>
          <small>{batch ? `${f.count} ${f.count === 1 ? 'image' : 'images'}` : f.action === 'move' ? 'Move' : 'Copy'}</small>
        </motion.li>
      ))

  return (
    <section className="card panel">
      <h2>Where it goes</h2>
      <div className="place-row">
        <div className="place-head">
          <span>Character folders</span>
          <Toggle
            checked={inCharacters}
            label="Place in character folders"
            disabled={!hasCharacters}
            onChange={setPlaceInCharacters}
          />
        </div>
        <ul className="place-list">{rows('character')}</ul>
      </div>
      <div className="place-row">
        <div className="place-head">
          <span>Set folder</span>
          <Toggle checked={inSet && hasSet} label="Place in the set folder" disabled={!hasSet} onChange={setPlaceInSet} />
        </div>
        <ul className="place-list">{rows('set')}</ul>
      </div>
      {!summary.length && <p className="place-note">The file stays where it is and is only renamed.</p>}
    </section>
  )
}

/** Applies the last characters and set in one click, for working through similar images. */
function ReuseLast() {
  const last = useAppStore((s) => s.lastChoice)
  const names = useAppStore((s) => s.names)
  const useLast = useAppStore((s) => s.useLastChoice)
  if (!last) return null
  const parts = [...last.characters.map((raw) => displayName(raw, names)), ...(last.setName ? [last.setName] : [])]
  if (!parts.length) return null
  return (
    <button className="button compact reuse-last" title="Use the same characters and set as the last image you applied" onClick={useLast}>
      <History size={14} />
      <span>Use last: {parts.join(', ')}</span>
    </button>
  )
}

export function Inspector() {
  const { items, drafts, ids } = useTargets()
  const apply = useAppStore((s) => s.apply)
  const skip = useAppStore((s) => s.skip)
  const remove = useAppStore((s) => s.remove)
  const count = ids.length

  return (
    <aside className="inspector" aria-label="Review details">
      <div className="inspector-cards">
        <ReuseLast />
        <CharactersCard items={items} drafts={drafts} />
        <SetCard drafts={drafts} items={items} />
        <FilenameCard ids={ids} drafts={drafts} />
        <PlacementCard drafts={drafts} />
      </div>
      <div className="actions">
        <button className="button icon-only danger" aria-label={count > 1 ? `Delete ${count} images` : 'Delete image'} title="Send to the Recycle Bin (Del)" onClick={remove}>
          <Trash2 size={17} />
        </button>
        <button className="button" title="Skip for now (S)" onClick={skip}>
          Skip
        </button>
        <button
          className="button icon-only"
          aria-label={count > 1 ? `Apply ${count} images and add them to the Discord queue` : 'Apply and add to the Discord queue'}
          title="Apply and add to the Discord queue (Shift+Enter)"
          onClick={() => void apply(true)}
        >
          <Send size={17} />
        </button>
        <motion.button className="button primary apply" whileTap={{ scale: 0.97 }} title="Apply (Enter)" onClick={() => void apply()}>
          {count > 1 ? `Apply ${count} images` : 'Apply'}
          <CornerDownLeft size={15} />
        </motion.button>
      </div>
    </aside>
  )
}
