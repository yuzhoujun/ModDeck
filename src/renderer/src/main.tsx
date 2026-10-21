import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { OverlayApp } from './OverlayApp'
import './styles.css'

const mode = new URLSearchParams(window.location.search).get('mode')
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  mode === 'overlay' ? <OverlayApp /> : <App />
)
