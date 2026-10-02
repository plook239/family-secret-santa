import assert from 'assert';
import { promises as fs } from 'fs';
import path from 'path';
import { preparePages, frontendFiles, validatePublicConfig } from '../scripts/prepare-pages.mjs';
const publicSettings = { mode: 'supabase', supabaseUrl: 'https://example.supabase.co', publicKey: 'sb_publishable_public-test-value' };
validatePublicConfig(publicSettings);
const legacy = role => 'header.' + Buffer.from(JSON.stringify({ role })).toString('base64') + '.signature';
validatePublicConfig({ ...publicSettings, publicKey: legacy('anon') });
for (const settings of [
  { ...publicSettings, mode: 'demo' },
  { ...publicSettings, supabaseUrl: 'http://127.0.0.1:54321' },
  { ...publicSettings, supabaseUrl: 'https://example.supabase.co/functions/v1' },
  { ...publicSettings, publicKey: 'sb_secret_do-not-publish' },
  { ...publicSettings, publicKey: legacy('service_role') }
]) assert.throws(() => validatePublicConfig(settings));
console.log('PASS: production config accepts public keys and rejects demo, local URLs, endpoint suffixes and privileged keys.');
const result = await preparePages('.browser-test/pages-root/family-secret-santa');
assert.strictEqual(result.files, frontendFiles.length + 1);
for (const file of frontendFiles) assert.ok((await fs.stat(path.join(result.destination, file))).isFile());
for (const directory of ['supabase', 'tests', 'node_modules', 'scripts']) {
  await assert.rejects(fs.stat(path.join(result.destination, directory)), { code: 'ENOENT' });
}
assert.ok(!frontendFiles.includes('js/demo-service.js'));
assert.ok(!frontendFiles.includes('js/assignment.js'));
await assert.rejects(preparePages('../outside-repository'));
console.log(`PASS: ${result.checked} relative HTML/CSS/module references stay within /family-secret-santa/.`);
console.log(`PASS: ${result.files}-file artifact excludes backend, tests, dependencies and demo modules.`);
