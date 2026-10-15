/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Worker origin serving /api/r2 when the site is hosted statically (GitHub Pages). */
  readonly VITE_API_BASE?: string
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_DATABASE_URL: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_STORAGE_BUCKET: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string
  readonly VITE_FIREBASE_APP_ID: string
  readonly VITE_CLOUDINARY_CLOUD_NAME: string
  readonly VITE_CLOUDINARY_UPLOAD_PRESET: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
