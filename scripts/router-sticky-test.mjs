import { routeMessage as r } from '../server/router.mjs';
const cases = [['rename Enemy to Foe','deep',60000],['rename Enemy to Foe','standard',60000],['add a pause menu','deep',60000],['add a pause menu','deep',8000],['refactor the physics','quick',60000]];
for (const [t, last, ctx] of cases) { const x = r(t, { lastTier: last, lastContextTokens: ctx }); console.log(`${last.padEnd(8)} ${String(ctx).padStart(6)} "${t}" -> ${x.tier} (${x.reason})`); }
