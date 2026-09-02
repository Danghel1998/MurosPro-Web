/**
 * Motor de diseño estructural de concreto armado (Norma E.060 / ACI 318)
 * Calibrado con el despiece y distribución por capas de la hoja Excel UNI
 * y con la metodología de la Memoria de Cálculo de referencia (dentellón,
 * acero horizontal en dos tramos/dos caras, longitud crítica de corte del
 * acero vertical, y cortante de diseño a distancia "d" de la base).
 */

import { REBAR_TABLE } from '../constants.js';
import { calcRankineKa } from './soilPressures.js';

export function calculateStructuralDesign(wallData, geoResults) {
  const { geometry, backfill, loads, materials, safety_req } = wallData;

  const fc = materials.fc; // MPa (21 MPa = 210 kg/cm²)
  const fy = materials.fy; // MPa (420 MPa = 4200 kg/cm²)
  const fc_kgcm2 = materials.fc_kgcm2 || (fc / 0.0980665);
  const fy_kgcm2 = materials.fy_kgcm2 || (fy / 0.0980665);
  const gamma_c = materials.gamma_c || 23.54;
  const gamma_s = backfill.gamma;
  const q_surcharge = loads.q_surcharge || 0;
  const beta = backfill.beta || 0;

  const H_stem = geometry.H - geometry.hz; // Hp
  const hz = geometry.hz;
  const B_toe = geometry.B_toe;
  const b_bot = geometry.b_bot;
  const b_top = geometry.b_top;
  const t_tri = Math.max(0, b_bot - b_top);
  const B_heel = Math.max(0, geometry.B - B_toe - b_bot);

  const cover_stem = materials.cover_stem || 0.04; // 4 cm
  const cover_footing = materials.cover_footing || 0.075; // 7.5 cm

  // Barras comerciales seleccionadas
  const rebarStem = REBAR_TABLE[materials.rebar_stem_id] || REBAR_TABLE[1];
  const rebarToe = REBAR_TABLE[materials.rebar_toe_id] || REBAR_TABLE[1];
  const rebarHeel = REBAR_TABLE[materials.rebar_heel_id] || REBAR_TABLE[2];
  const rebarTemp = REBAR_TABLE[materials.rebar_temp_id] || REBAR_TABLE[0];

  // Factores de mayoración: U = 1.2D + 1.7L + 1.7H (convención de la
  // memoria de referencia UNI para el empuje de tierras y la sobrecarga).
  const LF_H = 1.70;
  const LF_L = 1.70;
  const LF_D = 1.20;
  const phi_flex = 0.90;
  const phi_shear = 0.85; // 0.85 en E.060 (o 0.75 en ACI 318 moderno)
  // E.060 ítem 14.3.1 / ACI 318: cuantía horizontal mínima. 0.0020 para
  // varillas deformadas Ø ≤ 5/8" con fy ≥ 4200 kg/cm²; 0.0025 para
  // varillas mayores a 5/8" (o malla electrosoldada), que exigen más área
  // por su menor adherencia relativa. Depende de la varilla horizontal
  // escogida (rebarTemp).
  const RHO_H_MIN = rebarTemp.diameter_mm <= 15.9 ? 0.0020 : 0.0025;

  // =========================================================================
  // 1. DISEÑO DE LA PANTALLA / VÁSTAGO (STEM)
  // =========================================================================
  const Ka = calcRankineKa(backfill.phi, beta);
  const hs = gamma_s > 0 ? q_surcharge / gamma_s : 0; // altura equivalente de sobrecarga

  // A. Empuje de sobrecarga sobre la pantalla (altura completa H_stem)
  const F1_stem = Ka * q_surcharge * H_stem;
  const y1_stem = H_stem / 2.0;

  // B. Empuje de suelo sobre la pantalla (altura completa H_stem)
  const F2_stem = 0.5 * Ka * gamma_s * Math.pow(H_stem, 2);
  const y2_stem = H_stem / 3.0;

  // Momento último en la base de la pantalla
  const Mu_stem = (LF_L * F1_stem * y1_stem) + (LF_H * F2_stem * y2_stem);

  // Peralte efectivo d en la base de la pantalla (antes del cortante: el
  // cortante de diseño se evalúa a una distancia "d" de la base)
  const d_stem = Math.max(0.1, b_bot - cover_stem - (rebarStem.diameter_m / 2.0)); // metros

  const b_unit = 1.0; // 1 metro de ancho

  // C. Cortante último Vu evaluado a distancia "d" de la base (E.060/ACI
  // 318): solo el empuje que actúa sobre la altura reducida (H_stem - d)
  // genera cortante en esa sección crítica, no el empuje de toda la altura.
  const H_shear = Math.max(0, H_stem - d_stem);
  const F1_shear = Ka * q_surcharge * H_shear;
  const F2_shear = 0.5 * Ka * gamma_s * Math.pow(H_shear, 2);
  const Vu_stem = (LF_L * F1_shear) + (LF_H * F2_shear);

  // Capacidad resistente a cortante del concreto: Vc = 0.53·√f'c·b·d, con
  // f'c en kg/cm² y b, d en cm (fórmula de la memoria de referencia),
  // convertida a kN para compararla con Vu (mismo sistema que el resto
  // del módulo).
  const Vc_stem_kg = 0.53 * Math.sqrt(fc_kgcm2) * (b_unit * 100.0) * (d_stem * 100.0);
  const Vc_stem = (Vc_stem_kg * 9.80665) / 1000.0;
  const phiVc_stem = phi_shear * Vc_stem;
  const pass_stem_shear = Vu_stem <= phiVc_stem;

  // Acero vertical principal en la cara interior (tracción)
  const stemFlex = calcRequiredRebar(Mu_stem, fc, fy, b_unit, d_stem, phi_flex);
  const spacing_stem = calcSpacing(stemFlex.As_design, rebarStem.area_cm2);

  // Verificación del peralte (formato de la memoria de referencia, en
  // kg/cm²): con la cuantía final ω = ρ·fy/f'c, se recalcula el peralte
  // mínimo "d" que exige Mu, y se compara contra el peralte disponible
  // (dreal) según el t2 realmente escogido — y el t2 mínimo que resultaría
  // de ese "d" (t2 = d + recubrimiento + Ø/2).
  const Mu_kgcm = (Mu_stem * 1000.0 / 9.80665) * 100.0; // kg·m -> kg·cm
  const omega_stem = (stemFlex.rho_design * fy_kgcm2) / fc_kgcm2;
  const b_cm = 100.0;
  const d_check_cm = Math.sqrt(Mu_kgcm / (phi_flex * b_cm * fc_kgcm2 * omega_stem * (1 - 0.59 * omega_stem)));
  const dreal_cm = d_stem * 100.0;
  const cover_stem_cm = cover_stem * 100.0;
  const t2_calc_cm = d_check_cm + cover_stem_cm + (rebarStem.diameter_mm / 10.0 / 2.0);
  const t2_usar_cm = Math.ceil((b_bot * 100.0) / 5.0) * 5.0; // redondeado a 5 cm

  // Longitud crítica (Lc): altura medida desde la base donde el momento
  // actuante cae a la mitad del momento en la base (punto a partir del cual
  // basta con la mitad del acero vertical), más una extensión igual al
  // peralte efectivo "d" (ACI 318 12.10.3), redondeada hacia arriba.
  const x_cut = solveCutoffHeight(Mu_stem / 2.0, Ka, gamma_s, q_surcharge, H_stem, LF_H, LF_L);
  const hc_stem = Math.max(0, H_stem - x_cut);
  const Lc_stem = hc_stem + d_stem;
  const Lc_stem_usar = Math.ceil(Lc_stem * 10.0) / 10.0; // redondeado a 10 cm

  // Acero vertical en la cara exterior (compresión / montaje, mínimo)
  const As_stem_vert_ext = 0.0015 * 10000.0 * b_bot; // 0.0015 b t
  const spacing_vert_ext = calcSpacing(As_stem_vert_ext, rebarTemp.area_cm2);

  // Acero horizontal (Ash): dos tramos en altura — de la base hasta la
  // mitad (d = t2, espesor en la base) y de la mitad hasta la corona
  // (d = promedio t1,t2) — y dos caras en cada tramo (cara exterior =
  // 2/3 Ast, cara interior = 1/3 Ast), según E.060 ítem 9.7 / 14.3.1.
  const d_h_inferior = b_bot;
  const d_h_superior = (b_top + b_bot) / 2.0;

  const Ast_inferior = RHO_H_MIN * 10000.0 * d_h_inferior;
  const Ash_ce_inferior = (2.0 / 3.0) * Ast_inferior;
  const Ash_ci_inferior = (1.0 / 3.0) * Ast_inferior;

  const Ast_superior = RHO_H_MIN * 10000.0 * d_h_superior;
  const Ash_ce_superior = (2.0 / 3.0) * Ast_superior;
  const Ash_ci_superior = (1.0 / 3.0) * Ast_superior;

  const sp_ce_inferior = calcSpacing(Ash_ce_inferior, rebarTemp.area_cm2);
  const sp_ci_inferior = calcSpacing(Ash_ci_inferior, rebarTemp.area_cm2);
  const sp_ce_superior = calcSpacing(Ash_ce_superior, rebarTemp.area_cm2);
  const sp_ci_superior = calcSpacing(Ash_ci_superior, rebarTemp.area_cm2);

  // =========================================================================
  // 2. DISEÑO DE LA PUNTERA (TOE / ZAPATA ANTERIOR)
  // =========================================================================
  const d_toe = Math.max(0.1, hz - cover_footing - (rebarToe.diameter_m / 2.0));

  // Desglose F1 (reacción rectangular a q en la cara del vástago), F2
  // (reacción triangular excedente hacia la punta, hasta q_max) y F3 (peso
  // propio de la losa de zapata bajo la punta, descendente) — igual que la
  // memoria de referencia ("En la Punta"). Momento = −(Fuerza × Brazo).
  const q_stem_front = geoResults.q_toe - (geoResults.q_toe - geoResults.q_heel) * (B_toe / geometry.B); // q3
  const F1_toe = q_stem_front * B_toe;
  const y1_toe = B_toe / 2.0;
  const F2_toe = 0.5 * (geoResults.q_toe - q_stem_front) * B_toe;
  const y2_toe = (2.0 / 3.0) * B_toe;
  const F3_toe = -(hz * gamma_c * B_toe);
  const y3_toe = B_toe / 2.0;

  const Vd_toe = F1_toe + F2_toe + F3_toe;
  const Mmax_toe = -((F1_toe * y1_toe) + (F2_toe * y2_toe) + (F3_toe * y3_toe));

  const Vu_toe = Math.max(0.1, LF_H * Math.abs(Vd_toe));
  const Mu_toe = Math.max(0.1, LF_H * Math.abs(Mmax_toe));

  const Vc_toe_kg = 0.53 * Math.sqrt(fc_kgcm2) * (b_unit * 100.0) * (d_toe * 100.0);
  const Vc_toe = (Vc_toe_kg * 9.80665) / 1000.0;
  const phiVc_toe = phi_shear * Vc_toe;
  const pass_toe_shear = Vu_toe <= phiVc_toe;

  const toeFlex = calcRequiredRebar(Mu_toe, fc, fy, b_unit, d_toe, phi_flex);
  const spacing_toe = calcSpacing(toeFlex.As_design, rebarToe.area_cm2);

  // =========================================================================
  // 3. DISEÑO DEL TALÓN (HEEL / ZAPATA POSTERIOR)
  // =========================================================================
  const d_heel = Math.max(0.1, hz - cover_footing - (rebarHeel.diameter_m / 2.0));

  // Desglose F1 (peso propio del suelo de relleno + sobrecarga sobre el
  // talón, descendente), F2 (reacción ascendente rectangular a q_min) y F3
  // (reacción ascendente triangular excedente hacia la cara del vástago,
  // hasta q2) — igual que la memoria de referencia ("En el Talón").
  // Momento = +(Fuerza × Brazo) para los tres términos.
  const wTalonSoil = geoResults.weights.find(w => w.id === 'W3'); // suelo relleno sobre talón
  const wTalonSC = geoResults.weights.find(w => w.id === 'W2'); // sobrecarga talón + corona
  const F1_heel = -((wTalonSoil ? wTalonSoil.weight : 0) + (wTalonSC ? wTalonSC.weight : 0));
  const y1_heel = B_heel / 2.0;

  const q_at_heel_inner = geoResults.q_heel + (geoResults.q_toe - geoResults.q_heel) * (B_heel / geometry.B); // q2
  const F2_heel = geoResults.q_heel * B_heel;
  const y2_heel = B_heel / 2.0;
  const F3_heel = 0.5 * (q_at_heel_inner - geoResults.q_heel) * B_heel;
  const y3_heel = B_heel / 3.0;

  const Vd_heel = F1_heel + F2_heel + F3_heel;
  const Mmax_heel = (F1_heel * y1_heel) + (F2_heel * y2_heel) + (F3_heel * y3_heel);

  const Vu_heel = Math.max(0.1, LF_H * Math.abs(Vd_heel));
  const Mu_heel = Math.max(0.1, LF_H * Math.abs(Mmax_heel));

  const Vc_heel_kg = 0.53 * Math.sqrt(fc_kgcm2) * (b_unit * 100.0) * (d_heel * 100.0);
  const Vc_heel = (Vc_heel_kg * 9.80665) / 1000.0;
  const phiVc_heel = phi_shear * Vc_heel;
  const pass_heel_shear = Vu_heel <= phiVc_heel;

  const heelFlex = calcRequiredRebar(Mu_heel, fc, fy, b_unit, d_heel, phi_flex);
  const spacing_heel = calcSpacing(heelFlex.As_design, rebarHeel.area_cm2);

  // Acero transversal de reparto en puntera y talón (compartido, incluye
  // el dentellón si está presente — misma varilla continúa hacia el tacón)
  const As_trans_footing = 0.0018 * 10000.0 * hz;
  const spacing_trans_footing = calcSpacing(As_trans_footing, rebarTemp.area_cm2);

  // Longitud de desarrollo básica ld (cm)
  const ld_stem_cm = Math.max(30.0, ((fy / (2.1 * Math.sqrt(fc))) * (rebarStem.diameter_mm / 10.0) * 1.3));

  return {
    stem: {
      Vu: Vu_stem,
      Mu: Mu_stem,
      Mu_kgm: (Mu_stem * 1000.0) / 9.80665,
      Vu_kg: (Vu_stem * 1000.0) / 9.80665,
      d: d_stem,
      b: b_bot,
      Vc: Vc_stem,
      Vc_kg: (Vc_stem * 1000.0) / 9.80665,
      phiVc: phiVc_stem,
      phiVc_kg: (phiVc_stem * 1000.0) / 9.80665,
      pass_shear: pass_stem_shear,
      Ka, gamma_s, hp: H_stem, hs,
      gamma_s_kgm3: gamma_s * 101.9716,
      breakdown: [
        { label: 'F1', force_kg: F1_stem * 1000 / 9.80665, arm: y1_stem, moment_kgm: F1_stem * y1_stem * 1000 / 9.80665 },
        { label: 'F2', force_kg: F2_stem * 1000 / 9.80665, arm: y2_stem, moment_kgm: F2_stem * y2_stem * 1000 / 9.80665 }
      ],
      Vd_kg: (F1_stem + F2_stem) * 1000 / 9.80665,
      Mmax_kgm: ((F1_stem * y1_stem) + (F2_stem * y2_stem)) * 1000 / 9.80665,
      Mu_Tnm: Mu_stem * (1000.0 / 9.80665) / 1000.0,
      Mu_kgcm,
      omega: omega_stem,
      d_check_cm,
      dreal_cm,
      t2_calc_cm,
      t2_usar_cm,
      cover_stem_cm,
      ...stemFlex,
      rebar: rebarStem,
      spacing: spacing_stem,
      rebar_callout: `${rebarStem.name} @ ${spacing_stem} cm (As = ${(rebarStem.area_cm2 * 100 / spacing_stem).toFixed(2)} cm²/m)`,
      Lc: Lc_stem,
      Lc_usar: Lc_stem_usar,
      hc: hc_stem,
      rebar_intercalado: `Cortar a Lc = ${Lc_stem_usar.toFixed(2)} m desde la base (queda solo cara exterior + mínimo)`,
      rebar_vert_ext: `${rebarTemp.name} @ ${spacing_vert_ext} cm (Cara exterior)`,
      fc_kgcm2, fy_kgcm2,
      x_cut, hp_menos_hc: H_stem - hc_stem,
      As_vert_ext: As_stem_vert_ext,
      spacing_vert_ext,
      rebarTemp,
      d_h_inferior, d_h_superior,
      rho_h_min: RHO_H_MIN,
      Ast_inferior, Ash_ce_inferior, Ash_ci_inferior, sp_ce_inferior, sp_ci_inferior,
      Ast_superior, Ash_ce_superior, Ash_ci_superior, sp_ce_superior, sp_ci_superior,
      horizontal_summary: {
        inferior_ce: `${rebarTemp.name} @ ${sp_ce_inferior} cm (cara exterior)`,
        inferior_ci: `${rebarTemp.name} @ ${sp_ci_inferior} cm (cara interior)`,
        superior_ce: `${rebarTemp.name} @ ${sp_ce_superior} cm (cara exterior)`,
        superior_ci: `${rebarTemp.name} @ ${sp_ci_superior} cm (cara interior)`
      },
      ld_cm: Math.round(ld_stem_cm)
    },
    toe: {
      Vu: Vu_toe,
      Mu: Mu_toe,
      Mu_kgm: (Mu_toe * 1000.0) / 9.80665,
      d: d_toe,
      hz: hz,
      Vc: Vc_toe,
      phiVc: phiVc_toe,
      pass_shear: pass_toe_shear,
      breakdown: [
        { label: 'F1', force_kg: F1_toe * 1000 / 9.80665, arm: y1_toe, moment_kgm: -(F1_toe * y1_toe) * 1000 / 9.80665 },
        { label: 'F2', force_kg: F2_toe * 1000 / 9.80665, arm: y2_toe, moment_kgm: -(F2_toe * y2_toe) * 1000 / 9.80665 },
        { label: 'F3', force_kg: F3_toe * 1000 / 9.80665, arm: y3_toe, moment_kgm: -(F3_toe * y3_toe) * 1000 / 9.80665 }
      ],
      Vd_kg: Vd_toe * 1000 / 9.80665,
      Mmax_kgm: Mmax_toe * 1000 / 9.80665,
      q3_kgm2: q_stem_front * 101.9716,
      qmax_kgm2: geoResults.q_toe * 101.9716,
      ...toeFlex,
      Mu_kgcm: (Mu_toe * 1000.0 / 9.80665) * 100.0,
      fc_kgcm2, fy_kgcm2,
      rebar: rebarToe,
      spacing: spacing_toe,
      rebarTemp,
      As_trans: As_trans_footing,
      spacing_trans: spacing_trans_footing,
      rebar_callout: `${rebarToe.name} @ ${spacing_toe} cm inferior (As = ${(rebarToe.area_cm2 * 100 / spacing_toe).toFixed(2)} cm²/m)`,
      rebar_trans: `${rebarTemp.name} @ ${spacing_trans_footing} cm transversal (compartido con talón${geometry.has_key ? ' y dentellón' : ''})`
    },
    heel: {
      Vu: Vu_heel,
      Mu: Mu_heel,
      Mu_kgm: (Mu_heel * 1000.0) / 9.80665,
      d: d_heel,
      hz: hz,
      Vc: Vc_heel,
      phiVc: phiVc_heel,
      pass_shear: pass_heel_shear,
      breakdown: [
        { label: 'F1', force_kg: F1_heel * 1000 / 9.80665, arm: y1_heel, moment_kgm: (F1_heel * y1_heel) * 1000 / 9.80665 },
        { label: 'F2', force_kg: F2_heel * 1000 / 9.80665, arm: y2_heel, moment_kgm: (F2_heel * y2_heel) * 1000 / 9.80665 },
        { label: 'F3', force_kg: F3_heel * 1000 / 9.80665, arm: y3_heel, moment_kgm: (F3_heel * y3_heel) * 1000 / 9.80665 }
      ],
      Vd_kg: Vd_heel * 1000 / 9.80665,
      Mmax_kgm: Mmax_heel * 1000 / 9.80665,
      q2_kgm2: q_at_heel_inner * 101.9716,
      qmin_kgm2: geoResults.q_heel * 101.9716,
      ...heelFlex,
      Mu_kgcm: (Mu_heel * 1000.0 / 9.80665) * 100.0,
      fc_kgcm2, fy_kgcm2,
      rebar: rebarHeel,
      spacing: spacing_heel,
      rebarTemp,
      As_trans: As_trans_footing,
      spacing_trans: spacing_trans_footing,
      rebar_callout: `${rebarHeel.name} @ ${spacing_heel} cm superior (As = ${(rebarHeel.area_cm2 * 100 / spacing_heel).toFixed(2)} cm²/m)`,
      rebar_trans: `${rebarTemp.name} @ ${spacing_trans_footing} cm transversal (compartido con puntera${geometry.has_key ? ' y dentellón' : ''})`
    },
    pass_all_structural: pass_stem_shear && pass_toe_shear && pass_heel_shear
  };
}

/**
 * Resuelve por bisección la altura remanente "x" (medida hacia abajo desde
 * la corona) para la cual el momento actuante M(x) iguala Mu_target. Se usa
 * para hallar el punto de corte del acero vertical de la cara interior.
 */
function solveCutoffHeight(Mu_target, Ka, gamma_s, q_surcharge, H_stem, LF_H, LF_L) {
  const M_at = (x) => {
    const F2 = 0.5 * Ka * gamma_s * x * x;
    const F1 = Ka * q_surcharge * x;
    return LF_H * F2 * (x / 3.0) + LF_L * F1 * (x / 2.0);
  };
  let lo = 0.0;
  let hi = Math.max(0.01, H_stem);
  if (M_at(hi) <= Mu_target) return hi; // el momento nunca cae a la mitad (caso atípico)
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2.0;
    if (M_at(mid) < Mu_target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2.0;
}

function calcRequiredRebar(Mu_kNm, fc_MPa, fy_MPa, b_m, d_m, phi = 0.9) {
  const Mu = Math.max(0.001, Mu_kNm);
  const b_cm = b_m * 100.0;
  const d_cm = d_m * 100.0;

  const Mu_Nmm = Mu * 1e6;
  const b_mm = b_m * 1000.0;
  const d_mm = d_m * 1000.0;

  const Rn = Mu_Nmm / (phi * b_mm * Math.pow(d_mm, 2));

  let rho = 0.0018;
  const discr = 1.0 - (2.0 * Rn) / (0.85 * fc_MPa);

  if (discr > 0) {
    rho = (0.85 * fc_MPa / fy_MPa) * (1.0 - Math.sqrt(discr));
  } else {
    rho = 0.025;
  }

  // Cuantía mínima (E.060 / ACI 318)
  const rho_min1 = (0.25 * Math.sqrt(fc_MPa)) / fy_MPa;
  const rho_min2 = 1.4 / fy_MPa;
  const rho_min = Math.max(0.0018, Math.max(rho_min1, rho_min2));

  const rho_design = Math.max(rho, rho_min);

  const As_calc = rho * b_cm * d_cm;
  const As_min = rho_min * b_cm * d_cm;
  const As_design = rho_design * b_cm * d_cm;

  // Profundidad del bloque de compresión a (cm)
  const a_cm = (As_design * (fy_MPa / 10.0)) / (0.85 * (fc_MPa / 10.0) * b_cm);

  return {
    Mu_kNm,
    Rn,
    rho,
    rho_min,
    rho_design,
    a_cm,
    As_calc,
    As_min,
    As_design
  };
}

function calcSpacing(As_req_cm2_m, rebar_area_cm2) {
  if (As_req_cm2_m <= 0.01) return 25.0;

  const raw_spacing = (rebar_area_cm2 * 100.0) / As_req_cm2_m;
  const standard_spacings = [7.5, 10.0, 12.5, 15.0, 17.5, 20.0, 22.5, 25.0, 30.0];

  for (let s of standard_spacings) {
    if (s <= raw_spacing) {
      continue;
    } else {
      const idx = standard_spacings.indexOf(s);
      return idx > 0 ? standard_spacings[idx - 1] : 7.5;
    }
  }

  return 25.0;
}
