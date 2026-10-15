#!/usr/bin/env node
/*
 * After `vite build`: copies dist/index.html to console.html / surface.html / studio.html.
 *
 * iOS "Add to Home Screen" reopens the manifest's start_url and only trusts the manifest link that
 * is in the page's HTML (not one swapped by script), so each role gets its own page with its own
 * manifest. Each page selects its role itself when opened without ?role=…
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const roles = { console: '控台', surface: '控制面板', studio: 'Studio' }

for (const [role, label] of Object.entries(roles)) {
  let out = html.replace(/manifest\.webmanifest/, `manifest-${role}.webmanifest`).replace(/(name="apple-mobile-web-app-title" content=")[^"]*/, `$1Cue ${label}`)
  if (out === html) throw new Error(`index.html has no manifest link to specialise for ${role}`)
  const pick = `<script>if(!new URLSearchParams(location.search).get('role'))history.replaceState(null,'','?role=${role}'+location.hash)</script>`
  out = out.replace('<head>', `<head>\n    ${pick}`)
  writeFileSync(join(dist, `${role}.html`), out)
  console.log(`✓ dist/${role}.html`)
}
