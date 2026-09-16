# Bequitacora Vital

Diario de salud personal: comidas, sueño, suplementación e informes médicos, con un score general, estadísticas visuales y consejos de mejora.

## Estructura del proyecto

```
bequitacora-vital/
├── index.html        página principal
├── css/
│   └── style.css      estilos (blanco / negro / gris, responsive)
├── js/
│   └── app.js         lógica de la app (registro, score, gráficas)
└── README.md
```

## Cómo abrirla

**Opción rápida:** haz doble clic en `index.html` para abrirla en el navegador.

**Opción recomendada** (para que el guardado de datos funcione de forma fiable en todos los navegadores): sirve la carpeta con un servidor local en lugar de abrir el archivo directamente. Desde una terminal, dentro de esta carpeta:

```bash
python3 -m http.server 8000
```

y abre `http://localhost:8000` en el navegador.

## Dónde se guardan los datos

Esta versión de escritorio guarda todo en el `localStorage` del navegador que uses (es decir, en tu propio ordenador, ligado a ese navegador). No se sincroniza entre dispositivos ni navegadores distintos. Si limpias los datos de navegación de ese sitio, perderás lo guardado — puedes hacer copia exportando manualmente si lo necesitas más adelante.

El botón "Pedir consejo personalizado" (IA) solo funciona cuando esta misma app se abre dentro de un Artifact de Claude (usa la cuenta de Claude de quien la abre); en el navegador local ese botón se oculta automáticamente porque esa función no existe fuera de Claude.

## Personalizar

- Colores y tipografías: `css/style.css` (variables en `:root`).
- Textos de consejos automáticos: objeto `TIPS_LIBRARY` en `js/app.js`.
- Pesos del score general (sueño 30% / nutrición 30% / suplementos 15% / médico 25%): función `computeScores` en `js/app.js`.
