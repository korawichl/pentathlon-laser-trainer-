import fs from 'fs';
import { execSync } from 'child_process';

console.log('📦 Starting build pipeline...');

// 1. Ensure index.html references source main.ts and style.css for Vite bundling
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/i, '<script type="module" src="/src/main.ts"></script>');
html = html.replace(/<link rel="stylesheet"[^>]*href="[^"]+"[^>]*>/i, '<link rel="stylesheet" href="/src/style.css">');
fs.writeFileSync('index.html', html, 'utf8');

// 2. Run Typecheck and Vite build
console.log('🔍 Checking types and bundling with Vite...');
execSync('npx tsc --noEmit && npx vite build', { stdio: 'inherit' });

// 3. Sync dist assets to root assets for static deployment compatibility
console.log('🔄 Syncing dist assets to root...');
fs.copyFileSync('dist/index.html', 'index.html');
if (fs.existsSync('dist/assets')) {
  if (!fs.existsSync('assets')) {
    fs.mkdirSync('assets', { recursive: true });
  }
  fs.readdirSync('dist/assets').forEach(f => {
    fs.copyFileSync(`dist/assets/${f}`, `assets/${f}`);
  });
}

console.log('✅ Build and sync finished successfully!');
