import { render } from 'preact'
import { registerSW } from 'virtual:pwa-register'
import { App } from './ui/App.tsx'
import './ui/app.css'

const root = document.getElementById('app')
if (root) render(<App />, root)

/*
 * Register the service worker through the plugin's own entry point, which
 * resolves the base path for a GitHub Pages project site and gives us the
 * update hook. Precache-all: the app must work in a basement gym with no
 * signal.
 *
 * A failed registration is not fatal. The app runs entirely from IndexedDB
 * and is fully usable online without it, so a browser that refuses to
 * register -- or a context that disallows workers -- must not break the
 * page.
 */
const updateSW = registerSW({
  immediate: true,
  onRegisterError(error: unknown) {
    console.warn('Service worker did not register; offline use is unavailable.', error)
  },
  onNeedRefresh() {
    // A new version is precached. Take it on the next deliberate reload
    // rather than interrupting a log that is in progress.
    window.addEventListener('pagehide', () => void updateSW(true), { once: true })
  },
})
