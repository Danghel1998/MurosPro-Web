# MurosPro - Software de Diseño de Muros de Contención en Voladizo

**MurosPro** es una aplicación de ingeniería geotécnica y estructural para el análisis, verificación y dimensionamiento de **muros de contención en voladizo de hormigón armado** según los estándares de la normativa **ACI 318** y **Eurocódigo 2**.

---

## 🚀 Características Principales

### 1. 📐 Modelado Geométrico Interactivo
- Ajuste paramétrico de altura total ($H$), espesor de zapata ($h_z$), ancho total de base ($B$), longitud de puntera ($B_{pun}$), espesor en coronación ($b_{cor}$) y en base del vástago ($b_{base}$).
- Soporte para **dentellón / tacón de hormigón** en la base para incrementar la resistencia al deslizamiento.
- Profundidad de desplante ($D_f$).

### 2. 🌍 Geotecnia y Cargas
- Coeficientes de empuje activo ($K_a$) y pasivo ($K_p$) según **Rankine** y **Coulomb**.
- Análisis de talud posterior inclinado con ángulo $\beta$.
- Análisis sísmico pseudo-estático según la teoría de **Mononobe-Okabe** ($k_h, k_v$).
- Presencia de **nivel freático** parcial con empuje hidrostático y peso sumergido ($\gamma'$).
- Presión por **sobrecarga uniforme** en coronación ($q$).

### 3. ⚖️ Verificaciones de Estabilidad Geotécnica
- **Factor de Seguridad al Volcamiento**: $FS_v = \frac{\sum M_R}{\sum M_O} \ge 1.50$
- **Factor de Seguridad al Deslizamiento**: $FS_d = \frac{\sum F_R}{\sum F_d} \ge 1.50$
- **Excentricidad de la resultante**: Verificación de tercio central ($e \le B/6$).
- **Presiones de contacto sobre el terreno**: Diagramas trapezoidales y triangulares con verificación de no sobrepasar la capacidad admisible ($q_{max} \le q_{adm}$).

### 4. 🏗️ Diseño Estructural de Hormigón Armado (ACI 318)
- **Vástago / Pantalla**: Momento último ($M_u$), cortante actuante ($V_u$) vs capacidad del hormigón ($\phi V_c$), cuantías de acero a flexión ($A_s$), corte de armadura a media altura, y armadura horizontal de retracción y temperatura.
- **Puntera (Toe)**: Flexión por reacción neta del terreno y refuerzo inferior.
- **Talón (Heel)**: Flexión por carga superior de tierras y refuerzo superior.
- Selección automática de diámetros comerciales (#3 a #10, Ø8mm a Ø32mm) y cálculo de espaciamientos prácticos ($s$).

### 5. 📊 Visualizador Gráfico 2D
- Renderizado interactivo a escala en HTML5 Canvas con soporte para **Pan** (arrastre) y **Zoom** (rueda del ratón).
- Tres modos de visualización conmutable:
  1. **Geometría y Cotas Técnicas**.
  2. **Diagramas de Empujes y Presiones en la Base**.
  3. **Despiece Detallado de Armaduras de Concreto**.

### 6. 📑 Memoria de Cálculo Detallada
- Reporte formal paso a paso con fórmulas matemáticas renderizadas mediante **KaTeX**.
- Botón para **Imprimir o Guardar en PDF** con diseño adaptado a hojas técnicas.
- Exportación del plano a **PNG** de alta resolución y guardado de proyectos en formato **JSON**.

---

## 💻 Instrucciones de Uso

### Opción A (Recomendada - Con servidor local automático):
1. Haz doble clic en el archivo **`iniciar_app.bat`** (o ejecuta `python server.py` en la terminal).
2. Se abrirá automáticamente la aplicación en tu navegador web en `http://localhost:8080`.

### Opción B (Directa en Navegador):
1. Abre directamente el archivo **`index.html`** en cualquier navegador web moderno (Chrome, Edge, Firefox, Brave, Safari).

---

## 📁 Estructura del Proyecto

```
muros-voladizo-app/
├── index.html                  # Interfaz de usuario principal
├── server.py                   # Servidor web local en Python
├── iniciar_app.bat             # Lanzador con doble clic para Windows
├── test_verification.py        # Script de pruebas numéricas automatizadas
├── README.md                   # Documentación técnica
├── css/
│   └── styles.css              # Estilos personalizados y reglas de impresión PDF
└── js/
    ├── constants.js            # Tablas de aceros, suelos tipo y presets
    ├── engine/
    │   ├── soilPressures.js    # Empujes de tierra, sobrecarga, agua y sismo
    │   ├── geotechnical.js     # Estabilidad: volcamiento, deslizamiento, excentricidad
    │   └── structural.js       # Hormigón armado: flexión, cortante, cuantías
    ├── visualizer/
    │   └── wallCanvas.js       # Motor gráfico 2D Canvas interactivo
    └── ui/
        └── uiController.js     # Controlador reactivo y sincronización de datos
```
