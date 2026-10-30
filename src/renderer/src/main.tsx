import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { OverlayApp } from './OverlayApp'
import { OverlayDetailApp } from './OverlayDetailApp'
import { I18nProvider } from './i18n'
import './styles.css'

const mode = new URLSearchParams(window.location.search).get('mode')
if (mode === 'overlay' || mode === 'overlay-detail') {
  document.body.classList.add('overlay-body')
}
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <I18nProvider>
    {mode === 'overlay' ? (
      <OverlayApp />
    ) : mode === 'overlay-detail' ? (
      <OverlayDetailApp />
    ) : (
      <App />
    )}
  </I18nProvider>
)
