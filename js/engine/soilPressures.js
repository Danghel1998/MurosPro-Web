/**
 * Motor de cálculo de empujes de tierras, sobrecarga, agua y sismo
 */

export function degToRad(deg) {
  return (deg * Math.PI) / 180.0;
}

export function radToDeg(rad) {
  return (rad * 180.0) / Math.PI;
}

/**
 * Coeficiente de empuje activo Ka según Rankine
 */
export function calcRankineKa(phiDeg, betaDeg = 0) {
  const phi = degToRad(phiDeg);
  const beta = degToRad(betaDeg);

  if (betaDeg <= 0.001) {
    // Caso horizontal
    return Math.pow(Math.tan(Math.PI / 4.0 - phi / 2.0), 2);
  }

  // Caso con talud inclinado beta <= phi
  if (beta > phi) {
    // Si el talud supera el ángulo de fricción, se limita
    return Math.cos(phi) * 1.5;
  }

  const cosB = Math.cos(beta);
  const cos2B = Math.cos(beta) * Math.cos(beta);
  const cos2Phi = Math.cos(phi) * Math.cos(phi);
  const rad = Math.sqrt(Math.max(0, cos2B - cos2Phi));

  const num = cosB - rad;
  const den = cosB + rad;
  return cosB * (num / den);
}

/**
 * Coeficiente de empuje pasivo Kp según Rankine
 */
export function calcRankineKp(phiDeg) {
  const phi = degToRad(phiDeg);
  return Math.pow(Math.tan(Math.PI / 4.0 + phi / 2.0), 2);
}

/**
 * Coeficiente sísmico de empuje activo Kae según Mononobe-Okabe
 */
export function calcMononobeOkabeKae(phiDeg, betaDeg = 0, deltaDeg = 0, kh = 0.15, kv = 0) {
  const phi = degToRad(phiDeg);
  const beta = degToRad(betaDeg);
  const delta = degToRad(deltaDeg);
  
  // Ángulo de inercia sísmica
  const psi = Math.atan(kh / (1.0 - kv));
  
  if (phi - psi - beta < 0) {
    // Condición límite donde no hay solución real (aceleración excesiva)
    return calcRankineKa(phiDeg, betaDeg) * (1 + 1.5 * kh);
  }

  const num = Math.pow(Math.cos(phi - psi), 2);
  const termSqrt = Math.sqrt(
    Math.max(0, (Math.sin(phi + delta) * Math.sin(phi - beta - psi)) /
                (Math.cos(delta + psi) * Math.cos(beta)))
  );
  const den = Math.cos(psi) * Math.cos(delta + psi) * Math.pow(1.0 + termSqrt, 2);

  if (den <= 0.0001) return calcRankineKa(phiDeg, betaDeg) * 1.5;

  return num / den;
}

/**
 * Calcula todas las presiones laterales, fuerzas resultantes y puntos de aplicación
 * respecto al fondo de la zapata (y = 0)
 */
export function calculateLateralEarthPressures(wallData) {
  const { geometry, backfill, loads } = wallData;
  const H = geometry.H; // Altura total
  const beta = backfill.beta || 0;
  const gammaWater = 9.81; // kN/m³

  // 1. Coeficientes
  const Ka_static = calcRankineKa(backfill.phi, beta);
  let Ka = Ka_static;
  let Kae = Ka_static;
  let DeltaKae = 0;

  if (loads.is_seismic && loads.kh > 0) {
    Kae = calcMononobeOkabeKae(backfill.phi, beta, backfill.delta || (backfill.phi / 2), loads.kh, loads.kv || 0);
    DeltaKae = Math.max(0, Kae - Ka_static);
  }

  const Kp = calcRankineKp(wallData.foundation.phi);

  // Niveles
  const hasWater = loads.has_water_table && loads.hw > 0;
  const hw = hasWater ? Math.min(loads.hw, H) : 0; // Altura freática desde fondo de zapata
  const h1 = H - hw; // Altura de suelo seco/no saturado superior

  // Fuerzas resultantes (kN/m) y Brazos de palanca desde base (m)
  const forces = [];

  // --- A. Empuje por Sobrecarga (q) ---
  const q = loads.q_surcharge || 0;
  let Fq = 0;
  let y_Fq = H / 2.0;
  if (q > 0) {
    Fq = Ka * q * H;
    y_Fq = H / 2.0;
    forces.push({
      id: 'F_q',
      name: 'Empuje por Sobrecarga (q)',
      force_total: Fq,
      force_h: Fq * Math.cos(degToRad(beta)),
      force_v: Fq * Math.sin(degToRad(beta)),
      arm_y: y_Fq,
      arm_x_toe: geometry.B, // Actúa en el plano virtual posterior
      description: `q = ${(q * 101.9716).toFixed(0)} kg/m², p_q = ${(Ka * q * 101.9716).toFixed(0)} kg/m²`
    });
  }

  // --- B. Empuje de Suelo Estático ---
  if (!hasWater) {
    // Caso totalmente seco / húmedo
    const p_bot = Ka * backfill.gamma * H;
    const F_soil = 0.5 * p_bot * H;
    const y_soil = H / 3.0;

    forces.push({
      id: 'F_soil',
      name: 'Empuje Activo del Suelo (Triangular)',
      force_total: F_soil,
      force_h: F_soil * Math.cos(degToRad(beta)),
      force_v: F_soil * Math.sin(degToRad(beta)),
      arm_y: y_soil,
      arm_x_toe: geometry.B,
      description: `p_base = ${(p_bot * 101.9716).toFixed(0)} kg/m²`
    });
  } else {
    // Caso con nivel freático a altura hw desde la base
    // Estrato 1: De z = 0 hasta z = h1 (Suelo no saturado)
    const p1_bot = Ka * backfill.gamma * h1;
    const F_soil1 = 0.5 * p1_bot * h1;
    const y_soil1 = hw + h1 / 3.0;

    forces.push({
      id: 'F_soil1',
      name: 'Empuje Suelo Superior (Seco)',
      force_total: F_soil1,
      force_h: F_soil1 * Math.cos(degToRad(beta)),
      force_v: F_soil1 * Math.sin(degToRad(beta)),
      arm_y: y_soil1,
      arm_x_toe: geometry.B,
      description: `Estrato superior h1 = ${h1.toFixed(2)} m`
    });

    // Estrato 2: Rectángulo por presión del estrato 1 sobre estrato sumergido
    const F_soil2_rect = p1_bot * hw;
    const y_soil2_rect = hw / 2.0;

    forces.push({
      id: 'F_soil2_rect',
      name: 'Empuje Suelo Sumergido (Efecto Sobrecarga Estrato 1)',
      force_total: F_soil2_rect,
      force_h: F_soil2_rect * Math.cos(degToRad(beta)),
      force_v: F_soil2_rect * Math.sin(degToRad(beta)),
      arm_y: y_soil2_rect,
      arm_x_toe: geometry.B,
      description: `p = ${(p1_bot * 101.9716).toFixed(0)} kg/m² en altura hw = ${hw.toFixed(2)} m`
    });

    // Estrato 2: Triángulo por peso sumergido (gamma' = gamma_sat - gamma_w)
    const gamma_prime = Math.max(0, (backfill.gamma_sat || 20.0) - gammaWater);
    const p2_tri = Ka * gamma_prime * hw;
    const F_soil2_tri = 0.5 * p2_tri * hw;
    const y_soil2_tri = hw / 3.0;

    forces.push({
      id: 'F_soil2_tri',
      name: 'Empuje Suelo Sumergido (Triangular γ\')',
      force_total: F_soil2_tri,
      force_h: F_soil2_tri * Math.cos(degToRad(beta)),
      force_v: F_soil2_tri * Math.sin(degToRad(beta)),
      arm_y: y_soil2_tri,
      arm_x_toe: geometry.B,
      description: `γ' = ${(gamma_prime * 101.9716).toFixed(0)} kg/m³, p_sub = ${(p2_tri * 101.9716).toFixed(0)} kg/m²`
    });

    // Presión hidrostática pura del agua
    const p_water = gammaWater * hw;
    const F_water = 0.5 * p_water * hw;
    const y_water = hw / 3.0;

    forces.push({
      id: 'F_water',
      name: 'Empuje Hidrostático del Agua',
      force_total: F_water,
      force_h: F_water, // El agua actúa normal a la superficie vertical
      force_v: 0,
      arm_y: y_water,
      arm_x_toe: geometry.B,
      description: `u = ${(p_water * 101.9716).toFixed(0)} kg/m² en base`
    });
  }

  // --- C. Incremento Dinámico Sísmico (ΔPae) ---
  if (loads.is_seismic && DeltaKae > 0) {
    const gamma_avg = backfill.gamma;
    const kv = loads.kv || 0;
    const F_seismic = 0.5 * DeltaKae * gamma_avg * Math.pow(H, 2) * (1 - kv);
    const y_seismic = 0.6 * H; // Actúa a 0.6H según Seed & Whitman / Mononobe-Okabe

    forces.push({
      id: 'F_seismic',
      name: 'Empuje Sísmico Dinámico (ΔPae Mononobe-Okabe)',
      force_total: F_seismic,
      force_h: F_seismic * Math.cos(degToRad(beta)),
      force_v: F_seismic * Math.sin(degToRad(beta)),
      arm_y: y_seismic,
      arm_x_toe: geometry.B,
      description: `ΔKae = ${DeltaKae.toFixed(4)}, aplicación a 0.60 H`
    });
  }

  // Sumatorias laterales totales
  let sum_Fh = 0;
  let sum_Fv_from_earth = 0;
  let sum_Mo_toe = 0; // Momento de volteo respecto a la puntera (pie del muro)

  forces.forEach(f => {
    sum_Fh += f.force_h;
    sum_Fv_from_earth += f.force_v;
    // El empuje horizontal genera momento de vuelco horario
    sum_Mo_toe += f.force_h * f.arm_y;
    // Si beta > 0, la componente vertical del empuje ayuda a estabilizar
  });

  // --- D. Empuje Pasivo Frontal (si se considera) ---
  let Fp = 0;
  let passive_detail = null;
  const Df = geometry.Df || geometry.hz;
  const gamma_f = wallData.foundation.gamma;
  if (loads.consider_passive && Df > 0) {
    if (geometry.has_key && geometry.key_depth > 0) {
      // Dentellón: el empuje pasivo se desarrolla en la altura del propio
      // dentellón (Hd), en un plano trapezoidal entre la profundidad de
      // desplante Df (arriba, σps) y Df+Hd (abajo, σpi) — NO desde la
      // superficie del terreno. Al ser un elemento estructural diseñado a
      // propósito (no el suelo incidental frente al muro), se confía en el
      // 100% del empuje pasivo calculado (criterio de la metodología UNI).
      const Hd = geometry.key_depth;
      const sigma_ps = gamma_f * Df * Kp;
      const sigma_pi = gamma_f * (Df + Hd) * Kp;
      Fp = Hd * (sigma_ps + sigma_pi) / 2.0;
      passive_detail = { mode: 'dentellon', Hd, sigma_ps, sigma_pi, factor: 1.0 };
    } else {
      // Sin dentellón: empuje pasivo incidental del suelo natural frente al
      // muro (triangular, desde la superficie hasta Df). Al no ser
      // confiable a largo plazo (riesgo de erosión o remoción de ese
      // suelo), se confía solo en una fracción (E.050).
      const redFactor = loads.passive_factor !== undefined ? loads.passive_factor : 0.5;
      const p_pass = Kp * gamma_f * Df;
      Fp = 0.5 * p_pass * Df * redFactor;
      passive_detail = { mode: 'incidental', Df, p_pass, factor: redFactor };
    }
  }

  return {
    Ka,
    Kp,
    Kae,
    DeltaKae,
    forces,
    sum_Fh,
    sum_Fv_from_earth,
    sum_Mo_toe,
    passive_force: Fp,
    passive_detail
  };
}
