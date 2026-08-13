import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Vite replaces these in production. Settings tests render the same components
  // without going through vite.config.ts, so give the one they exercise a stable
  // test value instead of leaking a ReferenceError from the About/Updates UI.
  define: {
    __APP_VERSION__: JSON.stringify('test-version'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
