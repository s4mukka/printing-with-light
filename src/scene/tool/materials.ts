import * as THREE from 'three';

export const M = {
  panel: () => new THREE.MeshPhysicalMaterial({ color: 0xa9a6a0, roughness: 0.52, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.35 }),
  panelWarm: () => new THREE.MeshPhysicalMaterial({ color: 0x55534f, roughness: 0.62, metalness: 0.1, clearcoat: 0.2, clearcoatRoughness: 0.5 }),
  dark: () => new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.5, metalness: 0.55 }),
  darker: () => new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.62, metalness: 0.3 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0xaeb3ba, roughness: 0.28, metalness: 1 }),
  chrome: () => new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.08, metalness: 1 }),
  stone: () => new THREE.MeshStandardMaterial({ color: 0x1d1f23, roughness: 0.78, metalness: 0.05 }),
  ceramic: () => new THREE.MeshPhysicalMaterial({ color: 0xc4c0b8, roughness: 0.34, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
  // transparent glass without a transmission pass — much cheaper on integrated GPUs
  glass: () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xbfdcf5,
      metalness: 0,
      roughness: 0.04,
      transparent: true,
      opacity: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      specularIntensity: 1,
      envMapIntensity: 1.6,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  window: () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.04,
      transparent: true,
      opacity: 0.16,
      clearcoat: 1,
      envMapIntensity: 1.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  mirror: () => new THREE.MeshPhysicalMaterial({ color: 0xc8d4ff, metalness: 1, roughness: 0.06, iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessRange: [180, 420] }),
  glow: (c: THREE.ColorRepresentation, i = 2) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i), toneMapped: true }),
};

/** Rounded box via extruded rounded rectangle — soft product-design edges. */
export function roundedBox(w: number, h: number, d: number, r: number, seg = 5) {
  // the extrude bevel grows the outline by `bev`, so draw the shape that much smaller
  const bev = Math.min(r * 0.5, h * 0.25, w * 0.2, d * 0.2);
  const iw = w - 2 * bev;
  const id = d - 2 * bev;
  const shape = new THREE.Shape();
  const x = -iw / 2;
  const y = -id / 2;
  const rr = Math.max(0.001, Math.min(r - bev, iw / 2, id / 2));
  shape.moveTo(x + rr, y);
  shape.lineTo(x + iw - rr, y);
  shape.quadraticCurveTo(x + iw, y, x + iw, y + rr);
  shape.lineTo(x + iw, y + id - rr);
  shape.quadraticCurveTo(x + iw, y + id, x + iw - rr, y + id);
  shape.lineTo(x + rr, y + id);
  shape.quadraticCurveTo(x, y + id, x, y + id - rr);
  shape.lineTo(x, y + rr);
  shape.quadraticCurveTo(x, y, x + rr, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: seg, curveSegments: seg * 2 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bev, 0);
  geo.computeVertexNormals();
  return geo; // spans x ∈ [−w/2, w/2], y ∈ [0, h], z ∈ [−d/2, d/2]
}

/** Lens element as a lathe: sag > 0 bulges outward. */
export function lensGeometry(R: number, sagTop: number, sagBottom: number, edge: number, seg = 18) {
  const pts: THREE.Vector2[] = [];
  const arc = (sag: number, top: boolean) => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i <= seg; i++) {
      const r = (R * i) / seg;
      const f = 1 - (r / R) ** 2;
      const y = (top ? edge / 2 : -edge / 2) + (top ? 1 : -1) * sag * f;
      out.push(new THREE.Vector2(Math.max(r, 0.0001), y));
    }
    return out;
  };
  const top = arc(sagTop, true);
  const bot = arc(sagBottom, false).reverse();
  pts.push(...top, ...bot);
  const g = new THREE.LatheGeometry(pts, 72);
  g.computeVertexNormals();
  return g;
}

/** Thick cylinder shell with a museum-style cut-away facing +z. Spans y ∈ [−h/2, h/2]. */
export function cutawayCylinder(r: number, h: number, outerMat: THREE.Material, innerMat: THREE.Material, edgeMat: THREE.Material, gap = Math.PI * 0.6, thick = 0.045) {
  const g = new THREE.Group();
  const start = gap / 2;
  const len = Math.PI * 2 - gap;
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 96, 1, true, start, len), outerMat);
  outer.castShadow = true;
  const innerM = innerMat.clone();
  innerM.side = THREE.BackSide;
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(r - thick, r - thick, h, 96, 1, true, start, len), innerM);
  g.add(outer, inner);
  for (const y of [h / 2, -h / 2]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - thick, r, 96, 1, start - Math.PI / 2, len), edgeMat);
    ring.rotation.x = y > 0 ? -Math.PI / 2 : Math.PI / 2;
    if (y < 0) ring.rotation.z = 0;
    ring.position.y = y;
    if (y < 0) {
      // mirrored ring: flip angles to stay aligned with the shell
      ring.geometry = new THREE.RingGeometry(r - thick, r, 96, 1, -(start - Math.PI / 2) - len, len);
    }
    g.add(ring);
  }
  for (const phi of [start, start + len]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(thick, h), edgeMat);
    const rm = r - thick / 2;
    face.position.set(rm * Math.sin(phi), 0, rm * Math.cos(phi));
    face.rotation.y = phi + Math.PI / 2;
    face.material = edgeMat;
    (face.material as THREE.Material).side = THREE.DoubleSide;
    g.add(face);
  }
  return g;
}
