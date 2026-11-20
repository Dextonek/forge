// Installs the built-in providers into FORGE_DATA (use a test folder!) and runs the no-cost handshake test
// on each: initialize + session/new. No prompts are sent. Usage: node scripts/providers-proof.mjs [ids...]
const { BUILTIN, install, testProvider, listProviders } = await import('../server/providers.mjs');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : BUILTIN.filter((p) => p.pkg).map((p) => p.id);
for (const id of ids) {
  console.log(`\n== ${id}`);
  const t0 = Date.now();
  try { const r = await install(id, () => {}); console.log(`   installed ${r.version} in ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
  catch (e) { console.log('   install FAILED:', e.message); continue; }
  const r = await testProvider(id);
  console.log('   test:', JSON.stringify(r, null, 1).replace(/\n/g, '\n   '));
}
console.log('\nsummary:', listProviders().map((p) => `${p.id}: ${p.installed ? 'installed ' + (p.version ?? '') : 'not installed'} · ${p.test?.state ?? 'not tested'}`).join(' | '));
