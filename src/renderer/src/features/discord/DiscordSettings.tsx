import { useEffect, useState, type FormEvent } from 'react'
import type { ChannelOption } from '../../../../shared/api'
import { errorMessage } from '../../errors'
import { useAppStore } from '../../store'
import { useDiscordStore } from './discordStore'

function ChannelField({ label, value, channels, onChange }: { label: string; value: string; channels: ChannelOption[]; onChange(value: string): void }) {
  return (
    <label>
      {label}
      {channels.length ? (
        <select className="select field-select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose a channel</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
              {channel.type === 15 ? ' (forum)' : channel.type === 16 ? ' (media)' : ''}
            </option>
          ))}
        </select>
      ) : (
        <input className="input" inputMode="numeric" spellCheck={false} placeholder="Channel ID" value={value} onChange={(event) => onChange(event.target.value.trim())} />
      )}
    </label>
  )
}

export function DiscordSettings() {
  const status = useDiscordStore((s) => s.status)
  const refreshStatus = useDiscordStore((s) => s.refreshStatus)
  const notify = useAppStore((s) => s.notify)
  const [token, setToken] = useState('')
  const [guildId, setGuildId] = useState('')
  const [characters, setCharacters] = useState('')
  const [sets, setSets] = useState('')
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const fillFrom = (next: typeof status): void => {
    if (!next) return
    setGuildId(next.config.guildId)
    setCharacters(next.config.parents.characters)
    setSets(next.config.parents.sets)
  }

  const loadChannels = async (connected: boolean, guild: string): Promise<void> => {
    setChannels(connected && guild ? await window.thumbGrove.getDiscordChannels().catch(() => []) : [])
  }

  useEffect(() => {
    if (!status) return
    fillFrom(status)
    void loadChannels(status.connected, status.config.guildId)
    // Fills the form when the page opens, without overwriting what's typed later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status === null])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const next = await window.thumbGrove.saveDiscord({ token, config: { guildId, parents: { characters, sets } } })
      setToken('')
      await refreshStatus()
      await loadChannels(next.connected, guildId)
      if (next.error) setError(next.error)
      else if (next.connected) notify(`Connected as ${next.username}`)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  const forget = async (): Promise<void> => {
    await window.thumbGrove.forgetDiscordToken()
    await refreshStatus()
    setChannels([])
  }

  return (
    <>
      <form className="name-form setting-form" onSubmit={(event) => void save(event)}>
        <label>
          Bot token
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.hasToken ? 'Saved. Paste a new one to replace it.' : 'Paste your bot token'}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label>
          Server ID
          <input className="input" inputMode="numeric" spellCheck={false} value={guildId} onChange={(event) => setGuildId(event.target.value.trim())} />
        </label>
        <ChannelField label="Character threads channel" value={characters} channels={channels} onChange={setCharacters} />
        <ChannelField label="Set threads channel" value={sets} channels={channels} onChange={setSets} />
        <p className="form-note">The token is encrypted on this computer and only used to talk to Discord.</p>
        {status?.connected && <p className="connected-note">Connected as {status.username}</p>}
        {error && <p className="panel-warning model-error">{error}</p>}
        <div className="form-actions">
          {status?.hasToken && (
            <button type="button" className="button ghost form-action-left" onClick={() => void forget()}>
              Forget token
            </button>
          )}
          <button type="submit" className="button primary" disabled={saving || !guildId}>
            {saving ? 'Checking…' : 'Save and connect'}
          </button>
        </div>
      </form>
    </>
  )
}
