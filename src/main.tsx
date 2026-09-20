import { render } from 'preact'
import { App } from './ui/App.tsx'
import './ui/app.css'

const root = document.getElementById('app')
if (root) render(<App />, root)

// Register the service worker. Precache-all: the app must work in a
// basement gym with no signal.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}sw.js`,
      { scope: import.meta.env.BASE_URL },
    )
  })
}
