// 3D model viewer for the Assets tab: orbit around a .glb/.gltf, see triangles, materials, textures and
// animations. three.js is served locally by Forge (/vendor/three), so this works offline.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let current = null; // { dispose }

export function closeViewer() { current?.dispose(); current = null; }

export async function openViewer(host, url, title) {
  closeViewer();
  host.innerHTML = `<div class="vHead"><b></b><span class="grow"></span><button class="ib vClose" title="Close">✕</button></div>
    <div class="vStage"><div class="vMsg">Loading…</div></div><div class="vInfo"></div>`;
  host.querySelector('.vHead b').textContent = title;
  host.hidden = false;
  const stage = host.querySelector('.vStage'), info = host.querySelector('.vInfo'), msg = host.querySelector('.vMsg');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f0f);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 5, 4); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const clock = new THREE.Clock();
  let mixer = null;

  const resize = () => { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();
  renderer.setAnimationLoop(() => { const dt = clock.getDelta(); mixer?.update(dt); controls.update(); renderer.render(scene, camera); });

  const dispose = () => {
    renderer.setAnimationLoop(null); ro.disconnect(); controls.dispose();
    scene.traverse((o) => { o.geometry?.dispose(); [].concat(o.material ?? []).forEach((m) => { Object.values(m).forEach((v) => v?.isTexture && v.dispose()); m.dispose(); }); });
    renderer.dispose(); host.hidden = true; host.innerHTML = '';
  };
  current = { dispose };
  host.querySelector('.vClose').addEventListener('click', closeViewer);

  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = gltf.scene;
    scene.add(root);
    // Animation-only files (a skeleton plus clips, no mesh) are common in game pipelines: draw the bones.
    let hasMesh = false; root.traverse((o) => { if (o.isMesh) hasMesh = true; });
    let bones = null;
    if (!hasMesh) {
      bones = new THREE.SkeletonHelper(root);
      bones.material.linewidth = 2;
      scene.add(bones);
    }
    // Frame the model (or its bones) and put a grid under it.
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    if (hasMesh) box.setFromObject(root);
    else root.traverse((o) => { if (o.isBone || o.isObject3D) box.expandByPoint(o.getWorldPosition(new THREE.Vector3())); });
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 1;
    const grid = new THREE.GridHelper(radius * 4, 20, 0x444444, 0x262626); grid.position.y = box.min.y; scene.add(grid);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.9, radius * 1.6));
    camera.near = radius / 100; camera.far = radius * 100; camera.updateProjectionMatrix();

    let tris = 0, meshes = 0; const mats = new Set(), texs = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry; tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      for (const m of [].concat(o.material)) { mats.add(m); for (const v of Object.values(m)) if (v?.isTexture) texs.add(v); }
    });
    msg.remove();
    controls.update(); renderer.render(scene, camera); // first frame right away
    const clips = gltf.animations ?? [];
    let nBones = 0; root.traverse((o) => { if (o.isBone) nBones++; });
    info.innerHTML = (hasMesh ? '' : `<span class="warnTxt">Skeleton/animation only: no mesh in this file (${nBones} bones shown as lines)</span>`)
      + `<span>${Math.round(tris).toLocaleString()} triangles</span><span>${meshes} mesh${meshes === 1 ? '' : 'es'}</span>
      <span>${mats.size} material${mats.size === 1 ? '' : 's'}</span><span>${texs.size} texture${texs.size === 1 ? '' : 's'}</span>
      <span>${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} units</span>
      ${clips.length ? `<span class="vAnims">${clips.map((c, i) => `<button class="btn small" data-clip="${i}">▶ ${c.name.replace(/[<>&"]/g, '') || 'clip ' + (i + 1)} (${c.duration.toFixed(1)}s)</button>`).join('')}</span>` : '<span class="dim">no animations</span>'}`;
    if (clips.length) {
      mixer = new THREE.AnimationMixer(root);
      info.addEventListener('click', (e) => {
        const b = e.target.closest('[data-clip]'); if (!b) return;
        mixer.stopAllAction(); mixer.clipAction(clips[Number(b.dataset.clip)]).play();
        info.querySelectorAll('[data-clip]').forEach((x) => x.classList.toggle('on', x === b));
      });
    }
    return { triangles: Math.round(tris), meshes, materials: mats.size, textures: texs.size, animations: clips.map((c) => c.name) };
  } catch (err) {
    msg.textContent = `Could not load the model: ${err.message ?? err}`;
    return { error: String(err.message ?? err) };
  }
}
