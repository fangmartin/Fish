/// <reference types="vite/client" />

import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import styles from './styles.css?inline'

declare global {
  interface Window {
    __FISH_APP_MOUNTED__?: boolean
  }
}

function MountedApp() {
  useLayoutEffect(() => { window.__FISH_APP_MOUNTED__ = true }, [])
  return <App />
}

// Load the aquarium stylesheet after the HTML splash can paint.
const stylesheet = document.createElement('style')
stylesheet.textContent = styles
document.head.append(stylesheet)
createRoot(document.getElementById('root')!).render(<MountedApp />)
