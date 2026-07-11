import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, '..');
const requireUrl = process.argv.includes('--require-url');
const apiBaseUrl = String(process.env.VACAPAY_API_BASE_URL || '').trim().replace(/\/$/, '');

if (requireUrl && !/^https:\/\//i.test(apiBaseUrl)) {
  throw new Error('VACAPAY_API_BASE_URL is required and must start with https://');
}

const resolvedApiUrl = apiBaseUrl || '/api';
const mediaBaseUrl = String(process.env.VACAPAY_MEDIA_BASE_URL || '').trim().replace(/\/$/, '')
  || resolvedApiUrl.replace(/\/api$/, '');
const outputDir = path.join(frontendDir, 'generated');
const outputPath = path.join(outputDir, 'runtime-config.js');
const content = `window.VACAPAY_CONFIG = ${JSON.stringify({
  apiBaseUrl: resolvedApiUrl,
  mediaBaseUrl
}, null, 2)};\n`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, content, 'utf8');
console.log(`Runtime API configured for ${resolvedApiUrl}`);
