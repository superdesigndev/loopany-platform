import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'

// Dev-only local env: this config runs in the dev server's node process, so vars
// loaded here reach the server functions via process.env (Vite never injects
// non-VITE_ vars into process.env on its own). Use it to point LOOPANY_CLI at the
// in-repo daemon so the New-loop paste tells Claude Code to run your local code
// instead of the published `npx @crewlet/loopany@latest`. Prod ignores it (the
// file isn't shipped). `.env.local` overrides `.env`; both are optional.
for (const f of ['.env', '.env.local']) {
  try {
    process.loadEnvFile(f)
  } catch {
    /* file absent — fine */
  }
}

export default defineConfig({
  // Bind IPv4 127.0.0.1 (not the default IPv6 `localhost`) so the daemon + curl
  // reach the dev server at 127.0.0.1 consistently.
  server: { host: '127.0.0.1', port: Number(process.env.LOOPANY_PORT) || 3000, strictPort: !!process.env.LOOPANY_PORT },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // Nitro builds the production server (default node-server preset → a
    // listening `.output/server/index.mjs`, started by `pnpm start`).
    nitro(),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
})
