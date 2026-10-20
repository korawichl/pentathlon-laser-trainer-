import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: './', // Ensures assets load properly on GitHub Pages (https://<user>.github.io/<repo>/)
  plugins: [
    basicSsl() // Required for DeviceOrientationEvent on iOS & mobile browsers!
  ],
  server: {
    host: true, // Listen on all IP addresses so phones on the same Wi-Fi can open it
    port: 5173,
    https: true
  }
});
