/**
 * Motor gráfico interactivo HTML5 Canvas 2D para visualización paramétrica
 * de muros de contención en voladizo, cuñas de presiones y despiece de armaduras.
 */

import { degToRad } from '../engine/soilPressures.js';

export class WallCanvasRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    // Estado de vista (Pan y Zoom)
    this.viewMode = 'geometry'; // 'geometry' | 'pressures' | 'rebar'
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    this.wallData = null;
    this.geoResults = null;
    this.structResults = null;

    this.setupEvents();
  }

  setupEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX - this.panX;
      this.dragStartY = e.clientY - this.panY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.panX = e.clientX - this.dragStartX;
      this.panY = e.clientY - this.dragStartY;
      this.render();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      this.zoom = Math.max(0.4, Math.min(3.0, this.zoom * zoomFactor));
      this.render();
    });

    window.addEventListener('resize', () => {
      this.resizeCanvas();
      this.render();
    });
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.render();
  }

  /**
   * Renderiza temporalmente en otro modo de vista (p.ej. 'forces' o
   * 'pressures') para capturar una imagen PNG destinada a la Memoria de
   * Cálculo, sin alterar la vista interactiva que el usuario tiene activa.
   * `viewState` permite pasar un zoom/panX/panY propios (independientes
   * del zoom interactivo), para que cada esquema del informe se pueda
   * acercar/mover por separado.
   */
  captureSnapshot(mode, viewState) {
    const prevMode = this.viewMode;
    const prevZoom = this.zoom, prevPanX = this.panX, prevPanY = this.panY;
    this.viewMode = mode;
    if (viewState) {
      if (viewState.zoom !== undefined) this.zoom = viewState.zoom;
      if (viewState.panX !== undefined) this.panX = viewState.panX;
      if (viewState.panY !== undefined) this.panY = viewState.panY;
    }
    this.render();
    let dataUrl = '';
    try {
      dataUrl = this.canvas.toDataURL('image/png');
    } catch (e) { /* canvas no disponible aún */ }
    this.viewMode = prevMode;
    this.zoom = prevZoom;
    this.panX = prevPanX;
    this.panY = prevPanY;
    this.render();
    return dataUrl;
  }

  resetView() {
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.render();
  }

  resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    // Si el contenedor está oculto (p.ej. porque la pestaña activa es
    // "Memoria de Cálculo" en vez de "Visualizador 2D"), getBoundingClientRect
    // devuelve 0x0. Ignorar ese caso evita colapsar el canvas a tamaño cero
    // (lo que deja capturas en blanco en los esquemas del informe) cuando un
    // resize de ventana ocurre mientras el visualizador no está visible.
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
  }

  updateData(wallData, geoResults, structResults) {
    this.wallData = wallData;
    this.geoResults = geoResults;
    this.structResults = structResults;
    this.render();
  }

  render() {
    if (!this.wallData || !this.geoResults) return;

    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    const ctx = this.ctx;

    // Limpiar fondo
    ctx.clearRect(0, 0, width, height);

    // Fondo con cuadrícula sutil tipo plano técnico
    this.drawGrid(width, height);

    // Configurar sistema de coordenadas mundo -> pantalla
    const { geometry, backfill } = this.wallData;
    const H = geometry.H;
    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const b_top = geometry.b_top;
    const hz = geometry.hz;
    const B_heel = Math.max(0, B - B_toe - b_bot);

    // Escala base (píxeles por metro)
    const margin = 80;
    // El modo "local_pressures" no dibuja cotas ni cuñas de empuje a los
    // lados, así que usa márgenes más ajustados para que el esquema
    // aproveche mejor el recuadro en vez de verse pequeño y centrado.
    const isLocalPressures = this.viewMode === 'local_pressures';

    // Región de mundo a encuadrar (por defecto, el muro completo). Los
    // esquemas recortados a un solo miembro (pantalla/punta/talón) definen
    // su propia región para acercarse solo a esa parte.
    let focusXMin = -1.5, focusXMax = B + 1.5;
    let focusYMin = -0.5, focusYMax = H + 1.8;
    let xOffset = -40; // ajuste fino existente para los modos con cotas a la izquierda

    if (isLocalPressures) {
      focusXMin = -0.6; focusXMax = B + 0.6;
      focusYMin = -0.5; focusYMax = H + 1.0;
      xOffset = -40;
    } else if (this.viewMode === 'stem_forces') {
      focusXMin = B_toe - 0.5; focusXMax = B_toe + b_bot + 2.4;
      focusYMin = -0.3; focusYMax = H + 0.6;
      xOffset = 0;
    } else if (this.viewMode === 'toe_forces') {
      focusXMin = -2.0; focusXMax = B_toe + b_bot * 0.5 + 0.3;
      focusYMin = -0.4; focusYMax = hz + 2.2;
      xOffset = 0;
    } else if (this.viewMode === 'heel_forces') {
      focusXMin = B_toe + b_bot * 0.5 - 0.3; focusXMax = B + 2.2;
      focusYMin = -0.4; focusYMax = hz + 2.2;
      xOffset = 0;
    }

    const totalWorldWidth = focusXMax - focusXMin;
    const totalWorldHeight = focusYMax - focusYMin;
    const worldCenterX = (focusXMin + focusXMax) / 2;
    const worldCenterY = (focusYMin + focusYMax) / 2;

    const scaleX = (width - margin * 2) / totalWorldWidth;
    const scaleY = (height - margin * 2) / totalWorldHeight;
    const baseScale = Math.min(scaleX, scaleY) * this.zoom;

    // Origen de coordenadas del muro (Punto O: Esquina inferior frontal de la zapata)
    // x = 0, y = 0 en el suelo bajo la puntera
    const originX = (width / 2) - worldCenterX * baseScale + this.panX + xOffset;
    const originY = (height / 2) + worldCenterY * baseScale + this.panY;

    const toScreenX = (x) => originX + x * baseScale;
    const toScreenY = (y) => originY - y * baseScale; // Y positivo hacia arriba en el mundo

    // 1. Dibujar Suelos y Estratos
    this.drawSoilAndBackfill(ctx, toScreenX, toScreenY, baseScale);

    // 2. Dibujar Estructura de Hormigón del Muro
    this.drawConcreteWall(ctx, toScreenX, toScreenY, baseScale);

    // 3. Dibujar según el modo activo
    if (this.viewMode === 'geometry') {
      this.drawDimensions(ctx, toScreenX, toScreenY, baseScale);
      this.drawLoads(ctx, toScreenX, toScreenY, baseScale);
    } else if (this.viewMode === 'pressures') {
      this.drawPressureWedges(ctx, toScreenX, toScreenY, baseScale);
      this.drawBasePressureDistribution(ctx, toScreenX, toScreenY, baseScale);
    } else if (this.viewMode === 'forces') {
      this.drawDimensions(ctx, toScreenX, toScreenY, baseScale);
      this.drawVerticalForceArrows(ctx, toScreenX, toScreenY, baseScale);
    } else if (this.viewMode === 'local_pressures') {
      this.drawBasePressureDistribution(ctx, toScreenX, toScreenY, baseScale);
      this.drawLocalPressureLoads(ctx, toScreenX, toScreenY, baseScale);
    } else if (this.viewMode === 'rebar') {
      this.drawRebarDetailing(ctx, toScreenX, toScreenY, baseScale);
    }

    // Marca de agua y leyenda de escala
    this.drawOverlayInfo(ctx, width, height, baseScale);
  }

  drawGrid(width, height) {
    const ctx = this.ctx;
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;

    const gridSize = 30;
    for (let x = 0; x < width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  drawSoilAndBackfill(ctx, toX, toY, scale) {
    const { geometry, backfill, loads } = this.wallData;
    const H = geometry.H;
    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const b_top = geometry.b_top;
    const hz = geometry.hz;
    const t_tri = Math.max(0, b_bot - b_top);
    const beta = backfill.beta || 0;
    const Df = geometry.Df || hz;

    // --- Suelo Delantero (Frente a la puntera) ---
    // Si Df supera hz, el terreno de desplante también cubre la puntera
    // (y, de ser el caso, la base del cartabón batido del vástago); el
    // borde derecho se extiende de forma segura más allá de la puntera —
    // el hormigón de la zapata/vástago se dibuja encima y lo cubrirá donde
    // corresponda, dejando visible el suelo solo donde realmente aplica.
    const groundLevelFront = Df;
    const frontSoilRightX = B_toe + t_tri + 0.05;
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(toX(-2.5), toY(0));
    ctx.lineTo(toX(frontSoilRightX), toY(0));
    ctx.lineTo(toX(frontSoilRightX), toY(groundLevelFront));
    ctx.lineTo(toX(-2.5), toY(groundLevelFront));
    ctx.closePath();
    ctx.fill();

    // Línea de terreno natural frontal
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(toX(-2.5), toY(groundLevelFront));
    ctx.lineTo(toX(frontSoilRightX), toY(groundLevelFront));
    ctx.stroke();

    // Textura de terreno / grama frontal
    this.drawGroundPattern(ctx, toX(-2.5), toY(groundLevelFront), toX(frontSoilRightX), toY(groundLevelFront));

    // --- Suelo de Relleno Posterior ---
    const heelBackX = B;
    const stemBackX = B_toe + b_bot;
    const backfillExtentX = B + 2.5;
    const slopeHeight = (backfillExtentX - stemBackX) * Math.tan(degToRad(beta));

    ctx.fillStyle = '#fef3c7'; // Tono terroso cálido suave
    ctx.beginPath();
    ctx.moveTo(toX(stemBackX), toY(hz));
    ctx.lineTo(toX(heelBackX), toY(hz));
    ctx.lineTo(toX(heelBackX), toY(0));
    ctx.lineTo(toX(backfillExtentX), toY(0));
    ctx.lineTo(toX(backfillExtentX), toY(H + slopeHeight));
    ctx.lineTo(toX(stemBackX), toY(H));
    ctx.closePath();
    ctx.fill();

    // Línea de talud / superficie del relleno
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(toX(stemBackX), toY(H));
    ctx.lineTo(toX(backfillExtentX), toY(H + slopeHeight));
    ctx.stroke();

    // --- Nivel Freático (si aplica) ---
    if (loads.has_water_table && loads.hw > 0) {
      const hw = Math.min(loads.hw, H);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.25)'; // Azul translúcido
      ctx.beginPath();
      ctx.moveTo(toX(stemBackX), toY(0));
      ctx.lineTo(toX(backfillExtentX), toY(0));
      ctx.lineTo(toX(backfillExtentX), toY(hw));
      ctx.lineTo(toX(stemBackX), toY(hw));
      ctx.closePath();
      ctx.fill();

      // Línea freática ondulada / discontinua
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(toX(stemBackX), toY(hw));
      ctx.lineTo(toX(backfillExtentX), toY(hw));
      ctx.stroke();
      ctx.setLineDash([]);

      // Símbolo de nivel freático (triángulo invertido con líneas)
      const symX = toX(stemBackX + 1.0);
      const symY = toY(hw);
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.moveTo(symX - 7, symY - 10);
      ctx.lineTo(symX + 7, symY - 10);
      ctx.lineTo(symX, symY);
      ctx.closePath();
      ctx.fill();
      
      ctx.fillStyle = '#0369a1';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.fillText(`N.F. (hw = ${hw.toFixed(2)}m)`, symX + 12, symY - 3);
    }
  }

  drawGroundPattern(ctx, x1, y1, x2, y2) {
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.2;
    const step = 15;
    for (let x = x1; x <= x2; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x - 8, y1 + 10);
      ctx.stroke();
    }
  }

  drawConcreteWall(ctx, toX, toY, scale) {
    const { geometry } = this.wallData;
    const H = geometry.H;
    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const b_top = geometry.b_top;
    const hz = geometry.hz;
    const H_stem = H - hz;

    // Vértices del muro de hormigón
    // Zapata: (0,0) -> (B,0) -> (B, hz) -> (B_toe + b_bot, hz) ...
    // Vástago: ... -> (B_toe + b_bot, H) -> (B_toe + b_bot - b_top, H) -> (B_toe, hz) -> (0, hz) -> (0,0)
    const stemBackX = B_toe + b_bot;
    const stemTopFrontX = stemBackX - b_top;
    const stemBotFrontX = B_toe;

    ctx.save();

    // Relleno de hormigón con degradado elegante
    const grad = ctx.createLinearGradient(toX(0), toY(H), toX(B), toY(0));
    grad.addColorStop(0, '#94a3b8');
    grad.addColorStop(0.5, '#cbd5e1');
    grad.addColorStop(1, '#64748b');

    ctx.fillStyle = grad;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'miter';

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(0)); // 1. Esquina frontal base zapata
    
    // Tacón / Dentellón opcional en la base
    if (geometry.has_key && geometry.key_depth > 0 && geometry.key_width > 0) {
      const kx1 = geometry.key_pos;
      const kx2 = geometry.key_pos + geometry.key_width;
      const ky = -geometry.key_depth;

      ctx.lineTo(toX(kx1), toY(0));
      ctx.lineTo(toX(kx1), toY(ky));
      ctx.lineTo(toX(kx2), toY(ky));
      ctx.lineTo(toX(kx2), toY(0));
    }

    ctx.lineTo(toX(B), toY(0)); // 2. Esquina trasera base zapata
    ctx.lineTo(toX(B), toY(hz)); // 3. Esquina trasera superior zapata
    ctx.lineTo(toX(stemBackX), toY(hz)); // 4. Unión talón-vástago
    ctx.lineTo(toX(stemBackX), toY(H)); // 5. Coronación trasera
    ctx.lineTo(toX(stemTopFrontX), toY(H)); // 6. Coronación delantera
    ctx.lineTo(toX(stemBotFrontX), toY(hz)); // 7. Unión vástago-puntera
    ctx.lineTo(toX(0), toY(hz)); // 8. Esquina frontal superior zapata
    ctx.closePath();

    ctx.fill();
    ctx.stroke();

    // Línea divisoria tenue de vaciado zapata-vástago (junta de construcción)
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.35)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(toX(stemBotFrontX), toY(hz));
    ctx.lineTo(toX(stemBackX), toY(hz));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  drawDimensions(ctx, toX, toY, scale) {
    const { geometry } = this.wallData;
    const H = geometry.H;
    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const b_top = geometry.b_top;
    const hz = geometry.hz;
    const Df = geometry.Df || hz;
    const H_stem = H - hz;
    const B_heel = Math.max(0, B - B_toe - b_bot);
    const stemBackX = B_toe + b_bot;
    const stemTopFrontX = stemBackX - b_top;
    const stemBotFrontX = B_toe;

    ctx.save();
    ctx.fillStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.font = '500 12px Inter, sans-serif';

    // --- Cotas verticales a la izquierda: H (total), Hp (vástago libre) y
    // h1 (profundidad de desplante), apiladas como en el esquema de cátedra ---
    ctx.strokeStyle = '#dc2626'; // rojo
    this.drawDimLine(ctx, toX(-1.55), toY(0), toX(-1.55), toY(H), `H = ${H.toFixed(2)} m`, 'left');
    this.drawProjLine(ctx, toX(0), toY(0), toX(-1.65), toY(0));
    this.drawProjLine(ctx, toX(stemTopFrontX), toY(H), toX(-1.65), toY(H));

    this.drawDimLine(ctx, toX(-1.05), toY(hz), toX(-1.05), toY(H), `Hp = ${H_stem.toFixed(2)} m`, 'left');
    this.drawProjLine(ctx, toX(0), toY(hz), toX(-1.15), toY(hz));

    if (Df > 0.01) {
      this.drawDimLine(ctx, toX(-0.5), toY(0), toX(-0.5), toY(Df), `h1 = ${Df.toFixed(2)} m`, 'left');
      this.drawProjLine(ctx, toX(0), toY(Df), toX(-0.6), toY(Df));
    }

    // --- Cota del espesor de zapata "e" a la DERECHA, en verde ---
    ctx.strokeStyle = '#16a34a';
    this.drawDimLine(ctx, toX(B + 0.4), toY(0), toX(B + 0.4), toY(hz), `e = ${hz.toFixed(2)} m`, 'right');
    this.drawProjLine(ctx, toX(B), toY(0), toX(B + 0.5), toY(0));
    this.drawProjLine(ctx, toX(B), toY(hz), toX(B + 0.5), toY(hz));

    // --- Cota Ancho de Zapata B (abajo, azul) ---
    ctx.strokeStyle = '#2563eb';
    const dimY_B = -1.35;
    this.drawDimLine(ctx, toX(0), toY(dimY_B), toX(B), toY(dimY_B), `B = ${B.toFixed(2)} m`, 'bottom');
    this.drawProjLine(ctx, toX(0), toY(0), toX(0), toY(dimY_B - 0.1));
    this.drawProjLine(ctx, toX(B), toY(0), toX(B), toY(dimY_B - 0.1));

    // --- Cotas parciales: Punta (P), Base del vástago (F = t2), Talón (T) ---
    const dimY_parts = -0.5;
    this.drawDimLine(ctx, toX(0), toY(dimY_parts), toX(B_toe), toY(dimY_parts), `P = ${B_toe.toFixed(2)} m`, 'bottom');
    this.drawDimLine(ctx, toX(B_toe), toY(dimY_parts), toX(stemBackX), toY(dimY_parts), `F = ${b_bot.toFixed(2)} m`, 'bottom');
    if (B_heel > 0.1) {
      this.drawDimLine(ctx, toX(stemBackX), toY(dimY_parts), toX(B), toY(dimY_parts), `T = ${B_heel.toFixed(2)} m`, 'bottom');
    }
    this.drawProjLine(ctx, toX(B_toe), toY(hz), toX(B_toe), toY(dimY_parts - 0.1));
    this.drawProjLine(ctx, toX(stemBackX), toY(hz), toX(stemBackX), toY(dimY_parts - 0.1));

    ctx.save();
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText('PUNTA', toX(B_toe / 2), toY(dimY_parts) + 18);
    if (B_heel > 0.1) ctx.fillText('TALÓN', toX(stemBackX + B_heel / 2), toY(dimY_parts) + 18);
    ctx.restore();

    // --- Cota de la corona "c" (arriba, azul) ---
    ctx.strokeStyle = '#2563eb';
    const dimY_top = H + 0.35;
    this.drawDimLine(ctx, toX(stemTopFrontX), toY(dimY_top), toX(stemBackX), toY(dimY_top), `c = ${b_top.toFixed(2)} m`, 'top');
    this.drawProjLine(ctx, toX(stemTopFrontX), toY(H), toX(stemTopFrontX), toY(dimY_top + 0.1));
    this.drawProjLine(ctx, toX(stemBackX), toY(H), toX(stemBackX), toY(dimY_top + 0.1));

    // --- Rótulos de zonas: PANTALLA (apilado verticalmente), ZAPATA, RELLENO ---
    ctx.save();
    ctx.textAlign = 'center';
    const frontAtMid = stemBotFrontX + (stemTopFrontX - stemBotFrontX) * 0.5;
    const stemCenterXMid = (frontAtMid + stemBackX) / 2;
    const word = 'PANTALLA';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    const letterH = 15;
    const centerPx = toX(stemCenterXMid);
    const startYpx = toY(hz + H_stem / 2) - (word.length * letterH) / 2 + letterH * 0.75;
    for (let i = 0; i < word.length; i++) {
      ctx.fillText(word[i], centerPx, startYpx + i * letterH);
    }

    ctx.font = 'bold 13px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('ZAPATA', toX(B / 2), toY(hz / 2) + 4);

    ctx.font = 'italic bold 15px Georgia, serif';
    ctx.fillStyle = 'rgba(146, 64, 14, 0.55)';
    ctx.fillText('RELLENO', toX(stemBackX + (B - stemBackX) / 2), toY(H_stem / 2 + hz));
    ctx.restore();

    ctx.restore();
  }

  drawLoads(ctx, toX, toY, scale) {
    const { geometry, backfill, loads } = this.wallData;
    const q = loads.q_surcharge || 0;
    const H = geometry.H;
    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const stemBackX = B_toe + b_bot;
    const beta = backfill.beta || 0;

    // Dibujar flechas de sobrecarga q
    if (q > 0) {
      ctx.save();
      ctx.strokeStyle = '#dc2626'; // Rojo sobrecarga
      ctx.fillStyle = '#dc2626';
      ctx.lineWidth = 2;

      const numArrows = 5;
      const startX = stemBackX + 0.3;
      const endX = B + 2.0;
      const step = (endX - startX) / (numArrows - 1);

      for (let i = 0; i < numArrows; i++) {
        const x = startX + i * step;
        const groundY = H + (x - stemBackX) * Math.tan(degToRad(beta));
        const arrowTopY = groundY + 0.7;

        this.drawArrow(ctx, toX(x), toY(arrowTopY), toX(x), toY(groundY), 6);
      }

      // Barra superior conectora de sobrecarga
      const y1 = H + 0.7;
      const y2 = H + (endX - stemBackX) * Math.tan(degToRad(beta)) + 0.7;
      ctx.beginPath();
      ctx.moveTo(toX(startX), toY(y1));
      ctx.lineTo(toX(endX), toY(y2));
      ctx.stroke();

      // Etiqueta de sobrecarga (q en kg/m², como en la hoja de cálculo)
      const q_kgm2 = (q * 1000) / 9.80665;
      ctx.font = 'bold 12px Inter, sans-serif';
      const midX = (startX + endX) / 2;
      const midY = (y1 + y2) / 2 + 0.25;
      ctx.fillText(`Sobrecarga q = ${q_kgm2.toFixed(0)} kg/m²`, toX(midX) - 60, toY(midY));

      // Etiqueta Ws (peso total de la sobrecarga sobre talón + corona)
      const w1 = this.geoResults && this.geoResults.weights
        ? this.geoResults.weights.find(w => w.id === 'W2')
        : null;
      if (w1) {
        ctx.font = '600 12px Inter, sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.fillText(`Ws = ${w1.weight_kg.toFixed(1)} kg/m`, toX(startX), toY(y1 + 0.45));
      }

      ctx.restore();
    }
  }

  /**
   * Dibuja flechas verticales numeradas (1..N) sobre cada zona de peso
   * (W1..W6) en su posición real (arm_x), para el diagrama de "Cálculo de
   * Fuerzas Verticales y Momentos" de la Memoria de Cálculo.
   */
  drawVerticalForceArrows(ctx, toX, toY, scale) {
    const { geometry } = this.wallData;
    const geo = this.geoResults;
    if (!geo || !geo.weights) return;

    const H = geometry.H;
    const hz = geometry.hz;
    const H_stem = Math.max(0, H - hz);
    const keyDepth = geometry.key_depth || 0;
    const Df = geometry.Df || hz;

    const yAnchorFor = (id) => {
      if (id === 'W1') return hz + Math.max(0, Df - hz) / 2; // suelo sobre la puntera
      if (id === 'W2') return H; // sobrecarga: superficie del relleno
      if (id === 'W3') return hz + H_stem * 0.62; // suelo relleno sobre talón
      if (id === 'W6') return hz * 0.5; // zapata
      if (id === 'W7') return -keyDepth * 0.5; // dentellón
      return hz + H_stem * 0.62; // W4 / W5: vástago (cartabón y cuerpo)
    };

    ctx.save();
    const arrowLenWorld = 0.55;

    geo.weights.forEach((wt, idx) => {
      const x = wt.arm_x;
      const yBot = yAnchorFor(wt.id);
      const yTop = yBot + arrowLenWorld;

      ctx.strokeStyle = '#4338ca';
      ctx.fillStyle = '#4338ca';
      ctx.lineWidth = 2.5;
      this.drawArrow(ctx, toX(x), toY(yTop), toX(x), toY(yBot), 6);

      const labelX = toX(x);
      const labelY = toY(yTop) - 11;
      ctx.beginPath();
      ctx.arc(labelX, labelY, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#4338ca';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#4338ca';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), labelX, labelY + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    });

    ctx.restore();
  }

  drawPressureWedges(ctx, toX, toY, scale) {
    const { geometry, backfill, loads } = this.wallData;
    const geo = this.geoResults;
    if (!geo || !geo.lateralPressures) return;

    const H = geometry.H;
    const B = geometry.B;
    const backX = B; // Actúa en el plano virtual posterior

    ctx.save();

    const Ka = geo.lateralPressures.Ka;
    const p_bot_soil = Ka * backfill.gamma * H;
    const q = loads.q_surcharge || 0;
    const p_q = Ka * q;

    const Ea_kg = (0.5 * p_bot_soil * H * 1000) / 9.80665;
    const Eq_kg = (p_q * H * 1000) / 9.80665;

    // Dos paneles independientes, uno junto al otro, cada uno con flechas
    // consecutivas (rectangular para Ea s/c, triangular para Ea), su flecha
    // resultante y su cota de altura de aplicación, al estilo del gráfico
    // de referencia (H/2 para la sobrecarga uniforme, H/3 para el suelo).
    const N = 14;
    const wMax = 1.3; // longitud gráfica ilustrativa de la flecha más larga de cada panel
    let cursorX = backX + 1.0;

    if (q > 0) {
      this.drawRectPressurePanel(ctx, toX, toY, {
        x0: cursorX, x1: cursorX + wMax, H, N,
        label: 'Ea s/c', valueKg: Eq_kg,
        appHeight: H / 2, dimLabel: `${(H / 2).toFixed(2)} m`,
      });
      cursorX += wMax + 1.6;
    }

    this.drawTriPressurePanel(ctx, toX, toY, {
      x0: cursorX, wMax, H, N,
      label: 'Ea', valueKg: Ea_kg,
      appHeight: H / 3, dimLabel: `${(H / 3).toFixed(2)} m`,
    });

    // 3. Diagrama de empuje pasivo en el frente (si existe)
    if (loads.consider_passive && geo.lateralPressures.passive_force > 0) {
      const Df = geometry.Df || geometry.hz;
      const Fp = geo.lateralPressures.passive_force;
      const p_pass_width = 1.0;

      ctx.fillStyle = 'rgba(16, 185, 129, 0.3)'; // Verde
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(toX(0), toY(Df));
      ctx.lineTo(toX(0), toY(0));
      ctx.lineTo(toX(-p_pass_width), toY(0));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      this.drawArrow(ctx, toX(-p_pass_width), toY(Df / 3), toX(0), toY(Df / 3), 5);
      ctx.fillStyle = '#047857';
      const Fp_kg = (Fp * 1000) / 9.80665;
      ctx.fillText(`Empuje Pasivo Fp = ${Fp_kg.toFixed(1)} kg/m`, toX(-p_pass_width) - 170, toY(Df / 3));
    }

    ctx.restore();
  }

  /**
   * Panel de flechas rectangular (carga uniforme, p.ej. Ea s/c): todas las
   * flechas tienen la misma longitud, con una línea vertical que une sus
   * colas a la derecha.
   */
  drawRectPressurePanel(ctx, toX, toY, opt) {
    const { x0, x1, H, N, label, valueKg, appHeight, dimLabel } = opt;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = '#2563eb';
    ctx.lineWidth = 1.8;
    for (let i = 0; i < N; i++) {
      const y = (H / N) * (i + 0.5);
      this.drawArrow(ctx, toX(x1), toY(y), toX(x0), toY(y), 5);
    }
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toX(x1), toY(0));
    ctx.lineTo(toX(x1), toY(H));
    ctx.stroke();

    this.drawForcePointer(ctx, toX, toY, { xRef: x1, appHeight, baseY: 0, label, valueKg, dimLabel });
    ctx.restore();
  }

  /**
   * Panel de flechas triangular (carga que crece linealmente hacia la
   * base, p.ej. Ea del suelo activo): la línea que une las colas traza la
   * hipotenusa del triángulo (cero en la corona, máxima en la base).
   */
  drawTriPressurePanel(ctx, toX, toY, opt) {
    const { x0, wMax, H, N, label, valueKg, appHeight, dimLabel } = opt;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = '#2563eb';
    ctx.lineWidth = 1.8;
    for (let i = 0; i < N; i++) {
      const y = (H / N) * (i + 0.5);
      const w = wMax * (1 - y / H);
      this.drawArrow(ctx, toX(x0 + w), toY(y), toX(x0), toY(y), 5);
    }
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toX(x0), toY(H));
    ctx.lineTo(toX(x0 + wMax), toY(0));
    ctx.stroke();

    this.drawForcePointer(ctx, toX, toY, { xRef: x0 + wMax, appHeight, baseY: 0, label, valueKg, dimLabel });
    ctx.restore();
  }

  /**
   * Marca "+" en la altura de aplicación de la resultante, flecha naranja
   * corta con su etiqueta y valor, y la cota vertical (con extremos "+" y
   * el valor numérico rotado 90°, con fondo blanco para legibilidad) desde
   * esa altura hasta la base del panel.
   */
  drawForcePointer(ctx, toX, toY, opt) {
    const { xRef, appHeight, baseY, label, valueKg, dimLabel } = opt;
    const crossX = xRef + 0.9;

    this.drawCrossTick(ctx, toX(crossX), toY(appHeight));
    this.drawCrossTick(ctx, toX(crossX), toY(baseY));

    ctx.save();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(toX(crossX), toY(appHeight));
    ctx.lineTo(toX(crossX), toY(baseY));
    ctx.stroke();
    ctx.restore();

    const midY = (toY(appHeight) + toY(baseY)) / 2;
    ctx.save();
    ctx.translate(toX(crossX) + 16, midY);
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(dimLabel).width;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(-textW / 2 - 3, -8, textW + 6, 16);
    ctx.fillStyle = '#1e293b';
    ctx.fillText(dimLabel, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#f97316';
    ctx.fillStyle = '#f97316';
    ctx.lineWidth = 2.5;
    this.drawArrow(ctx, toX(crossX + 0.75), toY(appHeight), toX(crossX + 0.05), toY(appHeight), 6);

    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.fillStyle = '#c2410c';
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${label} = ${valueKg.toFixed(1)} kg/m`, toX(crossX + 0.05), toY(appHeight) - 10);
    ctx.restore();
  }

  drawCrossTick(ctx, sx, sy, size = 5) {
    ctx.save();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx - size, sy);
    ctx.lineTo(sx + size, sy);
    ctx.moveTo(sx, sy - size);
    ctx.lineTo(sx, sy + size);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Dibuja las cargas locales q1 (peso propio sobre el talón), q4 (peso
   * propio sobre la punta) como flechas descendentes, y resalta q2/q3
   * (presión de contacto en las caras del vástago) sobre el diagrama de
   * presiones de la base — para el gráfico combinado "Presiones Locales
   * en la Zapata (q1 – q4)" de la Memoria de Cálculo.
   */
  drawLocalPressureLoads(ctx, toX, toY, scale) {
    const { geometry } = this.wallData;
    const geo = this.geoResults;
    if (!geo || !geo.weights) return;

    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const B_heel = geo.B_heel;
    const hz = geometry.hz;
    const H = geometry.H;
    const H_stem = Math.max(0.001, H - hz);
    const Df = geometry.Df || hz;

    const w1 = geo.weights.find(w => w.id === 'W1'); // suelo sobre la puntera
    const w2 = geo.weights.find(w => w.id === 'W2'); // sobrecarga talón+corona
    const w3 = geo.weights.find(w => w.id === 'W3'); // suelo relleno talón

    ctx.save();
    ctx.font = 'bold 12px Inter, sans-serif';

    // W1, W2, W3: flechas de peso propio del relleno/sobrecarga que
    // alimentan q1 (W2+W3) y q4 (W1), con su valor rotulado.
    const drawWeightArrow = (wt, yBot, dx, arrowLen) => {
      if (!wt) return;
      const yTop = yBot + arrowLen;
      ctx.strokeStyle = '#4338ca';
      ctx.fillStyle = '#4338ca';
      ctx.lineWidth = 2.5;
      this.drawArrow(ctx, toX(wt.arm_x), toY(yTop), toX(wt.arm_x), toY(yBot), 6);
      ctx.fillText(`${wt.id} = ${(wt.weight_kg / 1000).toFixed(2)} Tn`, toX(wt.arm_x) + dx, toY(yTop));
    };
    // W1 usa una flecha más larga para que su etiqueta no choque con la
    // fila de la resultante N (dibujada por drawBasePressureDistribution).
    drawWeightArrow(w1, hz + Math.max(0, Df - hz) / 2, 8, 1.6);
    drawWeightArrow(w2, H, -70, 0.55);
    drawWeightArrow(w3, hz + H_stem * 0.62, -70, 0.55);

    // q4: reparto de flechas descendentes sobre la punta (peso propio del
    // suelo de relleno sobre ella, si Df > hz).
    const q4 = B_toe > 0.01 ? (w1?.weight_kg || 0) / B_toe : 0;
    if (B_toe > 0.05) {
      const numArrows = Math.max(3, Math.round(B_toe / 0.4));
      ctx.strokeStyle = '#d97706';
      ctx.fillStyle = '#d97706';
      ctx.lineWidth = 2;
      for (let i = 0; i < numArrows; i++) {
        const x = (B_toe / numArrows) * (i + 0.5);
        this.drawArrow(ctx, toX(x), toY(Math.max(Df, hz) + 0.35), toX(x), toY(hz), 4);
      }
      ctx.fillText(`q4 = ${(q4 / 1000).toFixed(2)} Tn/m²`, toX(B_toe / 2) - 40, toY(Math.max(Df, hz) + 0.55));
    }

    // q1: reparto de flechas descendentes pequeñas y consecutivas sobre
    // todo el ancho del talón (peso propio del relleno + sobrecarga que
    // actúan sobre él), al igual que q4 sobre toda la punta.
    const q1 = B_heel > 0.01 ? ((w2?.weight_kg || 0) + (w3?.weight_kg || 0)) / B_heel : 0;
    if (B_heel > 0.02) {
      const xTalonStart = B_toe + b_bot;
      const numArrowsQ1 = Math.max(3, Math.round(B_heel / 0.4));
      ctx.strokeStyle = '#991b1b';
      ctx.fillStyle = '#991b1b';
      ctx.lineWidth = 2;
      for (let i = 0; i < numArrowsQ1; i++) {
        const x = xTalonStart + (B_heel / numArrowsQ1) * (i + 0.5);
        this.drawArrow(ctx, toX(x), toY(hz + 0.55), toX(x), toY(hz), 4);
      }
      ctx.fillText(`q1 = ${(q1 / 1000).toFixed(2)} Tn/m²`, toX(xTalonStart + B_heel / 2) - 40, toY(hz + 0.75));
    }

    // q2 (cara talón) y q3 (cara punta): resalta la presión de contacto
    // en las caras del vástago sobre el diagrama de presiones de la base.
    const q_toe = geo.q_toe, q_heel = geo.q_heel;
    const qToeKgm2 = q_toe * 101.9716;
    const qHeelKgm2 = q_heel * 101.9716;
    const maxBaseP = Math.max(q_toe, geo.q_adm * 1.1, 100);
    const hScale = 1.0 / maxBaseP;
    const xFaceTalon = B_toe + b_bot; // cara talón del vástago
    const xFacePunta = B_toe;         // cara punta del vástago
    [
      { x: xFaceTalon, label: 'q2', val: qHeelKgm2 + (qToeKgm2 - qHeelKgm2) * (B_heel / B), dy: 0.85, align: 'left' },
      { x: xFacePunta, label: 'q3', val: qHeelKgm2 + (qToeKgm2 - qHeelKgm2) * ((B_heel + b_bot) / B), dy: 0.45, align: 'right' }
    ].forEach(pt => {
      const q_x = geo.is_middle_third ? (q_toe - (q_toe - q_heel) * (pt.x / B)) : 0;
      if (q_x > 0.01) {
        const arrowH = q_x * hScale;
        ctx.strokeStyle = '#7c2d12';
        ctx.fillStyle = '#7c2d12';
        ctx.lineWidth = 3;
        this.drawArrow(ctx, toX(pt.x), toY(-arrowH), toX(pt.x), toY(0), 6);
        const text = `${pt.label} = ${(pt.val / 1000).toFixed(2)} Tn/m²`;
        const textX = pt.align === 'right' ? toX(pt.x) - ctx.measureText(text).width - 8 : toX(pt.x) + 8;
        ctx.fillText(text, textX, toY(-arrowH - pt.dy));
      }
    });

    ctx.restore();
  }

  drawBasePressureDistribution(ctx, toX, toY, scale) {
    const geo = this.geoResults;
    if (!geo) return;

    const { geometry } = this.wallData;
    const B = geometry.B;
    const q_toe = geo.q_toe;
    const q_heel = geo.q_heel;
    const q_adm = geo.q_adm;

    ctx.save();

    // Escala gráfica de presiones verticales
    const maxBaseP = Math.max(q_toe, q_adm * 1.1, 100);
    const hScale = 1.0 / maxBaseP; // metros gráficos por kPa

    const h_toe = q_toe * hScale;
    const h_heel = q_heel * hScale;

    // Color según si pasa o no q_adm
    const isPass = geo.pass_bearing && geo.pass_eccentricity;
    ctx.fillStyle = isPass ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.35)';
    ctx.strokeStyle = isPass ? '#16a34a' : '#dc2626';
    ctx.lineWidth = 2.5;

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(0));
    ctx.lineTo(toX(B), toY(0));
    ctx.lineTo(toX(B), toY(-h_heel));
    
    if (geo.is_middle_third) {
      ctx.lineTo(toX(0), toY(-h_toe));
    } else {
      // Despegue: ancho efectivo 3 * x_resultant
      const x_eff = Math.min(B, geo.effective_width);
      ctx.lineTo(toX(x_eff), toY(0));
      ctx.lineTo(toX(0), toY(-h_toe));
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Flechas de reacción del terreno hacia arriba
    const numArrows = 6;
    for (let i = 0; i <= numArrows; i++) {
      const x = (i / numArrows) * B;
      let q_x = 0;
      if (geo.is_middle_third) {
        q_x = q_toe - (q_toe - q_heel) * (x / B);
      } else {
        const x_eff = Math.min(B, geo.effective_width);
        q_x = x <= x_eff ? q_toe * (1 - x / x_eff) : 0;
      }
      if (q_x > 0.01) {
        const arrowH = q_x * hScale;
        this.drawArrow(ctx, toX(x), toY(-arrowH), toX(x), toY(0), 5);
      }
    }

    // Línea de capacidad admisible q_adm
    const h_adm = q_adm * hScale;
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(toX(-0.3), toY(-h_adm));
    ctx.lineTo(toX(B + 0.3), toY(-h_adm));
    ctx.stroke();
    ctx.setLineDash([]);

    // Etiquetas de presiones (kg/cm²)
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.fillText(`q_max = ${(q_toe / 98.0665).toFixed(2)} kg/cm²`, toX(0) - 20, toY(-h_toe - 0.25));
    ctx.fillText(`q_min = ${(q_heel / 98.0665).toFixed(2)} kg/cm²`, toX(B) - 40, toY(-Math.max(0.1, h_heel) - 0.25));

    ctx.fillStyle = '#4f46e5';
    ctx.fillText(`q_adm = ${(q_adm / 98.0665).toFixed(2)} kg/cm²`, toX(B + 0.4), toY(-h_adm));

    // Flecha de la Resultante Total N y Excentricidad
    const x_res = geo.x_resultant;
    ctx.strokeStyle = '#9333ea';
    ctx.fillStyle = '#9333ea';
    ctx.lineWidth = 3;
    this.drawArrow(ctx, toX(x_res), toY(1.2), toX(x_res), toY(0), 8);
    ctx.font = 'bold 12px Inter, sans-serif';
    const N_kg = (geo.sum_N * 1000) / 9.80665;
    ctx.fillText(`N = ${N_kg.toFixed(1)} kg/m (e = ${(geo.eccentricity * 100).toFixed(1)} cm)`, toX(x_res) - 45, toY(1.4));

    ctx.restore();
  }

  drawRebarDetailing(ctx, toX, toY, scale) {
    const { geometry, materials } = this.wallData;
    const str = this.structResults;
    if (!str) return;

    const H = geometry.H;
    const B = geometry.B;
    const B_toe = geometry.B_toe;
    const b_bot = geometry.b_bot;
    const b_top = geometry.b_top;
    const hz = geometry.hz;
    const B_heel = Math.max(0, B - B_toe - b_bot);

    const stemBackX = B_toe + b_bot;
    const stemTopFrontX = stemBackX - b_top;
    const stemBotFrontX = B_toe;

    const covStem = materials.cover_stem || 0.05;
    const covFoot = materials.cover_footing || 0.07;

    ctx.save();

    // Lienzo limpio: la silueta del muro + relleno ya la dibujan
    // drawSoilAndBackfill/drawConcreteWall antes de llegar aquí. El acero
    // se irá agregando de nuevo, un elemento a la vez, según se indique.

    // 1. Acero Superior de la Zapata (Talón) - MORADO. Corrido en todo el
    // ancho de la zapata (punta + talón), con gancho a 90° en ambos
    // extremos según el diámetro real de la varilla (12·db), no una
    // longitud fija.
    const hookLen = (diameter_m) => Math.max(0.10, diameter_m * 12.0);
    const heelRebarY = hz - covFoot;
    const hookHeel = hookLen(str.heel.rebar.diameter_m);
    ctx.strokeStyle = '#9333ea';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(toX(covFoot), toY(heelRebarY - hookHeel));
    ctx.lineTo(toX(covFoot), toY(heelRebarY));
    ctx.lineTo(toX(B - covFoot), toY(heelRebarY));
    ctx.lineTo(toX(B - covFoot), toY(heelRebarY - hookHeel));
    ctx.stroke();

    this.drawCallout(ctx, toX(stemBackX + B_heel / 2), toY(heelRebarY), toX(stemBackX + B_heel / 2 + 0.3), toY(hz + 0.8),
      `Acero Superior de Zapata (corrido): ${str.heel.rebar_callout}`, '#9333ea');

    // 2. Acero Inferior de la Zapata (Punta) - VERDE. Corrido en todo el
    // ancho de la zapata (punta + talón), con gancho a 90° en ambos
    // extremos según el diámetro real de la varilla (12·db), doblando
    // hacia arriba (es la malla inferior).
    const toeRebarY = covFoot;
    const hookToe = hookLen(str.toe.rebar.diameter_m);
    ctx.strokeStyle = '#00b140';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(toX(covFoot), toY(toeRebarY + hookToe));
    ctx.lineTo(toX(covFoot), toY(toeRebarY));
    ctx.lineTo(toX(B - covFoot), toY(toeRebarY));
    ctx.lineTo(toX(B - covFoot), toY(toeRebarY + hookToe));
    ctx.stroke();

    this.drawCallout(ctx, toX(B_toe / 2), toY(toeRebarY), toX(B_toe / 2 - 0.4), toY(-0.4),
      `Acero Inferior de Zapata (corrido): ${str.toe.rebar_callout}`, '#00b140');

    // 3. Acero Transversal de Reparto (Punta y Talón) - AZUL. Visto en
    // corte (corre perpendicular a este plano, a lo largo del muro), por
    // eso se dibuja como puntos. Corrido en TODO el ancho de la zapata (no
    // solo bajo su propio miembro): una fila a la altura del acero
    // inferior y otra a la altura del acero superior, cada una con su
    // propio espaciamiento real, igual que las varillas principales.
    ctx.fillStyle = '#f97316';
    const dotsRow = (y, xFrom, xTo, spacingCm) => {
      const s = Math.max(0.02, (spacingCm || 20) / 100);
      for (let x = xFrom + s / 2; x < xTo - 1e-6; x += s) {
        ctx.beginPath();
        ctx.arc(toX(x), toY(y), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    dotsRow(toeRebarY, covFoot, B - covFoot, str.toe.spacing_trans);
    dotsRow(heelRebarY, covFoot, B - covFoot, str.heel.spacing_trans);

    // 4. Acero Vertical en Cara Exterior (Asvce) - AZUL. Varilla única
    // continua, apoyada justo encima de la parrilla inferior de la zapata
    // (Acero Punta) y siguiendo el batido de la cara exterior hasta la
    // corona, con gancho a 90° en la base y en la corona.
    const yBaseCe = toeRebarY + (str.toe.rebar.diameter_m + str.stem.rebarTemp.diameter_m) / 2;
    const hookCe = hookLen(str.stem.rebarTemp.diameter_m);
    const xFrontAt = (y) => stemBotFrontX + (stemTopFrontX - stemBotFrontX) * ((y - hz) / (H - hz)) + covStem;
    const xBaseCe = xFrontAt(hz);
    const xTopCe = xFrontAt(H);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(toX(xBaseCe + hookCe), toY(yBaseCe));
    ctx.lineTo(toX(xBaseCe), toY(yBaseCe));
    ctx.lineTo(toX(xTopCe), toY(H - covStem));
    ctx.lineTo(toX(xTopCe + hookCe), toY(H - covStem));
    ctx.stroke();

    this.drawCallout(ctx, toX(xTopCe), toY(H - covStem), toX(xTopCe + 0.6), toY(H - 1.2),
      `Acero Vertical Cara Exterior (Asvce): ${str.stem.rebar_vert_ext}`, '#2563eb');

    // 5. Acero Vertical en Cara Interior (Asvci) - ROJO. Varilla continua
    // (gancho en la base y en la corona, ambos hacia la cara exterior) más
    // la varilla de tramo 1 en VERDE (gancho solo en la base, hacia la
    // cara interior, se corta sin gancho en Lc).
    const xInt = stemBackX - covStem;
    const hookCi = hookLen(str.stem.rebar.diameter_m);
    const yBaseCiCont = covFoot + (str.toe.rebar.diameter_m + str.stem.rebar.diameter_m) / 2;
    const yBaseCiT1 = yBaseCiCont + 0.15;
    const yLcCi = hz + str.stem.Lc_usar;
    ctx.strokeStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(toX(xInt - hookCi), toY(yBaseCiCont));
    ctx.lineTo(toX(xInt), toY(yBaseCiCont));
    ctx.lineTo(toX(xInt), toY(H - covStem));
    ctx.lineTo(toX(xInt - hookCi), toY(H - covStem));
    ctx.stroke();

    ctx.strokeStyle = '#d946ef';
    ctx.beginPath();
    ctx.moveTo(toX(xInt), toY(yLcCi));
    ctx.lineTo(toX(xInt), toY(yBaseCiT1));
    ctx.lineTo(toX(xInt + hookCi), toY(yBaseCiT1));
    ctx.stroke();

    this.drawCallout(ctx, toX(xInt), toY(H - covStem), toX(xInt + 0.6), toY(H - 1.6),
      `Acero Vertical Cara Interior (Asvci): ${str.stem.rebar_callout}`, '#dc2626');

    // 6. Acero Horizontal (Ash) - círculos pegados a las varillas, siguiendo el batido
    const xFrontAtAsh = (y) => stemBotFrontX + (stemTopFrontX - stemBotFrontX) * ((y - hz) / (H - hz)) + covStem + 0.03;
    const xIntCi = stemBackX - 0.06; // cara interior, un poco más a la izquierda del acero vertical rojo

    const drawHorizontalCirclesAsh = (yStart, yEnd, spacingCm, colorHex, xFunc) => {
      ctx.fillStyle = colorHex;
      const spacing = Math.max(0.02, (spacingCm || 20) / 100);
      for (let y = yStart + spacing/2; y <= yEnd - 1e-6; y += spacing) {
        const x = xFunc ? xFunc(y) : xIntCi;
        ctx.beginPath();
        ctx.arc(toX(x), toY(y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    // Usar espaciamiento inferior para toda la altura (uniforme)
    drawHorizontalCirclesAsh(hz, H, str.stem.sp_ce_inferior, '#2563eb', xFrontAtAsh); // azul exterior (sigue pendiente)
    drawHorizontalCirclesAsh(hz, H, str.stem.sp_ci_inferior, '#16a34a', null); // verde interior (posición constante)

    // 7. Acero del Dentellón (si está habilitado): vertical en "U" con
    // gancho de anclaje a 45° hacia abajo/adentro en cada rama (naranja
    // rojizo), y horizontal en ambas caras, visto en corte como puntos
    // (amarillo) — mismo criterio y diámetro que el 3D.
    if (geometry.has_key && geometry.key_depth > 0 && geometry.key_width > 0) {
      const xKeyL = geometry.key_pos + covFoot;
      const xKeyR = geometry.key_pos + geometry.key_width - covFoot;
      // El gancho se engancha en el Acero Transversal de Reparto cercano al
      // Acero Superior de Zapata: la rama recta sube derecho hasta ese nivel
      // (heelRebarY, sin pasarse de altura) y justo ahí se dobla en diagonal
      // (45°) hacia abajo/adentro, con el gancho según norma (12·db).
      const rKeyRadius2D = 0.75 * 0.0254 / 2;
      const hookKeyLen = hookLen(rKeyRadius2D * 2); // gancho según norma: 12·db de esta varilla
      const cos45 = Math.cos(Math.PI / 4), sin45 = Math.sin(Math.PI / 4);
      const yBendKey = heelRebarY + str.toe.rebarTemp.diameter_m * 1.5; // un poco encima del transversal, como agarrándolo
      const yBottomKey = -geometry.key_depth + covFoot;

      ctx.strokeStyle = '#ea580c';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(toX(xKeyL + hookKeyLen * cos45), toY(yBendKey - hookKeyLen * sin45));
      ctx.lineTo(toX(xKeyL), toY(yBendKey));
      ctx.lineTo(toX(xKeyL), toY(yBottomKey));
      ctx.lineTo(toX(xKeyR), toY(yBottomKey));
      ctx.lineTo(toX(xKeyR), toY(yBendKey));
      ctx.lineTo(toX(xKeyR - hookKeyLen * cos45), toY(yBendKey - hookKeyLen * sin45));
      ctx.stroke();

      this.drawCallout(ctx, toX(xKeyR), toY(yBendKey), toX(xKeyR + 0.6), toY(yBendKey - 0.3),
        `Acero Vertical del Dentellón: Ø 3/4" (19.1 mm) @ 15 cm`, '#ea580c');

      ctx.fillStyle = '#facc15';
      const spDentH = Math.max(0.02, (str.toe.spacing_trans || 20) / 100);
      const yFirstRow = yBottomKey + spDentH / 2;
      for (let y = yFirstRow; y <= yBendKey - spDentH / 2 + 1e-6; y += spDentH) {
        ctx.beginPath(); ctx.arc(toX(xKeyL), toY(y), 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(toX(xKeyR), toY(y), 3, 0, Math.PI * 2); ctx.fill();
      }
      // Acero horizontal adicional, en el centro del ancho, apoyado justo
      // encima del acero de fondo (rama inferior del acero vertical del
      // dentellón), no a media altura del primer tramo, para que no quede
      // flotando sin tocar esa varilla.
      const xKeyMid = (xKeyL + xKeyR) / 2;
      const rDentHRadius = str.toe.rebarTemp.diameter_m / 2;
      const yOverBottomKey = yBottomKey + rKeyRadius2D + rDentHRadius;
      ctx.beginPath(); ctx.arc(toX(xKeyMid), toY(yOverBottomKey), 3, 0, Math.PI * 2); ctx.fill();
      this.drawCallout(ctx, toX(xKeyL), toY((yBendKey + yBottomKey) / 2), toX(xKeyL - 0.6), toY((yBendKey + yBottomKey) / 2 - 0.2),
        `Acero Horizontal del Dentellón: ${str.toe.rebar_trans}`, '#facc15');
    }

    ctx.restore();
  }

  drawCallout(ctx, fromX, fromY, toX, toY, text, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;

    // Punto en origen
    ctx.beginPath();
    ctx.arc(fromX, fromY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Línea directriz
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    const isRight = toX >= fromX;
    const shelfX = isRight ? toX + 30 : toX - 30;
    ctx.lineTo(shelfX, toY);
    ctx.stroke();

    // Texto
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillStyle = '#0f172a';
    ctx.fillText(text, isRight ? toX + 5 : toX - ctx.measureText(text).width - 5, toY - 5);

    ctx.restore();
  }

  drawDimLine(ctx, x1, y1, x2, y2, text, align = 'center') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Flechas de cota en extremos
    this.drawArrowHead(ctx, x1, y1, Math.atan2(y1 - y2, x1 - x2));
    this.drawArrowHead(ctx, x2, y2, Math.atan2(y2 - y1, x2 - x1));

    // Texto de cota centrado
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const textWidth = ctx.measureText(text).width;

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(midX - textWidth / 2 - 3, midY - 8, textWidth + 6, 16);
    ctx.fillStyle = '#1e293b';
    ctx.fillText(text, midX - textWidth / 2, midY + 4);
    ctx.restore();
  }

  drawArrowHead(ctx, x, y, angle) {
    const size = 6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, -size / 2.5);
    ctx.lineTo(-size, size / 2.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawProjLine(ctx, x1, y1, x2, y2) {
    ctx.save();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  drawArrow(ctx, fromX, fromY, toX, toY, headSize = 6) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    ctx.save();
    ctx.translate(toX, toY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-headSize, -headSize / 2);
    ctx.lineTo(-headSize, headSize / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawOverlayInfo(ctx, width, height, scale) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;

    const cardW = 180;
    const cardH = 32;
    ctx.fillRect(15, height - cardH - 15, cardW, cardH);
    ctx.strokeRect(15, height - cardH - 15, cardW, cardH);

    ctx.fillStyle = '#475569';
    ctx.font = '500 11px Inter, sans-serif';
    ctx.fillText(`Escala: 1m = ${scale.toFixed(1)} px | Zoom: ${(this.zoom * 100).toFixed(0)}%`, 25, height - 25);
    ctx.restore();
  }
}
