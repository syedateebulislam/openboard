import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { localApiPlugin } from './vite.local-api'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), localApiPlugin(env)],
  }
})
