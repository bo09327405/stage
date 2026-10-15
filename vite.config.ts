import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { cloudinaryProxy } from './server/cloudinaryProxy.ts'
import { notionProxy } from './server/notionProxy.ts'
import { r2Proxy } from './server/r2Proxy.ts'
import { ttsProxy } from './server/ttsProxy.ts'

/** Server-only secrets in the project folder: never served to the browser (dev / preview / ngrok). */
const SECRET_FILES = ['google-credentials.json']

/** Refuses any request that names a secret file, whatever the path form (/x, /@fs/…, ?raw, ?import). */
function blockSecrets(): Plugin {
  const blocked = (url = '') => {
    let path = url
    try {
      path = decodeURIComponent(url)
    } catch {
      // keep the raw url
    }
    return SECRET_FILES.some((f) => path.toLowerCase().includes(f.toLowerCase()))
  }
  // Must return nothing: a function returned from configureServer is run as a post-hook.
  const mount = (server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; end: () => void }, next: () => void) => void) => unknown } }) => {
    server.middlewares.use((req, res, next) => {
      if (!blocked(req.url)) return next()
      res.statusCode = 404
      res.end()
    })
  }
  return { name: 'block-secrets', enforce: 'pre', configureServer: mount, configurePreviewServer: mount }
}

// https://vite.dev/config/
/** One id per build: baked into the bundle and written to version.json, so a running page can tell it is stale. */
const BUILD_ID = Date.now().toString(36)
const emitVersion = (): Plugin => ({
  name: 'emit-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: BUILD_ID }) })
  },
})

export default defineConfig(({ mode, command }) => {
  // All .env values, for server-side plugins only. Only VITE_* ones ever reach the browser bundle;
  // CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET and the R2_* keys stay on the dev server.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    // GitHub Pages serves the build from /stage/; dev keeps /.
    base: command === 'build' ? '/stage/' : '/',
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    plugins: [
      blockSecrets(),
      emitVersion(),
      react(),
      tailwindcss(),
      notionProxy(),
      ttsProxy({ engine: env.TTS_ENGINE, root: process.cwd(), azureKey: env.AZURE_SPEECH_KEY, azureRegion: env.AZURE_SPEECH_REGION, edgeVersion: env.EDGE_TTS_VERSION }),
      r2Proxy({
        endpoint: env.R2_ENDPOINT,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        cloudinaryCloud: env.VITE_CLOUDINARY_CLOUD_NAME,
        publicBaseUrl: env.R2_PUBLIC_BASE_URL,
        databaseUrl: env.VITE_FIREBASE_DATABASE_URL,
      }),
      cloudinaryProxy({
        cloudName: env.VITE_CLOUDINARY_CLOUD_NAME,
        apiKey: env.CLOUDINARY_API_KEY,
        apiSecret: env.CLOUDINARY_API_SECRET,
      }),
    ],
    server: {
      // Self-signed LAN cert (.cert/) so iPad Safari gets a secure context for the microphone.
      https: existsSync('.cert/key.pem') ? { key: readFileSync('.cert/key.pem'), cert: readFileSync('.cert/cert.pem') } : undefined,
      // Allow ngrok tunnel hostnames (e.g. `npx ngrok http 5173`); Vite blocks unknown hosts by default.
      allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io', '.trycloudflare.com', '.nip.io'],
      // The local TTS model (~215 MB, `npm run tts:setup`) never changes while developing.
      watch: { ignored: ['**/tts-models/**'] },
      // Vite's defaults plus the server-only credentials (also blocked by blockSecrets()).
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...SECRET_FILES.map((f) => `**/${f}`)] },
    },
  }
})
