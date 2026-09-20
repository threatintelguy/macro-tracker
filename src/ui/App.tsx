/**
 * App shell.
 *
 * Three tabs, hash-routed. Resisting a fourth is a design goal, and no
 * router library is needed for three.
 */

import { useEffect } from 'preact/hooks'
import * as store from './store.ts'
import { Today } from './screens/Today.tsx'
import { Log } from './screens/Log.tsx'
import { Settings } from './screens/Settings.tsx'
import { Onboarding } from './screens/Onboarding.tsx'

export function App() {
  useEffect(() => {
    void store.boot()
    store.tab.value = store.tabFromHash()
    const onHash = (): void => {
      store.tab.value = store.tabFromHash()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Theme follows the stored profile; dark is the default.
  useEffect(() => {
    document.documentElement.dataset['theme'] = store.profile.value?.theme ?? 'dark'
  }, [store.profile.value?.theme])

  if (!store.ready.value) {
    return <div class="screen">Loading…</div>
  }

  if (!store.profile.value) {
    return <Onboarding />
  }

  const tab = store.tab.value

  return (
    <>
      {tab === 'today' && <Today />}
      {tab === 'log' && <Log />}
      {tab === 'settings' && <Settings />}

      {store.toast.value && <div class="toast">{store.toast.value}</div>}

      <nav class="tabbar">
        {(
          [
            ['today', 'Today'],
            ['log', 'Log'],
            ['settings', 'Settings'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => store.setTab(id)}
          >
            <span class="dot" />
            {label}
          </button>
        ))}
      </nav>
    </>
  )
}
