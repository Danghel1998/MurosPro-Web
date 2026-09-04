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
  asvci: 0xdc2626,      // Acero vertical cara interior (Asvci), varilla continua — rojo
  asvciBaston: 0xd946ef, // Asvci, bastón de tramo 1 (se corta en Lc) — magenta
  asvce: 0x2563eb,      // Acero vertical cara exterior (Asvce) — azul
  ashci: 0xef4444,      // Acero horizontal cara interior (Ash) — rojo claro
  ashce: 0x3b82f6,      // Acero horizontal cara exterior (Ash) — azul claro
  puntaMain: 0x00b140,  // Acero principal de la punta — verde
  talonMain: 0x9333ea,  // Acero principal del talón — morado
  transversal: 0xf97316, // Acero transversal de reparto — naranja
  dentellonVert: 0xea580c, // Acero vertical del dentellón (estribo en U) — naranja rojizo
  dentellonHoriz: 0xfacc15 // Acero horizontal del dentellón (ambas caras) — amarillo
};

// Multiplicador por defecto del radio de las varillas (ver comentario junto
// a `rebarScaleFactor` en el constructor).
const REBAR_EXAGGERATION = 3;

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
    // Sin damping: con inercia, cualquier evento de puntero espurio (foco,
    // redimensionado, etc.) puede acumular una rotación/zoom residual que
    // aleja la cámara del encuadre inicial sin que el usuario haya
    // arrastrado nada — con damping desactivado la posición es siempre un
    // ida-y-vuelta exacto (sin inercia) mientras no haya arrastre real.
    this.controls.enableDamping = false;

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

    // Subgrupos por tipo de acero, para poder mostrar/ocultar cada uno
    // desde la leyenda (checkboxes) sin reconstruir toda la geometría.
    this.rebarSubgroups = {};
    Object.keys(COLORS).forEach((key) => {
      const g = new THREE.Group();
      this.rebarSubgroups[key] = g;
      this.rebarGroup.add(g);
    });

    // Factor de exageración del diámetro de las varillas: el diámetro real
    // (p.ej. 1/2" = 12.7 mm) es casi invisible junto a un muro de varios
    // metros, así que por defecto se dibuja más grueso para poder verlas y
    // distinguir colores; `setRebarRealScale` permite verlas a su tamaño real.
    this.rebarScaleFactor = REBAR_EXAGGERATION;

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
      // Reintenta el tamaño en cada cuadro: si start() se llamó mientras el
      // contenedor estaba oculto (p.ej. otra pestaña principal activa),
      // clientWidth/Height eran 0 y el canvas se quedaba en blanco para
      // siempre — al ser visible más tarde, este reintento lo corrige solo.
      if (this.renderer.domElement.width < 2 || this.renderer.domElement.height < 2) {
        this.resize();
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this._animating = false;
  }

  /** Captura la vista 3D actual como PNG (data URL), para incrustarla en el
   * Plano. Si el contenedor está oculto (otra pestaña principal activa,
   * clientWidth/Height = 0), usa una resolución fija temporal solo para
   * este render — de lo contrario el canvas quedaría en blanco. No usa
   * preserveDrawingBuffer: toDataURL() se llama inmediatamente después de
   * render(), en la misma tarea síncrona, lo cual sí captura el frame
   * (el buffer no se descarta hasta el siguiente compuesto del navegador). */
  captureSnapshot(width = 900, height = 700) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const usesFallbackSize = w < 2 || h < 2;
    if (usesFallbackSize) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    let dataUrl = '';
    try {
      dataUrl = this.renderer.domElement.toDataURL('image/png');
    } catch (e) { /* contexto WebGL no disponible aún */ }
    if (usesFallbackSize) this.resize();
    return dataUrl;
  }

  updateData(wallData, geoResults, structResults) {
    this.wallData = wallData;
    this.structResults = structResults;
    if (!wallData || !structResults) return;
    this._clearGroup(this.concreteGroup);
    Object.values(this.rebarSubgroups).forEach((g) => this._clearGroup(g));
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

  /** Muestra u oculta un tipo de acero (clave de COLORS) en la vista 3D. */
  setRebarTypeVisible(key, visible) {
    const g = this.rebarSubgroups[key];
    if (g) g.visible = visible;
  }

  _stripDepth(geometry) {
    // Franja representativa de la longitud del muro (no todo el muro,
    // para que las varillas y su espaciamiento se vean con claridad).
    // Proporcional a H (no solo a B): con muros altos, una franja fija de
    // 1.2 m se veía como una "torre" delgada e inestable respecto a la
    // altura — se escala con H para dar una vista más estable/cúbica.
    return Math.min(2.5, Math.max(0.8, geometry.H * 0.35));
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
    shape.lineTo(B_toe + b_bot, H);
    shape.lineTo(B_toe + (b_bot - b_top), H);
    shape.lineTo(B_toe, hz);
    shape.lineTo(0, hz);
    shape.lineTo(0, 0);

    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    const material = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
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

  /** Agrega una barra al subgrupo de su tipo de acero (`key` de COLORS),
   * para poder mostrarlo/ocultarlo desde la leyenda sin reconstruir todo.
   * El radio se multiplica por `rebarScaleFactor` (ver setRebarRealScale). */
  _addBar(p1, p2, radius, key) {
    const mesh = this._bar(p1, p2, radius * this.rebarScaleFactor, COLORS[key]);
    if (mesh) this.rebarSubgroups[key].add(mesh);
  }

  /** Alterna entre ver las varillas a su diámetro real (`useReal=true`) o
   * exageradas (por defecto) para que se distingan a la escala del muro. */
  setRebarRealScale(useReal) {
    this.rebarScaleFactor = useReal ? 1 : REBAR_EXAGGERATION;
    if (!this.wallData || !this.structResults) return;
    Object.values(this.rebarSubgroups).forEach((g) => this._clearGroup(g));
    this._buildRebar(this.wallData, this.structResults);
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

    // --- 1. Asv Ci: acero vertical cara interior — una sola varilla continua
    // que alterna de color en el patrón de espaciamiento: roja (base a corona),
    // verde (base a Lc), roja, verde, etc. Todos con gancho en la base.
    // Los ganchos de Asvce/Asvci-roja/Asvci-verde se apilan en 3 niveles de
    // altura distintos (en vez de compartir la misma y) para que se vean uno
    // encima del otro en el 3D en lugar de cruzarse/superponerse.
    const rStem = str.stem.rebar.diameter_m / 2;
    const rExt = str.stem.rebarTemp.diameter_m / 2;
    const rToeMain = str.toe.rebar.diameter_m / 2;
    const yBaseCe = coverFoot + rToeMain + rExt;       // nivel 1 (más bajo): Asvce, sobre la parrilla
    const yBaseCiRed = yBaseCe + rExt + rStem;          // nivel 2: Asvci roja, encima de Asvce
    const yBaseCiGreen = yBaseCiRed + rStem + rStem;    // nivel 3 (más alto): Asvci verde, encima de la roja
    const xBack = B_toe + b_bot - coverStem;
    const yCutCi = Math.min(H, hz + str.stem.Lc_usar);
    const posZ = zPositions(str.stem.spacing);
    posZ.forEach((z, idx) => {
      const isRed = idx % 2 === 0; // par = rojo, impar = verde
      const colorKey = isRed ? 'asvci' : 'asvciBaston';
      const yBase = isRed ? yBaseCiRed : yBaseCiGreen;
      const yTop = isRed ? (H - coverStem) : yCutCi;
      const hookDir = isRed ? -0.25 : 0.25; // rojo hacia adentro, verde hacia afuera
      this._addBar(V(xBack, yBase, z), V(xBack + hookDir, yBase, z), rStem, colorKey); // gancho base
      this._addBar(V(xBack, yBase, z), V(xBack, yTop, z), rStem, colorKey);
      if (isRed) {
        this._addBar(V(xBack, H - coverStem, z), V(xBack - 0.25, H - coverStem, z), rStem, colorKey); // gancho corona
      }
    });

    // --- 2. Asv Ce: acero vertical cara exterior, sigue el batido de la
    // cara frontal — una sola varilla continua desde encima de la parrilla
    // inferior de la zapata (Acero Punta) hasta la corona, con un solo
    // espaciamiento (el más cerrado, de la base), sin economizar.
    const xFrontAt = (y) => B_toe + (b_bot - b_top) * ((y - hz) / H_stem) + coverStem;
    zPositions(str.stem.spacing_vert_ext_inferior).forEach((z) => {
      const xBase = xFrontAt(hz);
      const xTop = xFrontAt(H);
      this._addBar(V(xBase + 0.2, yBaseCe, z), V(xBase, yBaseCe, z), rExt, 'asvce'); // gancho base más corto
      this._addBar(V(xBase, yBaseCe, z), V(xTop, H - coverStem, z), rExt, 'asvce');
      this._addBar(V(xTop, H - coverStem, z), V(xTop + 0.2, H - coverStem, z), rExt, 'asvce'); // gancho corona más corto
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
        // Desplazada hacia adentro (mismo diámetro que Asvce) para no
        // compartir exactamente su misma posición X, lo que las hacía
        // atravesarse en cada cruce en vez de verse una al lado de la otra.
        const x = xFrontAt(y) + 2 * rExt;
        this._addBar(V(x, y, zStart), V(x, y, zEnd), rExt, 'ashce');
        this._addBar(V(x, y, zStart), V(x + hookCe, y, zStart), rExt, 'ashce'); // gancho horizontal girado 90° hacia adentro (dirección contraria)
        this._addBar(V(x, y, zEnd), V(x + hookCe, y, zEnd), rExt, 'ashce'); // gancho horizontal girado 90° hacia adentro (dirección contraria)
      }
      // Desplazada hacia adentro (mismo diámetro que Asvci) por la misma
      // razón: Asvci está exactamente en xBack, y compartir esa posición
      // hacía que ambas varillas se atravesaran en cada cruce.
      const xCiAsh = xBack - 2 * rStem;
      for (let y = yFrom + sCi / 2; y <= yTo - sCi / 2 + 1e-6; y += sCi) {
        this._addBar(V(xCiAsh, y, zStart), V(xCiAsh, y, zEnd), rStem, 'ashci');
        this._addBar(V(xCiAsh, y, zStart), V(xCiAsh - hookCi, y, zStart), rStem, 'ashci'); // gancho horizontal girado 90°
        this._addBar(V(xCiAsh, y, zEnd), V(xCiAsh - hookCi, y, zEnd), rStem, 'ashci'); // gancho horizontal girado 90°
      }
    };
    addHorizSet(hz, midY, str.stem.sp_ce_inferior, str.stem.sp_ci_inferior);
    addHorizSet(midY, H, str.stem.sp_ce_superior, str.stem.sp_ci_superior);

    // --- 4. Acero principal inferior y superior de la zapata, corrido en
    // todo su ancho (punta + talón), no solo bajo el miembro para el que
    // se calculó su As/espaciamiento — igual que en obra real, donde la
    // malla superior y la inferior son continuas. Gancho a 90° en ambos
    // extremos según el diámetro real de cada varilla (12·db, E.060/ACI
    // 318 cap. 25), no una longitud fija.
    const hookLen = (diameter_m) => Math.max(0.10, diameter_m * 12.0);

    const rToe = str.toe.rebar.diameter_m / 2;
    const hookToe = hookLen(str.toe.rebar.diameter_m);
    const yToe = coverFoot;
    zPositions(str.toe.spacing).forEach((z) => {
      this._addBar(V(coverFoot, yToe + hookToe, z), V(coverFoot, yToe, z), rToe, 'puntaMain'); // gancho frontal (hacia arriba)
      this._addBar(V(coverFoot, yToe, z), V(B - coverFoot, yToe, z), rToe, 'puntaMain');
      this._addBar(V(B - coverFoot, yToe, z), V(B - coverFoot, yToe + hookToe, z), rToe, 'puntaMain'); // gancho posterior
    });

    const rHeel = str.heel.rebar.diameter_m / 2;
    const hookHeel = hookLen(str.heel.rebar.diameter_m);
    const yHeel = hz - coverFoot;
    if (B_heel > 0.01) {
      zPositions(str.heel.spacing).forEach((z) => {
        this._addBar(V(coverFoot, yHeel - hookHeel, z), V(coverFoot, yHeel, z), rHeel, 'talonMain'); // gancho frontal (hacia abajo)
        this._addBar(V(coverFoot, yHeel, z), V(B - coverFoot, yHeel, z), rHeel, 'talonMain');
        this._addBar(V(B - coverFoot, yHeel, z), V(B - coverFoot, yHeel - hookHeel, z), rHeel, 'talonMain'); // gancho posterior (hacia abajo)
      });
    }

    // --- 5. Acero transversal de reparto (perpendicular al principal),
    // corrido en TODO el ancho de la zapata (no solo bajo su propio
    // miembro) y a lo largo del muro (eje Z), con gancho a 90° en ambos
    // extremos según su diámetro real (12·db) — igual criterio que las
    // varillas principales de la zapata.
    const rTrans = str.toe.rebarTemp.diameter_m / 2;
    const hookTrans = hookLen(str.toe.rebarTemp.diameter_m);
    xPositions(str.toe.spacing_trans, coverFoot * 1.5, B - coverFoot * 1.5).forEach((x) => {
      const y = yToe + rToe + rTrans;
      this._addBar(V(x, y, zStart), V(x, y, zEnd), rTrans, 'transversal');
      this._addBar(V(x, y, zStart), V(x, y + hookTrans, zStart), rTrans, 'transversal'); // gancho
      this._addBar(V(x, y, zEnd), V(x, y + hookTrans, zEnd), rTrans, 'transversal'); // gancho
    });
    if (B_heel > 0.01) {
      xPositions(str.heel.spacing_trans, coverFoot * 1.5, B - coverFoot * 1.5).forEach((x) => {
        const y = yHeel - rHeel - rTrans;
        this._addBar(V(x, y, zStart), V(x, y, zEnd), rTrans, 'transversal');
        this._addBar(V(x, y, zStart), V(x, y - hookTrans, zStart), rTrans, 'transversal'); // gancho
        this._addBar(V(x, y, zEnd), V(x, y - hookTrans, zEnd), rTrans, 'transversal'); // gancho
      });
    }

    // --- 6. Acero vertical del Dentellón (estribo en "U"), solo si está
    // habilitado: baja desde dentro de la zapata (anclaje), cruza el fondo
    // del dentellón y vuelve a subir por el otro lado, con gancho de anclaje
    // doblado hacia afuera (45°) en la parte superior de cada rama.
    if (geo.has_key && geo.key_depth > 0 && geo.key_width > 0) {
      const rKey = 0.75 * 0.0254 / 2; // Ø 3/4"
      const hookKey = hookLen(rKey * 2); // gancho según norma: 12·db de esta varilla
      const cosHook = Math.cos(THREE.MathUtils.degToRad(45));
      const sinHook = Math.sin(THREE.MathUtils.degToRad(45));
      const xKeyL = geo.key_pos + coverFoot;
      const xKeyR = geo.key_pos + geo.key_width - coverFoot;
      // El gancho se engancha en el Acero Transversal de Reparto cercano al
      // Acero Superior de Zapata (talón): la rama recta sube derecho hasta
      // el nivel mismo de esa varilla transversal (yTransHeelLevel, sin
      // pasarse de altura) y justo ahí se dobla en diagonal (45°) hacia
      // abajo/adentro, con la longitud de gancho según norma (12·db).
      const yTransHeelLevel = B_heel > 0.01 ? (yHeel - rHeel - rTrans) : (yHeel - rHeel);
      const yBendKey = yTransHeelLevel + 3 * rTrans; // un poco encima del transversal, como agarrándolo
      const yBottomKey = -geo.key_depth + coverFoot; // fondo del dentellón
      zPositions(15).forEach((z) => {
        this._addBar(V(xKeyL, yBottomKey, z), V(xKeyL, yBendKey, z), rKey, 'dentellonVert'); // rama izquierda
        this._addBar(V(xKeyL, yBendKey, z), V(xKeyL + hookKey * cosHook, yBendKey - hookKey * sinHook, z), rKey, 'dentellonVert'); // gancho izquierdo, se dobla justo al enganchar
        this._addBar(V(xKeyL, yBottomKey, z), V(xKeyR, yBottomKey, z), rKey, 'dentellonVert'); // fondo
        this._addBar(V(xKeyR, yBottomKey, z), V(xKeyR, yBendKey, z), rKey, 'dentellonVert'); // rama derecha
        this._addBar(V(xKeyR, yBendKey, z), V(xKeyR - hookKey * cosHook, yBendKey - hookKey * sinHook, z), rKey, 'dentellonVert'); // gancho derecho, se dobla justo al enganchar
      });

      // --- 7. Acero horizontal del Dentellón (ambas caras), mismo criterio
      // que el Ash de la pantalla (barras horizontales apiladas en altura,
      // con gancho en los extremos), usando el diámetro del acero de
      // temperatura ya calculado (compartido con el transversal de la zapata).
      const rDentH = str.toe.rebarTemp.diameter_m / 2;
      const spDentH = Math.max(0.03, (str.toe.spacing_trans || 20) / 100);
      const hookDentH = Math.max(0.06, str.toe.rebarTemp.diameter_m * 12);
      // Desplazadas hacia adentro (suma de radios con dentellonVert) por la
      // misma razón que Ash/Asvci: compartir la misma X con la rama vertical
      // hacía que ambas varillas se atravesaran en cada cruce.
      const xCiHL = xKeyL + rKey + rDentH;
      const xCiHR = xKeyR - rKey - rDentH;
      const yFirstRowDentH = yBottomKey + spDentH / 2;
      for (let y = yFirstRowDentH; y <= yBendKey - spDentH / 2 + 1e-6; y += spDentH) {
        this._addBar(V(xCiHL, y, zStart), V(xCiHL, y, zEnd), rDentH, 'dentellonHoriz'); // cara izquierda
        this._addBar(V(xCiHL, y, zStart), V(xCiHL + hookDentH, y, zStart), rDentH, 'dentellonHoriz'); // gancho
        this._addBar(V(xCiHL, y, zEnd), V(xCiHL + hookDentH, y, zEnd), rDentH, 'dentellonHoriz'); // gancho
        this._addBar(V(xCiHR, y, zStart), V(xCiHR, y, zEnd), rDentH, 'dentellonHoriz'); // cara derecha
        this._addBar(V(xCiHR, y, zStart), V(xCiHR - hookDentH, y, zStart), rDentH, 'dentellonHoriz'); // gancho
        this._addBar(V(xCiHR, y, zEnd), V(xCiHR - hookDentH, y, zEnd), rDentH, 'dentellonHoriz'); // gancho
      }
      // Acero horizontal adicional, en el centro del ancho, apoyado justo
      // encima del acero de fondo (rama inferior del acero vertical del
      // dentellón) — no a media altura del primer tramo, para que no quede
      // flotando sin tocar esa varilla.
      const xKeyMid = (xKeyL + xKeyR) / 2;
      const yOverBottomKey = yBottomKey + rKey + rDentH;
      this._addBar(V(xKeyMid, yOverBottomKey, zStart), V(xKeyMid, yOverBottomKey, zEnd), rDentH, 'dentellonHoriz');
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
