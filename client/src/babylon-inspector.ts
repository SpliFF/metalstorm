/**
 * Bundled Babylon model inspector (approach 2 of the model-debug pair).
 *
 * A standalone Vite page (sibling entry to index.html / viewport.html) that
 * loads a single glTF model into its OWN main-thread scene and opens the
 * Babylon Inspector on it. Unlike the game — whose scene lives in the
 * game-processor worker on an OffscreenCanvas, out of the DOM Inspector's
 * reach — this page has a real DOM, so `scene.debugLayer` works.
 *
 * It imports the exact same @babylonjs 9.1.0 modules AND the game's own
 * ktx2-config, so the glTF + KTX2 load path is byte-for-byte the game's,
 * minus the worker and the entity-renderer instancing. That makes it the
 * bisection tool: if a model breaks here too it's the model/loader/KTX2; if
 * it loads clean here the bug is in our worker-side code.
 *
 * The CDN twin (public/model-inspector.html) does the same with UMD scripts
 * from unpkg and no build step; keep the two behaviourally in sync.
 */

import './core/ktx2-config.js'; // registers the KTX2 loader + pins transcoder URLs (same as the game)
import {
    Engine, Scene, ArcRotateCamera, HemisphericLight, DirectionalLight,
    Vector3, Color3, Color4, SceneLoader, MeshBuilder, StandardMaterial,
    type AbstractMesh, type Material,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { Inspector } from '@babylonjs/inspector';

const hud = document.getElementById('hud')!;
function log(msg: string, cls = ''): void {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = msg;
    hud.appendChild(d);
    hud.scrollTop = hud.scrollHeight;
    console.log('[babylon-inspector]', msg);
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.14, 0.16, 0.19, 1);
const cam = new ArcRotateCamera('cam', Math.PI * 1.15, 1.05, 20, Vector3.Zero(), scene);
cam.wheelPrecision = 15;
cam.attachControl(canvas, true);
new HemisphericLight('hemi', new Vector3(0.3, 1, 0.2), scene).intensity = 1.05;
const dir = new DirectionalLight('dir', new Vector3(-0.5, -1, -0.35), scene);
dir.intensity = 2.0;
const ground = MeshBuilder.CreateGround('ground', { width: 80, height: 80 }, scene);
const gm = new StandardMaterial('gm', scene);
gm.diffuseColor = new Color3(0.16, 0.18, 0.21);
gm.specularColor = new Color3(0, 0, 0);
ground.material = gm;
engine.runRenderLoop(() => scene.render());
addEventListener('resize', () => engine.resize());

let loaded: AbstractMesh[] | null = null;
let wire = false;
let inspectorOpen = false;

function frame(meshes: AbstractMesh[]): void {
    const geo = meshes.filter((m) => m.getTotalVertices() > 0);
    if (!geo.length) return;
    let min = new Vector3(1e9, 1e9, 1e9);
    let max = new Vector3(-1e9, -1e9, -1e9);
    for (const m of geo) {
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, bb.minimumWorld);
        max = Vector3.Maximize(max, bb.maximumWorld);
    }
    const c = min.add(max).scale(0.5);
    const r = max.subtract(min).length() / 2 || 10;
    cam.setTarget(c);
    cam.radius = r * 2.6;
}

async function load(url: string): Promise<void> {
    if (loaded) { loaded.forEach((m) => m.dispose()); loaded = null; }
    hud.replaceChildren();
    log(`Babylon ${Engine.Version} · loading ${url}`, 'h');

    // glTF loader diagnostics: verbose parse logging + the Khronos validator.
    const obs = SceneLoader.OnPluginActivatedObservable.add((loader) => {
        const g = loader as unknown as {
            name?: string; loggingEnabled?: boolean; validate?: boolean;
            onValidatedObservable?: { add(cb: (r: {
                issues?: { numErrors?: number; numWarnings?: number; numHints?: number;
                    numInfos?: number; messages?: unknown[] };
            }) => void): void };
        };
        if (g.name !== 'gltf') return;
        g.loggingEnabled = true;
        g.validate = true;
        g.onValidatedObservable?.add((r) => {
            const i = r.issues ?? {};
            log(`glTF-validate: ${i.numErrors ?? 0} errors, ${i.numWarnings ?? 0} warnings, `
                + `${i.numHints ?? 0} hints, ${i.numInfos ?? 0} infos`, i.numErrors ? 'err' : 'ok');
            for (const raw of (i.messages ?? []).slice(0, 60)) {
                const m = raw as { severity?: number; message?: string; pointer?: string };
                const s = (m && typeof m === 'object')
                    ? `${m.severity === 0 ? 'ERROR' : 'warn'}: ${m.message} @ ${m.pointer ?? ''}`
                    : String(raw);
                log('  ' + s, (m && m.severity === 0) ? 'err' : 'warn');
            }
        });
    });

    const t0 = performance.now();
    const wd = window.setInterval(() => log(
        `…still loading after ${((performance.now() - t0) / 1000) | 0}s — `
        + `${scene.meshes.length} meshes, ${scene.textures.length} textures parsed so far`, 'warn'), 4000);
    const slash = url.lastIndexOf('/');
    try {
        const res = await SceneLoader.ImportMeshAsync('', url.slice(0, slash + 1), url.slice(slash + 1), scene);
        clearInterval(wd);
        SceneLoader.OnPluginActivatedObservable.remove(obs);
        loaded = res.meshes;
        let verts = 0;
        const rows = res.meshes.map((m) => {
            const v = m.getTotalVertices();
            verts += v;
            let size = '';
            if (v > 0) {
                m.refreshBoundingInfo({});
                const e = m.getBoundingInfo().boundingBox.extendSize;
                size = `${(e.x * 2).toFixed(1)}×${(e.y * 2).toFixed(1)}×${(e.z * 2).toFixed(1)}`;
            }
            return { name: m.name, verts: v, size, mat: m.material?.name ?? null };
        });
        log(`✔ loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s — ${res.meshes.length} meshes, `
            + `${verts} verts, ${res.transformNodes.length} transform nodes, `
            + `${res.animationGroups.length} clips`, 'ok');
        console.table(rows);
        for (const r of rows) log(`  ${r.name}: ${r.verts} v  ${r.size}  mat=${r.mat}`, r.verts ? 'dim' : 'warn');
        frame(res.meshes);
        if (wire) res.meshes.forEach((m) => { if (m.material) (m.material as Material).wireframe = true; });
        res.animationGroups.forEach((grp, i) => (i === 0 ? grp.play(true) : grp.stop()));
    } catch (e) {
        clearInterval(wd);
        SceneLoader.OnPluginActivatedObservable.remove(obs);
        log('✘ LOAD FAILED: ' + ((e as Error)?.message ?? e), 'err');
        console.error(e);
    }
}

const urlInput = document.getElementById('url') as HTMLInputElement;
document.getElementById('go')!.addEventListener('click', () => {
    const u = urlInput.value.trim();
    if (u) void load(u);
});
document.getElementById('insp')!.addEventListener('click', () => {
    inspectorOpen = !inspectorOpen;
    if (inspectorOpen) Inspector.Show(scene, { embedMode: false, overlay: true });
    else Inspector.Hide();
});
document.getElementById('wire')!.addEventListener('click', () => {
    wire = !wire;
    scene.meshes.forEach((m) => { if (m.material && m !== ground) (m.material as Material).wireframe = wire; });
});

const params = new URLSearchParams(location.search);
const model = params.get('model');
if (model) {
    urlInput.value = model;
    void load(model).then(() => {
        if (params.get('inspector') !== '0') { Inspector.Show(scene, { embedMode: false, overlay: true }); inspectorOpen = true; }
    });
} else {
    log('paste a model URL below and press Load — e.g. /api/games/data/metalstorm/models/fable_colossus.gltf', 'dim');
}
