import { getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app'
import { getDatabase } from 'firebase/database'

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const missing = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key)
if (missing.length > 0) {
  throw new Error(`Firebase 設定缺少環境變數：${missing.join(', ')}（請檢查 .env.local）`)
}

// Reuse the existing app during Vite HMR instead of initializing twice.
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)
export const db = getDatabase(app)
