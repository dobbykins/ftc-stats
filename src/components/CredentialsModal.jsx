import { useState } from 'react'
import { saveCredentials, getCredentials } from '../api/ftc'
import styles from './CredentialsModal.module.css'

export default function CredentialsModal({ onSave, onClose }) {
  const existing = getCredentials()
  const [user, setUser] = useState(existing.user)
  const [key, setKey]   = useState(existing.key)

  function handleSave() {
    if (!user.trim() || !key.trim()) return
    saveCredentials(user, key)
    onSave?.()
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>FTC Events API Credentials</div>
        <p className={styles.desc}>
          Get your API key from{' '}
          <a href="https://ftc-events.firstinspires.org" target="_blank" rel="noreferrer">
            ftc-events.firstinspires.org
          </a>{' '}
          → Account → API Key.
        </p>

        <label className={styles.label}>Username</label>
        <input
          className={styles.input}
          value={user}
          onChange={e => setUser(e.target.value)}
          placeholder="your FIRST username"
          autoComplete="username"
        />

        <label className={styles.label}>API Key</label>
        <input
          className={styles.input}
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="your API key"
          autoComplete="current-password"
          onKeyDown={e => e.key === 'Enter' && handleSave()}
        />

        <div className={styles.note}>
          Credentials are stored locally in your browser and sent only to your proxy worker.
        </div>

        <div className={styles.actions}>
          {onClose && <button className={styles.cancel} onClick={onClose}>Cancel</button>}
          <button className={styles.save} onClick={handleSave} disabled={!user || !key}>
            Save & Connect
          </button>
        </div>
      </div>
    </div>
  )
}
