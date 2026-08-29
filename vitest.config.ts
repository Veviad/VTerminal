import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Vite replaces these in production. Settings tests render the same components
  // without going through vite.config.ts, so give them stable test values instead
  // of leaking a ReferenceError from the About/Updates UI.
  define: {
    __APP_VERSION__: JSON.stringify('test-version'),
    __BUILD_NUMBER__: JSON.stringify('test-build'),
    __GIT_HASH__: JSON.stringify('test-hash'),
    __APP_AUTHOR__: JSON.stringify('Test Author'),
    __APP_LICENSE__: JSON.stringify('GPL-3.0-only'),
    __APP_PUBLISHER__: JSON.stringify('Test Publisher'),
    __APP_COPYRIGHT__: JSON.stringify('Copyright © 2026 Test Publisher'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
