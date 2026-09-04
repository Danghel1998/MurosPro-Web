/**
 * Cuadro de habilitación de acero: lista cada tipo de barra doblada del
 * muro (marca, diámetro, forma, longitud de una barra, cantidad y peso
 * total), a partir de una longitud física de muro (wallData.geometry.
 * wall_length) — el resto del motor trabaja por metro lineal (kg/m,
 * cm²/m) y no conoce esa longitud, así que este cálculo vive aparte.
 */

const hookAllow = (diameter_m) => Math.max(0.10, diameter_m * 12.0);

function row(mark, element, rebar, shape, unitLength_m, quantity) {
  const qty = Math.max(0, Math.ceil(quantity));
  const totalLength_m = unitLength_m * qty;
  return {
    mark,
    element,
    diameter_name: rebar.inches || rebar.name,
    diameter_mm: rebar.diameter_mm,
    shape,
    unitLength_m,
    quantity: qty,
    totalLength_m,
    weight_kg: totalLength_m * rebar.weight_kgm,
  };
}

export function calculateRebarSchedule(wallData, structResults) {
  const geo = wallData.geometry;
  const wallLength = geo.wall_length || 10.0;
  const str = structResults;
  const stem = str.stem, toe = str.toe, heel = str.heel;

  const H_stem = stem.hp;
  const Lc = stem.Lc_usar;
  const B = geo.B;
  const B_toe = geo.B_toe;
  const B_heel = Math.max(0, B - B_toe - geo.b_bot);
  const batter = geo.b_bot - geo.b_top; // desplazamiento horizontal total de la cara frontal
  const slope = H_stem > 0.001 ? Math.hypot(H_stem, batter) / H_stem : 1.0; // largo diagonal / altura

  const rows = [];
  let mark = 1;
  const nextMark = () => `M${mark++}`;

  // --- Acero vertical: cara interior (Asv Ci), 2 tramos ---
  {
    const db = stem.rebar;
    const hook = hookAllow(db.diameter_m);
    rows.push(row(nextMark(), 'Vástago — Asv Ci, tramo 1 (base a Lc)', db, 'hook-straight',
      hook + Lc, wallLength / (stem.spacing / 100)));
    rows.push(row(nextMark(), 'Vástago — Asv Ci, tramo 2 (Lc a corona)', db, 'straight',
      Math.max(0.1, H_stem - Lc), wallLength / (stem.spacing_z2 / 100)));
  }

  // --- Acero vertical: cara exterior (Asv Ce), varilla única continua,
  // diagonal por el batido, con gancho en la base y en la corona ---
  {
    const db = stem.rebarTemp;
    const hook = hookAllow(db.diameter_m);
    rows.push(row(nextMark(), 'Vástago — Asv Ce, base a corona', db, 'hook-diagonal',
      2 * hook + H_stem * slope, wallLength / (stem.spacing_vert_ext_inferior / 100)));
  }

  // --- Acero horizontal del vástago (Ash / "Rep."), corre a lo largo del
  // muro: la longitud de UNA barra es la longitud del muro (+ ganchos en
  // ambos extremos), y la cantidad depende de la altura de cada tramo.
  {
    const midHeight = H_stem / 2.0;
    const dbCe = stem.rebarTemp;
    const dbCi = stem.rebar;
    const hookCe = hookAllow(dbCe.diameter_m);
    const hookCi = hookAllow(dbCi.diameter_m);
    rows.push(row(nextMark(), 'Vástago — Ash cara exterior, inferior', dbCe, 'hooks-both',
      wallLength + 2 * hookCe, midHeight / (stem.sp_ce_inferior / 100)));
    rows.push(row(nextMark(), 'Vástago — Ash cara interior, inferior', dbCi, 'hooks-both',
      wallLength + 2 * hookCi, midHeight / (stem.sp_ci_inferior / 100)));
    rows.push(row(nextMark(), 'Vástago — Ash cara exterior, superior', dbCe, 'hooks-both',
      wallLength + 2 * hookCe, midHeight / (stem.sp_ce_superior / 100)));
    rows.push(row(nextMark(), 'Vástago — Ash cara interior, superior', dbCi, 'hooks-both',
      wallLength + 2 * hookCi, midHeight / (stem.sp_ci_superior / 100)));
  }

  // --- Acero principal de la zapata, corrido en todo el ancho B (punta + talón) ---
  {
    const dbToe = toe.rebar;
    const hookToe = hookAllow(dbToe.diameter_m);
    rows.push(row(nextMark(), 'Zapata — Acero inferior (corrido)', dbToe, 'hooks-both',
      B + 2 * hookToe, wallLength / (toe.spacing / 100)));

    if (B_heel > 0.01) {
      const dbHeel = heel.rebar;
      const hookHeel = hookAllow(dbHeel.diameter_m);
      rows.push(row(nextMark(), 'Zapata — Acero superior (corrido)', dbHeel, 'hooks-both',
        B + 2 * hookHeel, wallLength / (heel.spacing / 100)));
    }
  }

  // --- Acero transversal de reparto de la zapata (perpendicular al
  // principal), corre a lo largo del muro, sin gancho.
  {
    const dbTrans = toe.rebarTemp;
    if (B_toe > 0.01) {
      rows.push(row(nextMark(), 'Zapata — Transversal de reparto (punta)', dbTrans, 'straight',
        wallLength, B_toe / (toe.spacing_trans / 100)));
    }
    if (B_heel > 0.01) {
      rows.push(row(nextMark(), 'Zapata — Transversal de reparto (talón)', dbTrans, 'straight',
        wallLength, B_heel / (heel.spacing_trans / 100)));
    }
  }

  const totalWeight_kg = rows.reduce((sum, r) => sum + r.weight_kg, 0);
  return { wallLength, rows, totalWeight_kg };
}
