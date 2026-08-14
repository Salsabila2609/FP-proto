import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Cookie sesi httpOnly ikut terkirim karena API diproksi lewat origin yang sama.
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
});
