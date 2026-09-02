/**
 * Motor de verificación de estabilidad geotécnica de muros de contención
 * Calibrado con la metodología de cálculo de la UNI / E.060 / ACI 318
 */

import { calculateLateralEarthPressures, degToRad } from './soilPressures.js';

export function calculateGeotechnicalStability(wallData) {
  const { geometry, backfill, foundation, loads, materials, safety_req } = wallData;

  const H = geometry.H;
  const hz = geometry.hz;
  const H_stem = H - hz; // Altura libre de pantalla (Hp)
  const B = geometry.B;
  const B_toe = geometry.B_toe; // Longitud puntera (P)
  const b_bot = geometry.b_bot; // Base vástago (t2)
  const b_top = geometry.b_top; // Corona vástago (t1)
  const t_tri = Math.max(0, b_bot - b_top); // Cartabón vástago
  const B_heel = Math.max(0, B - B_toe - b_bot); // Longitud talón (T)

  const gamma_c = materials.gamma_c || 23.54; // kN/m³ (2400 kg/m³)
  const gamma_s = backfill.gamma; // kN/m³ (1760 kg/m³)
  const gamma_f = foundation.gamma; // kN/m³, suelo de fundación/desplante
  const q_surcharge = loads.q_surcharge || 0;
  const beta = backfill.beta || 0;
  const Df = geometry.Df || hz;

  // 1. Desglose detallado de pesos estabilizadores verticales (W1 a W5)
  // Geometría: el achaflanado (cartabón) del vástago va del lado de la
  // PUNTERA (cara frontal batida) y la cara posterior (lado del talón) es
  // vertical — confirmado con el ejemplo de las diapositivas del curso
  // (arma de la cuña = P + t_tri/3, arma del cuerpo = P + t_tri + t1/2).
  // No existe un término de "cuña de suelo" independiente: el relleno
  // sobre el talón es un único bloque rectangular (W2).
  const weights = [];

  // W1: Suelo de relleno sobre la puntera. Cuando la profundidad de
  // desplante (Df) supera el espesor de la zapata (hz), el terreno natural
  // entre el nivel de piso terminado y el tope de la zapata también
  // descansa sobre la puntera y debe considerarse como peso estabilizador.
  const soil_over_toe_h = Math.max(0, Df - hz);
  if (soil_over_toe_h > 0.001 && B_toe > 0.01) {
    const w0_weight = gamma_f * B_toe * soil_over_toe_h;
    const w0_x = B_toe / 2.0;
    weights.push({
      id: 'W1',
      name: 'W1: Suelo de Relleno sobre la Puntera',
      weight: w0_weight,
      weight_kg: (w0_weight * 1000) / 9.80665,
      arm_x: w0_x,
      moment: w0_weight * w0_x,
      description: `${B_toe.toFixed(2)}m × ${soil_over_toe_h.toFixed(2)}m × ${(gamma_f * 101.97).toFixed(0)} kg/m³ (Df − hz)`,
      material: 'Suelo',
      gamma_kgm3: gamma_f * 101.97,
      area: B_toe * soil_over_toe_h,
    });
  }

  // W2: Sobrecarga sobre el talón (q * T), aplicada sobre la superficie
  // horizontal del relleno encima del talón. Se expresa como una capa
  // equivalente de suelo de altura Hs (Hs = q ÷ γs) para que el peso
  // también se pueda leer como Área × γs = γs·Hs·T, igual que el resto de
  // las filas de suelo/concreto (Peso = V·γ).
  const w1_width = B_heel;
  const hs_equiv = gamma_s > 0 ? q_surcharge / gamma_s : 0;
  if (q_surcharge > 0 && w1_width > 0.01) {
    const w1_weight = q_surcharge * w1_width;
    const w1_x = B - (w1_width / 2.0);
    weights.push({
      id: 'W2',
      name: 'W2: Sobrecarga sobre el Talón (q)',
      weight: w1_weight,
      weight_kg: (w1_weight * 1000) / 9.80665,
      arm_x: w1_x,
      moment: w1_weight * w1_x,
      description: `q = ${(q_surcharge * 1000 / 9806.65).toFixed(2)} tn/m² × ${w1_width.toFixed(2)} m (talón) = γs·Hs·T`,
      material: 'Suelo',
      gamma_kgm3: gamma_s * 101.97,
      area: hs_equiv * w1_width,
    });
  }

  // W3: Suelo rectangular sobre el talón (gamma_s * B_heel * H_stem)
  if (B_heel > 0.01) {
    const w2_weight = gamma_s * B_heel * H_stem;
    const w2_x = B - (B_heel / 2.0);
    weights.push({
      id: 'W3',
      name: 'W3: Suelo Relleno Rectangular (Talón)',
      weight: w2_weight,
      weight_kg: (w2_weight * 1000) / 9.80665,
      arm_x: w2_x,
      moment: w2_weight * w2_x,
      description: `${B_heel.toFixed(2)}m × ${H_stem.toFixed(2)}m × ${(gamma_s * 101.97).toFixed(0)} kg/m³`,
      material: 'Suelo',
      gamma_kgm3: gamma_s * 101.97,
      area: B_heel * H_stem,
    });
  }

  // W4: Hormigón cartabón triangular del vástago, lado de la puntera
  // (0.5 * gamma_c * t_tri * H_stem), brazo = P + t_tri/3
  if (t_tri > 0.001) {
    const w3_weight = 0.5 * gamma_c * t_tri * H_stem;
    const w3_x = B_toe + (t_tri / 3.0);
    weights.push({
      id: 'W4',
      name: 'W4: Vástago (Cartabón triangular concreto)',
      weight: w3_weight,
      weight_kg: (w3_weight * 1000) / 9.80665,
      arm_x: w3_x,
      moment: w3_weight * w3_x,
      description: `0.5 × ${t_tri.toFixed(2)}m × ${H_stem.toFixed(2)}m × ${(gamma_c * 101.97).toFixed(0)} kg/m³`,
      material: 'Concreto',
      gamma_kgm3: gamma_c * 101.97,
      area: 0.5 * t_tri * H_stem,
    });
  }

  // W5: Hormigón vástago cuerpo rectangular, ancho = corona (t1), detrás
  // del cartabón: brazo = P + t_tri + t1/2
  const w4_weight = gamma_c * b_top * H_stem;
  const w4_x = B_toe + t_tri + (b_top / 2.0);
  weights.push({
    id: 'W5',
    name: 'W5: Vástago (Cuerpo rectangular)',
    weight: w4_weight,
    weight_kg: (w4_weight * 1000) / 9.80665,
    arm_x: w4_x,
    moment: w4_weight * w4_x,
    description: `${b_top.toFixed(2)}m × ${H_stem.toFixed(2)}m × ${(gamma_c * 101.97).toFixed(0)} kg/m³`,
    material: 'Concreto',
    gamma_kgm3: gamma_c * 101.97,
    area: b_top * H_stem,
  });

  // W6: Zapata losa de cimentación (gamma_c * B * hz)
  const w5_weight = gamma_c * B * hz;
  const w5_x = B / 2.0;
  weights.push({
    id: 'W6',
    name: 'W6: Zapata (Losa de cimentación)',
    weight: w5_weight,
    weight_kg: (w5_weight * 1000) / 9.80665,
    arm_x: w5_x,
    moment: w5_weight * w5_x,
    description: `${B.toFixed(2)}m × ${hz.toFixed(2)}m × ${(gamma_c * 101.97).toFixed(0)} kg/m³`,
    material: 'Concreto',
    gamma_kgm3: gamma_c * 101.97,
    area: B * hz,
  });

  // W7: Dentellón / Tacón si está activo
  if (geometry.has_key && geometry.key_depth > 0 && geometry.key_width > 0) {
    const w6_weight = gamma_c * geometry.key_width * geometry.key_depth;
    const w6_x = geometry.key_pos + (geometry.key_width / 2.0);
    weights.push({
      id: 'W7',
      name: 'W7: Dentellón / Tacón de Concreto',
      weight: w6_weight,
      weight_kg: (w6_weight * 1000) / 9.80665,
      arm_x: w6_x,
      moment: w6_weight * w6_x,
      description: `${geometry.key_width.toFixed(2)}m × ${geometry.key_depth.toFixed(2)}m × ${(gamma_c * 101.97).toFixed(0)} kg/m³`,
      material: 'Concreto',
      gamma_kgm3: gamma_c * 101.97,
      area: geometry.key_width * geometry.key_depth,
    });
  }

  // 2. Empujes laterales y fuerzas desestabilizadoras
  const lateralPressures = calculateLateralEarthPressures(wallData);

  // Sumatorias de fuerzas estabilizadoras
  let sum_W = 0;
  let sum_MR_weights = 0;
  weights.forEach(w => {
    sum_W += w.weight;
    sum_MR_weights += w.moment;
  });

  // Componente vertical de empuje
  const Fv_earth = lateralPressures.sum_Fv_from_earth || 0;
  const MR_earth_v = Fv_earth * B;

  const sum_N = sum_W + Fv_earth;
  const sum_MR = sum_MR_weights + MR_earth_v;
  const sum_Mo = lateralPressures.sum_Mo_toe;

  // 3. FACTOR DE SEGURIDAD AL VOLCAMIENTO (FSv)
  const fs_overturning = sum_Mo > 0.001 ? sum_MR / sum_Mo : 999.0;
  const fs_overturning_req = loads.is_seismic ? safety_req.fs_overturning_seismic : safety_req.fs_overturning;
  const pass_overturning = fs_overturning >= fs_overturning_req;

  // 4. FACTOR DE SEGURIDAD AL DESLIZAMIENTO (FSd)
  // Fr = N * tan(phi_base) + c' * B + F_pasivo
  const mu = foundation.mu || Math.tan(degToRad(foundation.phi));
  // Solo se confía en el 50% de la cohesión en la base (incertidumbre del
  // ensayo / posible pérdida de contacto), criterio de la metodología UNI.
  const adhesion = 0.5 * (foundation.c || 0) * B;
  const F_friction = sum_N * mu;
  const F_passive = lateralPressures.passive_force || 0;
  const sum_FR = F_friction + adhesion + F_passive;
  const sum_Fd = lateralPressures.sum_Fh;

  const fs_sliding = sum_Fd > 0.001 ? sum_FR / sum_Fd : 999.0;
  const fs_sliding_req = loads.is_seismic ? safety_req.fs_sliding_seismic : safety_req.fs_sliding;
  const pass_sliding = fs_sliding >= fs_sliding_req;

  // 5. EXCENTRICIDAD Y PRESIONES DE CONTACTO EN EL TERRENO (q)
  const M_net = sum_MR - sum_Mo;
  const x_resultant = sum_N > 0.001 ? M_net / sum_N : 0;
  const eccentricity = (B / 2.0) - x_resultant; // e = B/2 - Xr
  const e_max_allowed = B / 6.0; // Límite del tercio central (B/6)

  let q_toe = 0;
  let q_heel = 0;
  let is_middle_third = Math.abs(eccentricity) <= e_max_allowed;
  let effective_width = B;

  if (is_middle_third) {
    // Distribución trapezoidal / triangular continua (todo en compresión)
    q_toe = (sum_N / B) * (1.0 + (6.0 * eccentricity) / B);
    q_heel = (sum_N / B) * (1.0 - (6.0 * eccentricity) / B);
  } else {
    // Despegue (triangular equivalente en 3 * Xr)
    effective_width = Math.max(0.1, 3.0 * x_resultant);
    q_toe = (2.0 * sum_N) / effective_width;
    q_heel = 0.0;
  }

  // Presión admisible: el valor ingresado en "Capacidad de carga" ya se
  // toma como la presión ADMISIBLE del estudio de suelos (σt), sin aplicar
  // una reducción adicional por factor de seguridad — a diferencia de un
  // enfoque que trata ese dato como capacidad ÚLTIMA y lo divide entre un
  // FS (2.5 o 3.0). Se asume que el FS ya está incorporado en el valor que
  // entrega el estudio de suelos, igual que en la memoria de referencia.
  const q_ult = foundation.q_ult || 353.04; // kPa (fallback: 3.6 kg/cm²)
  const q_adm = q_ult;
  const pass_bearing = q_toe <= q_adm;
  const pass_eccentricity = Math.abs(eccentricity) <= e_max_allowed;

  return {
    B,
    B_toe,
    B_heel,
    H,
    H_stem,
    hz,
    b_top,
    b_bot,
    t_tri,
    
    weights,
    sum_W,
    lateralPressures,
    
    sum_N,
    sum_MR,
    sum_Mo,
    sum_FR,
    sum_Fd,
    F_friction,
    adhesion,
    F_passive,
    
    fs_overturning,
    fs_overturning_req,
    pass_overturning,
    
    fs_sliding,
    fs_sliding_req,
    pass_sliding,
    
    M_net,
    x_resultant,
    eccentricity,
    e_max_allowed,
    is_middle_third,
    effective_width,
    q_toe,
    q_heel,
    q_adm,
    // Valores en kg/cm²
    q_toe_kgcm2: q_toe / 98.0665,
    q_heel_kgcm2: q_heel / 98.0665,
    q_adm_kgcm2: q_adm / 98.0665,
    pass_bearing,
    pass_eccentricity,
    
    pass_all: pass_overturning && pass_sliding && pass_bearing && pass_eccentricity
  };
}

/**
 * Evalúa la estabilidad en los DOS casos de carga independientes de la
 * metodología UNI (no se combinan simultáneamente):
 *   Caso A: Empuje de tierra + Sobrecarga vehicular, SIN sismo.
 *   Caso B: Empuje de tierra + Sismo (Mononobe-Okabe), SIN sobrecarga vehicular.
 * Cada verificación (FSv, FSd, excentricidad, presión) reporta el caso más
 * crítico ("gobernante") para esa verificación específica, ya que cada
 * caso tiene su propia presión admisible y su propia demanda lateral.
 */
export function calculateDualCaseStability(wallData) {
  const wallDataA = JSON.parse(JSON.stringify(wallData));
  wallDataA.loads.is_seismic = false;
  const caseA = calculateGeotechnicalStability(wallDataA);
  caseA.case_id = 'A';
  caseA.case_label = 'Empuje de Tierra + Sobrecarga Vehicular (Sin Sismo)';

  if (!wallData.loads.is_seismic) {
    // No se ha seleccionado zona sísmica: un solo caso válido (Caso A)
    return { caseA, caseB: null, governing: caseA, dual: false };
  }

  const wallDataB = JSON.parse(JSON.stringify(wallData));
  wallDataB.loads.is_seismic = true;
  wallDataB.loads.q_surcharge = 0;
  const caseB = calculateGeotechnicalStability(wallDataB);
  caseB.case_id = 'B';
  caseB.case_label = 'Empuje de Tierra + Sismo (Sin Sobrecarga Vehicular)';

  const govFsOverturning = caseA.fs_overturning <= caseB.fs_overturning ? caseA : caseB;
  const govFsSliding = caseA.fs_sliding <= caseB.fs_sliding ? caseA : caseB;
  // Excentricidad y presiones de contacto son cantidades acopladas (derivan
  // de la misma posición de la resultante Xr), así que se toman del MISMO
  // caso gobernante: el de mayor utilización de la capacidad portante.
  const utilA = caseA.q_toe / caseA.q_adm;
  const utilB = caseB.q_toe / caseB.q_adm;
  const govBearing = utilA >= utilB ? caseA : caseB;
  const govEccentricity = govBearing;

  const governing = {
    ...caseA,
    sum_MR: govFsOverturning.sum_MR,
    sum_Mo: govFsOverturning.sum_Mo,
    fs_overturning: govFsOverturning.fs_overturning,
    fs_overturning_req: govFsOverturning.fs_overturning_req,
    pass_overturning: govFsOverturning.pass_overturning,
    fs_overturning_case: govFsOverturning.case_id,

    sum_FR: govFsSliding.sum_FR,
    sum_Fd: govFsSliding.sum_Fd,
    fs_sliding: govFsSliding.fs_sliding,
    fs_sliding_req: govFsSliding.fs_sliding_req,
    pass_sliding: govFsSliding.pass_sliding,
    fs_sliding_case: govFsSliding.case_id,

    sum_N: govBearing.sum_N,
    M_net: govBearing.M_net,
    x_resultant: govEccentricity.x_resultant,
    eccentricity: govEccentricity.eccentricity,
    e_max_allowed: govEccentricity.e_max_allowed,
    pass_eccentricity: govEccentricity.pass_eccentricity,
    eccentricity_case: govEccentricity.case_id,
    is_middle_third: govBearing.is_middle_third,
    effective_width: govBearing.effective_width,

    q_toe: govBearing.q_toe,
    q_heel: govBearing.q_heel,
    q_adm: govBearing.q_adm,
    q_toe_kgcm2: govBearing.q_toe_kgcm2,
    q_heel_kgcm2: govBearing.q_heel_kgcm2,
    q_adm_kgcm2: govBearing.q_adm_kgcm2,
    pass_bearing: govBearing.pass_bearing,
    bearing_case: govBearing.case_id
  };
  governing.pass_all = governing.pass_overturning && governing.pass_sliding &&
    governing.pass_bearing && governing.pass_eccentricity;

  return { caseA, caseB, governing, dual: true };
}
