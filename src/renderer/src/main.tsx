import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { OverlayApp } from './OverlayApp'
import { OverlayDetailApp } from './OverlayDetailApp'
import './styles.css'

const mode = new URLSearchParams(window.location.search).get('mode')
if (mode === 'overlay' || mode === 'overlay-detail') {
  document.body.classList.add('overlay-body')
}
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  mode === 'overlay' ? (
    <OverlayApp />
  ) : mode === 'overlay-detail' ? (
    <OverlayDetailApp />
  ) : (
    <App />
  )
)
