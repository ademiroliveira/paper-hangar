import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { arrowPath, faceMatrix, stepMatrices, type CompiledPlane, type Step } from '@paper-hangar/crease';
import { reduceMotion, type Player } from './usePlayer';

const COL = {
  paper: new THREE.Color('#FBFBF7'),
  kami: new THREE.Color('#3557D4'),
  paperGlow: new THREE.Color('#FFC4A3'),
  kamiGlow: new THREE.Color('#7D97FF'),
  accent: new THREE.Color('#FF6A1F'),
  bg: new THREE.Color('#173A31'),
};
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const VIEWS = { table: { theta: 0, phi: 36 * DEG }, flight: { theta: 52 * DEG, phi: 64 * DEG } };
const SUN_OFFSET = new THREE.Vector3(-16, 40, 18);
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

interface Props { plane: CompiledPlane; player: Player; step: number }

export const FoldCanvas = memo(function FoldCanvas(props: Props) {
  return (
    <Canvas
      flat
      shadows={{ type: THREE.PCFShadowMap }}
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.5, far: 600, position: [0, 50, 50] }}
      gl={{ antialias: true }}
      style={{ touchAction: 'none' }}
      aria-label="3D paper model. Drag the paper along the orange arrow to fold it. Drag anywhere else to turn the view; pinch to zoom."
    >
      <Scene {...props} />
    </Canvas>
  );
});

/* ---------- static pieces ---------- */

function matTexture(gl: THREE.WebGLRenderer) {
  const S = 1024, CM = 10, px = S / CM;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#1F4A3E';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < CM; i++) {
    const strong = i === 0, mid = i === 5;
    g.fillStyle = strong ? '#5E8F80' : mid ? '#3E6F61' : '#2B5A4D';
    const lw = strong ? 4 : mid ? 3 : 2;
    g.fillRect(i * px, 0, lw, S);
    g.fillRect(0, i * px, S, lw);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.anisotropy = gl.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildWorld(W: number, H: number, FLY: number, gl: THREE.WebGLRenderer) {
  const root = new THREE.Group();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x2a4a40, 1.6);
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;

  // Cutting mat with a 1 cm grid; the sheet sits squared to a grid corner.
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ map: matTexture(gl), roughness: 0.95 }));
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(-W / 2, -0.03, H / 2);
  mat.receiveShadow = true;

  // rig (idle float when finished) > paperGroup (the engine's table frame) > overlay (diagram marks)
  const rig = new THREE.Group();
  rig.position.set(0, FLY, 0);
  const paperGroup = new THREE.Group();
  paperGroup.position.set(-W / 2, -FLY, H / 2);
  rig.add(paperGroup);
  const overlay = new THREE.Group();
  paperGroup.add(overlay);
  root.add(hemi, sun, sun.target, mat, rig);

  const paperOpts = { vertexColors: true, roughness: 0.88, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const materials = {
    front: new THREE.MeshStandardMaterial({ ...paperOpts, side: THREE.FrontSide, shadowSide: THREE.DoubleSide }),
    back: new THREE.MeshStandardMaterial({ ...paperOpts, side: THREE.BackSide }),
    edge: new THREE.LineBasicMaterial({ color: 0x22332d, transparent: true, opacity: 0.32 }),
    mark: new THREE.MeshBasicMaterial({ color: COL.accent, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    arrow: new THREE.MeshBasicMaterial({ color: COL.accent, transparent: true }),
  };
  return { root, sun, rig, paperGroup, overlay, mat, materials };
}
type World = ReturnType<typeof buildWorld>;

/* ---------- per-step meshes ---------- */

interface StepMeshes {
  step: Step;
  index: number;
  front: THREE.Mesh;
  back: THREE.Mesh;
  edges: THREE.LineSegments;
  triFace: number[];
  creases: THREE.Mesh[];
  arrows: THREE.Mesh[];
}

function buildStepMeshes(world: World, step: Step, index: number): StepMeshes {
  const tris = step.faces.reduce((n, f) => n + f.poly.length - 2, 0);
  const segs = step.faces.reduce((n, f) => n + f.poly.length, 0);
  const pos = new THREE.BufferAttribute(new Float32Array(tris * 9), 3).setUsage(THREE.DynamicDrawUsage);
  const nor = new THREE.BufferAttribute(new Float32Array(tris * 9), 3).setUsage(THREE.DynamicDrawUsage);
  const gFront = new THREE.BufferGeometry(), gBack = new THREE.BufferGeometry(), gEdges = new THREE.BufferGeometry();
  gFront.setAttribute('position', pos); gFront.setAttribute('normal', nor);
  gBack.setAttribute('position', pos); gBack.setAttribute('normal', nor);
  gFront.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tris * 9), 3).setUsage(THREE.DynamicDrawUsage));
  gBack.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tris * 9), 3).setUsage(THREE.DynamicDrawUsage));
  gEdges.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 6), 3).setUsage(THREE.DynamicDrawUsage));
  const front = new THREE.Mesh(gFront, world.materials.front);
  const back = new THREE.Mesh(gBack, world.materials.back);
  const edges = new THREE.LineSegments(gEdges, world.materials.edge);
  front.castShadow = true;
  for (const o of [front, back, edges]) { o.frustumCulled = false; world.paperGroup.add(o); }
  const triFace: number[] = [];
  step.faces.forEach((f, i) => { for (let k = 0; k < f.poly.length - 2; k++) triFace.push(i); });

  // Diagram marks: dashed fold line + fold arrow, the way paper instructions draw them.
  const top = Math.max(...step.faces.map(f => f.maxY()));
  const creases: THREE.Mesh[] = [], arrows: THREE.Mesh[] = [];
  step.ops.forEach((op, k) => {
    if (op.crease) {
      const y = top + 0.05;
      const a = op.crease[0].clone().setY(y), b = op.crease[1].clone().setY(y);
      const dir = b.clone().sub(a), len = dir.length();
      dir.normalize();
      const perp = new THREE.Vector3().crossVectors(dir, UP).normalize().multiplyScalar(0.09);
      const verts: number[] = [];
      for (let s = 0.2; s < len - 0.2; s += 1.35) {
        const e = Math.min(s + 0.85, len - 0.2);
        const p0 = a.clone().addScaledVector(dir, s), p1 = a.clone().addScaledVector(dir, e);
        const q = [p0.clone().add(perp), p0.clone().sub(perp), p1.clone().sub(perp), p1.clone().add(perp)];
        for (const v of [q[0], q[1], q[2], q[0], q[2], q[3]]) verts.push(v.x, v.y, v.z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const m = new THREE.Mesh(g, world.materials.mark);
      m.renderOrder = 2;
      world.overlay.add(m);
      creases.push(m);
    }
    const path = arrowPath(step, k);
    if (path) {
      const curve = new THREE.CatmullRomCurve3(path);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.13, 8, false), world.materials.arrow);
      const tan = curve.getTangent(1);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.25, 18), world.materials.arrow);
      head.quaternion.setFromUnitVectors(UP, tan);
      head.position.copy(path[path.length - 1]).addScaledVector(tan, 0.2);
      for (const m of [tube, head]) { m.renderOrder = 3; world.overlay.add(m); arrows.push(m); }
    }
  });
  return { step, index, front, back, edges, triFace, creases, arrows };
}

function disposeStepMeshes(world: World, m: StepMeshes) {
  world.paperGroup.remove(m.front, m.back, m.edges);
  m.front.geometry.dispose(); m.back.geometry.dispose(); m.edges.geometry.dispose();
  for (const o of [...m.creases, ...m.arrows]) { world.overlay.remove(o); o.geometry.dispose(); }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _cf = new THREE.Color(), _cb = new THREE.Color();

function writeGeometry(m: StepMeshes, t: number, glow: number) {
  const st = m.step, mats = stepMatrices(st, t);
  const gF = m.front.geometry, gB = m.back.geometry, gE = m.edges.geometry;
  const pos = gF.attributes.position.array as Float32Array, nor = gF.attributes.normal.array as Float32Array;
  const cf = gF.attributes.color.array as Float32Array, cb = gB.attributes.color.array as Float32Array;
  const ed = gE.attributes.position.array as Float32Array;
  let o = 0, e = 0;
  st.faces.forEach((f, i) => {
    const vs = f.world(faceMatrix(st, i, mats));
    _a.subVectors(vs[1], vs[0]); _b.subVectors(vs[2], vs[0]); _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
    const g = st.movingAny[i] ? glow : 0;
    _cf.copy(COL.paper).lerp(COL.paperGlow, g);
    _cb.copy(COL.kami).lerp(COL.kamiGlow, g);
    for (let k = 1; k < vs.length - 1; k++) {
      for (const v of [vs[0], vs[k], vs[k + 1]]) {
        pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
        nor[o] = _n.x; nor[o + 1] = _n.y; nor[o + 2] = _n.z;
        cf[o] = _cf.r; cf[o + 1] = _cf.g; cf[o + 2] = _cf.b;
        cb[o] = _cb.r; cb[o + 1] = _cb.g; cb[o + 2] = _cb.b;
        o += 3;
      }
    }
    for (let k = 0; k < vs.length; k++) {
      const v = vs[k], w = vs[(k + 1) % vs.length];
      ed[e++] = v.x; ed[e++] = v.y; ed[e++] = v.z;
      ed[e++] = w.x; ed[e++] = w.y; ed[e++] = w.z;
    }
  });
  gF.attributes.position.needsUpdate = true;
  gF.attributes.normal.needsUpdate = true;
  gF.attributes.color.needsUpdate = true;
  gB.attributes.color.needsUpdate = true;
  gE.attributes.position.needsUpdate = true;
}

/* ---------- the scene ---------- */

function Scene({ plane, player, step: stepIndex }: Props) {
  const { scene, camera, gl, size } = useThree();
  const cam3 = camera as THREE.PerspectiveCamera;
  const W = plane.width, H = plane.height, FLY = plane.flyHeight;
  const world = useMemo(() => buildWorld(W, H, FLY, gl), [W, H, FLY, gl]);
  const meshes = useRef<StepMeshes | null>(null);
  const cam = useRef({
    theta: 0, phi: 36 * DEG, r: 70, target: new THREE.Vector3(), zoom: 1, ready: false,
    goal: { theta: 0, phi: 36 * DEG, r: 70, target: new THREE.Vector3() },
  });
  const doneBlend = useRef(0);

  useEffect(() => {
    scene.background = COL.bg;
    scene.fog = new THREE.Fog(COL.bg, 80, 200);
    scene.add(world.root);
    return () => {
      scene.remove(world.root);
      if (meshes.current) { disposeStepMeshes(world, meshes.current); meshes.current = null; }
      world.mat.geometry.dispose();
      (world.mat.material as THREE.MeshStandardMaterial).map?.dispose();
      (world.mat.material as THREE.Material).dispose();
      Object.values(world.materials).forEach(m => m.dispose());
    };
  }, [scene, world]);

  /** Frame the step: every pose it passes through stays in view. */
  const fit = (st: Step, aspect: number) => {
    const c = cam.current;
    const ts = st.view === 'flight' ? [0.55, 0.8, 1] : [0, 0.25, 0.5, 0.75, 1];
    const pts: THREE.Vector3[] = [];
    const off = new THREE.Vector3(-W / 2, 0, H / 2);
    for (const t of ts) {
      const mats = stepMatrices(st, t);
      st.faces.forEach((f, i) => f.world(faceMatrix(st, i, mats)).forEach(v => pts.push(v.add(off))));
    }
    const center = new THREE.Box3().setFromPoints(pts).getCenter(new THREE.Vector3());
    const { theta, phi } = c.goal;
    const z = new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
    const x = new THREE.Vector3().crossVectors(UP, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const tv = Math.tan((cam3.fov * DEG) / 2), th = tv * aspect;
    let d = 10;
    for (const p of pts) {
      const rel = p.clone().sub(center);
      const px = rel.dot(x), py = rel.dot(y), pz = rel.dot(z);
      d = Math.max(d, pz + Math.abs(px) / th, pz + Math.abs(py) / tv);
    }
    c.goal.r = d * 1.1;
    c.goal.target.copy(center);
  };
  const setView = (view: Step['view']) => {
    const c = cam.current, v = VIEWS[view], twoPi = Math.PI * 2;
    c.goal.theta = v.theta + twoPi * Math.round((c.theta - v.theta) / twoPi);
    c.goal.phi = v.phi;
    c.zoom = 1;
  };

  // Rebuild meshes when the step changes.
  useEffect(() => {
    const st = plane.steps[stepIndex];
    if (meshes.current) disposeStepMeshes(world, meshes.current);
    meshes.current = buildStepMeshes(world, st, stepIndex);
    setView(st.view);
    fit(st, size.width / Math.max(1, size.height));
    const c = cam.current;
    if (!c.ready) {
      c.ready = true;
      c.theta = c.goal.theta; c.phi = c.goal.phi; c.r = c.goal.r; c.target.copy(c.goal.target);
    }
  }, [plane, stepIndex, world]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit when the canvas changes size (rotation, split view).
  useEffect(() => {
    if (meshes.current) fit(meshes.current.step, size.width / Math.max(1, size.height));
  }, [size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- gestures: grab the paper to fold it; drag elsewhere to orbit; pinch to zoom ---------- */
  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'fold' | 'orbit' | 'pinch' | null = null;
    let grab: { fi: number; local: THREE.Vector3 } | null = null;
    let pinch0 = { d: 1, zoom: 1 };
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

    const pick = (x: number, y: number) => {
      const m = meshes.current;
      if (!m) return null;
      const rect = el.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), cam3);
      m.front.geometry.computeBoundingSphere();
      m.back.geometry.computeBoundingSphere();
      const hits = raycaster.intersectObjects([m.front, m.back], false);
      if (!hits.length || hits[0].faceIndex == null) return null;
      return { fi: m.triFace[hits[0].faceIndex], point: hits[0].point };
    };
    const lastIndex = plane.steps.length - 1;
    const canGrab = (fi: number) => {
      const m = meshes.current!;
      return m.step.movingAny[fi] && !(m.index === lastIndex && player.s.t >= 0.999);
    };
    const tFromPointer = (c: { x: number; y: number }) => {
      const m = meshes.current!, st = m.step, rect = el.getBoundingClientRect();
      const px = c.x - rect.left, py = c.y - rect.top, N = 64;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= N; i++) {
        const p = grab!.local.clone().applyMatrix4(faceMatrix(st, grab!.fi, stepMatrices(st, i / N)));
        world.paperGroup.localToWorld(p).project(cam3);
        pts.push({ x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height });
      }
      const cur = player.s.t;
      let best = { d: Infinity, t: cur };
      for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N;
        if (t1 < cur - 0.3 || t0 > cur + 0.3) continue;
        const a = pts[i], b = pts[i + 1], abx = b.x - a.x, aby = b.y - a.y, L2 = abx * abx + aby * aby;
        const u = L2 > 1e-6 ? clamp(((px - a.x) * abx + (py - a.y) * aby) / L2, 0, 1) : 0;
        const d = (px - a.x - abx * u) ** 2 + (py - a.y - aby * u) ** 2;
        if (d < best.d) best = { d, t: t0 + (t1 - t0) * u };
      }
      return best.t;
    };

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        const hit = pick(e.clientX, e.clientY);
        if (hit && canGrab(hit.fi)) {
          player.stop();
          const st = meshes.current!.step;
          const inv = faceMatrix(st, hit.fi, stepMatrices(st, player.s.t)).invert();
          grab = { fi: hit.fi, local: world.paperGroup.worldToLocal(hit.point.clone()).applyMatrix4(inv) };
          mode = 'fold';
          el.style.cursor = 'grabbing';
          player.setDragging(true);
        } else mode = 'orbit';
      } else if (pointers.size === 2 && mode !== 'fold') {
        const [a, b] = [...pointers.values()];
        mode = 'pinch';
        pinch0 = { d: dist(a, b), zoom: cam.current.zoom };
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId)!, cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      const c = cam.current;
      if (mode === 'fold') player.setT(tFromPointer(cur));
      else if (mode === 'orbit') {
        c.goal.theta -= (cur.x - prev.x) * 0.008;
        c.goal.phi = clamp(c.goal.phi - (cur.y - prev.y) * 0.008, 0.12, 1.42);
      } else if (mode === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        c.zoom = clamp((pinch0.zoom * pinch0.d) / Math.max(10, dist(a, b)), 0.45, 2.5);
      }
    };
    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (mode === 'fold') {
        mode = null; grab = null; el.style.cursor = '';
        player.setDragging(false);
        if (player.s.t > 0.5) player.markFoldedByHand();
        if (player.s.t > 0.93) player.animateTo(1, 220);
        else if (player.s.t < 0.05) player.animateTo(0, 180);
      } else if (pointers.size === 0) mode = null;
      else if (mode === 'pinch') mode = 'orbit';
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.current.zoom = clamp(cam.current.zoom * Math.exp(e.deltaY * 0.0012), 0.45, 2.5);
    };
    const dbl = () => { if (meshes.current) setView(meshes.current.step.view); };

    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dbl);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dbl);
    };
  }, [gl, cam3, world, player, plane]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- every frame ---------- */
  useFrame((_, delta) => {
    const now = performance.now();
    player.tick(now);
    const m = meshes.current;
    if (!m) return;
    const dt = Math.min(0.05, delta);
    const { t, dragging, anim } = player.s;
    // The UI may already be on another step for a frame before the meshes rebuild.
    const tt = m.index === player.s.step ? t : 0;
    const idle = !dragging && !anim;
    const fade = 1 - smooth(Math.min(1, tt / 0.12));
    const wave = Math.max(0, Math.sin((now / 1000) * 2.6));
    const pulse = idle && !reduceMotion ? wave : 0.5;
    // At rest, the paper that moves next lifts a few degrees, as if asking to be folded.
    const nudge = idle && !reduceMotion && tt < 0.001 ? 0.03 * wave * wave : 0;
    writeGeometry(m, tt + nudge, fade * (0.3 + 0.5 * pulse));

    const arrowOp = 1 - smooth(Math.min(1, tt / 0.16));
    world.materials.arrow.opacity = arrowOp;
    m.arrows.forEach(a => { a.visible = arrowOp > 0.01; });
    const creaseOp = 1 - smooth(clamp((tt - 0.7) / 0.3, 0, 1));
    world.materials.mark.opacity = creaseOp;
    m.creases.forEach(c => { c.visible = creaseOp > 0.01; });

    const finished = m.index === plane.steps.length - 1 && tt >= 0.999 && !reduceMotion;
    doneBlend.current += ((finished ? 1 : 0) - doneBlend.current) * (1 - Math.exp(-dt * 2));
    const s = now / 1000, k = doneBlend.current;
    world.rig.position.y = FLY + Math.sin(s * 1.3) * 0.45 * k;
    world.rig.rotation.z = Math.sin(s * 0.9) * 0.05 * k;
    world.rig.rotation.x = Math.sin(s * 1.3 + 0.8) * 0.025 * k;

    const c = cam.current, a = 1 - Math.exp(-dt * 9);
    c.theta += (c.goal.theta - c.theta) * a;
    c.phi += (c.goal.phi - c.phi) * a;
    c.r += (c.goal.r * c.zoom - c.r) * a;
    c.target.lerp(c.goal.target, a);
    cam3.position.setFromSpherical(new THREE.Spherical(c.r, c.phi, c.theta)).add(c.target);
    cam3.lookAt(c.target);
    const fog = scene.fog as THREE.Fog;
    fog.near = c.r * 1.15;
    fog.far = c.r * 2.8;
    world.sun.position.copy(c.target).add(SUN_OFFSET);
    world.sun.target.position.copy(c.target);
  });

  return null;
}
