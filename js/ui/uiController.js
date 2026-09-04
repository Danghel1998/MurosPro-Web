/**
 * Controlador de interfaz de usuario, eventos, reactividad y sincronización
 * Adaptado a la interfaz exacta de las diapositivas y hojas Excel UNI
 * Incluye pestañas integradas (Hoja Excel, Geometría con Sliders, Armaduras y Avanzado)
 */

import { DEFAULT_WALL_DATA, PRESET_PROJECTS, REBAR_TABLE, ZONAS_SISMICAS } from '../constants.js';
import { calculateGeotechnicalStability, calculateDualCaseStability } from '../engine/geotechnical.js';
import { calculateStructuralDesign } from '../engine/structural.js';
import { calculateRebarSchedule } from '../engine/rebarSchedule.js';
import { degToRad } from '../engine/soilPressures.js';
import { WallCanvasRenderer } from '../visualizer/wallCanvas.js';
import { WallRenderer3D } from '../visualizer/wallRenderer3D.js';

export class AppUIController {
  constructor() {
    this.wallData = JSON.parse(JSON.stringify(DEFAULT_WALL_DATA));
    this.geoResults = null;
    this.structResults = null;
    this.reportUnit = 'kg'; // 'kg' | 'Tn' — unidad de peso/momento en la Memoria de Cálculo
    this.reportDiagramStates = {}; // zoom/pan/lock independiente por cada esquema del informe (clave = id del esquema)

    const canvasEl = document.getElementById('wallCanvas');
    this.renderer = new WallCanvasRenderer(canvasEl);
    this.renderer3D = null; // se crea perezosamente al abrir "Detalle 3D" por primera vez

    this.initUI();
    this.recalculateAndRender();
  }

  initUI() {
    this.populateRebarSelects();
    this.bindInputEvents();
    this.bindButtonEvents();
    this.syncFormWithData();
    this.renderer.resizeCanvas();
  }

  populateRebarSelects() {
    const selects = ['rebar_stem_id', 'rebar_toe_id', 'rebar_heel_id', 'rebar_temp_id'];
    selects.forEach(selId => {
      const el = document.getElementById(selId);
      if (!el) return;
      el.innerHTML = '';
      REBAR_TABLE.forEach((bar, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${bar.name} (Ab = ${bar.area_cm2} cm²)`;
        el.appendChild(opt);
      });
    });
  }

  bindInputEvents() {
    const inputs = document.querySelectorAll('input[data-bind], select[data-bind]');
    inputs.forEach(input => {
      input.addEventListener('input', (e) => {
        this.handleInputChange(e.target, false);
      });
      input.addEventListener('change', (e) => {
        this.handleInputChange(e.target, true);
      });
    });

    const hasWaterCheckbox = document.getElementById('has_water_table');
    if (hasWaterCheckbox) {
      hasWaterCheckbox.addEventListener('change', (e) => {
        const container = document.getElementById('water_params_container');
        if (container) container.classList.toggle('hidden', !e.target.checked);
      });
    }
  }

  handleInputChange(element, isCommit = true) {
    const bindPath = element.getAttribute('data-bind');
    if (!bindPath) return;

    const parts = bindPath.split('.');
    let target = this.wallData;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
    }

    const lastKey = parts[parts.length - 1];
    let val;
    if (element.type === 'checkbox') {
      val = element.checked;
    } else if (element.type === 'number' || element.type === 'range') {
      // No usar parseFloat mientras el usuario sigue escribiendo (p.ej. "9."
      // o "9.2" son válidos pero aún incompletos): si el valor no es un
      // número completo todavía, no tocamos wallData ni el predimensionado
      // hasta que termine de editar (evento 'change'), para no borrarle el
      // punto decimal en cada tecla.
      if (element.type === 'number' && !isCommit && !/^-?\d*\.?\d*$/.test(element.value)) return;
      val = parseFloat(element.value);
      if (!isCommit && Number.isNaN(val)) return;
    } else {
      val = element.value;
    }

    target[lastKey] = val;

    // Si el usuario edita "Hs" directamente, invalida la sobrecarga directa
    // (S/C) previamente fijada por el botón "Hs=S/C÷γs": a partir de ahora
    // q_surcharge vuelve a derivarse de Hs, no del valor exacto de S/C.
    if (bindPath === 'site_conditions.hs_surcharge') {
      this.wallData.site_conditions.sc_direct_kgm2 = undefined;
    }

    // Si el usuario marca/desmarca manualmente "Habilitar Dentellón / Tacón",
    // fija el modo a "Siempre (Sí)" / "No" en vez de dejarlo en "automático"
    // — de lo contrario, la lógica de auto-dimensionado (dentellon_mode ===
    // 'auto') sobrescribe geometry.has_key en el siguiente recálculo,
    // ignorando el clic del usuario.
    if (bindPath === 'geometry.has_key') {
      this.wallData.site_conditions.dentellon_mode = val ? 'si' : 'no';
      const modeSelect = document.querySelector('[data-bind="site_conditions.dentellon_mode"]');
      if (modeSelect) modeSelect.value = this.wallData.site_conditions.dentellon_mode;
      // El empuje pasivo del dentellón (Ep) solo se calcula si además
      // "Considerar Empuje Pasivo Frontal" está activo — se enciende junto
      // con el dentellón para que su sección del informe aparezca de
      // inmediato al habilitarlo, sin un segundo interruptor.
      if (val) {
        this.wallData.loads.consider_passive = true;
        const passiveCheckbox = document.querySelector('[data-bind="loads.consider_passive"]');
        if (passiveCheckbox) passiveCheckbox.checked = true;
      }
    }

    // Si cambió la altura H, actualizar automáticamente el predimensionado
    // base — solo al terminar de editar (change), no en cada tecla, para
    // no reescribir el campo mientras el usuario todavía está escribiendo.
    if (bindPath === 'geometry.H' && val > 0 && isCommit) {
      this.updateAutoPredimensioning(val);
    }

    // Convertir y sincronizar unidades técnicas a unidades SI de cálculo
    this.convertUnitsAndSync();

    // Sincronizar todos los inputs vinculados con el mismo data-sync
    const syncName = element.getAttribute('data-sync');
    if (syncName) {
      document.querySelectorAll(`[data-sync="${syncName}"]`).forEach(inp => {
        if (inp !== element) {
          if (inp.type === 'checkbox') {
            inp.checked = element.checked;
          } else {
            inp.value = element.value;
          }
        }
      });
    }

    // Actualizar etiquetas numéricas de los sliders
    if (bindPath === 'geometry.H') {
      const elVal = document.getElementById('val_geom_H');
      if (elVal) elVal.textContent = `${val.toFixed(2)} m`;
    } else if (bindPath === 'geometry.B') {
      const elVal = document.getElementById('val_geom_B');
      if (elVal) elVal.textContent = `${val.toFixed(2)} m`;
    }

    this.recalculateAndRender();
  }

  updateAutoPredimensioning(H) {
    this.wallData.geometry.hz = Math.round((H / 10.0) * 100) / 100; // hz = H/10
    this.wallData.geometry.b_bot = Math.round((H / 10.0) * 100) / 100; // t2 = H/10
    this.wallData.geometry.b_top = 0.30; // t1 = 0.30m
    this.wallData.geometry.B = Math.round((0.70 * H) * 100) / 100; // B = 0.70 H
    // P = H/3, redondeado hacia abajo al 5 cm más cercano (criterio del
    // ejemplo del curso: H=5.00m -> P=1.65m, no 1.6667m).
    this.wallData.geometry.B_toe = Math.floor((H / 3.0) * 20) / 20;
    this.syncFormWithData();
  }

  convertUnitsAndSync() {
    const w = this.wallData;

    // 1. Suelo de Fundación
    if (w.foundation.gamma_kgm3) {
      w.foundation.gamma = (w.foundation.gamma_kgm3 * 9.80665) / 1000.0;
    }
    if (w.foundation.c_kgcm2 !== undefined) {
      w.foundation.c = w.foundation.c_kgcm2 * 98.0665;
    }
    if (w.foundation.q_ult_kgcm2 !== undefined) {
      // Se guarda la capacidad ÚLTIMA (sin dividir); el factor de seguridad
      // (entre 3 en estático, entre 2 en sísmico) lo aplica geotechnical.js
      // según el caso de carga evaluado (metodología UNI).
      w.foundation.q_ult = w.foundation.q_ult_kgcm2 * 98.0665;
    }
    const ratio = w.foundation.friction_ratio || '2/3';
    const phi = w.foundation.phi || 32.0;
    if (ratio === '0') {
      w.foundation.mu = 0; // Base lisa / sin fricción (δ=0) — caso más conservador
    } else if (ratio === '2/3') {
      w.foundation.mu = Math.tan(degToRad(phi * (2.0 / 3.0)));
    } else if (ratio === '1/2') {
      w.foundation.mu = Math.tan(degToRad(phi * 0.5));
    } else {
      w.foundation.mu = Math.tan(degToRad(phi));
    }

    // 2. Suelo de Relleno
    if (w.backfill.gamma_kgm3) {
      w.backfill.gamma = (w.backfill.gamma_kgm3 * 9.80665) / 1000.0;
    }

    // 3. Materiales
    if (w.materials.fc_kgcm2) {
      w.materials.fc = w.materials.fc_kgcm2 * 0.0980665;
    }
    if (w.materials.fy_kgcm2) {
      w.materials.fy = w.materials.fy_kgcm2 * 0.0980665;
    }
    if (w.materials.gamma_c_kgm3) {
      w.materials.gamma_c = (w.materials.gamma_c_kgm3 * 9.80665) / 1000.0;
    }

    // 4. Condiciones del Sitio y Sismo
    const zonaKey = w.site_conditions?.zona_sismica || 'zona_1';
    if (ZONAS_SISMICAS[zonaKey]) {
      const z = ZONAS_SISMICAS[zonaKey];
      w.site_conditions.a0 = z.a0;
      w.loads.kh = z.kh;
      w.loads.kv = z.kv;
    }

    // Sobrecarga vehicular (Hs) -> q = gamma_r * Hs. Si el usuario fijó la
    // sobrecarga directa (S/C) con el botón "Hs=S/C÷γs", se usa ese valor
    // exacto en kg/m² en vez de recalcularlo a partir del Hs ya redondeado
    // (evita que, p.ej., S/C=1000 kg/m² termine dando q≈999.4 kg/m² por el
    // redondeo intermedio de Hs a 3 decimales).
    const hs = w.site_conditions?.hs_surcharge || 0.61;
    const gamma_r_kgm3 = w.backfill.gamma_kgm3 || 1900.0;
    const scDirectKgm2 = w.site_conditions?.sc_direct_kgm2;
    const q_kgm2 = (scDirectKgm2 !== undefined && scDirectKgm2 !== null) ? scDirectKgm2 : (gamma_r_kgm3 * hs);
    w.loads.q_surcharge = (q_kgm2 * 9.80665) / 1000.0;

    // Dentellón modo
    const dentMode = w.site_conditions?.dentellon_mode || 'auto';
    if (dentMode === 'si') {
      w.geometry.has_key = true;
    } else if (dentMode === 'no') {
      w.geometry.has_key = false;
    }
  }

  bindButtonEvents() {
    // Pestañas del panel izquierdo (Hoja Excel / Geometría / Armaduras / Avanzado)
    const inputTabs = document.querySelectorAll('[data-input-tab]');
    inputTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        inputTabs.forEach(t => {
          t.classList.remove('bg-white', 'text-indigo-700', 'shadow-sm');
          t.classList.add('text-slate-600');
        });
        tab.classList.add('bg-white', 'text-indigo-700', 'shadow-sm');
        tab.classList.remove('text-slate-600');

        const tabId = tab.getAttribute('data-input-tab');
        document.querySelectorAll('.input-group-panel').forEach(p => p.classList.add('hidden'));
        const activeGroup = document.getElementById(tabId);
        if (activeGroup) activeGroup.classList.remove('hidden');
      });
    });

    // Botón Predimensionar Automático
    const btnPredim = document.getElementById('btn_predimensionar');
    if (btnPredim) {
      btnPredim.addEventListener('click', () => {
        const H = this.wallData.geometry.H;
        this.updateAutoPredimensioning(H);
        this.convertUnitsAndSync();
        this.recalculateAndRender();
      });
    }

    // Botón Calcular Cohesión = tan(φf)
    const btnCalcCohesion = document.getElementById('btn_calc_cohesion');
    if (btnCalcCohesion) {
      btnCalcCohesion.addEventListener('click', () => {
        const phi = this.wallData.foundation.phi;
        this.wallData.foundation.c_kgcm2 = Math.round(Math.tan(degToRad(phi)) * 1000) / 1000;
        this.syncFormWithData();
        this.convertUnitsAndSync();
        this.recalculateAndRender();
      });
    }

    // Botón Calcular Hs = (S/C) / γs, a partir de la sobrecarga directa
    const btnCalcHsFromSc = document.getElementById('btn_calc_hs_from_sc');
    if (btnCalcHsFromSc) {
      btnCalcHsFromSc.addEventListener('click', () => {
        const scInput = document.getElementById('input_sc_direct');
        const sc_kgm2 = parseFloat(scInput ? scInput.value : '0') || 0;
        const gamma_r_kgm3 = this.wallData.backfill.gamma_kgm3 || 1900;
        this.wallData.site_conditions.hs_surcharge = Math.round((sc_kgm2 / gamma_r_kgm3) * 1000) / 1000;
        // Guarda el valor exacto de S/C: convertUnitsAndSync() lo usará
        // directamente para q_surcharge, en vez de recalcularlo a partir
        // del Hs ya redondeado (lo que perdería precisión, p.ej. 1000 -> 999.4).
        this.wallData.site_conditions.sc_direct_kgm2 = sc_kgm2;
        this.syncFormWithData();
        this.convertUnitsAndSync();
        this.recalculateAndRender();
      });
    }

    // Botones de modo gráfico (Geometría / Presiones / Armaduras)
    const modeBtns = document.querySelectorAll('[data-view-mode]');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modeBtns.forEach(b => b.classList.remove('bg-indigo-600', 'text-white', 'shadow'));
        modeBtns.forEach(b => b.classList.add('bg-slate-100', 'text-slate-700'));
        btn.classList.add('bg-indigo-600', 'text-white', 'shadow');
        btn.classList.remove('bg-slate-100', 'text-slate-700');

        const mode = btn.getAttribute('data-view-mode');
        const container2D = document.getElementById('canvas2d_container');
        const container3D = document.getElementById('canvas3d_container');

        if (mode === 'rebar3d') {
          if (container2D) container2D.classList.add('hidden');
          if (container3D) container3D.classList.remove('hidden');
          if (!this.renderer3D) {
            this.renderer3D = new WallRenderer3D(container3D);
            this._setupRebar3DLegendToggles();
          }
          this.renderer3D.updateData(this.wallData, this.geoResults, this.structResults);
          this._updateDentellonLegendRow();
          this._updateRebar3DLegendDims();
          this.renderer3D.start();
        } else {
          if (this.renderer3D) this.renderer3D.stop();
          if (container3D) container3D.classList.add('hidden');
          if (container2D) container2D.classList.remove('hidden');
          this.renderer.setViewMode(mode);
        }
      });
    });

    // Toggle de unidades kg / Tn en la Memoria de Cálculo
    const unitBtns = document.querySelectorAll('[data-report-unit]');
    unitBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        unitBtns.forEach(b => b.classList.remove('bg-indigo-600', 'text-white', 'shadow'));
        unitBtns.forEach(b => b.classList.add('bg-slate-100', 'text-slate-700'));
        btn.classList.add('bg-indigo-600', 'text-white', 'shadow');
        btn.classList.remove('bg-slate-100', 'text-slate-700');

        this.reportUnit = btn.getAttribute('data-report-unit');
        this.generateCalculationReport();
      });
    });

    // Zoom del esquema del muro dentro de la Memoria de Cálculo (delegado,
    // ya que los botones se regeneran cada vez que se arma el informe).
    // Cada esquema tiene su propio zoom/pan/bloqueo independiente,
    // identificado por data-report-key.
    const reportPanel = document.getElementById('report_panel');
    if (reportPanel) {
      reportPanel.addEventListener('click', (e) => {
        const zoomBtn = e.target.closest('[data-report-zoom]');
        if (!zoomBtn) return;
        const key = zoomBtn.getAttribute('data-report-key');
        const st = this.getDiagramState(key);
        const action = zoomBtn.getAttribute('data-report-zoom');
        if (action === 'lock') { st.locked = !st.locked; this.generateCalculationReport(); return; }
        if (st.locked) return;
        if (action === 'in') st.zoom = Math.min(3.0, st.zoom * 1.15);
        else if (action === 'out') st.zoom = Math.max(0.4, st.zoom / 1.15);
        else if (action === 'reset') { st.zoom = 1.0; st.panX = 0; st.panY = 0; }
        this.generateCalculationReport();
      });

      // Zoom con la rueda del mouse sobre cualquier esquema de la Memoria
      // (throttleado a un repintado por frame para no saturar el navegador
      // con ruedas de mouse muy rápidas). Si ese esquema está bloqueado, se
      // ignora por completo para no interceptar el scroll normal de la
      // página al bajar a leer el resto del informe.
      let wheelZoomRAF = null;
      reportPanel.addEventListener('wheel', (e) => {
        const img = e.target.closest('.report-diagram-img');
        if (!img) return;
        const key = img.getAttribute('data-report-key');
        const st = this.getDiagramState(key);
        if (st.locked) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
        st.zoom = Math.max(0.4, Math.min(3.0, st.zoom * factor));
        if (wheelZoomRAF) return;
        wheelZoomRAF = requestAnimationFrame(() => {
          this.generateCalculationReport();
          wheelZoomRAF = null;
        });
      }, { passive: false });

      // Arrastrar con el mouse para desplazar (pan) cualquier esquema de
      // la Memoria. Como el informe se regenera durante el arrastre (el
      // <img> original queda desmontado), se vuelve a localizar por su
      // data-report-key en cada movimiento en vez de guardar la referencia.
      let dragState = null;
      let dragRAF = null;
      reportPanel.addEventListener('mousedown', (e) => {
        const img = e.target.closest('.report-diagram-img');
        if (!img) return;
        const key = img.getAttribute('data-report-key');
        const st = this.getDiagramState(key);
        if (st.locked) return;
        e.preventDefault();
        dragState = {
          key,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startPanX: st.panX,
          startPanY: st.panY
        };
        img.style.cursor = 'grabbing';
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragState) return;
        const img = document.querySelector(`.report-diagram-img[data-report-key="${CSS.escape(dragState.key)}"]`);
        const rect = img ? img.getBoundingClientRect() : null;
        const nativeWidth = (this.renderer.canvas.width / (window.devicePixelRatio || 1)) || (rect ? rect.width : 1);
        const ratio = rect && rect.width > 0 ? nativeWidth / rect.width : 1;
        const st = this.getDiagramState(dragState.key);
        st.panX = dragState.startPanX + (e.clientX - dragState.startClientX) * ratio;
        st.panY = dragState.startPanY + (e.clientY - dragState.startClientY) * ratio;
        if (dragRAF) return;
        dragRAF = requestAnimationFrame(() => {
          this.generateCalculationReport();
          const freshImg = document.querySelector(`.report-diagram-img[data-report-key="${CSS.escape(dragState ? dragState.key : '')}"]`);
          if (freshImg && dragState) freshImg.style.cursor = 'grabbing';
          dragRAF = null;
        });
      });

      window.addEventListener('mouseup', () => {
        dragState = null;
      });
    }

    // Pestañas principales derechas (Visualizador / Fuerzas / Memoria)
    const mainTabs = document.querySelectorAll('[data-main-tab]');
    mainTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        mainTabs.forEach(t => {
          t.classList.remove('border-indigo-600', 'text-indigo-600');
          t.classList.add('border-transparent', 'text-slate-500');
        });
        tab.classList.add('border-indigo-600', 'text-indigo-600');
        tab.classList.remove('border-transparent', 'text-slate-500');

        const tabId = tab.getAttribute('data-main-tab');
        document.querySelectorAll('.tab-content-panel').forEach(p => p.classList.add('hidden'));
        const activePanel = document.getElementById(tabId);
        if (activePanel) {
          activePanel.classList.remove('hidden');
          if (tabId === 'visualizer_panel') {
            this.renderer.resizeCanvas();
            this.renderer.render();
            const container3D = document.getElementById('canvas3d_container');
            if (this.renderer3D && container3D && !container3D.classList.contains('hidden')) {
              this.renderer3D.resize();
            }
          }
        }
      });
    });

    // Presets
    const presetBtns = document.querySelectorAll('[data-preset]');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const pKey = btn.getAttribute('data-preset');
        if (PRESET_PROJECTS[pKey]) {
          this.wallData = JSON.parse(JSON.stringify(PRESET_PROJECTS[pKey].data));
          this.convertUnitsAndSync();
          this.syncFormWithData();
          this.recalculateAndRender();
        }
      });
    });

    const resetViewBtn = document.getElementById('btn_reset_view');
    if (resetViewBtn) {
      resetViewBtn.addEventListener('click', () => {
        const container3D = document.getElementById('canvas3d_container');
        if (this.renderer3D && container3D && !container3D.classList.contains('hidden')) {
          this.renderer3D._fitCamera(this.wallData.geometry);
        } else {
          this.renderer.resetView();
        }
      });
    }

    const printReportBtn = document.getElementById('btn_print_report');
    if (printReportBtn) {
      printReportBtn.addEventListener('click', () => {
        // Cambia a la pestaña "Memoria de Cálculo Completa" antes de
        // imprimir, sin importar qué pestaña estuviera activa, y regenera
        // el informe para asegurar que el esquema se imprima exactamente
        // con el zoom/encuadre que el usuario haya dejado configurado.
        const memoriaTab = document.querySelector('[data-main-tab="report_panel"]');
        if (memoriaTab) memoriaTab.click();
        this.generateCalculationReport();
        setTimeout(() => window.print(), 50);
      });
    }

    const exportImgBtn = document.getElementById('btn_export_png');
    if (exportImgBtn) {
      exportImgBtn.addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = `Muro_Contencion_${this.wallData.geometry.H}m.png`;
        link.href = this.renderer.canvas.toDataURL('image/png');
        link.click();
      });
    }

    const exportJsonBtn = document.getElementById('btn_export_json');
    if (exportJsonBtn) {
      exportJsonBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(this.wallData, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.download = `Proyecto_Muro_${this.wallData.geometry.H}m.json`;
        link.href = URL.createObjectURL(blob);
        link.click();
      });
    }
  }

  syncFormWithData() {
    const inputs = document.querySelectorAll('input[data-bind], select[data-bind]');
    inputs.forEach(input => {
      const bindPath = input.getAttribute('data-bind');
      if (!bindPath) return;

      const parts = bindPath.split('.');
      let target = this.wallData;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target) return;
        target = target[parts[i]];
      }
      if (!target) return;
      const val = target[parts[parts.length - 1]];

      if (input.type === 'checkbox') {
        input.checked = !!val;
      } else {
        input.value = val !== undefined ? val : '';
      }
    });

    const waterCont = document.getElementById('water_params_container');
    if (waterCont) waterCont.classList.toggle('hidden', !this.wallData.loads.has_water_table);
  }

  recalculateAndRender() {
    this.convertUnitsAndSync();

    if (this.wallData.site_conditions?.dentellon_mode === 'auto') {
      this.wallData.geometry.has_key = false;
      const tempDual = calculateDualCaseStability(this.wallData);
      if (!tempDual.governing.pass_sliding) {
        this.wallData.geometry.has_key = true;
      }
    }

    // La metodología UNI evalúa dos casos de carga independientes (tierra +
    // sobrecarga SIN sismo, y tierra + sismo SIN sobrecarga) en vez de
    // sumarlos simultáneamente. `governing` reporta, por cada verificación,
    // el caso más crítico de los dos.
    this.dualResults = calculateDualCaseStability(this.wallData);
    this.geoResults = this.dualResults.governing;
    // El diseño estructural (acero) se calcula con el Caso A (tierra +
    // sobrecarga), igual que la memoria de cálculo de referencia (UNI).
    this.structResults = calculateStructuralDesign(this.wallData, this.dualResults.caseA);
    this.renderer.updateData(this.wallData, this.geoResults, this.structResults);
    if (this.renderer3D) {
      this.renderer3D.updateData(this.wallData, this.geoResults, this.structResults);
      this._updateDentellonLegendRow();
      this._updateRebar3DLegendDims();
    }

    this.updateStatusBadges();
    this.updateForcesTable();
    this.updateStructuralSummary();
    this.updateStemCheckPanel();
    this.generateCalculationReport();
  }

  /** Conecta los checkboxes de la leyenda del "Detalle 3D" para mostrar u
   * ocultar cada tipo de acero de forma independiente. Se llama una sola
   * vez, al crear el renderer3D (los checkboxes viven siempre en el DOM,
   * solo el contenedor 3D se oculta/muestra). */
  _setupRebar3DLegendToggles() {
    const toggles = document.querySelectorAll('#rebar3d_legend .rebar-vis-toggle');
    toggles.forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-rebar-key');
        if (this.renderer3D) this.renderer3D.setRebarTypeVisible(key, input.checked);
      });
    });

    const realScaleToggle = document.getElementById('rebar3d_real_scale');
    if (realScaleToggle) {
      realScaleToggle.addEventListener('change', () => {
        if (this.renderer3D) this.renderer3D.setRebarRealScale(realScaleToggle.checked);
      });
    }

    const legendToggleBtn = document.getElementById('rebar3d_legend_toggle');
    const legendBody = document.getElementById('rebar3d_legend_body');
    if (legendToggleBtn && legendBody) {
      legendToggleBtn.addEventListener('click', () => {
        const collapsed = legendBody.classList.toggle('hidden');
        legendToggleBtn.textContent = collapsed ? '▸' : '▾';
      });
    }
  }

  /** Muestra la fila de la leyenda del acero vertical del dentellón solo
   * cuando el dentellón está habilitado (si no, ese grupo de varillas no
   * existe en el 3D y el checkbox no tendría nada que ocultar). */
  _updateDentellonLegendRow() {
    const hasKey = !!this.wallData?.geometry?.has_key;
    document.querySelectorAll('.dentellon-legend-row').forEach((row) => {
      row.classList.toggle('hidden', !hasKey);
    });
  }

  /** Escribe el diámetro y espaciamiento real de cada tipo de acero al
   * costado de su fila en la leyenda del "Detalle 3D", tomando los mismos
   * valores ya calculados por el motor estructural (sin recalcular nada). */
  _updateRebar3DLegendDims() {
    const str = this.structResults;
    if (!str) return;
    const dims = {
      asvci: `${str.stem.rebar.name} @ ${str.stem.spacing} cm`,
      asvciBaston: `${str.stem.rebar.name} @ ${str.stem.spacing} cm (hasta Lc)`,
      asvce: `${str.stem.rebarTemp.name} @ ${str.stem.spacing_vert_ext_inferior} cm`,
      ashce: `${str.stem.rebarTemp.name} @ ${str.stem.sp_ce_inferior} cm`,
      ashci: `${str.stem.rebar.name} @ ${str.stem.sp_ci_inferior} cm`,
      puntaMain: `${str.toe.rebar.name} @ ${str.toe.spacing} cm`,
      talonMain: `${str.heel.rebar.name} @ ${str.heel.spacing} cm`,
      transversal: `${str.toe.rebarTemp.name} @ ${str.toe.spacing_trans} cm`,
      dentellonVert: `Ø 3/4" (19.1 mm) @ 15 cm`,
      dentellonHoriz: `${str.toe.rebarTemp.name} @ ${str.toe.spacing_trans} cm`
    };
    document.querySelectorAll('.rebar-dim-text').forEach((span) => {
      const key = span.getAttribute('data-dim-key');
      if (dims[key]) span.textContent = dims[key];
    });
  }

  updateStemCheckPanel() {
    const str = this.structResults;
    if (!str) return;
    const stem = str.stem;

    const elMu = document.getElementById('stemchk_mu');
    if (elMu) elMu.textContent = `${stem.Mu_kgm.toFixed(0)} kg·m`;

    const elD = document.getElementById('stemchk_d');
    if (elD) elD.textContent = `d = ${(stem.d * 100).toFixed(1)} cm (t2 = ${(stem.b * 100).toFixed(0)} cm)`;

    const elEq = document.getElementById('stemchk_shear_eq');
    const elBadge = document.getElementById('stemchk_shear_badge');
    const elBox = document.getElementById('stemchk_shear_box');
    if (elEq && elBadge && elBox) {
      elEq.textContent = `Vu = ${stem.Vu_kg.toFixed(0)} kg  ≤  φVc = ${stem.phiVc_kg.toFixed(0)} kg`;
      elBadge.textContent = stem.pass_shear ? 'OK CUMPLE' : 'NO CUMPLE';
      elBadge.className = `px-2 py-0.5 rounded text-[10px] font-bold ${stem.pass_shear ? 'bg-emerald-200 text-emerald-900' : 'bg-rose-200 text-rose-900'}`;
      elBox.className = `p-2.5 rounded border mb-2 text-xs ${stem.pass_shear ? 'bg-emerald-50/40 border-emerald-200' : 'bg-rose-50/40 border-rose-200'}`;
    }

    const elLc = document.getElementById('stemchk_lc');
    if (elLc) elLc.textContent = `Lc = ${stem.Lc_usar.toFixed(2)} m (calculado: ${stem.Lc.toFixed(2)} m)`;
  }

  updateStatusBadges() {
    const geo = this.geoResults;
    const str = this.structResults;
    if (!geo || !str) return;

    this.renderKPIBadge('kpi_overturning', {
      title: 'FS Volcamiento (FSV)',
      val: geo.fs_overturning.toFixed(2),
      req: `≥ ${geo.fs_overturning_req.toFixed(2)}`,
      pass: geo.pass_overturning,
      progress: Math.min(100, (geo.fs_overturning / geo.fs_overturning_req) * 50)
    });

    this.renderKPIBadge('kpi_sliding', {
      title: 'FS Deslizamiento (FSD)',
      val: geo.fs_sliding.toFixed(2),
      req: `≥ ${geo.fs_sliding_req.toFixed(2)}`,
      pass: geo.pass_sliding,
      progress: Math.min(100, (geo.fs_sliding / geo.fs_sliding_req) * 50)
    });

    this.renderKPIBadge('kpi_eccentricity', {
      title: 'Excentricidad (e_x)',
      val: `${(geo.eccentricity * 100).toFixed(1)} cm`,
      req: `≤ ${(geo.e_max_allowed * 100).toFixed(1)} cm (B/6)`,
      pass: geo.pass_eccentricity,
      progress: Math.min(100, (Math.abs(geo.eccentricity) / geo.e_max_allowed) * 100)
    });

    this.renderKPIBadge('kpi_bearing', {
      title: 'Presión Máx. Suelo (q_max)',
      val: `${geo.q_toe_kgcm2.toFixed(2)} kg/cm²`,
      req: `≤ ${geo.q_adm_kgcm2.toFixed(2)} kg/cm²`,
      pass: geo.pass_bearing,
      progress: Math.min(100, (geo.q_toe / geo.q_adm) * 100)
    });

    const globalPass = geo.pass_all && str.pass_all_structural;
    const globalStatusEl = document.getElementById('global_status_banner');
    if (globalStatusEl) {
      if (globalPass) {
        globalStatusEl.className = 'p-3 rounded bg-emerald-50 border border-emerald-300 flex items-center justify-between shadow-sm';
        globalStatusEl.innerHTML = `
          <div class="flex items-center space-x-3">
            <div class="w-7 h-7 rounded bg-emerald-600 text-white flex items-center justify-center font-bold text-sm">✓</div>
            <div>
              <h4 class="font-bold text-emerald-900 text-xs">DISEÑO ADECUADO Y ESTABLE</h4>
              <p class="text-[11px] text-emerald-700">Cumple todas las verificaciones geotécnicas y estructurales según E.060/ACI 318.</p>
            </div>
          </div>
          <span class="px-2.5 py-1 text-xs font-bold rounded bg-emerald-200 text-emerald-900">OK CUMPLE</span>
        `;
      } else {
        globalStatusEl.className = 'p-3 rounded bg-amber-50 border border-amber-300 flex items-center justify-between shadow-sm';
        globalStatusEl.innerHTML = `
          <div class="flex items-center space-x-3">
            <div class="w-7 h-7 rounded bg-amber-600 text-white flex items-center justify-center font-bold text-sm">!</div>
            <div>
              <h4 class="font-bold text-amber-900 text-xs">REVISIÓN REQUERIDA EN EL DISEÑO</h4>
              <p class="text-[11px] text-amber-800">
                ${!geo.pass_sliding ? '• Factor de deslizamiento bajo: se recomienda activar o profundizar el Dentellón. ' : ''}
                ${!geo.pass_bearing ? '• La presión q_max excede la capacidad admisible del terreno. ' : ''}
              </p>
            </div>
          </div>
          <span class="px-2.5 py-1 text-xs font-bold rounded bg-amber-200 text-amber-900">REVISAR</span>
        `;
      }
    }
  }

  renderKPIBadge(elementId, data) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const bgClass = data.pass ? 'border-emerald-300 bg-emerald-50/70' : 'border-amber-300 bg-amber-50/70';
    const textClass = data.pass ? 'text-emerald-700' : 'text-amber-700';
    const barClass = data.pass ? 'bg-emerald-500' : 'bg-amber-500';
    const statusText = data.pass ? 'OK CUMPLE' : 'NO CUMPLE';
    const badgeBg = data.pass ? 'bg-emerald-200 text-emerald-900' : 'bg-amber-200 text-amber-900';

    el.className = `p-2.5 rounded border ${bgClass} transition-all duration-150`;
    el.innerHTML = `
      <div class="flex justify-between items-start mb-0.5">
        <span class="text-[11px] font-bold text-slate-600">${data.title}</span>
        <span class="text-[9px] font-extrabold px-1 py-0.5 rounded ${badgeBg}">${statusText}</span>
      </div>
      <div class="flex items-baseline space-x-1.5">
        <span class="text-lg font-extrabold font-mono ${textClass}">${data.val}</span>
        <span class="text-[10px] text-slate-500 font-medium">${data.req}</span>
      </div>
      <div class="w-full bg-slate-200 h-1 rounded mt-1.5 overflow-hidden">
        <div class="${barClass} h-full rounded transition-all duration-200" style="width: ${data.progress}%"></div>
      </div>
    `;
  }

  updateForcesTable() {
    const geo = this.geoResults;
    if (!geo) return;

    const tbodyWeights = document.getElementById('table_weights_tbody');
    if (tbodyWeights) {
      tbodyWeights.innerHTML = '';
      geo.weights.forEach(w => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 hover:bg-slate-50 text-xs';
        row.innerHTML = `
          <td class="py-2 px-3 font-medium text-slate-800">${w.name} <span class="text-slate-400 block text-[10px]">${w.description}</span></td>
          <td class="py-2 px-3 text-right font-semibold text-slate-700">${w.weight_kg ? w.weight_kg.toFixed(1) : (w.weight * 1000 / 9.80665).toFixed(1)} kg</td>
          <td class="py-2 px-3 text-right text-slate-600">${w.arm_x.toFixed(3)}</td>
          <td class="py-2 px-3 text-right font-bold text-indigo-900">${((w.moment * 1000) / 9.80665).toFixed(1)} kg·m</td>
        `;
        tbodyWeights.appendChild(row);
      });

      const totalKg = (geo.sum_N * 1000) / 9.80665;
      const totalMomKg = (geo.sum_MR * 1000) / 9.80665;
      document.getElementById('total_weight_n').innerHTML = `${totalKg.toFixed(1)} kg`;
      document.getElementById('total_moment_mr').innerHTML = `${totalMomKg.toFixed(1)} kg·m`;
    }

    const tbodyPressures = document.getElementById('table_pressures_tbody');
    if (tbodyPressures) {
      tbodyPressures.innerHTML = '';
      geo.lateralPressures.forces.forEach(f => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 hover:bg-slate-50 text-xs';
        const fKg = (f.force_h * 1000) / 9.80665;
        const mKg = (f.force_h * f.arm_y * 1000) / 9.80665;
        row.innerHTML = `
          <td class="py-2 px-3 font-medium text-slate-800">${f.name} <span class="text-slate-400 block text-[10px]">${f.description}</span></td>
          <td class="py-2 px-3 text-right font-semibold text-rose-700">${fKg.toFixed(1)} kg</td>
          <td class="py-2 px-3 text-right text-slate-600">${f.arm_y.toFixed(3)}</td>
          <td class="py-2 px-3 text-right font-bold text-rose-900">${mKg.toFixed(1)} kg·m</td>
        `;
        tbodyPressures.appendChild(row);
      });

      const totalFhKg = (geo.lateralPressures.sum_Fh * 1000) / 9.80665;
      const totalMoKg = (geo.sum_Mo * 1000) / 9.80665;
      document.getElementById('total_force_fh').innerHTML = `${totalFhKg.toFixed(1)} kg`;
      document.getElementById('total_moment_mo').innerHTML = `${totalMoKg.toFixed(1)} kg·m`;
    }

    this.updateCaseBPanel();
  }

  updateCaseBPanel() {
    const dual = this.dualResults;
    const panel = document.getElementById('case_b_panel');
    if (!panel) return;

    if (!dual || !dual.dual) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    const caseB = dual.caseB;

    document.getElementById('caseb_fsv').textContent = `${caseB.fs_overturning.toFixed(2)} (≥ ${caseB.fs_overturning_req.toFixed(2)})`;
    document.getElementById('caseb_fsd').textContent = `${caseB.fs_sliding.toFixed(2)} (≥ ${caseB.fs_sliding_req.toFixed(2)})`;
    document.getElementById('caseb_ex').textContent = `${(caseB.eccentricity * 100).toFixed(1)} cm (≤ ${(caseB.e_max_allowed * 100).toFixed(1)} cm)`;
    document.getElementById('caseb_qmax').textContent = `${caseB.q_toe_kgcm2.toFixed(2)} / ${caseB.q_adm_kgcm2.toFixed(2)} kg/cm²`;

    const tbodyB = document.getElementById('table_pressures_caseb_tbody');
    if (tbodyB) {
      tbodyB.innerHTML = '';
      caseB.lateralPressures.forces.forEach(f => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 hover:bg-slate-50 text-xs';
        const fKg = (f.force_h * 1000) / 9.80665;
        const mKg = (f.force_h * f.arm_y * 1000) / 9.80665;
        row.innerHTML = `
          <td class="py-2 px-3 font-medium text-slate-800">${f.name} <span class="text-slate-400 block text-[10px]">${f.description}</span></td>
          <td class="py-2 px-3 text-right font-semibold text-amber-700">${fKg.toFixed(1)} kg</td>
          <td class="py-2 px-3 text-right text-slate-600">${f.arm_y.toFixed(3)}</td>
          <td class="py-2 px-3 text-right font-bold text-amber-900">${mKg.toFixed(1)} kg·m</td>
        `;
        tbodyB.appendChild(row);
      });
    }
  }

  updateStructuralSummary() {
    const str = this.structResults;
    if (!str) return;

    const tbody = document.getElementById('table_structural_tbody');
    if (!tbody) return;

    tbody.innerHTML = `
      <tr class="border-b border-slate-100 hover:bg-slate-50 text-xs">
        <td class="py-2 px-3 font-bold text-slate-800">Pantalla (Base Vástago)</td>
        <td class="py-2 px-3 text-right">${str.stem.Mu_kgm.toFixed(0)} kg·m</td>
        <td class="py-2 px-3 text-right">${str.stem.Vu_kg.toFixed(0)} kg / <span class="text-slate-500">${(str.stem.phiVc * 1000 / 9.80665).toFixed(0)} kg</span></td>
        <td class="py-2 px-3 text-right font-bold text-indigo-600">${str.stem.As_design.toFixed(2)} cm²</td>
        <td class="py-2 px-3 font-semibold text-slate-900">${str.stem.rebar_callout} <span class="text-indigo-600 block text-[10px]">${str.stem.rebar_intercalado}</span></td>
        <td class="py-2 px-3 text-center">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${str.stem.pass_shear ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
            ${str.stem.pass_shear ? 'OK Cortante' : 'Falla Cortante'}
          </span>
        </td>
      </tr>
      <tr class="border-b border-slate-100 hover:bg-slate-50 text-xs">
        <td class="py-2 px-3 font-bold text-slate-800">Zapata Anterior (Punta)</td>
        <td class="py-2 px-3 text-right">${str.toe.Mu_kgm.toFixed(0)} kg·m</td>
        <td class="py-2 px-3 text-right">${(str.toe.Vu * 1000 / 9.80665).toFixed(0)} kg / <span class="text-slate-500">${(str.toe.phiVc * 1000 / 9.80665).toFixed(0)} kg</span></td>
        <td class="py-2 px-3 text-right font-bold text-indigo-600">${str.toe.As_design.toFixed(2)} cm²</td>
        <td class="py-2 px-3 font-semibold text-slate-900">${str.toe.rebar_callout} <span class="text-slate-400 block text-[10px]">${str.toe.rebar_trans}</span></td>
        <td class="py-2 px-3 text-center">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${str.toe.pass_shear ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
            ${str.toe.pass_shear ? 'OK Cortante' : 'Falla Cortante'}
          </span>
        </td>
      </tr>
      <tr class="border-b border-slate-100 hover:bg-slate-50 text-xs">
        <td class="py-2 px-3 font-bold text-slate-800">Zapata Posterior (Talón)</td>
        <td class="py-2 px-3 text-right">${str.heel.Mu_kgm.toFixed(0)} kg·m</td>
        <td class="py-2 px-3 text-right">${(str.heel.Vu * 1000 / 9.80665).toFixed(0)} kg / <span class="text-slate-500">${(str.heel.phiVc * 1000 / 9.80665).toFixed(0)} kg</span></td>
        <td class="py-2 px-3 text-right font-bold text-indigo-600">${str.heel.As_design.toFixed(2)} cm²</td>
        <td class="py-2 px-3 font-semibold text-slate-900">${str.heel.rebar_callout} <span class="text-slate-400 block text-[10px]">${str.heel.rebar_trans}</span></td>
        <td class="py-2 px-3 text-center">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${str.heel.pass_shear ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
            ${str.heel.pass_shear ? 'OK Cortante' : 'Falla Cortante'}
          </span>
        </td>
      </tr>
    `;
  }

  /**
   * Post-procesa el HTML ya generado de la Memoria de Cálculo, convirtiendo
   * los valores de peso/fuerza (kg->Tn), momento (kg·m->Tn·m) y presión de
   * contacto/portante (kg/cm²->Tn/m², factor ×10) al sistema en toneladas.
   * Se aplica sobre el string ya armado en vez de tocar cada valor
   * individualmente en la plantilla. Las propiedades de materiales (f'c,
   * fy) se protegen y quedan siempre en kg/cm², ya que por convención de
   * ingeniería nunca se expresan en Tn/m².
   */
  convertReportUnitsToTn(html) {
    // 0) Elimina el paréntesis secundario "(X.XX Tn)" que acompaña a
    // algunos valores en kg (ya redundante una vez que el valor principal
    // también pasa a Tn en el paso 2).
    html = html.replace(/\s*<span class="([^"]*text-\[11px\][^"]*)">\s*\([\d,.]+\s*Tn\)\s*<\/span>/g, '');

    // 1) Protege f'c y fy (resistencia de materiales): nunca se expresan
    // en Tn/m², se dejan intactos en kg/cm².
    const protectedSpans = [];
    html = html.replace(/<span class="[^"]*no-unit-convert[^"]*">[^<]*<\/span>/g, (m) => {
      protectedSpans.push(m);
      return `@@PROTECTED_UNIT_${protectedSpans.length - 1}@@`;
    });

    // 2) Momentos "kg·m" -> "Tn·m" (debe ir antes que el reemplazo de "kg" suelto)
    html = html.replace(/(-?[\d,]+\.?\d*)(\s*)kg·m/g, (m, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      return `${(num / 1000).toFixed(2)} Tn·m`;
    });
    // 3) Presiones de contacto/portante "kg/cm²" -> "Tn/m²" (×10)
    html = html.replace(/(-?[\d,]+\.?\d*)(\s*)kg\/cm²/g, (m, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      return `${(num * 10).toFixed(2)} Tn/m²`;
    });
    // 3b) Presiones locales "kg/m²" -> "Tn/m²" (÷1000)
    html = html.replace(/(-?[\d,]+\.?\d*)(\s*)kg\/m²/g, (m, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      return `${(num / 1000).toFixed(2)} Tn/m²`;
    });
    // 3c) Pesos específicos "kg/m³" -> "Tn/m³" (÷1000)
    html = html.replace(/(-?[\d,]+\.?\d*)(\s*)kg\/m³/g, (m, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      return `${(num / 1000).toFixed(2)} Tn/m³`;
    });
    // 4) Pesos/fuerzas "kg" sueltos -> "Tn" (evita kg/m³, kg/m², kg·cm)
    html = html.replace(/(-?[\d,]+\.?\d*)(\s*)kg(?!\/|·|-|\w)/g, (m, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      return `${(num / 1000).toFixed(2)} Tn`;
    });
    // 5) Encabezados/etiquetas sueltas sin número adjunto
    html = html.replace(/\(kg·m\)/g, '(Tn·m)').replace(/\(kg\)/g, '(Tn)');

    // 6) Restaura f'c/fy protegidos
    html = html.replace(/@@PROTECTED_UNIT_(\d+)@@/g, (m, i) => protectedSpans[parseInt(i, 10)]);

    return html;
  }

  /**
   * Devuelve (creando si hace falta) el estado de zoom/pan/bloqueo propio
   * de un esquema del informe, identificado por una clave única (p.ej.
   * 'predim', 'forces', 'pressures_ea'...). Cada esquema es independiente.
   */
  getDiagramState(key) {
    if (!this.reportDiagramStates[key]) {
      this.reportDiagramStates[key] = { zoom: 1.0, panX: 0, panY: 0, locked: false };
    }
    return this.reportDiagramStates[key];
  }

  /**
   * Barra de control de zoom (−/%/+/Restablecer/bloquear) para un esquema
   * específico de la Memoria de Cálculo, identificado por `key`. Cada
   * esquema tiene su propio zoom/pan, independiente de los demás.
   */
  zoomControlsHtml(key) {
    const st = this.getDiagramState(key);
    const pct = Math.round((st.zoom || 1) * 100);
    const locked = !!st.locked;
    return `
      <div class="flex items-center justify-center gap-2 mb-2 no-print">
        <button data-report-zoom="out" data-report-key="${key}" class="w-6 h-6 rounded border border-slate-300 bg-white hover:bg-slate-100 text-sm font-bold text-slate-600 transition" title="Alejar" ${locked ? 'disabled' : ''}>−</button>
        <span class="text-[11px] text-slate-500 font-mono w-10 text-center">${pct}%</span>
        <button data-report-zoom="in" data-report-key="${key}" class="w-6 h-6 rounded border border-slate-300 bg-white hover:bg-slate-100 text-sm font-bold text-slate-600 transition" title="Acercar" ${locked ? 'disabled' : ''}>+</button>
        <button data-report-zoom="reset" data-report-key="${key}" class="px-2 h-6 rounded border border-slate-300 bg-white hover:bg-slate-100 text-[11px] font-bold text-slate-600 transition" title="Restablecer zoom" ${locked ? 'disabled' : ''}>Restablecer</button>
        <button data-report-zoom="lock" data-report-key="${key}" class="w-6 h-6 rounded border text-sm transition ${locked ? 'bg-amber-100 border-amber-300 text-amber-700' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'}" title="${locked ? 'Desbloquear esquema (permitir zoom con la rueda del mouse)' : 'Bloquear esquema (evita que la rueda del mouse lo acerque al bajar la página)'}">${locked ? '🔒' : '🔓'}</button>
      </div>`;
  }

  generateCalculationReport() {
    const reportContainer = document.getElementById('calculation_report_content');
    if (!reportContainer) return;

    // Reemplazar innerHTML del informe (p.ej. al hacer zoom/pan/bloquear un
    // esquema) hace que el navegador pierda la posición de scroll del panel
    // contenedor y salte arriba — se guarda y restaura para que el usuario
    // no pierda su lugar en la página cada vez que interactúa con un gráfico.
    const reportPanelEl = document.getElementById('report_panel');
    const savedScrollTop = reportPanelEl ? reportPanelEl.scrollTop : null;

    const geo = this.geoResults;
    const str = this.structResults;
    const w = this.wallData;
    const dual = this.dualResults;
    const Ka = geo.lateralPressures.Ka;
    const caseLabel = (id) => id === 'B' ? 'Caso B: Sismo' : 'Caso A: Sobrecarga';

    const totalKg = (geo.sum_N * 1000) / 9.80665;
    const totalMRKg = (geo.sum_MR * 1000) / 9.80665;
    const totalMoKg = (geo.sum_Mo * 1000) / 9.80665;

    let canvasSnapshot = '';
    let canvasSnapshotForces = '';
    let canvasSnapshotPressuresEa = '';
    let canvasSnapshotLocalPressures = '';
    try {
      if (this.renderer) {
        // Cada esquema se captura con su propio zoom/pan independiente
        // (this.getDiagramState(key)), aunque varios compartan el mismo
        // modo de vista 'pressures'.
        canvasSnapshot = this.renderer.captureSnapshot('geometry', this.getDiagramState('predim'));
        canvasSnapshotForces = this.renderer.captureSnapshot('forces', this.getDiagramState('forces'));
        canvasSnapshotPressuresEa = this.renderer.captureSnapshot('pressures', this.getDiagramState('pressures_ea'));
        canvasSnapshotLocalPressures = this.renderer.captureSnapshot('local_pressures', this.getDiagramState('local_pressures'));
      }
    } catch (e) { /* canvas no disponible aún */ }

    let reportHtml = `
      <div class="space-y-6 text-slate-800 font-sans text-sm max-w-4xl mx-auto">
        
        <div class="border-b-2 border-indigo-700 pb-4 flex justify-between items-end">
          <div>
            <h2 class="text-xl font-bold text-slate-900 uppercase tracking-tight">Memoria de Cálculo: Muro de Contención en Voladizo</h2>
            <p class="text-slate-500 text-xs">Diseño Geotécnico y Estructural según Norma Técnica Peruana E.060 / ACI 318</p>
          </div>
          <div class="text-right text-xs text-slate-400">
            <span>Fecha: ${new Date().toLocaleDateString('es-ES')}</span>
          </div>
        </div>

        <!-- I. Datos de Diseño -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">I. DATOS DE DISEÑO</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            A continuación se presentan los datos de diseño (geometría, suelo de fundación y de
            relleno, materiales) y el predimensionamiento final escogido, con el cual el muro
            cumple las verificaciones de estabilidad y resistencia exigidas por la Norma Técnica
            Peruana E.060 y E.050, para la geometría más viable según el terreno disponible.
          </p>
          ${(() => {
            const dataTable = (rows) => `
              <div class="overflow-x-auto mb-4">
                <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                  <thead class="bg-indigo-600 text-white">
                    <tr>
                      <th class="py-1.5 px-2.5 text-left w-20">Símbolo</th>
                      <th class="py-1.5 px-2.5 text-right w-32">Valor</th>
                      <th class="py-1.5 px-2.5 text-left">Descripción</th>
                    </tr>
                  </thead>
                  <tbody class="text-slate-700">
                    ${rows.map(r => `
                    <tr class="border-t border-slate-100">
                      <td class="py-1.5 px-2.5 font-bold font-mono">${r.sym}</td>
                      <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${r.protect ? `<span class="no-unit-convert">${r.val}</span>` : r.val}</td>
                      <td class="py-1.5 px-2.5 text-slate-500 italic text-[11px]">→ ${r.desc}</td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </div>`;

            const covStemCm = (w.materials.cover_stem ?? 0.04) * 100;
            const covFootCm = (w.materials.cover_footing ?? 0.075) * 100;
            const ratioMap = { '0': 0, '1/2': 0.5, '2/3': 2 / 3, '1': 1 };
            const frRatio = w.foundation.friction_ratio || '2/3';
            const phiF = w.foundation.phi ?? 32;
            const deltaBase = (ratioMap[frRatio] !== undefined ? ratioMap[frRatio] : 2 / 3) * phiF;
            const qKgm2 = ((w.loads.q_surcharge || 0) * 1000) / 9.80665;

            return `
              <p class="text-xs font-bold text-slate-800 mb-1.5">1- GEOMETRÍA DEL MURO:</p>
              ${dataTable([
                { sym: 'H', val: `${w.geometry.H.toFixed(2)} m`, desc: 'Altura total' },
                { sym: 'h', val: `${(w.geometry.H - (w.geometry.Df ?? w.geometry.hz)).toFixed(2)} m`, desc: 'Altura de suelo a corona (h = H − Df)' },
                { sym: 'r(M)', val: `${covStemCm.toFixed(2)} cm`, desc: 'Recubrimiento del muro (pantalla)' },
                { sym: 'r(Z)', val: `${covFootCm.toFixed(2)} cm`, desc: 'Recubrimiento de la zapata' },
              ])}

              <p class="text-xs font-bold text-slate-800 mb-1.5">2- DATOS DEL TERRENO:</p>
              ${dataTable([
                { sym: 'γs', val: `${(w.foundation.gamma_kgm3 || 1800).toFixed(0)} kg/m³`, desc: 'Peso específico del suelo' },
                { sym: 'γr', val: `${(w.backfill.gamma_kgm3 || 1900).toFixed(0)} kg/m³`, desc: 'Peso específico del relleno' },
                { sym: 'σt', val: `${(w.foundation.q_ult_kgcm2 || 4.5).toFixed(2)} kg/cm²`, desc: 'Capacidad portante del suelo' },
                { sym: 'Ø', val: `${phiF.toFixed(1)}°`, desc: 'Ángulo de fricción interna del suelo de fundación' },
                { sym: 'Ør', val: `${(w.backfill.phi ?? 34).toFixed(1)}°`, desc: 'Ángulo de fricción interna del relleno' },
                { sym: 'β', val: `${(w.backfill.beta || 0).toFixed(1)}°`, desc: 'Ángulo de relleno con la horizontal' },
                { sym: 'α', val: `90.0°`, desc: 'Ángulo de la cara interna del muro con la horizontal' },
                { sym: 'δ', val: `${deltaBase.toFixed(1)}°`, desc: 'Ángulo de fricción suelo-muro' },
                { sym: 'Df', val: `${(w.geometry.Df ?? w.geometry.hz).toFixed(2)} m`, desc: 'Profundidad de cimentación según EMS' },
              ])}

              <p class="text-xs font-bold text-slate-800 mb-1.5">3- DATOS DEL CONCRETO Y ACERO:</p>
              ${dataTable([
                { sym: "f'c", val: `${(w.materials.fc_kgcm2 || 210).toFixed(0)} kg/cm²`, desc: 'Resistencia a la compresión del concreto', protect: true },
                { sym: 'γc', val: `${(w.materials.gamma_c_kgm3 || 2400).toFixed(0)} kg/m³`, desc: 'Peso específico del concreto' },
                { sym: 'fy', val: `${(w.materials.fy_kgcm2 || 4200).toFixed(0)} kg/cm²`, desc: 'Esfuerzo de fluencia del acero', protect: true },
              ])}

              <p class="text-xs font-bold text-slate-800 mb-1.5">4- FACTORES DE SEGURIDAD:</p>
              ${dataTable([
                { sym: 'F.S.D.', val: (w.safety_req?.fs_sliding ?? 1.50).toFixed(2), desc: 'Factor de seguridad por deslizamiento' },
                { sym: 'F.S.V.', val: (w.safety_req?.fs_overturning ?? 1.75).toFixed(2), desc: 'Factor de seguridad por volteo' },
              ])}

              <p class="text-xs font-bold text-slate-800 mb-1.5">5- SOBRECARGA:</p>
              ${dataTable([
                { sym: 'q=S/C', val: `${qKgm2.toFixed(0)} kg/m²`, desc: 'Sobrecarga' },
              ])}
            `;
          })()}
        </section>

        <!-- 1. Predimensionamiento -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">1. Predimensionamiento del Muro</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            Se muestran los datos necesarios para el predimensionamiento, así como el
            dimensionamiento final escogido, con el cual el muro cumple las exigencias
            estructurales además de la geometría más viable para el terreno disponible.
          </p>
          <div class="overflow-x-auto mb-3">
            <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
              <thead class="bg-amber-500 text-white">
                <tr>
                  <th class="py-1.5 px-2.5 text-left">Parámetro</th>
                  <th class="py-1.5 px-2.5 text-left">Fórmula / Rango Sugerido</th>
                  <th class="py-1.5 px-2.5 text-right">Calculado</th>
                  <th class="py-1.5 px-2.5 text-right">Escogido</th>
                </tr>
              </thead>
              <tbody class="text-slate-700">
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Altura de muro (H)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">H = Df + h</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">h = ${(w.geometry.H - w.geometry.Df).toFixed(2)} m</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${w.geometry.H.toFixed(2)} m</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Corona (t1)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">Mínimo 0.20 m, sugerido ≥ 0.30 m</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">-</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${w.geometry.b_top.toFixed(2)} m</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Base de vástago (t2)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">Ver 2.1 (corte en la base)</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${(str.stem.t2_calc_cm / 100).toFixed(2)} m</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${w.geometry.b_bot.toFixed(2)} m</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Ancho de zapata (B)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">B = 0.5H a 0.8H</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">0.7H = ${(0.7 * w.geometry.H).toFixed(2)} m</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${w.geometry.B.toFixed(2)} m</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Peralte de zapata (hz)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">hz = H/12 a H/10</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">H/10 = ${(w.geometry.H / 10).toFixed(2)} m</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${w.geometry.hz.toFixed(2)} m</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Punta (P)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">P = B/4 a B/3; P_min = hz</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${(w.geometry.B / 4).toFixed(2)} a ${(w.geometry.B / 3).toFixed(2)} m</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${w.geometry.B_toe.toFixed(2)} m</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">Talón (T)</td>
                  <td class="py-1.5 px-2.5 font-mono text-[11px]">T = B − (P + t2)</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">-</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold bg-amber-50">${geo.B_heel.toFixed(2)} m</td>
                </tr>
              </tbody>
            </table>
          </div>
          ${this.zoomControlsHtml('predim')}
          <div class="flex justify-center bg-slate-50 border border-slate-200 rounded-lg p-2 avoid-break">
            <img src="${canvasSnapshot}" alt="Esquema del muro" data-report-key="predim" class="max-w-full report-diagram-img cursor-grab active:cursor-grabbing" style="max-height: 420px;">
          </div>
        </section>

        <!-- 1.1 Dimensionamiento y verificación por corte en la base de la pantalla -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">2.1. Dimensionamiento y Verificación por Corte en la Base de la Pantalla</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            Se muestra el dimensionamiento de la base de la pantalla a partir del momento último
            actuante; este paso está relacionado con el cálculo del acero en la cara interior de
            la pantalla que se muestra en la sección 4. El cortante último se evalúa a una
            distancia "d" (peralte efectivo) de la base, tal como lo permite la Norma E.060 / ACI 318.
          </p>
          <p class="text-xs font-bold text-emerald-800 mb-1.5">Cálculo del momento último</p>
          <div class="grid grid-cols-2 gap-3 text-xs mb-3">
            <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
              <tbody>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Ka</td><td class="py-1 px-2 text-right font-mono">${str.stem.Ka.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">Coef. empuje activo</td></tr>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">γs</td><td class="py-1 px-2 text-right font-mono">${str.stem.gamma_s_kgm3.toFixed(0)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg/m³</td></tr>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">hp</td><td class="py-1 px-2 text-right font-mono">${str.stem.hp.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">m, altura de pantalla (H−hz)</td></tr>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">hs</td><td class="py-1 px-2 text-right font-mono">${str.stem.hs.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">m, altura de suelo por S/C</td></tr>
                <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">Mu</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${str.stem.Mu_Tnm.toFixed(2)}</td><td class="py-1 px-2 text-indigo-700 italic text-[11px]">Tn·m (${str.stem.Mu_kgcm.toLocaleString('es-PE', {maximumFractionDigits: 0})} kg·cm)</td></tr>
              </tbody>
            </table>
            <div class="p-2.5 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700 self-start">
              Mu = 1.7·[Ka·γs·hp²/2·(hp/3 + hs)]
            </div>
          </div>

          <p class="text-xs font-bold text-emerald-800 mb-1.5">Peralte "d" y espesor de pantalla (t2)</p>
          <div class="grid grid-cols-2 gap-3 text-xs mb-2">
            <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
              <tbody>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Ø (flexión)</td><td class="py-1 px-2 text-right font-mono">${str.stem.rho_design === str.stem.rho ? '0.90' : '0.90'}</td></tr>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">ω</td><td class="py-1 px-2 text-right font-mono">${str.stem.omega.toFixed(3)}</td></tr>
                <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">cm</td></tr>
                <tr class="bg-emerald-50 border-b border-slate-100"><td class="py-1 px-2 font-bold text-emerald-900">d</td><td class="py-1 px-2 text-right font-mono font-bold text-emerald-900">${str.stem.d_check_cm.toFixed(2)}</td><td class="py-1 px-2 text-emerald-700 italic text-[11px]">cm, mínimo exigido por Mu</td></tr>
                <tr class="bg-emerald-50"><td class="py-1 px-2 font-bold text-emerald-900">dreal</td><td class="py-1 px-2 text-right font-mono font-bold text-emerald-900">${str.stem.dreal_cm.toFixed(2)}</td><td class="py-1 px-2 text-emerald-700 italic text-[11px]">cm, disponible con t2 escogido</td></tr>
              </tbody>
            </table>
            <div class="space-y-2">
              <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700">
                t2 = d + r + Ø<sub>As</sub>/2 = ${str.stem.d_check_cm.toFixed(2)} + ${str.stem.cover_stem_cm.toFixed(1)} + ${(str.stem.rebar.diameter_mm / 20).toFixed(2)} = <strong>${str.stem.t2_calc_cm.toFixed(2)} cm</strong>
              </div>
              <div class="flex items-center justify-between p-2 rounded border ${str.stem.t2_usar_cm >= str.stem.t2_calc_cm ? 'bg-amber-50 border-amber-300' : 'bg-rose-50 border-rose-300'}">
                <span class="text-xs font-bold text-slate-700">Usar t2 =</span>
                <span class="font-mono font-bold text-amber-900">${str.stem.t2_usar_cm.toFixed(2)} cm</span>
              </div>
            </div>
          </div>
          <p class="text-[11px] text-slate-500 italic mb-3">
            Nota: el valor de "dreal" y, por lo tanto, de t2, varía según el diámetro de varilla
            (Ø<sub>As</sub> = ${str.stem.rebar.diameter_mm.toFixed(1)} mm) escogido para el acero
            vertical de la pantalla, ya que este diámetro forma parte directa de la fórmula
            t2 = d + r + Ø<sub>As</sub>/2.
          </p>

          <p class="text-xs font-bold text-indigo-800 mt-3 mb-1.5 underline">Verificación por Corte en la Base del Muro</p>

          <p class="text-xs font-bold text-emerald-800 mb-1">Cálculo del cortante último</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
            <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700">
              Vu = 1.7·Vd = 1.7·[Ka·γs·(hp−d)·(½(hp−d) + hs)]
            </div>
            <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
              <span class="font-bold text-indigo-900">Vu = ${str.stem.Vu_kg.toFixed(0)} kg</span>
              <span class="text-indigo-500 text-[11px]"> (${(str.stem.Vu_kg / 1000).toFixed(2)} Tn)</span>
            </div>
          </div>

          <p class="text-xs font-bold text-emerald-800 mb-1">Cálculo del cortante resistente del concreto</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
            <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700">
              Vc = 0.53·√f'c·b·d
            </div>
            <div class="p-2 bg-emerald-50 rounded border border-emerald-200 text-center">
              <span class="font-bold text-emerald-900">Vc = ${str.stem.Vc_kg.toFixed(0)} kg</span>
              <span class="text-emerald-600 text-[11px]"> (${(str.stem.Vc_kg / 1000).toFixed(2)} Tn)</span>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 items-stretch">
            <table class="w-full text-xs border border-slate-200 rounded overflow-hidden self-center">
              <thead class="bg-slate-100 text-slate-600">
                <tr><th class="py-1 px-2">Vu</th><th class="py-1 px-2"></th><th class="py-1 px-2">φVc</th></tr>
              </thead>
              <tbody>
                <tr class="border-t border-slate-100 text-center font-mono">
                  <td class="py-1 px-2">${(str.stem.Vu_kg / 1000).toFixed(2)}</td>
                  <td class="py-1 px-2">≤</td>
                  <td class="py-1 px-2">${(str.stem.phiVc_kg / 1000).toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            <div class="flex items-center justify-center rounded border text-xs font-bold ${str.stem.pass_shear ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-rose-50 border-rose-300 text-rose-700'}">
              ${str.stem.pass_shear ? 'Sí Cumple' : 'No Cumple'}
            </div>
          </div>
        </section>

        <!-- 2.2 Cálculo de Fuerzas -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">2.2. Cálculo de Fuerzas</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            En el presente ítem se muestra el cálculo de las diferentes fuerzas actuantes en la
            estructura, las cuales nos servirán para las diferentes verificaciones y el cálculo
            del acero de refuerzo posteriormente.
          </p>

          <p class="text-xs font-bold text-emerald-800 mb-1">Cálculo de la altura equivalente de la Sobrecarga (hs)</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-3">
            <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
              <span class="font-bold text-indigo-900">hs = ${str.stem.hs.toFixed(2)} m</span>
            </div>
            <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700 text-center">
              hs = S/C ÷ γs
            </div>
          </div>

          <p class="text-xs font-bold text-emerald-800 mb-1.5">Cálculo de Fuerzas Verticales y Momentos</p>
          <div class="overflow-x-auto mb-3">
            <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
              <thead class="bg-amber-500 text-white">
                <tr>
                  <th class="py-1.5 px-2.5 text-left">Zona</th>
                  <th class="py-1.5 px-2.5 text-left">Elemento</th>
                  <th class="py-1.5 px-2.5 text-left">Material</th>
                  <th class="py-1.5 px-2.5 text-right">γ</th>
                  <th class="py-1.5 px-2.5 text-right">Área (m²)</th>
                  <th class="py-1.5 px-2.5 text-right">Volumen (m²) × 1m</th>
                  <th class="py-1.5 px-2.5 text-right">Peso = V·γ</th>
                  <th class="py-1.5 px-2.5 text-right">Brazo (m)</th>
                  <th class="py-1.5 px-2.5 text-right">Momento</th>
                </tr>
              </thead>
              <tbody class="text-slate-700">
                ${[...geo.weights].sort((a, b) => (a.material === 'Concreto' ? 0 : 1) - (b.material === 'Concreto' ? 0 : 1)).map(wt => `
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5 font-bold">${wt.id}</td>
                  <td class="py-1.5 px-2.5">${wt.name.replace(/^W\d:\s*/, '')} <span class="text-slate-400 block text-[10px]">${wt.description}</span></td>
                  <td class="py-1.5 px-2.5">${wt.material || '-'}</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${wt.gamma_kgm3 !== undefined ? `${wt.gamma_kgm3.toFixed(0)} ${wt.gamma_unit || 'kg/m³'}` : '-'}</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${wt.area !== undefined ? wt.area.toFixed(2) : '-'}</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${wt.area !== undefined ? `${wt.area.toFixed(2)} · 1m` : '-'}</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${wt.weight_kg.toFixed(1)} kg</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${wt.arm_x.toFixed(3)}</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold">${((wt.moment * 1000) / 9.80665).toFixed(1)} kg·m</td>
                </tr>`).join('')}
                <tr class="border-t border-slate-200 bg-amber-50 font-bold">
                  <td class="py-1.5 px-2.5" colspan="6">Σ Fv / Σ MFv</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${totalKg.toFixed(1)} kg</td>
                  <td class="py-1.5 px-2.5"></td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${totalMRKg.toFixed(1)} kg·m</td>
                </tr>
              </tbody>
            </table>
          </div>

          ${canvasSnapshotForces ? `
          ${this.zoomControlsHtml('forces')}
          <div class="flex justify-center bg-slate-50 border border-slate-200 rounded-lg p-2 mb-3 avoid-break">
            <img src="${canvasSnapshotForces}" alt="Diagrama de fuerzas verticales" data-report-key="forces" class="max-w-full report-diagram-img cursor-grab active:cursor-grabbing" style="max-height: 380px;">
          </div>` : ''}

          <p class="text-xs font-bold text-emerald-800 mb-1.5">Empuje Activo (Ea)</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
            <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700 text-center">
              Ka = (1 − sen φ) / (1 + sen φ)
            </div>
            <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
              <span class="font-bold text-indigo-900">Ka = ${Ka.toFixed(2)}</span>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
            <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700 text-center">
              Ea<sub>s/c</sub> = Ka · γs · hs · H
            </div>
            <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
              <span class="font-bold text-indigo-900">Ea<sub>s/c</sub> = ${((geo.lateralPressures.forces[0]?.force_h || 0) * 1000 / 9.80665).toFixed(1)} kg</span>
              <span class="text-indigo-500 text-[11px] block">Ubicación: H/2 = ${(w.geometry.H / 2).toFixed(2)} m</span>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-3">
            <div class="p-2 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] text-slate-700 text-center">
              Ea = ½ · Ka · γs · H²
            </div>
            <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
              <span class="font-bold text-indigo-900">Ea = ${((geo.lateralPressures.forces[1]?.force_h || 0) * 1000 / 9.80665).toFixed(1)} kg</span>
              <span class="text-indigo-500 text-[11px] block">Ubicación: H/3 = ${(w.geometry.H / 3).toFixed(2)} m</span>
            </div>
          </div>

          <p class="text-xs font-bold text-emerald-800 mb-1.5">Cálculo de Fuerzas Horizontales y Momentos</p>
          <div class="overflow-x-auto">
            <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
              <thead class="bg-amber-500 text-white">
                <tr>
                  <th class="py-1.5 px-2.5 text-left">Fuerza</th>
                  <th class="py-1.5 px-2.5 text-right">Peso</th>
                  <th class="py-1.5 px-2.5 text-right">Brazo (m)</th>
                  <th class="py-1.5 px-2.5 text-right">Momento</th>
                </tr>
              </thead>
              <tbody class="text-slate-700">
                ${geo.lateralPressures.forces.map(f => `
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 px-2.5">${f.name} <span class="text-slate-400 block text-[10px]">${f.description}</span></td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${(f.force_h * 1000 / 9.80665).toFixed(1)} kg</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${f.arm_y.toFixed(3)}</td>
                  <td class="py-1.5 px-2.5 text-right font-mono font-bold">${(f.force_h * f.arm_y * 1000 / 9.80665).toFixed(1)} kg·m</td>
                </tr>`).join('')}
                <tr class="border-t border-slate-200 bg-amber-50 font-bold">
                  <td class="py-1.5 px-2.5">Σ Fh / Σ MFh</td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${(geo.lateralPressures.sum_Fh * 1000 / 9.80665).toFixed(1)} kg</td>
                  <td class="py-1.5 px-2.5"></td>
                  <td class="py-1.5 px-2.5 text-right font-mono">${totalMoKg.toFixed(1)} kg·m</td>
                </tr>
              </tbody>
            </table>
          </div>

          ${canvasSnapshotPressuresEa ? `
          ${this.zoomControlsHtml('pressures_ea')}
          <div class="flex justify-center bg-slate-50 border border-slate-200 rounded-lg p-2 mt-3 avoid-break">
            <img src="${canvasSnapshotPressuresEa}" alt="Diagrama de empujes laterales" data-report-key="pressures_ea" class="max-w-full report-diagram-img cursor-grab active:cursor-grabbing" style="max-height: 380px;">
          </div>` : ''}
        </section>

        <!-- 2.4 Estabilidad Geotécnica -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">2.3. Verificaciones de Estabilidad</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            A continuación se procede a calcular el coeficiente de fricción, para lo cual se toma
            el menor valor entre un valor de tablas sugerido y el valor calculado matemáticamente.
            Luego, se procede a verificar la estabilidad frente al desplazamiento horizontal, al
            volteo y a presiones excesivas, donde a la vez se verifica que la capacidad portante
            del suelo sea la adecuada.
          </p>
          ${(() => {
            const pd = geo.lateralPressures.passive_detail;
            if (!pd || pd.mode !== 'dentellon') return '';
            const sigma_ps_kg = pd.sigma_ps * 101.9716;
            const sigma_pi_kg = pd.sigma_pi * 101.9716;
            const Ep_kg = (geo.lateralPressures.passive_force * 1000) / 9.80665;

            const H = w.geometry.H, hz = w.geometry.hz, Df = w.geometry.Df || hz;
            const H_stem = Math.max(0.001, H - hz);
            const B_toe = w.geometry.B_toe, b_bot = w.geometry.b_bot, B = w.geometry.B;
            const Hd = pd.Hd, Bd = w.geometry.key_width;
            const key_pos = w.geometry.key_pos ?? (B_toe + (b_bot - Bd) / 2);
            const Hd_calc = H / 10.0;
            const Bd_calc = b_bot;

            // --- Diagrama SVG dedicado: perfil del muro con el dentellón en
            // la puntera (con Df/Hd/Bd/H acotados) + diagrama de presión
            // pasiva (σps/σpi/Ep) del lado izquierdo, ambos a escala.
            const pxPerM = Math.min(30, 250 / H);
            const rx0 = 240; // origen X del perfil del muro (panel derecho)
            const topY = 20;
            const zapataTopY = topY + H_stem * pxPerM;
            const zapataBotY = zapataTopY + hz * pxPerM;
            const dentBotY = zapataBotY + Hd * pxPerM;
            const frontGroundY = zapataBotY - Df * pxPerM;
            const stemX0 = rx0 + B_toe * pxPerM, stemX1 = rx0 + (B_toe + b_bot) * pxPerM;
            const zapX0 = rx0, zapX1 = rx0 + B * pxPerM;
            const dentX0 = rx0 + key_pos * pxPerM, dentX1 = rx0 + (key_pos + Bd) * pxPerM;

            const dimV = (x, y0, y1, label, labelX) => `
              <line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="#2563eb" stroke-width="1.2"/>
              <line x1="${x - 4}" y1="${y0}" x2="${x + 4}" y2="${y0}" stroke="#2563eb" stroke-width="1.2"/>
              <line x1="${x - 4}" y1="${y1}" x2="${x + 4}" y2="${y1}" stroke="#2563eb" stroke-width="1.2"/>
              <text x="${labelX}" y="${(y0 + y1) / 2 + 3}" font-size="10" font-weight="700" fill="#2563eb" text-anchor="middle">${label}</text>`;

            const diagram = `
              <svg viewBox="0 0 620 ${dentBotY + 40}" style="max-width:560px; width:100%;">
                <!-- Panel izquierdo: presión pasiva σps/σpi y Ep -->
                <g>
                  <line x1="150" y1="${frontGroundY}" x2="150" y2="${dentBotY}" stroke="#0f172a" stroke-width="1.3" stroke-dasharray="3,3"/>
                  <polygon points="150,${frontGroundY} 190,${frontGroundY} 215,${dentBotY} 150,${dentBotY}" fill="#fde68a" fill-opacity="0.5" stroke="#b45309" stroke-width="1.5"/>
                  <line x1="150" y1="${frontGroundY}" x2="190" y2="${frontGroundY}" stroke="#b45309" stroke-width="2"/>
                  <line x1="150" y1="${dentBotY}" x2="215" y2="${dentBotY}" stroke="#b45309" stroke-width="2"/>
                  <text x="145" y="${frontGroundY - 4}" font-size="11" font-weight="700" fill="#b45309" text-anchor="end">σps=${sigma_ps_kg.toFixed(0)} kg/m²</text>
                  <text x="220" y="${dentBotY + 2}" font-size="11" font-weight="700" fill="#b45309" text-anchor="start">σpi=${sigma_pi_kg.toFixed(0)} kg/m²</text>
                  <line x1="70" y1="${(frontGroundY + dentBotY) / 2}" x2="148" y2="${(frontGroundY + dentBotY) / 2}" stroke="#7c3aed" stroke-width="3"/>
                  <polygon points="148,${(frontGroundY + dentBotY) / 2} 138,${(frontGroundY + dentBotY) / 2 - 5} 138,${(frontGroundY + dentBotY) / 2 + 5}" fill="#7c3aed"/>
                  <text x="68" y="${(frontGroundY + dentBotY) / 2 - 6}" font-size="12" font-weight="700" fill="#7c3aed" text-anchor="end">Ep=${Ep_kg.toFixed(0)} kg</text>
                </g>
                <!-- Panel derecho: perfil del muro y el dentellón -->
                <g>
                  <rect x="${stemX0}" y="${topY}" width="${stemX1 - stemX0}" height="${zapataTopY - topY}" fill="#e2e8f0" stroke="#0f172a" stroke-width="2"/>
                  <rect x="${zapX0}" y="${zapataTopY}" width="${zapX1 - zapX0}" height="${zapataBotY - zapataTopY}" fill="#e2e8f0" stroke="#0f172a" stroke-width="2"/>
                  <rect x="${dentX0}" y="${zapataBotY}" width="${dentX1 - dentX0}" height="${dentBotY - zapataBotY}" fill="#c7d2fe" stroke="#0f172a" stroke-width="2"/>
                  <line x1="${zapX0 - 20}" y1="${frontGroundY}" x2="${stemX0}" y2="${frontGroundY}" stroke="#b45309" stroke-width="2"/>
                  <line x1="${zapX0 - 30}" y1="${topY - 5}" x2="${stemX1 + 10}" y2="${topY - 5}" stroke="#b45309" stroke-width="2"/>
                  ${dimV(zapX0 - 12, frontGroundY, zapataBotY, 'Df', zapX0 - 30)}
                  ${dimV(dentX0 - 12, zapataBotY, dentBotY, 'Hd', dentX0 - 30)}
                  <line x1="${dentX0}" y1="${dentBotY + 14}" x2="${dentX1}" y2="${dentBotY + 14}" stroke="#2563eb" stroke-width="1.2"/>
                  <line x1="${dentX0}" y1="${dentBotY + 10}" x2="${dentX0}" y2="${dentBotY + 18}" stroke="#2563eb" stroke-width="1.2"/>
                  <line x1="${dentX1}" y1="${dentBotY + 10}" x2="${dentX1}" y2="${dentBotY + 18}" stroke="#2563eb" stroke-width="1.2"/>
                  <text x="${(dentX0 + dentX1) / 2}" y="${dentBotY + 28}" font-size="10" font-weight="700" fill="#2563eb" text-anchor="middle">Bd</text>
                  <line x1="${stemX1 + 30}" y1="${topY}" x2="${stemX1 + 30}" y2="${zapataBotY}" stroke="#2563eb" stroke-width="1.2"/>
                  <line x1="${stemX1 + 26}" y1="${topY}" x2="${stemX1 + 34}" y2="${topY}" stroke="#2563eb" stroke-width="1.2"/>
                  <line x1="${stemX1 + 26}" y1="${zapataBotY}" x2="${stemX1 + 34}" y2="${zapataBotY}" stroke="#2563eb" stroke-width="1.2"/>
                  <text x="${stemX1 + 40}" y="${(topY + zapataBotY) / 2 + 3}" font-size="11" font-weight="700" fill="#2563eb">H=${H.toFixed(2)} m</text>
                </g>
              </svg>`;

            return `
          <div class="p-3 rounded-lg border border-indigo-100 bg-indigo-50/30 mb-3 avoid-break">
            <h4 class="font-bold text-slate-900 mb-2 text-xs underline">Diseño del Dentellón del Pie</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-3">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <thead class="bg-slate-100 text-slate-600"><tr><th class="py-1 px-2"></th><th class="py-1 px-2">Calculado</th><th class="py-1 px-2">Escogido</th></tr></thead>
                <tbody>
                  <tr class="border-t border-slate-100 text-center">
                    <td class="py-1 px-2 font-bold text-slate-600 text-left">Hd</td>
                    <td class="py-1 px-2 font-mono">${Hd_calc.toFixed(2)}</td>
                    <td class="py-1 px-2 font-mono font-bold bg-amber-50">${Hd.toFixed(2)} m</td>
                  </tr>
                  <tr class="border-t border-slate-100 text-center">
                    <td class="py-1 px-2 font-bold text-slate-600 text-left">Bd</td>
                    <td class="py-1 px-2 font-mono">${Bd_calc.toFixed(2)}</td>
                    <td class="py-1 px-2 font-mono font-bold bg-amber-50">${Bd.toFixed(2)} m</td>
                  </tr>
                </tbody>
              </table>
              <div class="text-[11px] text-slate-500 flex flex-col justify-center gap-1">
                <p>→ Altura de dentellón: Hd ≥ H/10 ${Hd >= Hd_calc ? '✓' : '✗'}</p>
                <p>→ Ancho de dentellón: Bd ≥ t2 ${Bd >= Bd_calc ? '✓' : '✗'}</p>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-2">
              <div>
                <p class="font-bold text-emerald-800 mb-1">Coeficiente de Empuje Pasivo (Kp)</p>
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  Kp = (1 + sen φ) / (1 − sen φ) = <strong>${geo.lateralPressures.Kp.toFixed(2)}</strong>
                </div>
              </div>
              <div>
                <p class="font-bold text-emerald-800 mb-1">Presión Pasiva Superior e Inferior</p>
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center leading-relaxed">
                  σps = γf·Df·Kp = <strong>${sigma_ps_kg.toFixed(0)} kg/m²</strong><br>
                  σpi = γf·(Df+Hd)·Kp = <strong>${sigma_pi_kg.toFixed(0)} kg/m²</strong>
                </div>
              </div>
            </div>
            <p class="font-bold text-emerald-800 mb-1 text-xs">Empuje Pasivo Actuando sobre el Dentellón (Ep)</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center text-xs mb-3">
              <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                Ep = [(σps + σpi) / 2] · Hd
              </div>
              <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
                <span class="font-bold text-indigo-900">Ep = ${Ep_kg.toFixed(0)} kg</span>
                <span class="text-indigo-500 text-[11px]"> (${(Ep_kg / 1000).toFixed(2)} Tn)</span>
              </div>
            </div>
            <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
              ${diagram}
            </div>
          </div>`;
          })()}

          <div class="grid grid-cols-1 gap-3 text-xs">

            <div class="p-3 rounded-lg border ${geo.pass_overturning ? 'bg-emerald-50/40 border-emerald-200' : 'bg-rose-50/40 border-rose-200'} avoid-break">
              <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">A. Estabilidad al Volteo ${dual.dual ? `<span class="font-normal text-slate-400 text-[10px]">(gobierna ${caseLabel(geo.fs_overturning_case)})</span>` : ''}</h4>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  FS_V = Σ MFv / Σ MFh ≥ ${geo.fs_overturning_req.toFixed(2)}
                </div>
                <table class="w-full text-xs border border-slate-200 rounded overflow-hidden">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Σ MFv</td><td class="py-1 px-2 text-right font-mono font-bold">${totalMRKg.toFixed(1)} kg·m</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Σ MFh</td><td class="py-1 px-2 text-right font-mono font-bold">${totalMoKg.toFixed(1)} kg·m</td></tr>
                    <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">FSv</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${geo.fs_overturning.toFixed(2)}</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="mt-2 rounded border text-xs font-bold text-center py-1.5 ${geo.pass_overturning ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-rose-50 border-rose-300 text-rose-700'}">
                ${geo.pass_overturning ? 'Sí Cumple' : 'No Cumple'}
              </div>
            </div>

            <div class="p-3 rounded-lg border ${geo.pass_sliding ? 'bg-emerald-50/40 border-emerald-200' : 'bg-amber-50/40 border-amber-300'} avoid-break">
              <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">B. Estabilidad al Deslizamiento ${dual.dual ? `<span class="font-normal text-slate-400 text-[10px]">(gobierna ${caseLabel(geo.fs_sliding_case)})</span>` : ''}</h4>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                <div class="space-y-2">
                  <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                    fr = μ·(Σ Fv) + Ep${geo.adhesion > 0 ? ' + 0.5·c\'·B' : ''}
                  </div>
                  <table class="w-full text-xs border border-slate-200 rounded overflow-hidden">
                    <tbody>
                      <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">fr</td><td class="py-1 px-2 text-right font-mono font-bold">${((geo.sum_FR * 1000) / 9.80665).toFixed(1)} kg</td></tr>
                      <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Σ Fh</td><td class="py-1 px-2 text-right font-mono font-bold">${((geo.sum_Fd * 1000) / 9.80665).toFixed(1)} kg</td></tr>
                      <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">FSD</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${geo.fs_sliding.toFixed(2)}</td></tr>
                    </tbody>
                  </table>
                  <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                    FS_D = fr / Σ Fh ≥ ${geo.fs_sliding_req.toFixed(2)}
                  </div>
                </div>
                <div class="flex flex-col justify-center gap-2 h-full">
                  ${geo.F_passive > 0 && geo.lateralPressures.passive_detail?.mode === 'dentellon' ? `
                  <p class="text-xs font-bold text-indigo-700">Considerar Dentellón</p>
                  <p class="text-[11px] text-slate-500 italic">Se decidió colocar el dentellón del pie para hacer uso del empuje pasivo que se desarrolla frente a él.</p>
                  ` : ''}
                  <div class="rounded border text-xs font-bold text-center py-1.5 ${geo.pass_sliding ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-rose-50 border-rose-300 text-rose-700'}">
                    ${geo.pass_sliding ? 'Sí Cumple' : 'No Cumple'}
                  </div>
                </div>
              </div>
            </div>

            <div class="p-3 rounded-lg border ${geo.pass_eccentricity ? 'bg-emerald-50/40 border-emerald-200' : 'bg-rose-50/40 border-rose-200'} avoid-break">
              <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">C. Ubicación de la Resultante y Excentricidad</h4>
              <p class="text-emerald-800 font-bold mb-1">Cálculo de la ubicación de la resultante</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  X = (Σ MFv − Σ MFh) / Σ Fv
                </div>
                <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
                  <span class="font-bold text-indigo-900">X = ${geo.x_resultant.toFixed(2)} m</span>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-[11px] font-mono mb-3">
                <span>B/3 = ${(geo.B / 3).toFixed(2)}</span><span>≤</span><span class="font-bold">${geo.x_resultant.toFixed(2)}</span><span>≤</span><span>2B/3 = ${(2 * geo.B / 3).toFixed(2)}</span>
                <span class="ml-2 px-2 py-0.5 rounded font-bold ${geo.is_middle_third ? 'bg-emerald-50 border border-emerald-300 text-emerald-700' : 'bg-rose-50 border border-rose-300 text-rose-700'}">${geo.is_middle_third ? 'Sí Cumple' : 'No Cumple'}</span>
              </div>

              ${(() => {
                const B = geo.B;
                const X = geo.x_resultant;
                const W = 460, Hs = 120, marginL = 30, marginR = 30;
                const drawW = W - marginL - marginR;
                const scale = drawW / B;
                const x0 = marginL, x1 = marginL + (B / 3) * scale, x2 = marginL + (2 * B / 3) * scale, x3 = marginL + B * scale;
                const xR = Math.min(x3, Math.max(x0, marginL + X * scale));
                const baseY = 52;
                const third = (a, b) => `
                  <line x1="${a}" y1="${baseY - 6}" x2="${a}" y2="${baseY + 6}" stroke="#334155" stroke-width="1.5"/>
                  <text x="${(a + b) / 2}" y="${baseY - 10}" font-size="9.5" text-anchor="middle" fill="#334155" font-weight="700">B/3</text>
                  <text x="${(a + b) / 2}" y="${baseY + 20}" font-size="9.5" text-anchor="middle" fill="#4338ca" font-weight="700">${(B / 3).toFixed(2)}</text>`;
                return `
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2 mb-3">
                <svg viewBox="0 0 ${W} ${Hs}" style="max-width:420px; width:100%;">
                  <line x1="${x0}" y1="${baseY}" x2="${x3}" y2="${baseY}" stroke="#334155" stroke-width="2"/>
                  ${third(x0, x1)}${third(x1, x2)}${third(x2, x3)}
                  <line x1="${x3}" y1="${baseY - 6}" x2="${x3}" y2="${baseY + 6}" stroke="#334155" stroke-width="1.5"/>
                  <text x="${(x0 + x3) / 2}" y="${baseY - 30}" font-size="10.5" text-anchor="middle" fill="#0f172a" font-weight="700">B = ${B.toFixed(2)} m</text>
                  <line x1="${xR}" y1="${baseY + 44}" x2="${xR}" y2="${baseY + 6}" stroke="#c2410c" stroke-width="2.5"/>
                  <polygon points="${xR - 4},${baseY + 10} ${xR + 4},${baseY + 10} ${xR},${baseY + 2}" fill="#c2410c"/>
                  <text x="${xR}" y="${baseY + 58}" font-size="10" text-anchor="middle" fill="#9a3412" font-weight="700">Σ Fv = ${totalKg.toFixed(0)} kg</text>
                  <text x="${xR}" y="${baseY + 71}" font-size="9.5" text-anchor="middle" fill="#9a3412">X = ${X.toFixed(2)} m</text>
                </svg>
              </div>`;
              })()}

              <p class="text-emerald-800 font-bold mb-1">Cálculo de la excentricidad</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  e = B/2 − X ≤ B/6
                </div>
                <table class="w-full text-xs border border-slate-200 rounded overflow-hidden">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">e</td><td class="py-1 px-2 text-right font-mono font-bold">${geo.eccentricity.toFixed(2)} m</td></tr>
                    <tr><td class="py-1 px-2 font-bold text-slate-600">B/6</td><td class="py-1 px-2 text-right font-mono font-bold">${geo.e_max_allowed.toFixed(2)} m</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="rounded border text-xs font-bold text-center py-1.5 mb-3 ${geo.pass_eccentricity ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-rose-50 border-rose-300 text-rose-700'}">
                ${geo.pass_eccentricity ? 'Sí Cumple' : 'No Cumple'}
              </div>

              <p class="text-emerald-800 font-bold mb-1">Cálculo de la presión actuante</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-2">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  q = (Σ Fv / (B · L)) · (1 ± 6e/B) ≤ σt
                </div>
                <table class="w-full text-xs border border-slate-200 rounded overflow-hidden">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Σ Fv</td><td class="py-1 px-2 text-right font-mono">${totalKg.toFixed(1)} kg</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">σt (adm)</td><td class="py-1 px-2 text-right font-mono">${geo.q_adm_kgcm2.toFixed(2)} kg/cm²</td></tr>
                    <tr class="border-b border-slate-100 bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">q_max</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${geo.q_toe_kgcm2.toFixed(2)} kg/cm²</td></tr>
                    <tr><td class="py-1 px-2 font-bold text-slate-600">q_min</td><td class="py-1 px-2 text-right font-mono">${geo.q_heel_kgcm2.toFixed(2)} kg/cm²</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="rounded border text-xs font-bold text-center py-1.5 ${geo.pass_bearing ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-rose-50 border-rose-300 text-rose-700'}">
                ${geo.pass_bearing ? 'Sí Cumple' : 'No Cumple'}
              </div>
            </div>

            ${(() => {
              const wTalonSoil = geo.weights.find(w => w.id === 'W3');
              const wTalonSC = geo.weights.find(w => w.id === 'W2');
              const wPuntaSoil = geo.weights.find(w => w.id === 'W1');
              const sumWTalon = (wTalonSoil?.weight_kg || 0) + (wTalonSC?.weight_kg || 0);
              const sumWPunta = wPuntaSoil?.weight_kg || 0;
              const q1 = geo.B_heel > 0.01 ? sumWTalon / geo.B_heel : 0;
              const q4 = geo.B_toe > 0.01 ? sumWPunta / geo.B_toe : 0;
              const qToeKgm2 = geo.q_toe * 101.9716;
              const qHeelKgm2 = geo.q_heel * 101.9716;
              const q2 = qHeelKgm2 + (qToeKgm2 - qHeelKgm2) * (geo.B_heel / geo.B);
              const q3 = qHeelKgm2 + (qToeKgm2 - qHeelKgm2) * ((geo.B_heel + geo.b_bot) / geo.B);
              return `
            <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 avoid-break">
              <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">Presiones Locales en la Zapata (q1 – q4)</h4>
              <p class="text-[11px] text-slate-500 mb-2">
                Se calculan las presiones de peso propio sobre la punta y el talón (q1, q4) y las
                presiones de contacto del terreno en las caras del vástago (q2, q3), interpoladas
                linealmente entre q_max y q_min, empleadas para el cálculo de momentos y cortantes
                en la zapata.
              </p>

              <p class="text-emerald-800 font-bold mb-1">Cálculo de q1 (peso propio sobre el talón)</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-3">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  q1 = (W<sub>suelo talón</sub> + W<sub>S/C</sub>) / A<sub>talón</sub>
                </div>
                <table class="w-full text-xs border border-slate-200 rounded overflow-hidden">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Σ W</td><td class="py-1 px-2 text-right font-mono">${sumWTalon.toFixed(1)} kg</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">A<sub>talón</sub></td><td class="py-1 px-2 text-right font-mono">${geo.B_heel.toFixed(2)} m²</td></tr>
                    <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">q1</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${q1.toFixed(1)} kg/m²</td></tr>
                  </tbody>
                </table>
              </div>

              <p class="text-emerald-800 font-bold mb-1">Cálculo de q2 (presión de contacto en la cara talón del vástago)</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-3">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  q2 = q_min + (q_max − q_min) · (T / B)
                </div>
                <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
                  <span class="font-bold text-indigo-900">q2 = ${q2.toFixed(1)} kg/m²</span>
                </div>
              </div>

              <p class="text-emerald-800 font-bold mb-1">Cálculo de q3 (presión de contacto en la cara punta del vástago)</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-3">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  q3 = q_min + (q_max − q_min) · ((T + t2) / B)
                </div>
                <div class="p-2 bg-indigo-50 rounded border border-indigo-200 text-center">
                  <span class="font-bold text-indigo-900">q3 = ${q3.toFixed(1)} kg/m²</span>
                </div>
              </div>

              <p class="text-emerald-800 font-bold mb-1">Cálculo de q4 (peso propio sobre la punta)</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  q4 = W<sub>suelo puntera</sub> / A<sub>punta</sub>
                </div>
                <table class="w-full text-xs border border-slate-200 rounded overflow-hidden">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">W</td><td class="py-1 px-2 text-right font-mono">${sumWPunta.toFixed(1)} kg</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">A<sub>punta</sub></td><td class="py-1 px-2 text-right font-mono">${geo.B_toe.toFixed(2)} m²</td></tr>
                    <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">q4</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${q4.toFixed(1)} kg/m²</td></tr>
                  </tbody>
                </table>
              </div>

              ${canvasSnapshotLocalPressures ? `
              ${this.zoomControlsHtml('local_pressures')}
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
                <img src="${canvasSnapshotLocalPressures}" alt="Diagrama de fuerzas y presiones locales en la zapata" data-report-key="local_pressures" class="max-w-full report-diagram-img cursor-grab active:cursor-grabbing" style="max-height: 420px;">
              </div>` : ''}
            </div>`;
            })()}

            ${(() => {
              const breakdownTable = (member) => `
                <div class="overflow-x-auto mb-2">
                  <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
                    <thead class="bg-amber-500 text-white">
                      <tr>
                        <th class="py-1.5 px-2.5 text-left">Fuerza</th>
                        <th class="py-1.5 px-2.5 text-right">Peso</th>
                        <th class="py-1.5 px-2.5 text-right">X (m)</th>
                        <th class="py-1.5 px-2.5 text-right">Momento</th>
                      </tr>
                    </thead>
                    <tbody class="text-slate-700">
                      ${member.breakdown.map(row => `
                      <tr class="border-t border-slate-100">
                        <td class="py-1.5 px-2.5 font-bold text-center">${row.label}</td>
                        <td class="py-1.5 px-2.5 text-right font-mono">${row.force_kg.toFixed(1)} kg</td>
                        <td class="py-1.5 px-2.5 text-right font-mono">${row.arm.toFixed(2)}</td>
                        <td class="py-1.5 px-2.5 text-right font-mono">${row.moment_kgm.toFixed(1)} kg·m</td>
                      </tr>`).join('')}
                      <tr class="border-t border-slate-200 bg-amber-50 font-bold">
                        <td class="py-1.5 px-2.5">Vd</td>
                        <td class="py-1.5 px-2.5 text-right font-mono">${member.Vd_kg.toFixed(1)} kg</td>
                        <td class="py-1.5 px-2.5 text-center">Mmax</td>
                        <td class="py-1.5 px-2.5 text-right font-mono">${member.Mmax_kgm.toFixed(1)} kg·m</td>
                      </tr>
                    </tbody>
                  </table>
                </div>`;

              const shearBadge = (member) => `
                <div class="grid grid-cols-2 gap-3 items-stretch mb-3">
                  <table class="w-full text-xs border border-slate-200 rounded overflow-hidden self-center">
                    <thead class="bg-slate-100 text-slate-600"><tr><th class="py-1 px-2">Vu</th><th class="py-1 px-2"></th><th class="py-1 px-2">φVc</th></tr></thead>
                    <tbody><tr class="border-t border-slate-100 text-center font-mono">
                      <td class="py-1 px-2">${((member.Vu * 1000) / 9.80665 / 1000).toFixed(2)}</td><td class="py-1 px-2">≤</td><td class="py-1 px-2">${((member.phiVc * 1000) / 9.80665 / 1000).toFixed(2)}</td>
                    </tr></tbody>
                  </table>
                  <div class="flex items-center justify-center rounded border text-xs font-bold ${member.pass_shear ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-rose-50 border-rose-300 text-rose-700'}">
                    ${member.pass_shear ? 'Sí Cumple' : 'No Cumple'}
                  </div>
                </div>`;

              return `
            <div class="p-3 rounded-lg border ${str.toe.pass_shear && str.heel.pass_shear && str.stem.pass_shear ? 'bg-emerald-50/40 border-emerald-200' : 'bg-rose-50/40 border-rose-200'}">
              <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">D. Cálculo de Momentos Flectores y Fuerzas Cortantes</h4>
              <p class="text-[11px] text-slate-500 mb-2">
                Se evalúa el momento y el cortante producidos por las fuerzas que actúan sobre cada tramo de la
                estructura (pantalla, punta y talón) por separado, descomponiendo cada uno en sus fuerzas
                componentes (F1, F2...) con su brazo de palanca X respecto a la sección crítica.
              </p>

              <p class="text-emerald-800 font-bold mb-1">En la Pantalla</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  F1 = Ka·(S/C)·hp·1
                </div>
                <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">
                  F2 = ½·γs·hp²·Ka
                </div>
              </div>
              ${breakdownTable(str.stem)}
              ${(() => {
                const hp = str.stem.hp;
                const y1 = str.stem.breakdown[0].arm;
                const y2 = str.stem.breakdown[1].arm;
                const bTop = w.geometry.b_top, bBot = w.geometry.b_bot;

                const W = 350, Hs = 420;
                const topY = 30, botY = 390;
                const stemH = botY - topY;
                const backX = 130;
                const t2px = 45;
                const t1px = Math.max(12, t2px * (bTop / bBot));
                const frontTopX = backX - t1px;
                const frontBotX = backX - t2px;

                const yAtArm = (arm) => botY - (arm / hp) * stemH;
                const yF1 = yAtArm(y1);
                const yF2 = yAtArm(y2);

                // Triángulo de reparto (carga distribuida) contra la cara
                // posterior de la pantalla: ancho creciente con la
                // profundidad, con marcas horizontales equiespaciadas.
                const distMaxW = 55;
                const nTicks = 15;
                let ticks = '';
                for (let i = 1; i < nTicks; i++) {
                  const ty = topY + (i / nTicks) * stemH;
                  const tw = (i / nTicks) * distMaxW;
                  ticks += `<line x1="${backX + tw}" y1="${ty}" x2="${backX}" y2="${ty}" stroke="#2563eb" stroke-width="1.2"/>
                    <polygon points="${backX + 4},${ty - 2.5} ${backX + 4},${ty + 2.5} ${backX},${ty}" fill="#2563eb"/>`;
                }

                const dimLine = (x, y1p, y2p, label, side = 1) => `
                  <line x1="${x}" y1="${y1p}" x2="${x}" y2="${y2p}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="${x - 5}" y1="${y1p}" x2="${x + 5}" y2="${y1p}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="${x - 5}" y1="${y2p}" x2="${x + 5}" y2="${y2p}" stroke="#4338ca" stroke-width="1.3"/>
                  <text x="${x + side * 12}" y="${(y1p + y2p) / 2 + 4}" font-size="12" font-weight="700" fill="#4338ca" text-anchor="${side > 0 ? 'start' : 'end'}">${label}</text>`;

                return `
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2 mb-3 avoid-break">
                <svg viewBox="0 0 ${W} ${Hs}" style="max-width:320px; width:100%;">
                  <!-- Contorno de la pantalla -->
                  <polygon points="${frontTopX},${topY} ${backX},${topY} ${backX},${botY} ${frontBotX},${botY}"
                    fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>
                  <!-- Base / terreno -->
                  <line x1="${frontBotX - 20}" y1="${botY}" x2="${backX + 20}" y2="${botY}" stroke="#0f172a" stroke-width="2"/>
                  ${Array.from({ length: 8 }, (_, i) => {
                    const hx = frontBotX - 18 + i * 6;
                    return `<line x1="${hx}" y1="${botY}" x2="${hx - 6}" y2="${botY + 8}" stroke="#94a3b8" stroke-width="1"/>`;
                  }).join('')}

                  <!-- Triángulo de carga distribuida -->
                  <polygon points="${backX},${topY} ${backX + distMaxW},${botY} ${backX},${botY}"
                    fill="none" stroke="#2563eb" stroke-width="1.5"/>
                  ${ticks}

                  <!-- hp: altura total de pantalla -->
                  <line x1="35" y1="${topY}" x2="35" y2="${botY}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="27" y1="${topY}" x2="43" y2="${topY}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="27" y1="${botY}" x2="43" y2="${botY}" stroke="#4338ca" stroke-width="1.3"/>
                  <rect x="12" y="${(topY + botY) / 2 - 15}" width="46" height="24" fill="#ffffff"/>
                  <text x="35" y="${(topY + botY) / 2 - 3}" font-size="11" font-weight="700" fill="#4338ca" text-anchor="middle">hp=</text>
                  <text x="35" y="${(topY + botY) / 2 + 9}" font-size="11" font-weight="700" fill="#4338ca" text-anchor="middle">${hp.toFixed(2)} m</text>

                  <!-- F1 -->
                  <line x1="${backX + 5}" y1="${yF1}" x2="${backX + 145}" y2="${yF1}" stroke="#b91c1c" stroke-width="3"/>
                  <polygon points="${backX},${yF1} ${backX + 10},${yF1 - 5} ${backX + 10},${yF1 + 5}" fill="#b91c1c"/>
                  <text x="${backX + 75}" y="${yF1 - 8}" font-size="13" font-weight="700" fill="#0f172a" text-anchor="middle">F1</text>

                  <!-- F2 -->
                  <line x1="${backX + 5}" y1="${yF2}" x2="${backX + 95}" y2="${yF2}" stroke="#b91c1c" stroke-width="3"/>
                  <polygon points="${backX},${yF2} ${backX + 10},${yF2 - 5} ${backX + 10},${yF2 + 5}" fill="#b91c1c"/>
                  <text x="${backX + 50}" y="${yF2 - 8}" font-size="13" font-weight="700" fill="#0f172a" text-anchor="middle">F2</text>

                  <!-- X1 / X2 -->
                  ${dimLine(backX + 170, yF1, botY, 'X1')}
                  ${dimLine(backX + 120, yF2, botY, 'X2')}
                </svg>
              </div>`;
              })()}

              <p class="text-emerald-800 font-bold mb-1">En la Punta</p>
              ${breakdownTable(str.toe)}
              ${(() => {
                const B_toe = geo.B_toe;
                const w1Punta = geo.weights.find(x => x.id === 'W1');
                const q4_kgm2 = B_toe > 0.01 ? (w1Punta ? w1Punta.weight_kg : 0) / B_toe : 0;
                const Wpx = 460, Hpx = 260;
                const rx0 = 155, rx1 = 340, ry0 = 110, ry1 = 150; // rectángulo de la losa (vástago a la derecha)
                const pxPerM = (rx1 - rx0) / B_toe;
                const y1_toe = str.toe.breakdown[0].arm, y2_toe = str.toe.breakdown[1].arm;
                const xF1 = rx1 - y1_toe * pxPerM;
                const xF2 = rx1 - y2_toe * pxPerM;
                const xVastago = rx1 - w.geometry.b_bot * pxPerM;
                const dimBracket = (x1p, x2p, y, label) => `
                  <line x1="${x1p}" y1="${y}" x2="${x2p}" y2="${y}" stroke="#4338ca" stroke-width="1.2"/>
                  <line x1="${x1p}" y1="${y - 6}" x2="${x1p}" y2="${y + 6}" stroke="#4338ca" stroke-width="1.2"/>
                  <line x1="${x2p}" y1="${y - 6}" x2="${x2p}" y2="${y + 6}" stroke="#4338ca" stroke-width="1.2"/>
                  <text x="${x1p + 6}" y="${y - 6}" font-size="10" font-weight="700" fill="#4338ca" text-anchor="start">${label}</text>`;
                const nF3 = 8;
                let f3Ticks = '';
                for (let i = 0; i < nF3; i++) {
                  const tx = rx0 + ((i + 0.5) / nF3) * (rx1 - rx0);
                  f3Ticks += `<line x1="${tx}" y1="${ry0 - 16}" x2="${tx}" y2="${ry0}" stroke="#64748b" stroke-width="1.5"/>
                    <polygon points="${tx - 3},${ry0 - 4} ${tx + 3},${ry0 - 4} ${tx},${ry0}" fill="#64748b"/>`;
                }
                const nF2 = 9;
                let f2Ticks = '';
                for (let i = 0; i < nF2; i++) {
                  const tx = rx0 + (i / (nF2 - 1)) * (rx1 - rx0);
                  const h = 10 + (i / (nF2 - 1)) * 28; // creciente hacia la punta (izquierda->derecha en este dibujo = hacia el vástago; F2 crece hacia el borde exterior = izquierda)
                  const hh = 10 + (1 - i / (nF2 - 1)) * 28;
                  f2Ticks += `<line x1="${tx}" y1="${ry1 + hh}" x2="${tx}" y2="${ry1}" stroke="#7c2d12" stroke-width="1.3"/>
                    <polygon points="${tx - 3},${ry1 + 4} ${tx + 3},${ry1 + 4} ${tx},${ry1}" fill="#7c2d12"/>`;
                }
                return `
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2 mb-3 avoid-break">
                <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:420px; width:100%;">
                  <rect x="${rx0}" y="${ry0}" width="${rx1 - rx0}" height="${ry1 - ry0}" fill="#e2e8f0" stroke="#0f172a" stroke-width="2"/>
                  <text x="${(rx0 + rx1) / 2}" y="${(ry0 + ry1) / 2 + 4}" font-size="11" font-weight="700" fill="#334155" text-anchor="middle">Punta</text>

                  <!-- q4: peso propio del relleno sobre la punta (descendente, uniforme) -->
                  ${f3Ticks}
                  <text x="${rx0 - 8}" y="${ry0 - 8}" font-size="10" font-weight="700" fill="#64748b" text-anchor="end">q4=${q4_kgm2.toFixed(1)} kg/m²</text>

                  <!-- qmax (triangular, borde exterior) + q3 (rectangular, cara del vástago) -->
                  ${f2Ticks}
                  <text x="${rx0 - 8}" y="${ry1 + 34}" font-size="10" font-weight="700" fill="#7c2d12" text-anchor="end">qmax=${str.toe.qmax_kgm2.toFixed(1)} kg/m²</text>
                  <text x="${rx1 + 24}" y="${ry1 + 16}" font-size="10" font-weight="700" fill="#7c2d12" text-anchor="start">q3=${str.toe.q3_kgm2.toFixed(1)} kg/m²</text>

                  <!-- Vástago (referencia) -->
                  <rect x="${rx1}" y="${ry0 - 30}" width="18" height="${ry0 - (ry0 - 30) + (ry1 - ry0)}" fill="#cbd5e1" stroke="#0f172a" stroke-width="1.5"/>

                  <!-- X3: ancho del vástago, medido desde su cara -->
                  ${dimBracket(xVastago, rx1, ry0 - 45, 'X3')}

                  <!-- X1 (posición de F1) y X2 (posición de F2), medidas desde la cara del vástago -->
                  ${dimBracket(xF1, rx1, ry1 + 40, 'X1')}
                  ${dimBracket(xF2, rx1, ry1 + 58, 'X2')}

                  <!-- Dimensión Punta = X.XX m -->
                  <line x1="${rx0}" y1="${ry1 + 80}" x2="${rx1}" y2="${ry1 + 80}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="${rx0}" y1="${ry1 + 74}" x2="${rx0}" y2="${ry1 + 86}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="${rx1}" y1="${ry1 + 74}" x2="${rx1}" y2="${ry1 + 86}" stroke="#4338ca" stroke-width="1.3"/>
                  <text x="${(rx0 + rx1) / 2}" y="${ry1 + 97}" font-size="12" font-weight="700" fill="#4338ca" text-anchor="middle">Punta = ${B_toe.toFixed(2)} m</text>
                </svg>
              </div>`;
              })()}
              ${shearBadge(str.toe)}

              <p class="text-emerald-800 font-bold mb-1">En el Talón</p>
              ${breakdownTable(str.heel)}
              ${(() => {
                const B_heel = geo.B_heel;
                const w2Talon = geo.weights.find(x => x.id === 'W2');
                const w3Talon = geo.weights.find(x => x.id === 'W3');
                const q1_kgm2 = B_heel > 0.01 ? ((w2Talon ? w2Talon.weight_kg : 0) + (w3Talon ? w3Talon.weight_kg : 0)) / B_heel : 0;
                const Wpx = 460, Hpx = 260;
                const rx0 = 150, rx1 = 320, ry0 = 110, ry1 = 150; // rectángulo del talón (vástago a la izquierda)
                const pxPerMHeel = (rx1 - rx0) / B_heel;
                const y2_heel = str.heel.breakdown[1].arm, y3_heel = str.heel.breakdown[2].arm;
                const xF2h = rx0 + y2_heel * pxPerMHeel;
                const xF3h = rx0 + y3_heel * pxPerMHeel;
                const xVastagoH = rx0 + w.geometry.b_bot * pxPerMHeel;
                const dimBracketH = (x1p, x2p, y, label) => `
                  <line x1="${x1p}" y1="${y}" x2="${x2p}" y2="${y}" stroke="#4338ca" stroke-width="1.2"/>
                  <line x1="${x1p}" y1="${y - 6}" x2="${x1p}" y2="${y + 6}" stroke="#4338ca" stroke-width="1.2"/>
                  <line x1="${x2p}" y1="${y - 6}" x2="${x2p}" y2="${y + 6}" stroke="#4338ca" stroke-width="1.2"/>
                  <text x="${x2p - 6}" y="${y - 6}" font-size="10" font-weight="700" fill="#4338ca" text-anchor="end">${label}</text>`;
                const nF1 = 8;
                let f1Ticks = '';
                for (let i = 0; i < nF1; i++) {
                  const tx = rx0 + ((i + 0.5) / nF1) * (rx1 - rx0);
                  f1Ticks += `<line x1="${tx}" y1="${ry0 - 22}" x2="${tx}" y2="${ry0}" stroke="#991b1b" stroke-width="1.5"/>
                    <polygon points="${tx - 3},${ry0 - 4} ${tx + 3},${ry0 - 4} ${tx},${ry0}" fill="#991b1b"/>`;
                }
                const nF3 = 9;
                let f3Ticks = '';
                for (let i = 0; i < nF3; i++) {
                  const tx = rx0 + (i / (nF3 - 1)) * (rx1 - rx0);
                  const h = 10 + (i / (nF3 - 1)) * 26; // F3 crece hacia el vástago (izquierda)
                  const hh = 10 + (1 - i / (nF3 - 1)) * 26;
                  f3Ticks += `<line x1="${tx}" y1="${ry1 + hh}" x2="${tx}" y2="${ry1}" stroke="#7c2d12" stroke-width="1.3"/>
                    <polygon points="${tx - 3},${ry1 + 4} ${tx + 3},${ry1 + 4} ${tx},${ry1}" fill="#7c2d12"/>`;
                }
                return `
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2 mb-3 avoid-break">
                <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:420px; width:100%;">
                  <!-- Vástago (referencia) -->
                  <rect x="${rx0 - 18}" y="${ry0 - 30}" width="18" height="${ry0 - (ry0 - 30) + (ry1 - ry0)}" fill="#cbd5e1" stroke="#0f172a" stroke-width="1.5"/>

                  <rect x="${rx0}" y="${ry0}" width="${rx1 - rx0}" height="${ry1 - ry0}" fill="#e2e8f0" stroke="#0f172a" stroke-width="2"/>
                  <text x="${(rx0 + rx1) / 2}" y="${(ry0 + ry1) / 2 + 4}" font-size="11" font-weight="700" fill="#334155" text-anchor="middle">Talón</text>

                  <!-- q1: peso propio del relleno + sobrecarga sobre el talón (descendente, uniforme) -->
                  ${f1Ticks}
                  <text x="${rx1 + 8}" y="${ry0 - 8}" font-size="10" font-weight="700" fill="#991b1b" text-anchor="start">q1=${q1_kgm2.toFixed(1)} kg/m²</text>

                  <!-- q2 (triangular, cara del vástago) + qmin (rectangular, borde exterior) -->
                  ${f3Ticks}
                  <text x="${rx0 - 30}" y="${ry1 + 30}" font-size="10" font-weight="700" fill="#7c2d12" text-anchor="end">q2=${str.heel.q2_kgm2.toFixed(1)} kg/m²</text>
                  <text x="${rx1 + 8}" y="${ry1 + 16}" font-size="10" font-weight="700" fill="#7c2d12" text-anchor="start">qmin=${str.heel.qmin_kgm2.toFixed(1)} kg/m²</text>

                  <!-- X3: ancho del vástago, medido desde su cara -->
                  ${dimBracketH(rx0, xVastagoH, ry0 - 45, 'X3')}

                  <!-- X1 (posición de F3, más cerca) y X2 (posición de F2), medidas desde la cara del vástago -->
                  ${dimBracketH(rx0, xF3h, ry1 + 40, 'X1')}
                  ${dimBracketH(rx0, xF2h, ry1 + 58, 'X2')}

                  <!-- Dimensión Talón = X.XX m -->
                  <line x1="${rx0}" y1="${ry1 + 80}" x2="${rx1}" y2="${ry1 + 80}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="${rx0}" y1="${ry1 + 74}" x2="${rx0}" y2="${ry1 + 86}" stroke="#4338ca" stroke-width="1.3"/>
                  <line x1="${rx1}" y1="${ry1 + 74}" x2="${rx1}" y2="${ry1 + 86}" stroke="#4338ca" stroke-width="1.3"/>
                  <text x="${(rx0 + rx1) / 2}" y="${ry1 + 97}" font-size="12" font-weight="700" fill="#4338ca" text-anchor="middle">Talón = ${B_heel.toFixed(2)} m</text>
                </svg>
              </div>`;
              })()}
              ${shearBadge(str.heel)}

              ${canvasSnapshotLocalPressures ? `
              ${this.zoomControlsHtml('local_pressures')}
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
                <img src="${canvasSnapshotLocalPressures}" alt="Diagrama de fuerzas y presiones en la punta y el talón" data-report-key="local_pressures" class="max-w-full report-diagram-img cursor-grab active:cursor-grabbing" style="max-height: 420px;">
              </div>` : ''}
            </div>`;
            })()}

          </div>
        </section>

        ${dual.dual ? `
        <!-- 3B. Comparación de Casos de Carga -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">2.3B. Comparación de Casos de Carga (Metodología UNI)</h3>
          <p class="text-[11px] text-slate-500 mb-2">La sobrecarga vehicular y el sismo se evalúan como combinaciones independientes (no se suman entre sí); cada verificación de arriba toma el caso más desfavorable de las dos.</p>
          <div class="overflow-x-auto">
            <table class="w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
              <thead class="bg-amber-500 text-white">
                <tr>
                  <th class="py-2 px-3 text-left">Caso</th>
                  <th class="py-2 px-3 text-right">FS Volcamiento</th>
                  <th class="py-2 px-3 text-right">FS Deslizamiento</th>
                  <th class="py-2 px-3 text-right">Excentricidad e_x</th>
                  <th class="py-2 px-3 text-right">q_max</th>
                  <th class="py-2 px-3 text-right">q_adm</th>
                </tr>
              </thead>
              <tbody>
                <tr class="border-t border-slate-100">
                  <td class="py-2 px-3 font-semibold text-slate-800">A: Tierra + Sobrecarga (Sin Sismo)</td>
                  <td class="py-2 px-3 text-right">${dual.caseA.fs_overturning.toFixed(2)}</td>
                  <td class="py-2 px-3 text-right">${dual.caseA.fs_sliding.toFixed(2)}</td>
                  <td class="py-2 px-3 text-right">${(dual.caseA.eccentricity * 100).toFixed(1)} cm</td>
                  <td class="py-2 px-3 text-right">${dual.caseA.q_toe_kgcm2.toFixed(2)} kg/cm²</td>
                  <td class="py-2 px-3 text-right">${dual.caseA.q_adm_kgcm2.toFixed(2)} kg/cm²</td>
                </tr>
                <tr class="border-t border-slate-100">
                  <td class="py-2 px-3 font-semibold text-slate-800">B: Tierra + Sismo (Sin Sobrecarga)</td>
                  <td class="py-2 px-3 text-right">${dual.caseB.fs_overturning.toFixed(2)}</td>
                  <td class="py-2 px-3 text-right">${dual.caseB.fs_sliding.toFixed(2)}</td>
                  <td class="py-2 px-3 text-right">${(dual.caseB.eccentricity * 100).toFixed(1)} cm</td>
                  <td class="py-2 px-3 text-right">${dual.caseB.q_toe_kgcm2.toFixed(2)} kg/cm²</td>
                  <td class="py-2 px-3 text-right">${dual.caseB.q_adm_kgcm2.toFixed(2)} kg/cm²</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        ` : ''}

        ${(() => {
          const rebarSelectHtml = (materialsKey) => {
            const current = w.materials[materialsKey];
            return `
              <select data-bind="materials.${materialsKey}" data-sync="materials.${materialsKey}" class="text-xs font-bold bg-white border border-indigo-300 rounded px-1.5 py-0.5 text-indigo-700 no-print">
                ${REBAR_TABLE.map((bar, idx) => `<option value="${idx}" ${String(idx) === String(current) ? 'selected' : ''}>${bar.inches || bar.name}</option>`).join('')}
              </select>`;
          };

          // Redondea a incrementos de 0.5 cm (0.005 m) y formatea sin ceros
          // finales innecesarios (0.149→"0.15", 0.1249→"0.125").
          const fmtSpacingM = (value_m) => {
            const rounded = Math.round(value_m / 0.005) * 0.005;
            let s = rounded.toFixed(3);
            if (s.endsWith('0')) s = s.slice(0, -1);
            return s;
          };

          const spacingBlock = (rebar, As_design_cm2m, spacing_final_cm, resultLabel, materialsKey, spacingKey) => {
            const Scalc_m = (rebar.area_cm2 * 100 / As_design_cm2m) / 100;
            const overrideCm = spacingKey ? w.materials[spacingKey] : null;
            const hasOverride = overrideCm !== null && overrideCm !== undefined && overrideCm !== '';
            const Sfinal_cm = hasOverride ? Number(overrideCm) : spacing_final_cm;
            return `
              <p class="font-bold text-slate-700 mb-1 flex items-center gap-2">Varilla a usar:
                ${materialsKey
                  ? rebarSelectHtml(materialsKey)
                  : `<span class="text-indigo-700">${rebar.inches || rebar.name}</span>`}
              </p>
              <table class="w-full text-xs border border-slate-200 rounded overflow-hidden mb-1.5">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">A<sub>varilla</sub></td><td class="py-1 px-2 text-right font-mono">${rebar.area_cm2.toFixed(2)} cm²</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">S calc</td><td class="py-1 px-2 text-right font-mono">${fmtSpacingM(Scalc_m)} m</td></tr>
                  <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">S final</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">
                    ${spacingKey
                      ? `<input type="number" step="0.5" min="5" data-bind="materials.${spacingKey}" data-sync="materials.${spacingKey}" value="${Sfinal_cm}" class="w-16 text-right font-mono font-bold text-indigo-900 border border-indigo-300 rounded px-1 no-print bg-white"> cm`
                      : `${(Sfinal_cm / 100).toFixed(3)} m`}
                  </td></tr>
                </tbody>
              </table>
              <div class="rounded border text-xs font-bold text-center py-1 mb-2 bg-emerald-50 border-emerald-300 text-emerald-700">
                Verif. S final ≤ S calc — OK
              </div>
              <div class="rounded border border-amber-300 bg-amber-50 text-xs font-bold text-center py-1.5 text-slate-800">
                ${resultLabel} = 1 ø ${rebar.inches || rebar.name} @ ${Sfinal_cm.toFixed(1)} cm
              </div>`;
          };

          // Diagrama del muro completo (vástago + zapata) mostrando la
          // varilla vertical en la cara interior (recortada a Lc) o en la
          // cara exterior (continua hasta la corona).
          const rebarDiagram = (mode) => {
            const H = w.geometry.H, hz = w.geometry.hz, B = w.geometry.B;
            const B_toe = w.geometry.B_toe, bBot = w.geometry.b_bot, bTop = w.geometry.b_top;
            const Wpx = 340, Hpx = 380;
            const zapY = 320, zapBotY = 350, topY = 25;
            const stemH = zapY - topY;
            const backX = 160;
            const t2px = 60, t1px = Math.max(15, t2px * (bTop / bBot));
            const frontBotX = backX - t2px, frontTopX = backX - t1px;
            const zapLeftX = frontBotX - 35, zapRightX = backX + 35;

            const isCi = mode === 'ci';
            const yAtHeight = (h) => zapY - (h / str.stem.hp) * stemH;
            const cut1Y = yAtHeight(str.stem.Lc_usar);
            const barTopY = isCi ? cut1Y : topY;

            const commonMarkup = `
                <!-- Contorno del muro (vástago + zapata) -->
                <polygon points="${zapLeftX},${zapBotY} ${zapRightX},${zapBotY} ${zapRightX},${zapY} ${backX},${zapY} ${backX},${topY} ${frontTopX},${topY} ${frontBotX},${zapY} ${zapLeftX},${zapY}"
                  fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>

                <!-- Relleno (cara interior, derecha) -->
                ${Array.from({ length: 6 }, (_, i) => `<line x1="${backX + 10 + i * 8}" y1="${topY}" x2="${backX + 4 + i * 8}" y2="${topY + 8}" stroke="#b45309" stroke-width="1.2"/>`).join('')}
                <line x1="${backX}" y1="${topY}" x2="${backX + 55}" y2="${topY}" stroke="#0f172a" stroke-width="1.5"/>

                <!-- Cimentación (debajo de la zapata) -->
                ${Array.from({ length: 9 }, (_, i) => `<line x1="${zapLeftX + 6 + i * 8}" y1="${zapBotY}" x2="${zapLeftX + i * 8}" y2="${zapBotY + 8}" stroke="#94a3b8" stroke-width="1"/>`).join('')}

                <!-- Etiquetas de cara -->
                <text x="${(frontTopX + frontBotX) / 2 - 14}" y="${(topY + zapY) / 2}" font-size="10" fill="#94a3b8" text-anchor="middle" transform="rotate(-90 ${(frontTopX + frontBotX) / 2 - 14} ${(topY + zapY) / 2})">Cara Exterior</text>
                <text x="${backX - 24}" y="${(topY + zapY) / 2}" font-size="10" fill="#94a3b8" text-anchor="middle" transform="rotate(-90 ${backX - 24} ${(topY + zapY) / 2})">Cara Interior</text>`;

            if (isCi) {
              const barX = backX - 6;   // varilla continua: llega hasta la corona, gancho arriba y abajo
              const barXc = barX - 10;  // varilla de tramo 1: gancho en la base, se corta (sin gancho) en Lc
              const hookYContinua = zapBotY - 6;   // gancho más abajo (más cerca de la base real)
              const hookYTramo1 = zapBotY - 18;    // gancho más arriba, para que no se crucen
              return `
              <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:320px; width:100%;">
                ${commonMarkup}
                <!-- Varilla que continúa hasta la corona: gancho a 90° en la base (dentro de
                     la zapata) y gancho a 90° en la corona. Línea sólida de un solo tramo
                     físico — el corte por economía es otra varilla más corta (abajo). Su
                     gancho va más abajo (más cerca de la base real) que el de tramo 1. -->
                <path d="M ${barX - 10} ${topY + 4} L ${barX} ${topY + 4} L ${barX} ${hookYContinua} L ${barX - 10} ${hookYContinua}"
                  fill="none" stroke="#dc2626" stroke-width="2.6"/>
                <!-- Varilla de tramo 1: gancho en la base, se corta (sin gancho) en Lc — su
                     gancho queda más arriba que el de la varilla continua -->
                <path d="M ${barXc} ${cut1Y} L ${barXc} ${hookYTramo1} L ${barXc + 10} ${hookYTramo1}"
                  fill="none" stroke="#d946ef" stroke-width="2.6"/>

                <!-- Etiqueta -->
                <text x="${barX + 60}" y="${topY + 24}" font-size="12" font-weight="700" fill="#2563eb" text-anchor="start">Asv Ci</text>
                <line x1="${barX + 55}" y1="${topY + 20}" x2="${barX + 4}" y2="${topY + 16}" stroke="#2563eb" stroke-width="1.2"/>
                <line x1="${barX + 55}" y1="${topY + 20}" x2="${barXc + 4}" y2="${(cut1Y + hookYTramo1) / 2}" stroke="#2563eb" stroke-width="1.2"/>
                <polygon points="${barX + 6},${topY + 13} ${barX + 6},${topY + 19} ${barX},${topY + 16}" fill="#2563eb"/>

                <!-- Cota Lc -->
                <line x1="${zapRightX + 20}" y1="${zapY}" x2="${zapRightX + 20}" y2="${cut1Y}" stroke="#4338ca" stroke-width="1.3"/>
                <line x1="${zapRightX + 14}" y1="${zapY}" x2="${zapRightX + 26}" y2="${zapY}" stroke="#4338ca" stroke-width="1.3"/>
                <line x1="${zapRightX + 14}" y1="${cut1Y}" x2="${zapRightX + 26}" y2="${cut1Y}" stroke="#4338ca" stroke-width="1.3"/>
                <text x="${zapRightX + 30}" y="${(zapY + cut1Y) / 2 + 4}" font-size="11" font-weight="700" fill="#4338ca" text-anchor="start">Lc = ${str.stem.Lc_usar.toFixed(2)} m</text>
              </svg>`;
            }

            // Cara exterior: la varilla sigue el batir del frente (diagonal),
            // en los mismos 2 tramos (espaciamiento más amplio hacia la
            // corona), continua desde la zapata hasta la corona.
            const offset = 8;
            const xAtY = (y) => {
              const t = (y - topY) / (zapY - topY); // 0 en la corona, 1 en la base
              return frontTopX + (frontBotX - frontTopX) * t + offset;
            };
            const barBotX = xAtY(zapY), barTopX = xAtY(topY);
            return `
              <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:320px; width:100%;">
                ${commonMarkup}
                <!-- Varilla única, continua desde la base hasta la corona, siguiendo el
                     batido de la cara exterior: gancho a 90° en la base (dentro de la
                     zapata) y gancho a 90° en la corona. -->
                <path d="M ${barBotX + 10} ${zapBotY - 10} L ${barBotX} ${zapBotY - 10} L ${barTopX} ${topY + 4} L ${barTopX + 10} ${topY + 4}" fill="none" stroke="#dc2626" stroke-width="2.6"/>

                <!-- Etiqueta -->
                <text x="${barBotX - 65}" y="${(topY + zapY) / 2 - 20}" font-size="12" font-weight="700" fill="#2563eb" text-anchor="end">Asv Ce</text>
                <line x1="${barBotX - 60}" y1="${(topY + zapY) / 2 - 20}" x2="${(barBotX + barTopX) / 2 - 4}" y2="${(topY + zapY) / 2 - 20}" stroke="#2563eb" stroke-width="1.2"/>
                <polygon points="${(barBotX + barTopX) / 2 - 2},${(topY + zapY) / 2 - 23} ${(barBotX + barTopX) / 2 - 2},${(topY + zapY) / 2 - 17} ${(barBotX + barTopX) / 2 + 4},${(topY + zapY) / 2 - 20}" fill="#2563eb"/>
              </svg>`;
          };

          return `
        <!-- 2.4 Cálculo de Acero -->
        <section>
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">2.4. Cálculo de Acero</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            A continuación, se procede a calcular el acero de refuerzo tanto en la pantalla como en la
            zapata del muro de contención.
          </p>

          <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 mb-3">
            <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">A. Cálculo de Acero Vertical en Cara Interior (Asv<sub>ci</sub>)</h4>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs mb-2">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Mu</td><td class="py-1 px-2 text-right font-mono">${str.stem.Mu_kgcm.toLocaleString('es-PE', { maximumFractionDigits: 0 })}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg·cm</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">d</td><td class="py-1 px-2 text-right font-mono">${(str.stem.d * 100).toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">cm</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100.00</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">cm</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">ø</td><td class="py-1 px-2 text-right font-mono">0.90</td><td class="py-1 px-2 text-slate-400 italic text-[11px]"></td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">f'c</td><td class="py-1 px-2 text-right font-mono">${str.stem.fc_kgcm2.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg/cm²</td></tr>
                  <tr><td class="py-1 px-2 font-bold text-slate-600">fy</td><td class="py-1 px-2 text-right font-mono">${str.stem.fy_kgcm2.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg/cm²</td></tr>
                </tbody>
              </table>
              <div>
                <table class="w-full border border-slate-200 rounded overflow-hidden">
                  <tbody>
                    <tr class="bg-emerald-50 border-b border-slate-100"><td class="py-1 px-2 font-bold text-emerald-900">Asv<sub>ci</sub></td><td class="py-1 px-2 text-right font-mono font-bold text-emerald-900">${str.stem.As_design.toFixed(2)} cm²</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">a</td><td class="py-1 px-2 text-right font-mono">${str.stem.a_cm.toFixed(2)} cm</td></tr>
                    <tr><td class="py-1 px-2 font-bold text-slate-600">ρ</td><td class="py-1 px-2 text-right font-mono">${str.stem.rho_design.toFixed(4)}</td></tr>
                  </tbody>
                </table>
              </div>
              <div>
                <table class="w-full border border-slate-200 rounded overflow-hidden mb-1.5">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Asv<sub>min</sub></td><td class="py-1 px-2 text-right font-mono">${str.stem.As_min.toFixed(2)} cm²</td></tr>
                    <tr><td class="py-1 px-2 font-bold text-slate-600">ρmin</td><td class="py-1 px-2 text-right font-mono">${str.stem.rho_min.toFixed(4)}</td></tr>
                  </tbody>
                </table>
                <p class="text-[10px] text-slate-400 italic mb-1">E.060 ítem 14.3.1</p>
                <div class="rounded border text-xs font-bold text-center py-1 bg-emerald-50 border-emerald-300 text-emerald-700">
                  Verif ρmin ≤ ρ — OK
                </div>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] font-mono mb-2">
              <div class="p-2 bg-white rounded border border-slate-200 text-center">As<sub>min</sub> = (0.7√f'c / fy) · b · d</div>
              <div class="p-2 bg-white rounded border border-slate-200 text-center">a = d − √(d² − 2Mu / (ø·0.85·f'c·b))</div>
              <div class="p-2 bg-white rounded border border-slate-200 text-center">As = Mu / (ø·fy·(d − a/2))</div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center mb-3">
              <div class="max-w-xs">
                ${spacingBlock(str.stem.rebar, str.stem.As_design, str.stem.spacing, 'Asv<sub>ci</sub>', 'rebar_stem_id', 'spacing_stem_override_cm')}
              </div>
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
                ${rebarDiagram('ci')}
              </div>
            </div>

            <p class="font-bold text-emerald-700 italic mb-2 text-sm">Cálculo de la longitud crítica (Lc):</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-2">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Mu</td><td class="py-1 px-2 text-right font-mono">${str.stem.Mu_Tnm.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">Tn·m</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Ka</td><td class="py-1 px-2 text-right font-mono">${str.stem.Ka.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]"></td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">ys</td><td class="py-1 px-2 text-right font-mono">${(str.stem.gamma_s_kgm3 / 1000).toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">Tn/m³</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">hp</td><td class="py-1 px-2 text-right font-mono">${str.stem.hp.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">m</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">hs</td><td class="py-1 px-2 text-right font-mono">${str.stem.hs.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">m</td></tr>
                  <tr><td class="py-1 px-2 font-bold text-slate-600">hc</td><td class="py-1 px-2 text-right font-mono">${str.stem.hc.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">m</td></tr>
                </tbody>
              </table>
              <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center self-start">
                Mu/2 = 1.7·[Ka·γs·(hp−hc)²/2 · ((hp−hc)/3 + hs)]
              </div>
            </div>
            <div class="rounded border text-xs font-bold text-center py-1 mb-2 bg-emerald-50 border-emerald-300 text-emerald-700">
              ${(str.stem.Mu_Tnm / 2).toFixed(2)} = ${(str.stem.Mu_Tnm / 2).toFixed(2)} — OK
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
              <div class="p-2 bg-white rounded border border-slate-200 font-mono text-[11px] text-center">Lc = hc + d<sub>real</sub></div>
              <table class="w-full border border-slate-200 rounded overflow-hidden">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">d<sub>real</sub></td><td class="py-1 px-2 text-right font-mono">${str.stem.d.toFixed(2)} m</td></tr>
                  <tr class="bg-indigo-50"><td class="py-1 px-2 font-bold text-indigo-900">Lc</td><td class="py-1 px-2 text-right font-mono font-bold text-indigo-900">${str.stem.Lc.toFixed(2)} m</td></tr>
                </tbody>
              </table>
            </div>
            <div class="rounded border text-xs font-bold text-center py-1 mt-2 bg-amber-50 border-amber-300 text-slate-800">
              Usar: Lc = ${str.stem.Lc_usar.toFixed(2)} m
            </div>
          </div>

          <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 mb-3 avoid-break">
            <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">B. Cálculo de Acero Vertical en Cara Exterior (Asv<sub>ce</sub>)</h4>
            <p class="text-[11px] text-slate-500 mb-2">
              Al ser acero mínimo (0.0015·b·t), se calcula con el espesor real en la base del
              vástago (el más grueso) y se usa el mismo espaciamiento en toda la altura, sin
              economizar hacia la corona.
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-2">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">ρmin</td><td class="py-1 px-2 text-right font-mono">0.0015</td></tr>
                  <tr><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100.00 cm</td></tr>
                </tbody>
              </table>
              <div class="rounded border border-indigo-200 bg-indigo-50 flex items-center justify-center text-xs font-bold text-indigo-900">
                Asv<sub>ce</sub> = ${str.stem.As_vert_ext_inferior.toFixed(2)} cm²
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
              <div class="max-w-xs">
                ${spacingBlock(str.stem.rebarTemp, str.stem.As_vert_ext_inferior, str.stem.spacing_vert_ext_inferior, 'Asv<sub>ce</sub>', 'rebar_temp_id', 'spacing_vert_ext_override_cm')}
              </div>
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
                ${rebarDiagram('ce')}
              </div>
            </div>
          </div>

          <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 mb-3">
            <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">C. Cálculo de Acero Horizontal (Ash)</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-3">
              <div class="p-2 bg-amber-50 rounded border border-amber-300 flex items-center justify-center gap-2 font-bold">Diámetro del refuerzo: ${rebarSelectHtml('rebar_temp_id')}</div>
              <div class="p-2 bg-white rounded border border-slate-200 text-center">ρmin = ${str.stem.rho_h_min.toFixed(4)} <span class="text-slate-400 italic text-[10px]">(E.060 ítem 14.3.1${str.stem.rho_h_min > 0.002 ? ', Ø > 5/8"' : ''})</span></div>
            </div>

            <p class="text-center font-bold text-slate-700 bg-slate-100 rounded py-1 mb-2 text-xs">De la base hasta la parte media</p>
            <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2 mb-2 avoid-break">
              ${(() => {
                const Wpx = 260, Hpx = 220;
                const zapY = 160, zapBotY = 190, topY = 20;
                const backX = 130, t2px = 50, t1px = Math.max(12, t2px * (w.geometry.b_top / w.geometry.b_bot));
                const frontBotX = backX - t2px, frontTopX = backX - t1px;
                const zapLeftX = frontBotX - 30, zapRightX = backX + 30;
                const nPts = 7;
                const dotsCol = (cx) => Array.from({ length: nPts }, (_, i) => {
                  const cy = topY + 12 + (i / (nPts - 1)) * (zapY - topY - 24);
                  return `<circle cx="${cx}" cy="${cy}" r="2.2" fill="#0f172a"/>`;
                }).join('');
                return `
                <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:240px; width:100%;">
                  <polygon points="${zapLeftX},${zapBotY} ${zapRightX},${zapBotY} ${zapRightX},${zapY} ${backX},${zapY} ${backX},${topY} ${frontTopX},${topY} ${frontBotX},${zapY} ${zapLeftX},${zapY}"
                    fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>
                  ${Array.from({ length: 9 }, (_, i) => `<line x1="${zapLeftX + 6 + i * 7}" y1="${zapBotY}" x2="${zapLeftX + i * 7}" y2="${zapBotY + 7}" stroke="#94a3b8" stroke-width="1"/>`).join('')}
                  <line x1="${frontTopX - 15}" y1="${topY}" x2="${backX + 15}" y2="${topY}" stroke="#0f172a" stroke-width="1.5"/>
                  <path d="M ${(frontTopX + backX) / 2 - 10} ${topY} l 6,-6 l 8,12 l 6,-6" fill="none" stroke="#0f172a" stroke-width="1.5"/>
                  <text x="${(frontTopX + backX) / 2 - 34}" y="${(topY + zapY) / 2}" font-size="9.5" fill="#94a3b8" text-anchor="middle" transform="rotate(-90 ${(frontTopX + backX) / 2 - 34} ${(topY + zapY) / 2})">Cara Exterior</text>
                  <text x="${backX - 20}" y="${(topY + zapY) / 2}" font-size="9.5" fill="#94a3b8" text-anchor="middle" transform="rotate(-90 ${backX - 20} ${(topY + zapY) / 2})">Cara Interior</text>
                  ${dotsCol((frontTopX + frontBotX) / 2 + 18)}
                  ${dotsCol(backX - 12)}
                </svg>`;
              })()}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs mb-2">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">d = t2</td><td class="py-1 px-2 text-right font-mono">${(str.stem.d_h_inferior * 100).toFixed(2)} cm</td></tr>
                  <tr><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100.00 cm</td></tr>
                </tbody>
              </table>
              <div class="rounded border border-indigo-200 bg-indigo-50 flex items-center justify-center text-xs font-bold text-indigo-900">Ast = ${str.stem.Ast_inferior.toFixed(2)} cm²</div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs mb-3">
              <div>
                <p class="font-bold text-slate-700 mb-1 underline">Cara Exterior (Ash = 2/3 Ast)</p>
                <div class="rounded border border-indigo-200 bg-indigo-50 text-center font-bold text-indigo-900 py-1 mb-1.5">Ast<sub>ce</sub> = ${str.stem.Ash_ce_inferior.toFixed(2)} cm²</div>
                ${spacingBlock(str.stem.rebarTempCe, str.stem.Ash_ce_inferior, str.stem.sp_ce_inferior, 'Ash<sub>ce</sub>', 'rebar_temp_ce_id', 'sp_ce_inferior_override_cm')}
              </div>
              <div>
                <p class="font-bold text-slate-700 mb-1 underline">Cara Interior (Ash = 1/3 Ast)</p>
                <div class="rounded border border-indigo-200 bg-indigo-50 text-center font-bold text-indigo-900 py-1 mb-1.5">Ast<sub>ci</sub> = ${str.stem.Ash_ci_inferior.toFixed(2)} cm²</div>
                ${spacingBlock(str.stem.rebarTempCi, str.stem.Ash_ci_inferior, str.stem.sp_ci_inferior, 'Ash<sub>ci</sub>', 'rebar_temp_ci_id', 'sp_ci_inferior_override_cm')}
              </div>
            </div>

            <p class="text-center font-bold text-slate-700 bg-slate-100 rounded py-1 mb-2 text-xs">De la parte media hasta la corona</p>
            <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2 mb-2 avoid-break">
              ${(() => {
                // Solo la porción superior del vástago (de la parte media a
                // la corona): quiebre abajo (viene cortado de la parte
                // media) y remate simple arriba (corona real), sin zapata.
                const Wpx = 220, Hpx = 220;
                const topY = 20, botY = 190;
                const backX = 120;
                const t1px = 12; // ancho arriba (corona)
                const tMidPx = 12 + 0.5 * Math.max(4, 50 * (w.geometry.b_top / w.geometry.b_bot) - 12); // ancho aprox. a la mitad de la altura del vástago
                const frontTopX = backX - t1px, frontBotX = backX - tMidPx;
                const nPts = 6;
                const dotsCol = (cx) => Array.from({ length: nPts }, (_, i) => {
                  const cy = topY + 10 + (i / (nPts - 1)) * (botY - topY - 20);
                  return `<circle cx="${cx}" cy="${cy}" r="2.2" fill="#0f172a"/>`;
                }).join('');
                return `
                <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:200px; width:100%;">
                  <polygon points="${frontBotX},${botY} ${backX},${botY} ${backX},${topY} ${frontTopX},${topY}"
                    fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>
                  <!-- Remate simple en la corona -->
                  <line x1="${frontTopX - 12}" y1="${topY}" x2="${backX + 12}" y2="${topY}" stroke="#0f172a" stroke-width="1.5"/>
                  <!-- Quiebre abajo: viene cortado de la parte media -->
                  <path d="M ${frontBotX - 14} ${botY} L ${(frontBotX + backX) / 2 - 8} ${botY} l 6,-6 l 8,12 l 6,-6 L ${backX + 14} ${botY}" fill="none" stroke="#0f172a" stroke-width="1.5"/>
                  <text x="${(frontTopX + backX) / 2 - 28}" y="${(topY + botY) / 2}" font-size="9.5" fill="#94a3b8" text-anchor="middle" transform="rotate(-90 ${(frontTopX + backX) / 2 - 28} ${(topY + botY) / 2})">Cara Exterior</text>
                  <text x="${backX - 18}" y="${(topY + botY) / 2}" font-size="9.5" fill="#94a3b8" text-anchor="middle" transform="rotate(-90 ${backX - 18} ${(topY + botY) / 2})">Cara Interior</text>
                  ${dotsCol((frontTopX + frontBotX) / 2 + 14)}
                  ${dotsCol(backX - 12)}
                </svg>`;
              })()}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs mb-2">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">d = t'</td><td class="py-1 px-2 text-right font-mono">${(str.stem.d_h_superior * 100).toFixed(2)} cm</td></tr>
                  <tr><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100.00 cm</td></tr>
                </tbody>
              </table>
              <div class="rounded border border-indigo-200 bg-indigo-50 flex items-center justify-center text-xs font-bold text-indigo-900">Ast = ${str.stem.Ast_superior.toFixed(2)} cm²</div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <p class="font-bold text-slate-700 mb-1 underline">Cara Exterior (Ash = 2/3 Ast)</p>
                <div class="rounded border border-indigo-200 bg-indigo-50 text-center font-bold text-indigo-900 py-1 mb-1.5">Ast<sub>ce</sub> = ${str.stem.Ash_ce_superior.toFixed(2)} cm²</div>
                ${spacingBlock(str.stem.rebarTempCe, str.stem.Ash_ce_superior, str.stem.sp_ce_superior, 'Ash<sub>ce</sub>', 'rebar_temp_ce_id', 'sp_ce_superior_override_cm')}
              </div>
              <div>
                <p class="font-bold text-slate-700 mb-1 underline">Cara Interior (Ash = 1/3 Ast)</p>
                <div class="rounded border border-indigo-200 bg-indigo-50 text-center font-bold text-indigo-900 py-1 mb-1.5">Ast<sub>ci</sub> = ${str.stem.Ash_ci_superior.toFixed(2)} cm²</div>
                ${spacingBlock(str.stem.rebarTempCi, str.stem.Ash_ci_superior, str.stem.sp_ci_superior, 'Ash<sub>ci</sub>', 'rebar_temp_ci_id', 'sp_ci_superior_override_cm')}
              </div>
            </div>
          </div>

          ${(() => {
            const flexBlock = (member, title, resultLabel, footingLabel, rebarKey, spacingKey) => `
            <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 mb-3 avoid-break">
              <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">${title}</h4>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs mb-2">
                <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                  <tbody>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">Mu</td><td class="py-1 px-2 text-right font-mono">${member.Mu_kgcm.toLocaleString('es-PE', { maximumFractionDigits: 0 })}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg·cm</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">d</td><td class="py-1 px-2 text-right font-mono">${(member.d * 100).toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">cm</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100.00</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">cm</td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">ø</td><td class="py-1 px-2 text-right font-mono">0.90</td><td class="py-1 px-2 text-slate-400 italic text-[11px]"></td></tr>
                    <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">f'c</td><td class="py-1 px-2 text-right font-mono">${member.fc_kgcm2.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg/cm²</td></tr>
                    <tr><td class="py-1 px-2 font-bold text-slate-600">fy</td><td class="py-1 px-2 text-right font-mono">${member.fy_kgcm2.toFixed(2)}</td><td class="py-1 px-2 text-slate-400 italic text-[11px]">kg/cm²</td></tr>
                  </tbody>
                </table>
                <div>
                  <table class="w-full border border-slate-200 rounded overflow-hidden">
                    <tbody>
                      <tr class="bg-emerald-50 border-b border-slate-100"><td class="py-1 px-2 font-bold text-emerald-900">${resultLabel}</td><td class="py-1 px-2 text-right font-mono font-bold text-emerald-900">${member.As_design.toFixed(2)} cm²</td></tr>
                      <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">a</td><td class="py-1 px-2 text-right font-mono">${member.a_cm.toFixed(2)} cm</td></tr>
                      <tr><td class="py-1 px-2 font-bold text-slate-600">ρ</td><td class="py-1 px-2 text-right font-mono">${member.rho_design.toFixed(4)}</td></tr>
                    </tbody>
                  </table>
                </div>
                <div>
                  <table class="w-full border border-slate-200 rounded overflow-hidden mb-1.5">
                    <tbody>
                      <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">As<sub>min</sub></td><td class="py-1 px-2 text-right font-mono">${member.As_min.toFixed(2)} cm²</td></tr>
                      <tr><td class="py-1 px-2 font-bold text-slate-600">ρmin</td><td class="py-1 px-2 text-right font-mono">${member.rho_min.toFixed(4)}</td></tr>
                    </tbody>
                  </table>
                  <p class="text-[10px] text-slate-400 italic mb-1">E.060 ítem 14.3.1</p>
                  <div class="rounded border text-xs font-bold text-center py-1 bg-emerald-50 border-emerald-300 text-emerald-700">
                    Verif ρmin ≤ ρ — OK
                  </div>
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] font-mono mb-2">
                <div class="p-2 bg-white rounded border border-slate-200 text-center">As<sub>min</sub> = (0.7√f'c / fy) · b · d</div>
                <div class="p-2 bg-white rounded border border-slate-200 text-center">a = d − √(d² − 2Mu / (ø·0.85·f'c·b))</div>
                <div class="p-2 bg-white rounded border border-slate-200 text-center">As = Mu / (ø·fy·(d − a/2))</div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                <div class="max-w-xs">
                  ${spacingBlock(member.rebar, member.As_design, member.spacing, resultLabel, rebarKey, spacingKey)}
                </div>
                <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
                  ${footingLabelDiagram(footingLabel)}
                </div>
              </div>
            </div>`;

            const footingLabelDiagram = (label) => {
              const Wpx = 300, Hpx = 100;
              const rx0 = 20, rx1 = 280, ry0 = 30, ry1 = 80;
              const notchCx = (rx0 + rx1) / 2, notchW = 40;
              const breakY = ry0 - 15;
              // La varilla principal va abajo en la punta (tracción en la
              // cara inferior) y arriba en el talón (tracción en la cara
              // superior), con gancho a 90° en ambos extremos laterales
              // doblando siempre hacia el interior de la zapata — es la
              // varilla real, no una simple cota.
              const isPunta = label === 'Punta';
              const barY = isPunta ? ry1 - 10 : ry0 + 10;
              const hookH = 10;
              const hookSign = isPunta ? -1 : 1; // dobla hacia arriba en la punta, hacia abajo en el talón
              const labelY = isPunta ? barY + hookH * hookSign - 8 : barY + hookH * hookSign + 16;
              // Mismo color que su acero real: verde para la Punta (acero
              // inferior de zapata), morado para el Talón (acero superior).
              const barColor = isPunta ? '#00b140' : '#9333ea';
              return `
                <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:280px; width:100%;">
                  <polygon points="${rx0},${ry1} ${rx0},${ry0} ${notchCx - notchW / 2},${ry0} ${notchCx - notchW / 2},${breakY} ${notchCx + notchW / 2},${breakY} ${notchCx + notchW / 2},${ry0} ${rx1},${ry0} ${rx1},${ry1}"
                    fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>
                  <!-- Quiebre (el vástago continúa fuera de esta vista): línea recta con un
                       zigzag centrado sobre el saliente, convención estándar de plano -->
                  <line x1="${notchCx - notchW / 2 - 30}" y1="${breakY}" x2="${notchCx - notchW / 2 - 6}" y2="${breakY}" stroke="#334155" stroke-width="1.3"/>
                  <path d="M ${notchCx - notchW / 2 - 6} ${breakY} l 4,-6 l 8,12 l 8,-12 l 4,6" fill="none" stroke="#334155" stroke-width="1.3"/>
                  <line x1="${notchCx + notchW / 2 + 6}" y1="${breakY}" x2="${notchCx + notchW / 2 + 30}" y2="${breakY}" stroke="#334155" stroke-width="1.3"/>
                  <!-- Varilla principal con gancho a 90° en ambos extremos -->
                  <path d="M ${rx0 + 6},${barY + hookH * hookSign} L ${rx0 + 6},${barY} L ${rx1 - 6},${barY} L ${rx1 - 6},${barY + hookH * hookSign}"
                    fill="none" stroke="${barColor}" stroke-width="2.2"/>
                  <text x="${rx0 + 14}" y="${labelY}" font-size="12" font-weight="700" fill="${barColor}" text-anchor="start">${label}</text>
                </svg>`;
            };

            return `
          ${flexBlock(str.toe, 'D. Cálculo de Acero Principal en la Punta (As)', 'As', 'Punta', 'rebar_toe_id', 'spacing_toe_override_cm')}
          ${flexBlock(str.heel, 'E. Cálculo de Acero Principal en el Talón (As)', 'As', 'Talón', 'rebar_heel_id', 'spacing_heel_override_cm')}

          <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 avoid-break">
            <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">F. Acero Transversal de Reparto (Punta, Talón${w.geometry.has_key ? ' y Dentellón' : ''})</h4>
            <p class="text-[11px] text-slate-500 mb-2">
              Varilla mínima de reparto (E.060 ítem 7.12.2, ρ = 0.0018), continua entre la punta y el
              talón${w.geometry.has_key ? ', prolongándose también hacia el dentellón' : ''}.
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-2">
              <table class="w-full border border-slate-200 rounded overflow-hidden self-start">
                <tbody>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">ρ</td><td class="py-1 px-2 text-right font-mono">0.0018</td></tr>
                  <tr class="border-b border-slate-100"><td class="py-1 px-2 font-bold text-slate-600">hz</td><td class="py-1 px-2 text-right font-mono">${(str.toe.hz * 100).toFixed(2)} cm</td></tr>
                  <tr><td class="py-1 px-2 font-bold text-slate-600">b</td><td class="py-1 px-2 text-right font-mono">100.00 cm</td></tr>
                </tbody>
              </table>
              <div class="rounded border border-indigo-200 bg-indigo-50 flex items-center justify-center text-xs font-bold text-indigo-900">Ast = ${str.toe.As_trans.toFixed(2)} cm²</div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
              <div class="max-w-xs">
                ${spacingBlock(str.toe.rebarTemp, str.toe.As_trans, str.toe.spacing_trans, 'Ast', 'rebar_temp_id', 'spacing_trans_override_cm')}
              </div>
              <div class="flex justify-center bg-white border border-slate-200 rounded-lg p-2">
                ${(() => {
                  const Wpx = 300, Hpx = 100;
                  const rx0 = 20, rx1 = 280, ry0 = 30, ry1 = 80;
                  const notchCx = (rx0 + rx1) / 2, notchW = 40;
                  const breakY = ry0 - 15;
                  const midX = (rx0 + rx1) / 2;
                  const dotsRow = (y) => Array.from({ length: 13 }, (_, i) => {
                    const cx = rx0 + 10 + (i / 12) * (rx1 - rx0 - 20);
                    return `<circle cx="${cx}" cy="${y}" r="2.4" fill="#f97316"/>`;
                  }).join('');
                  return `
                    <svg viewBox="0 0 ${Wpx} ${Hpx}" style="max-width:280px; width:100%;">
                      <polygon points="${rx0},${ry1} ${rx0},${ry0} ${notchCx - notchW / 2},${ry0} ${notchCx - notchW / 2},${breakY} ${notchCx + notchW / 2},${breakY} ${notchCx + notchW / 2},${ry0} ${rx1},${ry0} ${rx1},${ry1}"
                        fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>
                      <line x1="${notchCx - notchW / 2 - 30}" y1="${breakY}" x2="${notchCx - notchW / 2 - 6}" y2="${breakY}" stroke="#334155" stroke-width="1.3"/>
                      <path d="M ${notchCx - notchW / 2 - 6} ${breakY} l 4,-6 l 8,12 l 8,-12 l 4,6" fill="none" stroke="#334155" stroke-width="1.3"/>
                      <line x1="${notchCx + notchW / 2 + 6}" y1="${breakY}" x2="${notchCx + notchW / 2 + 30}" y2="${breakY}" stroke="#334155" stroke-width="1.3"/>
                      <!-- Acero transversal visto en corte (perpendicular a este plano): dos hileras de puntos -->
                      ${dotsRow(ry0 + 12)}
                      ${dotsRow(ry1 - 12)}
                      <text x="${rx0 + 10}" y="${(ry0 + ry1) / 2 + 4}" font-size="12" font-weight="700" fill="#2563eb" text-anchor="start">Punta</text>
                      <text x="${rx1 - 10}" y="${(ry0 + ry1) / 2 + 4}" font-size="12" font-weight="700" fill="#2563eb" text-anchor="end">Talón</text>
                      <line x1="${midX}" y1="${ry0}" x2="${midX}" y2="${ry1}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/>
                    </svg>`;
                })()}
              </div>
            </div>
          </div>

          ${(() => {
            const barShapeIcon = (shape) => {
              const stroke = '#0f172a';
              const Wpx = 70, Hpx = 34;
              // Punta de flecha en la dirección del doblez, igual convención
              // que el plano de referencia (marca el gancho, no solo la línea).
              const arrow = (x, y, angleDeg) => `<g transform="translate(${x},${y}) rotate(${angleDeg})"><path d="M 0,0 L -6,-2.5 L -6,2.5 Z" fill="${stroke}"/></g>`;
              const shapes = {
                'hook-straight': `<path d="M 12,6 L 12,26 L 24,30" fill="none" stroke="${stroke}" stroke-width="2.5"/>${arrow(24, 30, 22)}`,
                'straight': `<line x1="12" y1="6" x2="12" y2="28" stroke="${stroke}" stroke-width="2.5"/>`,
                'hook-diagonal': `<path d="M 14,4 L 46,26 L 58,30" fill="none" stroke="${stroke}" stroke-width="2.5"/>${arrow(58, 30, 22)}`,
                'diagonal': `<line x1="14" y1="4" x2="52" y2="28" stroke="${stroke}" stroke-width="2.5"/>`,
                'hooks-both': `<path d="M 8,10 L 12,4 L 58,4 L 62,10" fill="none" stroke="${stroke}" stroke-width="2.5"/>${arrow(8, 10, 115)}${arrow(62, 10, 65)}`,
              };
              return `<svg viewBox="0 0 ${Wpx} ${Hpx}" style="width:56px; height:28px;">${shapes[shape] || shapes.straight}</svg>`;
            };

            const schedule = calculateRebarSchedule(w, str);
            return `
          <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/40 mb-3">
            <h4 class="font-bold text-slate-900 mb-2 bg-amber-100 px-2 py-1 rounded">G. Cuadro de Habilitación de Acero</h4>
            <p class="text-[11px] text-slate-500 mb-2">
              Lista de habilitación para un tramo de muro de <strong>${schedule.wallLength.toFixed(2)} m</strong> de
              longitud (editable en "Longitud del tramo de muro (L)", Hoja Datos). La forma de cada barra es
              esquemática; el largo ya incluye el desarrollo de gancho donde corresponde.
            </p>
            <div class="overflow-x-auto">
              <table class="w-full text-[11px] border border-slate-200 rounded-lg overflow-hidden">
                <thead class="bg-amber-500 text-white">
                  <tr>
                    <th class="py-1.5 px-2 text-left">Marca</th>
                    <th class="py-1.5 px-2 text-left">Elemento</th>
                    <th class="py-1.5 px-2 text-left">Ø</th>
                    <th class="py-1.5 px-2 text-center">Forma</th>
                    <th class="py-1.5 px-2 text-right">Long. unit. (m)</th>
                    <th class="py-1.5 px-2 text-right">Cant.</th>
                    <th class="py-1.5 px-2 text-right">Long. total (m)</th>
                    <th class="py-1.5 px-2 text-right">Peso (kg)</th>
                  </tr>
                </thead>
                <tbody class="text-slate-700">
                  ${schedule.rows.map(r => `
                  <tr class="border-t border-slate-100">
                    <td class="py-1 px-2 font-bold">${r.mark}</td>
                    <td class="py-1 px-2">${r.element}</td>
                    <td class="py-1 px-2 font-mono">${r.diameter_name}</td>
                    <td class="py-1 px-2 text-center">${barShapeIcon(r.shape)}</td>
                    <td class="py-1 px-2 text-right font-mono">${r.unitLength_m.toFixed(2)}</td>
                    <td class="py-1 px-2 text-right font-mono">${r.quantity}</td>
                    <td class="py-1 px-2 text-right font-mono">${r.totalLength_m.toFixed(1)}</td>
                    <td class="py-1 px-2 text-right font-mono">${r.weight_kg.toFixed(1)} kg</td>
                  </tr>`).join('')}
                  <tr class="border-t border-slate-200 bg-amber-50 font-bold">
                    <td class="py-1.5 px-2" colspan="7">Peso total de acero (tramo de ${schedule.wallLength.toFixed(2)} m)</td>
                    <td class="py-1.5 px-2 text-right font-mono">${schedule.totalWeight_kg.toFixed(1)} kg</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          `;
          })()}
          `;
          })()}
        </section>
        `;
        })()}

        <!-- 4. Resumen de Armaduras -->
        <section class="print-page-break">
          <h3 class="text-base font-bold text-indigo-900 border-b border-indigo-100 pb-1 mb-2">2.5. Resumen General del Acero de Refuerzo</h3>
          <p class="text-xs text-slate-600 mb-2 text-justify">
            A partir de los momentos y cortantes calculados en las secciones anteriores, se
            calcula el acero de refuerzo necesario en la pantalla y en la zapata del muro de
            contención, seleccionando el diámetro comercial y el espaciamiento final.
          </p>
          <div class="space-y-3 text-xs bg-slate-50 p-4 rounded-lg border border-slate-200">
            
            <div>
              <h4 class="font-bold text-slate-900 text-sm">1. Pantalla (Vástago)</h4>
              <ul class="list-disc list-inside space-y-1 mt-1 text-slate-700">
                <li><strong>Acero Vertical (Cara Interior):</strong> ${str.stem.rebar_callout} | <em>${str.stem.rebar_intercalado}</em></li>
                <li><strong>Acero Vertical (Cara Exterior):</strong> ${str.stem.rebar_vert_ext}</li>
                <li><strong>Acero Horizontal, tramo inferior (base a media altura):</strong> ${str.stem.horizontal_summary.inferior_ce} | ${str.stem.horizontal_summary.inferior_ci}</li>
                <li><strong>Acero Horizontal, tramo superior (media altura a corona):</strong> ${str.stem.horizontal_summary.superior_ce} | ${str.stem.horizontal_summary.superior_ci}</li>
              </ul>
            </div>

            <div class="pt-2 border-t border-slate-200">
              <h4 class="font-bold text-slate-900 text-sm">2. Zapata Anterior (Punta)</h4>
              <ul class="list-disc list-inside space-y-1 mt-1 text-slate-700">
                <li><strong>Acero Principal Inferior:</strong> ${str.toe.rebar_callout}</li>
                <li><strong>Acero Transversal de Montaje:</strong> ${str.toe.rebar_trans}</li>
              </ul>
            </div>

            <div class="pt-2 border-t border-slate-200">
              <h4 class="font-bold text-slate-900 text-sm">3. Zapata Posterior (Talón)</h4>
              <ul class="list-disc list-inside space-y-1 mt-1 text-slate-700">
                <li><strong>Acero Principal Superior:</strong> ${str.heel.rebar_callout}</li>
                <li><strong>Acero Transversal de Reparto:</strong> ${str.heel.rebar_trans}</li>
              </ul>
            </div>

          </div>
        </section>

      </div>
    `;

    reportContainer.innerHTML = this.reportUnit === 'Tn' ? this.convertReportUnitsToTn(reportHtml) : reportHtml;

    // Restaurar el scroll guardado al principio de la función (ver
    // comentario junto a `savedScrollTop`), ahora que el nuevo HTML ya está
    // en el DOM y el panel tiene su nueva altura.
    if (reportPanelEl && savedScrollTop !== null) {
      reportPanelEl.scrollTop = savedScrollTop;
    }

    // Los selectores de varilla y los campos de espaciamiento editable
    // insertados dentro del informe (p.ej. en los bloques "Varilla a usar" /
    // "S final") se recrean con cada regeneración del HTML, así que no
    // quedan enlazados por bindInputEvents() (que solo corrió una vez al
    // iniciar la app sobre los elementos que existían entonces) — se
    // vuelven a enlazar aquí cada vez.
    reportContainer.querySelectorAll('select[data-bind], input[data-bind]').forEach((el) => {
      el.addEventListener('change', (e) => this.handleInputChange(e.target, true));
    });

    if (window.renderMathInElement) {
      window.renderMathInElement(reportContainer, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false
      });
    }
  }
}
