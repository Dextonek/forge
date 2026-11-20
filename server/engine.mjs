// Engine detection by marker files, plus short engine-specific guidance for the agent.
import fs from 'node:fs';
import path from 'node:path';

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };

export function detectEngine(root) {
  if (exists(root, 'project.godot')) return 'godot';
  if (exists(root, 'ProjectSettings/ProjectVersion.txt')) return 'unity';
  if (fs.readdirSync(root).some((f) => f.endsWith('.uproject'))) return 'unreal';
  const pkg = read(root, 'package.json');
  const html = fs.readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => read(root, f)).join('\n');
  const js = fs.readdirSync(root).filter((f) => /\.(m?js|ts)$/.test(f)).slice(0, 20).map((f) => read(root, f)).join('\n');
  const all = pkg + html + js;
  if (/phaser/i.test(all)) return 'phaser';
  if (/pixi(\.js)?/i.test(all)) return 'pixi';
  if (/three(\.module)?(\.min)?\.js|from ['"]three['"]|THREE\./.test(all)) return 'threejs';
  if (html) return 'web';
  return 'unknown';
}

// True when the game can be previewed by serving the folder statically.
export const isWebEngine = (e) => ['threejs', 'phaser', 'pixi', 'web'].includes(e);

// Projects change: a folder added while empty becomes a web game once Claude writes index.html.
// Returns true when the stored engine changed.
export function refreshEngine(project) {
  let e;
  try { e = detectEngine(project.path); } catch { return false; }
  if (e === project.engine) return false;
  project.engine = e;
  project.web = isWebEngine(e);
  return true;
}

// Kept deliberately short: every word here is paid on every turn (though it is cached).
const HINTS = {
  threejs: 'three.js browser game, served as static files. Use setAnimationLoop, keep per-frame allocations out of the loop, dispose geometries/materials you replace.',
  phaser: 'Phaser browser game. Keep scenes small; use Arcade physics unless told otherwise.',
  pixi: 'PixiJS browser game. Batch sprites via spritesheets; avoid per-frame Graphics redraws.',
  web: 'Plain HTML/JS browser game served as static files.',
  godot: 'Godot project. Prefer GDScript with static typing; edit .tscn files carefully (keep ExtResource ids consistent).',
  unity: 'Unity project. C# scripts under Assets/. Never edit .meta files or Library/.',
  unreal: 'Unreal project. Gameplay C++ under Source/; do not touch Binaries/, Intermediate/, Saved/.',
  unknown: 'Game project; engine not detected.',
};
export const engineHint = (e) => HINTS[e] ?? HINTS.unknown;

// Binary / huge files the agent should never Read: each one can cost thousands of tokens for nothing.
export const BINARY_GLOBS = ['blend', 'blend1', 'fbx', 'glb', 'obj', 'png', 'jpg', 'jpeg', 'webp', 'psd', 'wav', 'mp3', 'ogg', 'ttf', 'otf', 'exr', 'hdr', 'ktx2', 'zip', 'pck', 'unitypackage', 'uasset', 'umap']
  .map((ext) => `Read(**/*.${ext})`);

// Folders that are never worth exploring.
export const IGNORE_DIRS = new Set(['.git', 'node_modules', '.godot', '.import', 'Library', 'Temp', 'Obj', 'Build', 'Builds', 'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'dist', '.forge']);
