# macOS Control Center para GNOME

Una extensión de GNOME Shell que recrea la experiencia del Centro de Control de macOS con un estilo moderno, vidrio translúcido y un conjunto de controles rápidos inspirados en el sistema operativo de Apple.

Esta extensión está pensada para GNOME 45+ y ofrece una interfaz tipo macOS con botones redondeados, menús de estado, panel superior personalizado, ajustes de reloj y un aspecto visual muy cuidado.

## Vista rápida

- Centro de Control con diseño tipo macOS
- Botones de Wi‑Fi, Bluetooth, batería, Spotlight y control central
- Soporte para accesos directos globales
- Ajustes de tamaño y espaciado de iconos del panel
- Estilo visual de macOS 27 con vidrio y redondeado
- Integración con Quick Settings y módulos del sistema
- Personalización de Liquid Glass para menús y dock

## Capturas de pantalla

> Deja aquí tus capturas para ilustrar cada función. Puedes guardar las imágenes en `docs/screenshots/` y mantener estos nombres como referencia.

### 1) Centro de Control estilo macOS 27

![Centro de Control estilo macOS 27](docs/screenshots/control-center-macos-27.png)

### 2) Accesos directos (Shortcuts)

![Accesos directos de teclado](docs/screenshots/shortcuts.png)

### 3) Configuración de iconos y espaciado

![Configuración de iconos y espaciado del panel](docs/screenshots/icon-size-spacing.png)

### 4) Preferencias de la extensión

![Preferencias y ajustes](docs/screenshots/preferences.png)

### 5) Ejemplo en el escritorio

![Ejemplo en el escritorio GNOME](docs/screenshots/desktop-example.png)

## Funciones principales

### 1) Centro de Control inspirado en macOS
La extensión añade un panel con diseño muy similar al Centro de Control de macOS, con una cuadrícula configurable de módulos, botones redondeados, tarjetas de contenido y diseño limpio.

Incluye elementos como:
- Wi‑Fi
- Bluetooth
- AirDrop
- Mensajes/estado de conexión
- Modo de enfoque
- Brillo y volumen
- Night Light
- Grabación de pantalla
- Captura de pantalla
- Duplicación de pantalla
- Reproducción multimedia

### 2) Atajos globales (Shortcuts)
La extensión permite personalizar accesos rápidos del sistema con combinaciones de teclado para:
- Abrir Spotlight
- Abrir el Centro de Control

Se pueden ajustar desde las preferencias o borrar con `Backspace` o `Delete`.

### 3) Configuración del icono y espaciado
Desde la sección de preferencias del panel puedes ajustar:
- tamaño del icono
- separación entre iconos
- escalado automático según la altura del panel

Esto ayuda a adaptar la barra superior a distintos tamaños de pantalla y temas visuales.

### 4) Estilo macOS 27
La apariencia visual intenta imitar la referencia visual de macOS 27, con:
- iconos redondeados y ligeros
- transparencias y vidrio
- esquinas suaves
- elementos con altura y proporción inspiradas en macOS
- microanimaciones y sensación de profundidad

### 5) Liquid Glass / vidrio del sistema
La extensión incluye ajustes de:
- desenfoque
- tonalidad / tint
- brillo
- saturación
- suavizado de esquinas

Estos ajustes se pueden aplicar al Centro de Control, Spotlight y al dock cuando está disponible.

### 6) Personalización del panel
Además de la apariencia, puedes:
- cambiar formato de hora
- elegir idioma del reloj
- cambiar entre 12h y 24h
- ocultar o reordenar controles
- añadir controles de GNOME y extensiones externas

## Instalación

### Opción 1: instalación manual

1. Clona el repositorio:

```bash
git clone https://github.com/Designer-Style147/MacOs-CC-Gnome.git
```

2. Copia la extensión a la carpeta de extensiones de GNOME:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev
cp -a MacOs-CC-Gnome/. ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev/
```

3. Compila los esquemas de configuración:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/macos-control-center@keyunge.dev/schemas/
```

4. Habilita la extensión:

```bash
gnome-extensions enable macos-control-center@keyunge.dev
```

5. Reinicia sesión o inicia sesión de nuevo para que la extensión se cargue correctamente.

### Opción 2: abrir preferencias

```bash
gnome-extensions prefs macos-control-center@keyunge.dev
```

## Preferencias

La extensión incluye una ventana de configuración con varias secciones:

- Panel Clock: formato de hora y idioma
- Panel: tamaño de íconos y espaciado
- Shortcuts: accesos directos globales
- Liquid Glass: desenfoque, brillo, saturación y forma del vidrio

## Requisitos

- GNOME Shell 45+
- Sistema con soporte para GNOME Shell y servicios del sistema
- Funciones como Bluetooth, Wi‑Fi, batería y grabación dependen de la disponibilidad del hardware y del entorno del sistema

## Notas

- Algunos controles pueden variar según tu distribución, hardware y extensiones instaladas.
- El efecto de vidrio del dock requiere que estés usando Dash to Dock o Ubuntu Dock.
- Algunas funciones, como mirroring o scrcpy, usan herramientas externas si están instaladas.

## Licencia

Consulta el archivo `lg/LICENSE` para los detalles de licencia de los componentes de Liquid Glass incluidos en esta extensión.
