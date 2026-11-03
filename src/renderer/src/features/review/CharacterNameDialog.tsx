import { useEffect, useState, type FormEvent } from 'react'
import { displayName, nameKey, seriesLabel } from '../../../../shared/naming'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'

export function CharacterNameDialog() {
  const raw = useAppStore((s) => s.editingCharacter)
  const names = useAppStore((s) => s.names)
  const close = useAppStore((s) => s.setEditingCharacter)
  const save = useAppStore((s) => s.saveCharacterName)
  const [name, setName] = useState('')
  const [series, setSeries] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (raw) {
      setName(displayName(raw, names))
      setSeries(seriesLabel(raw, names))
      setError(null)
      setSaving(false)
    }
  }, [raw, names])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!raw || !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await save(raw, name, series)
    } catch (failure) {
      setError(errorMessage(failure))
      setSaving(false)
    }
  }

  const renaming = raw !== null && nameKey(name) !== nameKey(displayName(raw, names))

  return (
    <Dialog open={raw !== null} title="Edit character" onClose={() => close(null)}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input className="input" autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Series
          <input className="input" maxLength={120} value={series} onChange={(event) => setSeries(event.target.value)} />
        </label>
        <p className="form-note">
          {renaming
            ? 'Their folder, tags, and Discord thread link move to the new name. Filenames already on disk stay as they are.'
            : 'Used in new filenames. Filenames already on disk stay as they are.'}
        </p>
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving || !name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
