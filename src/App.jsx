import { Routes, Route } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Navbar from './components/Navbar'
import Home from './pages/Home'
import Events from './pages/Events'
import EventDetail from './pages/EventDetail'
import Teams from './pages/Teams'
import Rankings from './pages/Rankings'
import CredentialsModal from './components/CredentialsModal'
import { useEpaData } from './hooks/useEpaData'
import styles from './App.module.css'

export default function App() {
  const epa = useEpaData()
  const [showCreds, setShowCreds] = useState(false)

  useEffect(() => {
    epa.load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleCredentialsSaved() {
    setShowCreds(false)
    epa.setNeedsCredentials(false)
    epa.load()
  }

  return (
    <div className={styles.app}>
      <Navbar
        onCredentials={() => setShowCreds(true)}
        epaLoaded={!!epa.state?.loaded}
        onRefresh={() => epa.load(true)}
      />

      {/* Loading banner */}
      {epa.loading && (
        <div className={styles.loadBanner}>
          <div className={styles.loadBar} style={{ width: `${epa.progress}%` }} />
          <span className={styles.loadMsg}>{epa.message}</span>
        </div>
      )}

      {/* Credentials needed banner */}
      {epa.needsCredentials && !showCreds && !epa.state?.loaded && (
        <div className={styles.credsBanner}>
          <span>FTC API credentials needed to load data.</span>
          <button className={styles.credsBtn} onClick={() => setShowCreds(true)}>
            Set Credentials →
          </button>
        </div>
      )}

      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<Home epa={epa} onSetCredentials={() => setShowCreds(true)} />} />
          <Route path="/rankings" element={<Rankings epa={epa} />} />
          <Route path="/events" element={<Events />} />
          <Route path="/events/:eventCode" element={<EventDetail epa={epa} />} />
          <Route path="/teams" element={<Teams epa={epa} />} />
        </Routes>
      </main>

      {(showCreds || epa.needsCredentials) && (
        <CredentialsModal
          onSave={handleCredentialsSaved}
          onClose={showCreds ? () => setShowCreds(false) : undefined}
        />
      )}
    </div>
  )
}
