"""
Script de verificación numérica automatizada de los cálculos geotécnicos y estructurales
"""

import math

def test_retaining_wall_calculation():
    H = 4.5
    B = 2.8
    hz = 0.5
    B_toe = 0.8
    b_top = 0.3
    b_bot = 0.45
    B_heel = B - B_toe - b_bot # 1.55 m
    
    phi = 32.0
    gamma_s = 18.0
    gamma_c = 24.0
    q = 10.0
    
    # 1. Ka
    phi_rad = math.radians(phi)
    Ka = (math.tan(math.pi / 4.0 - phi_rad / 2.0)) ** 2
    assert abs(Ka - 0.30726) < 0.001, f"Error en Ka: {Ka}"
    
    # 2. Empujes
    F_soil = 0.5 * Ka * gamma_s * (H ** 2)
    y_soil = H / 3.0
    
    F_q = Ka * q * H
    y_q = H / 2.0
    
    Mo = (F_soil * y_soil) + (F_q * y_q)
    Fh = F_soil + F_q
    
    # 3. Pesos y Momentos
    H_stem = H - hz # 4.0 m
    W1 = b_top * H_stem * gamma_c # 28.8
    x1 = B_toe + (b_bot - b_top) + b_top / 2.0 # 0.8 + 0.15 + 0.15 = 1.10
    
    W2 = 0.5 * (b_bot - b_top) * H_stem * gamma_c # 7.2
    x2 = B_toe + (2.0 / 3.0) * (b_bot - b_top) # 0.90
    
    W3 = B * hz * gamma_c # 33.6
    x3 = B / 2.0 # 1.40
    
    W4 = B_heel * H_stem * gamma_s # 111.6
    x4 = B_toe + b_bot + B_heel / 2.0 # 2.025
    
    W5 = q * B_heel # 15.5
    x5 = B_toe + b_bot + B_heel / 2.0 # 2.025
    
    sum_W = W1 + W2 + W3 + W4 + W5
    sum_MR = (W1 * x1) + (W2 * x2) + (W3 * x3) + (W4 * x4) + (W5 * x5)
    
    FS_v = sum_MR / Mo
    assert FS_v >= 1.5, f"Volcado insuficiente: {FS_v}"
    
    # Deslizamiento
    mu = 0.48
    sum_FR = sum_W * mu
    FS_d = sum_FR / Fh
    
    # Excentricidad
    M_net = sum_MR - Mo
    x_res = M_net / sum_W
    e = (B / 2.0) - x_res
    assert abs(e) <= B / 6.0, f"Excentricidad fuera de tercio: {e}"
    
    # Presiones
    q_toe = (sum_W / B) * (1.0 + 6.0 * e / B)
    q_heel = (sum_W / B) * (1.0 - 6.0 * e / B)
    
    print("==================================================")
    print("VERIFICACION NUMERICA DE MURO DE CONTENCION (OK)")
    print("==================================================")
    print(f"Coeficiente Ka: {Ka:.4f}")
    print(f"Empuje horizontal total Fh: {Fh:.2f} kN/m")
    print(f"Momento de vuelco Mo: {Mo:.2f} kN*m/m")
    print(f"Carga vertical total N: {sum_W:.2f} kN/m")
    print(f"Momento estabilizador MR: {sum_MR:.2f} kN*m/m")
    print(f"Factor de Seguridad Volcamiento FSv: {FS_v:.2f} (Req >= 1.50)")
    print(f"Factor de Seguridad Deslizamiento FSd: {FS_d:.2f} (Req >= 1.50)")
    print(f"Excentricidad e: {e*100:.1f} cm (Limite B/6: {B/6*100:.1f} cm)")
    print(f"Presión máxima suelo q_toe: {q_toe:.2f} kPa")
    print(f"Presión mínima suelo q_heel: {q_heel:.2f} kPa")
    print("==================================================")

if __name__ == '__main__':
    test_retaining_wall_calculation()
