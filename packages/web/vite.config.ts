import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' lets the built site live under any sub-path as static files.
export default defineConfig({
  base: './',
  plugins: [react()],
});
