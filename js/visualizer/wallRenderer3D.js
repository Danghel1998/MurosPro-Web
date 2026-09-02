/**
 * Vista 3D interactiva (Three.js) del detalle de armaduras de una franja
 * representativa del muro (1.2 m de longitud), a partir de los mismos
 * resultados estructurales (str.stem/toe/heel) que usa el detalle 2D.
 * No reemplaza el visualizador 2D — es un modo adicional ("Detalle 3D")
 * pensado para inspeccionar visualmente cómo se cruzan las varillas.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COLORS = {
  asvci: 0xdc2626,      // Acero vertical cara interior (Asvci) — rojo
  asvce: 0x2563eb,      // Acero vertical cara exterior (Asvce) — azul
  ashci: 0xef4444,      // Acero horizontal cara interior (Ash) — rojo claro
  ashce: 0x3b82f6,      // Acero horizontal cara exterior (Ash) — azul claro
  puntaMain: 0x16a34a,  // Acero principal de la punta — verde
  talonMain: 0x9333ea,  // Acero principal del talón — morado
  transversal: 0xf59e0b // Acero transversal de reparto — ámbar
};

export class WallRenderer3D {
  constructor(container) {
    this.container = container;
    this.wallData = null;
    this.structResults = null;
    this._animating = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeef2f7);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(4, 8, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-5, 4, -6);
    this.scene.add(fill);

    this.concreteGroup = new THREE.Group();
    this.rebarGroup = new THREE.Group();
    this.scene.add(this.concreteGroup, this.rebarGroup);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._clearGroup(this.concreteGroup);
    this._clearGroup(this.rebarGroup);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  start() {
    this.resize();
    if (this._animating) return;
    this._animating = true;
    const loop = () => {
      if (!this._animating) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this._animating = false;
  }

  updateData(wallData, geoResults, structResults) {
    this.wallData = wallData;
    this.structResults = structResults;
    if (!wallData || !structResults) return;
    this._clearGroup(this.concreteGroup);
    this._clearGroup(this.rebarGroup);
    this._buildConcrete(wallData);
    this._buildRebar(wallData, structResults);
    this._fitCamera(wallData.geometry);
  }

  _clearGroup(group) {
    while (group.children.length) {
      const obj = group.children.pop();
      obj.geometry?.dispose();
      obj.material?.dispose();
    }
  }

  _stripDepth(geometry) {
    // Franja representativa de la longitud del muro (no todo el muro,
    // para que las varillas y su espaciamiento se vean con claridad).
    return Math.min(1.2, Math.max(0.6, geometry.B * 0.4));
  }

  _buildConcrete(w) {
    const geo = w.geometry;
    const H = geo.H, hz = geo.hz, B = geo.B, B_toe = geo.B_toe, b_bot = geo.b_bot, b_top = geo.b_top;
    const depth = this._stripDepth(geo);

    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(B, 0);
    shape.lineTo(B, hz);
    shape.lineTo(B_toe + b_bot, hz);
    shape.lineTo(B_toe + (b_bot - b_top), H);
    shape.lineTo(B_toe, hz);
    shape.lineTo(0, hz);
    shape.lineTo(0, 0);

    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    const material = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1, transparent: true, opacity: 0.28, side: THREE.DoubleSide,
      roughness: 0.9, metalness: 0.0, depthWrite: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = -depth / 2;
    this.concreteGroup.add(mesh);

    const edges = new THREE.EdgesGeometry(geometry, 20);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.5 }));
    line.position.z = -depth / 2;
    this.concreteGroup.add(line);

    if (geo.has_key && geo.key_depth > 0 && geo.key_width > 0) {
      const keyGeo = new THREE.BoxGeometry(geo.key_width, geo.key_depth, depth);
      const keyMesh = new THREE.Mesh(keyGeo, material);
      keyMesh.position.set(geo.key_pos + geo.key_width / 2, -geo.key_depth / 2, 0);
      this.concreteGroup.add(keyMesh);
    }
  }

  /** Cilindro recto entre dos puntos p1->p2 (Vector3), de radio dado. */
  _bar(p1, p2, radius, color) {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const length = dir.length();
    if (length < 1e-4) return null;
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 8, 1, false);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.55 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(p1).add(p2).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return mesh;
  }

  _addBar(p1, p2, radius, color) {
    const mesh = this._bar(p1, p2, radius, color);
    if (mesh) this.rebarGroup.add(mesh);
  }

  _buildRebar(w, str) {
    const geo = w.geometry;
    const mats = w.materials;
    const H = geo.H, hz = geo.hz, B = geo.B, B_toe = geo.B_toe, b_bot = geo.b_bot, b_top = geo.b_top;
    const B_heel = Math.max(0, B - B_toe - b_bot);
    const H_stem = Math.max(0.001, H - hz);
    const depth = this._stripDepth(geo);
    const zStart = -depth / 2, zEnd = depth / 2;

    const coverStem = mats.cover_stem ?? 0.04;
    const coverFoot = mats.cover_footing ?? 0.075;

    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const zPositions = (spacingCm) => {
      const s = Math.max(0.03, (spacingCm || 20) / 100);
      const list = [];
      for (let z = zStart + s / 2; z <= zEnd - s / 2 + 1e-6; z += s) list.push(z);
      return list.length ? list : [0];
    };
    const xPositions = (spacingCm, x0, x1) => {
      const s = Math.max(0.03, (spacingCm || 20) / 100);
      const list = [];
      for (let x = x0 + s / 2; x <= x1 - s / 2 + 1e-6; x += s) list.push(x);
      return list.length ? list : [(x0 + x1) / 2];
    };

    // --- 1. Asv Ci: acero vertical cara interior (cara del talón), con
    // gancho en la base y corte a Lc (continúa más delgado hasta la corona).
    const rStem = str.stem.rebar.diameter_m / 2;
    const rStemThin = Math.max(0.004, rStem * 0.6);
    const xBack = B_toe + b_bot - coverStem;
    const yCutCi = Math.min(H, hz + str.stem.Lc_usar);
    zPositions(str.stem.spacing).forEach((z) => {
      this._addBar(V(xBack - 0.35, coverFoot, z), V(xBack, coverFoot, z), rStem, COLORS.asvci); // gancho
      this._addBar(V(xBack, coverFoot, z), V(xBack, yCutCi, z), rStem, COLORS.asvci);
      this._addBar(V(xBack, yCutCi, z), V(xBack, H - coverStem, z), rStemThin, COLORS.asvci);
    });

    // --- 2. Asv Ce: acero vertical cara exterior, sigue el batido de la
    // cara frontal desde la base hasta la corona (gancho hacia afuera).
    const rExt = str.stem.rebarTemp.diameter_m / 2;
    const xFrontAt = (y) => B_toe + (b_bot - b_top) * ((y - hz) / H_stem) + coverStem;
    zPositions(str.stem.spacing_vert_ext).forEach((z) => {
      const xBase = xFrontAt(hz);
      this._addBar(V(xBase - 0.3, coverFoot, z), V(xBase, coverFoot, z), rExt, COLORS.asvce);
      this._addBar(V(xBase, coverFoot, z), V(xFrontAt(H), H - coverStem, z), rExt, COLORS.asvce);
    });

    // --- 3. Ash: acero horizontal del vástago ("Rep." en la memoria de
    // referencia), dos tramos (base->media, media->corona) y dos caras
    // (exterior 2/3, interior 1/3). Cada barra lleva su gancho típico
    // (doblez de ~12·db hacia arriba) en ambos extremos de la franja, igual
    // que en el despiece de referencia.
    const midY = hz + H_stem * 0.5;
    const addHorizSet = (yFrom, yTo, spacingCeCm, spacingCiCm) => {
      const sCe = Math.max(0.03, (spacingCeCm || 20) / 100);
      const sCi = Math.max(0.03, (spacingCiCm || 20) / 100);
      const hookCe = Math.max(0.06, str.stem.rebarTemp.diameter_m * 12);
      const hookCi = Math.max(0.06, str.stem.rebar.diameter_m * 12);
      for (let y = yFrom + sCe / 2; y <= yTo - sCe / 2 + 1e-6; y += sCe) {
        const x = xFrontAt(y);
        this._addBar(V(x, y, zStart), V(x, y, zEnd), rExt, COLORS.ashce);
        this._addBar(V(x, y, zStart), V(x, y + hookCe, zStart), rExt, COLORS.ashce);
        this._addBar(V(x, y, zEnd), V(x, y + hookCe, zEnd), rExt, COLORS.ashce);
      }
      for (let y = yFrom + sCi / 2; y <= yTo - sCi / 2 + 1e-6; y += sCi) {
        this._addBar(V(xBack, y, zStart), V(xBack, y, zEnd), rStem, COLORS.ashci);
        this._addBar(V(xBack, y, zStart), V(xBack, y + hookCi, zStart), rStem, COLORS.ashci);
        this._addBar(V(xBack, y, zEnd), V(xBack, y + hookCi, zEnd), rStem, COLORS.ashci);
      }
    };
    addHorizSet(hz, midY, str.stem.sp_ce_inferior, str.stem.sp_ci_inferior);
    addHorizSet(midY, H, str.stem.sp_ce_superior, str.stem.sp_ci_superior);

    // --- 4. Acero principal de la Punta (inferior, con gancho al borde
    // frontal) y del Talón (superior, con gancho al borde posterior).
    const rToe = str.toe.rebar.diameter_m / 2;
    const yToe = coverFoot;
    const xToeEmbed = B_toe + b_bot * 0.6;
    zPositions(str.toe.spacing).forEach((z) => {
      this._addBar(V(coverFoot, hz - coverFoot, z), V(coverFoot, yToe, z), rToe, COLORS.puntaMain); // gancho
      this._addBar(V(coverFoot, yToe, z), V(xToeEmbed, yToe, z), rToe, COLORS.puntaMain);
    });

    const rHeel = str.heel.rebar.diameter_m / 2;
    const yHeel = hz - coverFoot;
    const xHeelEmbed = B_toe + b_bot * 0.4;
    if (B_heel > 0.01) {
      zPositions(str.heel.spacing).forEach((z) => {
        this._addBar(V(xHeelEmbed, yHeel, z), V(B - coverFoot, yHeel, z), rHeel, COLORS.talonMain);
        this._addBar(V(B - coverFoot, yHeel, z), V(B - coverFoot, coverFoot, z), rHeel, COLORS.talonMain); // gancho
      });
    }

    // --- 5. Acero transversal de reparto (perpendicular al principal),
    // compartido entre punta y talón.
    const rTrans = str.toe.rebarTemp.diameter_m / 2;
    xPositions(str.toe.spacing_trans, coverFoot * 1.5, B_toe - coverFoot).forEach((x) => {
      this._addBar(V(x, yToe + rToe + rTrans, zStart), V(x, yToe + rToe + rTrans, zEnd), rTrans, COLORS.transversal);
    });
    if (B_heel > 0.01) {
      xPositions(str.heel.spacing_trans, B_toe + b_bot + coverFoot, B - coverFoot * 1.5).forEach((x) => {
        this._addBar(V(x, yHeel - rHeel - rTrans, zStart), V(x, yHeel - rHeel - rTrans, zEnd), rTrans, COLORS.transversal);
      });
    }
  }

  _fitCamera(geometry) {
    const H = geometry.H, B = geometry.B;
    const depth = this._stripDepth(geometry);
    const target = new THREE.Vector3(B / 2, H / 2.4, 0);
    this.controls.target.copy(target);
    // Ángulo fijo (no depende del aspecto H/B/depth) para que el encuadre
    // inicial siempre sea una vista en 3/4 razonable, aunque el muro sea
    // mucho más alto que profundo (la franja representativa es angosta).
    const maxDim = Math.max(H, B, depth);
    const distance = maxDim * 1.9;
    const azimuth = THREE.MathUtils.degToRad(35);
    const elevation = THREE.MathUtils.degToRad(22);
    this.camera.position.set(
      target.x + distance * Math.cos(elevation) * Math.sin(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + distance * Math.cos(elevation) * Math.cos(azimuth)
    );
    this.camera.near = Math.max(0.01, distance / 200);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
