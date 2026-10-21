import fs from 'fs';
import { execSync } from 'child_process';

console.log('📦 Starting build pipeline...');

// 1. Ensure index.html references source main.ts, style.css, and root icons
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/i, '<script type="module" src="/src/main.ts"></script>');
html = html.replace(/<link rel="stylesheet"[^>]*href="[^"]+"[^>]*>/i, '<link rel="stylesheet" href="/src/style.css">');
html = html.replace(/href="[^"]*icon-192[^"]*"/i, 'href="./icon-192.png"');
html = html.replace(/href="[^"]*apple-touch-icon[^"]*"/i, 'href="./apple-touch-icon.png"');
html = html.replace(/href="[^"]*manifest[^"]*"/i, 'href="./manifest.json"');
fs.writeFileSync('index.html', html, 'utf8');

// 2. Clean dist directory
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true, force: true });
}

// 3. Run Typecheck and Vite build
console.log('🔍 Checking types and bundling with Vite...');
execSync('npx tsc --noEmit && npx vite build', { stdio: 'inherit' });

// 4. Sync dist assets to root assets for static deployment compatibility
console.log('🔄 Syncing dist assets to root...');
fs.copyFileSync('dist/index.html', 'index.html');
if (fs.existsSync('dist/assets')) {
  if (fs.existsSync('assets')) {
    fs.rmSync('assets', { recursive: true, force: true });
  }
  fs.mkdirSync('assets', { recursive: true });
  fs.readdirSync('dist/assets').forEach(f => {
    fs.copyFileSync(`dist/assets/${f}`, `assets/${f}`);
  });
}

console.log('✅ Build and sync finished successfully!');
