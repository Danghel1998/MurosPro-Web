/**
 * Constantes y tablas de referencia para diseño de muros de contención
 * Calibrado con metodología exacta de las diapositivas y hojas Excel UNI
 */

export const REBAR_TABLE = [
  { name: 'Ø 3/8" (9.5 mm)',  diameter_mm: 9.52,  diameter_m: 0.00952, area_cm2: 0.71, weight_kgm: 0.560, inches: '3/8"' },
  { name: 'Ø 1/2" (12.7 mm)', diameter_mm: 12.70, diameter_m: 0.01270, area_cm2: 1.29, weight_kgm: 0.994, inches: '1/2"' },
  { name: 'Ø 5/8" (15.9 mm)', diameter_mm: 15.88, diameter_m: 0.01588, area_cm2: 1.99, weight_kgm: 1.552, inches: '5/8"' },
  { name: 'Ø 3/4" (19.1 mm)', diameter_mm: 19.05, diameter_m: 0.01905, area_cm2: 2.84, weight_kgm: 2.235, inches: '3/4"' },
  { name: 'Ø 7/8" (22.2 mm)', diameter_mm: 22.22, diameter_m: 0.02222, area_cm2: 3.87, weight_kgm: 3.042, inches: '7/8"' },
  { name: 'Ø 1" (25.4 mm)',   diameter_mm: 25.40, diameter_m: 0.02540, area_cm2: 5.10, weight_kgm: 3.973, inches: '1"' },
  { name: 'Ø 1-1/8" (28.6 mm)', diameter_mm: 28.65, diameter_m: 0.02865, area_cm2: 6.45, weight_kgm: 5.060, inches: '1-1/8"' },
  { name: 'Ø 1-1/4" (32.0 mm)', diameter_mm: 32.00, diameter_m: 0.03200, area_cm2: 8.04, weight_kgm: 6.313, inches: '1-1/4"' },
  { name: 'Ø 8 mm',  diameter_mm: 8.0,  diameter_m: 0.0080, area_cm2: 0.503, weight_kgm: 0.395, inches: '8mm' },
  { name: 'Ø 10 mm', diameter_mm: 10.0, diameter_m: 0.0100, area_cm2: 0.785, weight_kgm: 0.617, inches: '10mm' },
  { name: 'Ø 12 mm', diameter_mm: 12.0, diameter_m: 0.0120, area_cm2: 1.131, weight_kgm: 0.888, inches: '12mm' },
  { name: 'Ø 16 mm', diameter_mm: 16.0, diameter_m: 0.0160, area_cm2: 2.011, weight_kgm: 1.578, inches: '16mm' },
  { name: 'Ø 20 mm', diameter_mm: 20.0, diameter_m: 0.0200, area_cm2: 3.142, weight_kgm: 2.466, inches: '20mm' },
  { name: 'Ø 25 mm', diameter_mm: 25.0, diameter_m: 0.0250, area_cm2: 4.909, weight_kgm: 3.853, inches: '25mm' },
  { name: 'Ø 32 mm', diameter_mm: 32.0, diameter_m: 0.0320, area_cm2: 8.042, weight_kgm: 6.313, inches: '32mm' },
];

export const ZONAS_SISMICAS = {
  zona_1: { name: 'Zona Sísmica 1 (0.10 g)', a0: 0.10, kh: 0.05, kv: 0.035 },
  zona_2: { name: 'Zona Sísmica 2 (0.25 g)', a0: 0.25, kh: 0.125, kv: 0.0875 },
  zona_3: { name: 'Zona Sísmica 3 (0.35 g)', a0: 0.35, kh: 0.175, kv: 0.1225 },
  zona_4: { name: 'Zona Sísmica 4 (0.45 g)', a0: 0.45, kh: 0.225, kv: 0.1575 },
};

export const DEFAULT_WALL_DATA = {
  // Geometría del Muro (m)
  geometry: {
    H: 5.00,         // Altura del muro (H)
    hz: 0.50,        // Espesor de zapata (e = H/10)
    B: 3.50,         // Ancho zapata (B = 0.70 H)
    B_toe: 1.65,     // Puntera (P = H/3 redondeado a 5cm; H=5.00m -> 1.65m, ejemplo del curso)
    b_top: 0.30,     // Corona vástago (t1 = 0.30m)
    b_bot: 0.50,     // Base vástago (t2 = H/10)
    has_key: false,  // Dentellón
    key_depth: 0.40,
    key_width: 0.40,
    key_pos: 1.20,
    Df: 1.20,        // Profundidad de fundación
    wall_length: 10.00, // Longitud física del tramo de muro (para el cuadro de habilitación de acero)
  },

  // Datos del Suelo de Fundación
  foundation: {
    gamma: 18.14,    // Peso específico = 1850.00 kg/m³ -> 18.14 kN/m³
    gamma_kgm3: 1850.0,
    phi: 32.0,       // Ángulo de fricción interna (32 °)
    c_kgcm2: 0.25,   // Cohesión = 0.25 kg/cm² = 25 kPa
    c: 24.52,        // kPa
    q_ult_kgcm2: 4.50, // Capacidad de carga última = 4.50 kg/cm²
    q_adm: 147.1,    // Capacidad admisible q_adm = q_ult / 3 = 1.50 kg/cm² = 147.1 kPa
    friction_ratio: '2/3', // Ángulo de fricción suelo-muro base (2/3)
    mu: 0.39,        // tan(2/3 * 32°) = 0.39
  },

  // Datos del Suelo de Relleno
  backfill: {
    gamma: 18.63,     // Peso específico = 1900.00 kg/m³ -> 18.63 kN/m³
    gamma_kgm3: 1900.0,
    phi: 34.0,        // Ángulo de fricción interna (34 °)
    delta: 0.0,       // Ángulo de fricción suelo-muro pantalla = 0
    beta: 0.0,        // Ángulo de inclinación interna = 0 °
    c: 0.0,
  },

  // Datos de los Materiales Utilizados
  materials: {
    fc_kgcm2: 210.0,   // Resistencia del concreto = 210.00 kg/cm²
    fc: 20.6,          // 21 MPa
    fy_kgcm2: 4200.0,  // Resistencia del acero = 4200.00 kg/cm²
    fy: 420.0,         // 420 MPa
    gamma_c_kgm3: 2400.0, // Peso específico del concreto = 2400.00 kg/m³
    gamma_c: 23.54,    // 23.54 kN/m³
    cover_stem: 0.04,  // 4 cm
    cover_footing: 0.075, // 7.5 cm
    rebar_stem_id: 1,  // Ø 1/2"
    rebar_toe_id: 1,   // Ø 1/2"
    rebar_heel_id: 2,  // Ø 5/8"
    rebar_temp_id: 1,  // Ø 1/2" (Asvce y transversal de zapata)
    rebar_temp_ce_id: 1, // Ø 1/2" (Ash cara exterior, independiente)
    rebar_temp_ci_id: 1, // Ø 1/2" (Ash cara interior, independiente)
  },

  // Condiciones del Sitio
  site_conditions: {
    zona_sismica: 'zona_1', // Zona sísmica 1 (0.10 g)
    a0: 0.10,
    hs_surcharge: 0.61,    // Sobrecarga vehicular (Hs = 0.61 m)
    q_surcharge: 11.36,    // q = gamma_r * Hs = 1900 * 0.61 = 1159 kg/m² = 11.36 kN/m²
    wall_inner_angle: 90.0,// Inclinación cara interna = 90°
    dentellon_mode: 'auto',// 'auto' (cuando es necesario) | 'si' | 'no'
    drain_rain_water: true,// Drenar agua de lluvia
  },

  loads: {
    q_surcharge: 11.36,
    has_water_table: false,
    hw: 0.0,
    consider_passive: false,
    passive_factor: 0.50,
    is_seismic: true,
    kh: 0.05,
    kv: 0.035,
  },

  safety_req: {
    fs_overturning: 1.50,
    fs_sliding: 1.25,
    fs_overturning_seismic: 1.50,
    fs_sliding_seismic: 1.25,
    code: 'E060',
  }
};

export const PRESET_PROJECTS = {
  diapos_uni_5m: {
    title: '⭐ Caso Imagen Diapos UNI (H = 5.00m, φ=34°, Hs=0.61m, Zona 1)',
    desc: 'Caso exacto de la imagen con H=5.0m, suelo relleno φ=34°, γ=1900, fundación φ=32°, c=0.25, Hs=0.61m, Zona 1 (0.10g).',
    data: JSON.parse(JSON.stringify(DEFAULT_WALL_DATA))
  },
  excel_uni_6_5m: {
    title: 'Caso Proyecto Canoas de Punta Sal (H = 6.50m, φ=22.5°, q=1 tn/m²)',
    desc: 'Caso con H=6.5m, B=4.55m, q=1.0 tn/m², f\'c=210 kg/cm², γ=1760 kg/m³, φ=22.5°.',
    data: (() => {
      const d = JSON.parse(JSON.stringify(DEFAULT_WALL_DATA));
      d.geometry.H = 6.50;
      d.geometry.hz = 0.65;
      d.geometry.B = 4.55;
      d.geometry.B_toe = 1.52;
      d.geometry.b_bot = 0.65;
      d.backfill.gamma_kgm3 = 1760;
      d.backfill.gamma = 17.26;
      d.backfill.phi = 22.5;
      d.foundation.gamma_kgm3 = 1700;
      d.foundation.gamma = 16.67;
      d.foundation.phi = 28.0;
      d.foundation.c_kgcm2 = 0.125;
      d.foundation.c = 12.26;
      d.foundation.q_ult_kgcm2 = 3.60;
      d.foundation.q_adm = 117.7;
      d.site_conditions.hs_surcharge = 0.568;
      d.loads.q_surcharge = 9.81;
      d.site_conditions.zona_sismica = 'zona_4';
      d.loads.is_seismic = false;
      return d;
    })()
  },
  muro_sismico_zona4: {
    title: 'Caso Muro H = 6.50m con Sismo Zona 4 (0.45g) y Dentellón',
    desc: 'Análisis sísmico completo con aceleración 0.45g y tacón para deslizamiento.',
    data: (() => {
      const d = JSON.parse(JSON.stringify(DEFAULT_WALL_DATA));
      d.geometry.H = 6.50;
      d.geometry.hz = 0.65;
      d.geometry.B = 4.55;
      d.geometry.B_toe = 1.52;
      d.geometry.b_bot = 0.65;
      d.geometry.has_key = true;
      d.geometry.key_depth = 0.50;
      d.geometry.key_width = 0.50;
      d.geometry.key_pos = 1.60;
      d.site_conditions.zona_sismica = 'zona_4';
      d.loads.is_seismic = true;
      d.loads.kh = 0.225;
      d.loads.kv = 0.1575;
      return d;
    })()
  }
};
