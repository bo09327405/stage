import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './services/apiBase'
import { installHaptics } from './utils/haptics'
import App from './App.tsx'

installHaptics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
