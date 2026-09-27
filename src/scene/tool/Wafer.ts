import * as THREE from 'three';
import { DIE } from '../../sim/engine';

export const WAFER_R = 0.9;
export const DIE_OFF = 11;
export const DIE_TEX = 22;

/**
 * Wafer surface: physically-based material whose base reflectance is computed per-pixel from a
 * two-layer thin-film interference model (resist on oxide on silicon) — so film thickness is visible
 * as colour, exactly like on a real wafer. Pattern, die grid, latent image and yield map are layered in.
 */
export class WaferMaterial extends THREE.MeshPhysicalMaterial {
  uniformsRef: Record<string, THREE.IUniform> = {
    uPattern: { value: null },
    uDies: { value: null },
    uRepeat: { value: 3 },
    uDie: { value: DIE },
    uClean: { value: 0 },
    uCoatR: { value: 0 },
    uResist: { value: 0 }, // nm displayed (uniform film) before development
    uPatterned: { value: 0 }, // 0 = uniform film, 1 = die pattern visible
    uLatent: { value: 0 },
    uHeat: { value: 0 },
    uMap: { value: 0 },
    uFlashDie: { value: new THREE.Vector2(-99, -99) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color('#c77dff') },
    uTime: { value: 0 },
    uThick: { value: 110 },
    uWet: { value: 0 },
    uWetColor: { value: new THREE.Color('#ffffff') },
    uIrid: { value: 0 },
  };

  constructor() {
    super({ color: 0xffffff, metalness: 1, roughness: 0.14, clearcoat: 0.25, clearcoatRoughness: 0.2, envMapIntensity: 0.8 });
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniformsRef);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvWUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          varying vec2 vWUv;
          uniform sampler2D uPattern;
          uniform sampler2D uDies;
          uniform float uRepeat, uDie, uClean, uCoatR, uResist, uPatterned, uLatent, uHeat, uMap, uFlash, uTime, uThick, uWet, uIrid;
          uniform vec2 uFlashDie;
          uniform vec3 uFlashColor, uWetColor;
          vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
          vec2 cdiv(vec2 a, vec2 b) { float d = dot(b,b); return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d; }
          vec2 cexp(float ph) { return vec2(cos(ph), sin(ph)); }
          // reflectance of air | resist(d1) | oxide(d2) | silicon at wavelength L (nm)
          float stackR(float d1, float d2, float L, float c) {
            float n0 = 1.0, n1 = 1.68, n2 = 1.46, n3 = 3.95;
            float r01 = (n0 - n1) / (n0 + n1);
            float r12 = (n1 - n2) / (n1 + n2);
            float r23 = (n2 - n3) / (n2 + n3);
            if (d1 < 0.5) r12 = (n0 - n2) / (n0 + n2);
            vec2 e2 = cexp(4.0 * PI * n2 * d2 * c / L);
            vec2 R12 = cdiv(vec2(r12, 0.0) + r23 * e2, vec2(1.0, 0.0) + r12 * r23 * e2);
            if (d1 < 0.5) return dot(R12, R12);
            vec2 e1 = cexp(4.0 * PI * n1 * d1 * c / L);
            vec2 r = cdiv(vec2(r01, 0.0) + cmul(R12, e1), vec2(1.0, 0.0) + r01 * cmul(R12, e1));
            return dot(r, r);
          }
          vec3 stackColor(float d1, float d2, float c) {
            vec3 R = vec3(stackR(d1, d2, 620.0, c), stackR(d1, d2, 540.0, c), stackR(d1, d2, 465.0, c));
            vec3 R2 = vec3(stackR(d1, d2, 660.0, c), stackR(d1, d2, 575.0, c), stackR(d1, d2, 440.0, c));
            vec3 col = (R + R2) * 0.5;
            // resist absorbs blue: amber body tint
            vec3 amber = vec3(1.0, 0.78, 0.46);
            col *= mix(vec3(1.0), amber, clamp(d1 / 260.0, 0.0, 1.0) * 0.85);
            return clamp(col * 1.55 + 0.04, 0.0, 1.0);
          }
          float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
          `,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          vec2 wp = vWUv * 2.0 - 1.0;
          float rr = length(wp);
          vec3 Vv = normalize(vViewPosition);
          float cI = clamp(abs(dot(normalize(vNormal), Vv)), 0.05, 1.0);
          float c1 = sqrt(1.0 - (1.0 - cI*cI) / (1.68*1.68));
          // die grid
          vec2 dg = wp / uDie;
          vec2 di = floor(dg);
          vec2 dq = fract(dg);
          vec4 dieInfo = texelFetch(uDies, ivec2(di) + ivec2(${DIE_OFF}), 0);
          float inDie = dieInfo.b * step(0.035, dq.x) * step(dq.x, 0.965) * step(0.035, dq.y) * step(dq.y, 0.965);
          vec4 pat = texture2D(uPattern, dq * uRepeat);
          // uniform resist film (before development), with spin-coat front and edge-bead removal
          float coatFront = smoothstep(uCoatR, uCoatR - 0.035, rr);
          float ebr = smoothstep(0.975, 0.962, rr);
          float resistNm = uResist * coatFront * ebr;
          // developed / etched pattern inside dies: resist-covered and cleared areas, mip-averaged
          float pmix = uPatterned * inDie;
          vec3 cUniform = stackColor(resistNm, 120.0, cI);
          vec3 cClear = stackColor(0.0, clamp(pat.g, 0.0, 1.0) * 120.0, cI);
          vec3 base = mix(cUniform, mix(cClear, cUniform, pat.r), pmix);
          float d1 = resistNm * mix(1.0, pat.r, pmix);
          // scribe streets slightly matte, and uniform die texture for fine patterns
          float street = dieInfo.b * (1.0 - inDie);
          // diffraction iridescence from the periodic die layout
          float iri = uIrid * inDie * uPatterned;
          float ang = dot(normalize(vNormal), Vv);
          base = mix(base, base * 0.55 + hue(fract(ang * 1.7 + wp.x * 0.35 + wp.y * 0.2 + 0.1)) * 0.55, iri * 0.55);
          // particles before cleaning
          float speck = step(0.992, hash12(floor(wp * 70.0))) * (1.0 - uClean) * step(rr, 0.96) * smoothstep(0.5, 0.2, length(fract(wp * 70.0) - 0.5));
          base = mix(base, vec3(0.05), speck * 0.9);
          // latent image: very faint in reality — shown as a violet tint
          float lat = uLatent * inDie * dieInfo.r * smoothstep(0.35, 0.9, pat.b);
          base = mix(base, base * vec3(0.72, 0.62, 0.95), lat * 0.7);
          // wetness (puddle)
          base = mix(base, base * uWetColor, uWet * 0.35);
          diffuseColor.rgb = base;
          `,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
          roughnessFactor = mix(0.12, 0.24, clamp(d1 / 200.0, 0.0, 1.0)) + street * 0.12 + speck * 0.5;
          roughnessFactor = mix(roughnessFactor, 0.05, uWet);
          `,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          // exposure flash on the die under the lens: the aerial image itself
          float isFlash = step(abs(di.x - uFlashDie.x), 0.1) * step(abs(di.y - uFlashDie.y), 0.1) * inDie;
          totalEmissiveRadiance += uFlashColor * isFlash * uFlash * (0.25 + 2.6 * pat.a * pat.a);
          totalEmissiveRadiance += uFlashColor * lat * 0.06;
          // hot plate glow reflected
          totalEmissiveRadiance += vec3(1.0, 0.42, 0.12) * uHeat * 0.05 * (1.0 - rr * 0.5);
          // yield map
          if (uMap > 0.001 && dieInfo.b > 0.5) {
            vec3 ok = vec3(0.3, 0.95, 0.7);
            vec3 bad = vec3(1.0, 0.3, 0.24);
            vec3 mc = mix(bad, ok, dieInfo.g);
            float e = min(min(dq.x, 1.0 - dq.x), min(dq.y, 1.0 - dq.y));
            float rim = smoothstep(0.1, 0.036, e) * inDie;
            float fill = mix(0.3, 0.02, dieInfo.g);
            totalEmissiveRadiance += mc * uMap * (inDie * fill + rim * mix(0.5, 0.22, dieInfo.g));
            diffuseColor.rgb *= mix(1.0, mix(0.5, 0.92, dieInfo.g), uMap);
          }
          `,
        );
    };
    this.customProgramCacheKey = () => 'wafer-v3';
  }
}

export function makeDieTexture() {
  const data = new Uint8Array(DIE_TEX * DIE_TEX * 4);
  const tex = new THREE.DataTexture(data, DIE_TEX, DIE_TEX, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Physical wafer object: patterned top, bevelled silicon edge, notch. */
export class WaferMesh extends THREE.Group {
  mat: WaferMaterial;
  top: THREE.Mesh;
  puddle: THREE.Mesh;
  puddleMat: THREE.MeshPhysicalMaterial;
  constructor() {
    super();
    this.mat = new WaferMaterial();
    const topGeo = new THREE.CircleGeometry(WAFER_R, 160);
    topGeo.rotateX(-Math.PI / 2);
    this.top = new THREE.Mesh(topGeo, this.mat);
    this.top.position.y = 0.012;
    this.top.receiveShadow = true;
    this.add(this.top);
    const edge = new THREE.Mesh(
      new THREE.CylinderGeometry(WAFER_R, WAFER_R * 0.995, 0.012, 160, 1, true),
      new THREE.MeshPhysicalMaterial({ color: 0x8c9098, metalness: 1, roughness: 0.25 }),
    );
    edge.position.y = 0.006;
    edge.castShadow = true;
    this.add(edge);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(WAFER_R * 0.995, 96), new THREE.MeshStandardMaterial({ color: 0x5b5e64, metalness: 0.8, roughness: 0.5 }));
    bottom.rotation.x = Math.PI / 2;
    this.add(bottom);
    this.puddleMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.03,
      transparent: true,
      opacity: 0.18,
      clearcoat: 1,
      envMapIntensity: 1.6,
      depthWrite: false,
    });
    const pg = new THREE.SphereGeometry(1, 64, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    this.puddle = new THREE.Mesh(pg, this.puddleMat);
    this.puddle.scale.set(0.001, 0.001, 0.001);
    this.puddle.position.y = 0.013;
    this.puddle.renderOrder = 5;
    this.add(this.puddle);
  }
  get u() {
    return this.mat.uniformsRef;
  }
}
