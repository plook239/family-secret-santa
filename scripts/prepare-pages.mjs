// Validate and copy unchanged static files. No bundling or frontend build step.
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { config } from '../js/config.js';

export const frontendFiles = Object.freeze([
  'index.html', 'admin.html', 'reveal.html', 'css/styles.css',
  'js/config.js', 'js/common.js', 'js/service.js', 'js/supabase-service.js',
  'js/join.js', 'js/admin.js', 'js/reveal.js'
]);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validatePublicConfig(settings) {
  if (settings.mode !== 'supabase') throw new Error('GitHub Pages requires mode: supabase.');
  let url;
  try { url = new URL(settings.supabaseUrl); } catch { throw new Error('Set the hosted Supabase project URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Use the hosted HTTPS Supabase project root URL.');
  }
  if (typeof settings.publicKey !== 'string' || !settings.publicKey || settings.publicKey.startsWith('sb_secret_')) throw new Error('Only a publishable or anon key may be published.');
  if (!settings.publicKey.startsWith('sb_publishable_')) {
    try {
      const payload = JSON.parse(Buffer.from(settings.publicKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.role !== 'anon') throw new Error();
    } catch { throw new Error('Only a publishable or legacy anon key may be published, never service_role.'); }
  }
}

export async function checkFrontendPaths(root = projectRoot) {
  const files = new Set(frontendFiles);
  const base = 'https://pages-example.github.io/family-secret-santa/';
  let checked = 0;
  function reference(source, value) {
    if (value.startsWith('#')) return;
    if (/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)) throw new Error(`Use a relative frontend path in ${source}: ${value}`);
    const sourceURL = new URL(source, base);
    const resolved = new URL(value, sourceURL);
    const destination = decodeURIComponent(resolved.pathname).slice('/family-secret-santa/'.length);
    if (!resolved.pathname.startsWith('/family-secret-santa/') || !files.has(destination)) throw new Error(`Unpublished or escaped frontend dependency in ${source}: ${value}`);
    checked++;
  }
  for (const file of frontendFiles) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    if (file.endsWith('.html')) {
      for (const match of source.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/g)) reference(file, match[2]);
    } else if (file.endsWith('.js')) {
      for (const match of source.matchAll(/\b(?:from\s+|import\s+)["']([^"']+)["']/g)) reference(file, match[1]);
      if (/\b(?:fetch|replace|assign)\s*\(\s*['"]\//.test(source)) throw new Error(`Root-relative request/navigation in ${file}.`);
      // The dynamic demo import in service.js is intentionally excluded: localhost only.
    } else if (file.endsWith('.css')) {
      for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) reference(file, match[1]);
    }
  }
  return checked;
}

async function existingFiles(directory, prefix = '') {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Pages artifact must not contain symbolic links.');
    if (entry.isDirectory()) result.push(...await existingFiles(path.join(directory, entry.name), relative + '/'));
    else result.push(relative);
  }
  return result;
}

export async function preparePages(output = 'site') {
  validatePublicConfig(config);
  const checked = await checkFrontendPaths();
  const destination = path.resolve(projectRoot, output);
  const relative = path.relative(projectRoot, destination);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Artifact directory must be inside the repository.');
  const allowed = new Set([...frontendFiles, '.nojekyll']);
  for (const file of await existingFiles(destination)) {
    if (!allowed.has(file)) throw new Error(`Unexpected existing artifact file: ${file}. Use a fresh output directory.`);
  }
  for (const file of frontendFiles) {
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(projectRoot, file), target);
  }
  await fs.writeFile(path.join(destination, '.nojekyll'), '');
  await checkFrontendPaths(destination);
  return { destination, checked, files: allowed.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await preparePages(process.argv[2]);
  console.log(`Prepared ${result.files} static files; ${result.checked} relative asset/module references passed repository-subpath checks.`);
}
