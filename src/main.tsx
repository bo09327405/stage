import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './services/apiBase'
import { installHaptics } from './utils/haptics'
import { startUpdateCheck } from './utils/updateCheck'
import App from './App.tsx'

installHaptics()
startUpdateCheck()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
