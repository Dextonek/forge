import { routeMessage as r } from '../server/router.mjs';
for (const t of ['change the cube speed to 2','make the player jump height bigger','rename Enemy to Foe','add a pause menu with resume and quit','refactor the physics into a fixed timestep system','why does the cube flicker on resize?','where is the camera set up']) console.log(r(t).tier.padEnd(9), t, '|', r(t).reason);
console.log(r('add a log', {lastTier:'deep', lastContextTokens: 60000}));

