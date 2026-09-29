import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { roomFolder } from './scripts/room-folder.ts'

// https://vite.dev/config/
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'src-tauri/**'] },
  // the browser build saves rooms to ~/Documents/Room Planner too (see scripts/room-folder.ts)
  plugins: [react(), roomFolder()],
  // Tauri prints its own output; keep Vite from wiping it.
  clearScreen: false,
  // Tauri expects the dev server on a fixed port (see src-tauri/tauri.conf.json build.devUrl).
  server: { port: 5173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // WKWebView on macOS 12; matches bundle.macOS.minimumSystemVersion.
  build: { target: 'safari13' },
})
