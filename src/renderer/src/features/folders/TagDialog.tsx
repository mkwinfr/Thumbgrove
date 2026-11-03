import { useEffect, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { Combobox } from '../../components/Combobox'
import { Dialog } from '../../components/Dialog'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useLibraryStore } from './libraryStore'

/** Edits one image's tags, or adds tags to several images or a whole folder. */
export function TagDialog() {
  const target = useLibraryStore((s) => s.tagTarget)
  const close = useLibraryStore((s) => s.setTagTarget)
  const notify = useAppStore((s) => s.notify)
  const [tags, setTags] = useState<string[]>([])
  const [known, setKnown] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const singleId = target?.kind === 'images' && target.ids.length === 1 ? target.ids[0]! : null

  useEffect(() => {
    if (!target) return
    setTags([])
    setError(null)
    setSaving(false)
    void window.thumbGrove.getAllTags().then(setKnown)
    if (singleId !== null) void window.thumbGrove.getImageTags(singleId).then(setTags)
  }, [target, singleId])

  const add = (tag: string): void => {
    const clean = tag.trim()
    if (clean) setTags((current) => (current.some((t) => t.toLowerCase() === clean.toLowerCase()) ? current : [...current, clean]))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!target) return
    setSaving(true)
    setError(null)
    try {
      if (singleId !== null) {
        await window.thumbGrove.setImageTags(singleId, tags)
        notify('Tags saved')
      } else {
        const added = target.kind === 'folder' ? await window.thumbGrove.addFolderTags(target.folder.id, tags) : await window.thumbGrove.addImageTags(target.ids, tags)
        notify(added ? 'Tags added' : 'These images already had those tags')
      }
      close(null)
    } catch (failure) {
      setError(errorMessage(failure))
      setSaving(false)
    }
  }

  const title = singleId !== null ? 'Edit tags' : target?.kind === 'folder' ? `Add tags to ${target.folder.name}` : `Add tags to ${target?.ids.length ?? 0} images`
  const note =
    target?.kind === 'folder'
      ? `Added to all ${target.folder.totalCount.toLocaleString()} images in this folder and its subfolders. Images keep the tags they already have.`
      : singleId === null
        ? 'Images keep the tags they already have.'
        : 'Tags can be searched from Folders. Characters and sets are added automatically when you apply a review.'

  return (
    <Dialog open={target !== null} title={title} onClose={() => close(null)}>
      <form className="name-form" onSubmit={(event) => void submit(event)}>
        {tags.length > 0 && (
          <div className="tag-list">
            {tags.map((tag) => (
              <span key={tag.toLowerCase()} className="tag">
                {tag}
                <button type="button" aria-label={`Remove ${tag}`} onClick={() => setTags((current) => current.filter((t) => t !== tag))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <Combobox
          id="tag-input"
          ariaLabel="Add a tag"
          placeholder="Add a tag"
          options={known.filter((tag) => !tags.some((t) => t.toLowerCase() === tag.toLowerCase())).map((tag) => ({ value: tag, label: tag }))}
          createLabel={(text) => `Add “${text}”`}
          onPick={add}
        />
        <p className="form-note">{note}</p>
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving || (singleId === null && !tags.length)}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
