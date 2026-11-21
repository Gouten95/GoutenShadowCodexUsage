# GoutenShadow Codex Usage

Aplicación de escritorio para consultar los límites disponibles de Codex con una cuenta de ChatGPT. La aplicación consulta `account/rateLimits/read` mediante el `app-server` local de Codex; no pide contraseñas, copia tokens ni utiliza un servidor propio. Las ventanas mostradas dependen de la respuesta de Codex y del tipo de cuenta.

## Requisitos

- Windows 10/11 con Microsoft Edge WebView2, o macOS (versión de Mac pendiente de probar).
- Codex CLI instalado y sesión iniciada con ChatGPT. En Windows también se detecta el ejecutable que instala la aplicación de Codex. Las cuentas que solo utilizan una clave API podrían no ofrecer estos límites.
- Para desarrollar: Node.js, Rust y los requisitos de compilación de Tauri. En Windows se necesitan las herramientas de C++ de Visual Studio y Windows SDK; en macOS, Xcode Command Line Tools.

## Uso

Inicia la aplicación y espera la primera lectura. Al cerrar la ventana seguirá ejecutándose en la bandeja; usa el menú del icono y selecciona **Salir** para cerrarla por completo. La bandeja muestra un icono con el dragón. Al colocar el cursor encima aparece una vista rápida con los porcentajes disponibles y sus reinicios. En Windows puedes mover el icono desde el área de iconos ocultos a la barra para verlo siempre. Desde el engrane puedes elegir entre el tema original y seis temas neón, además de activar una ventana flotante que permanece sobre otras aplicaciones. Haz clic en la ventana flotante para alternar entre la vista detallada y dos círculos compactos con el porcentaje restante. Usa ⛶ / ⊟ para cambiar de vista, arrastra desde cualquier punto libre para moverla y desde la esquina inferior derecha para ajustar su tamaño. Los números de la vista flotante siguen el color del tema; los arcos indican el uso restante de verde a rojo. La vista compacta muestra solo los círculos y revela los controles al pasar el cursor. La opacidad del fondo de la vista ampliada se puede elegir en Configuración. Ciérrala con × o desactívala en Configuración. También puedes ajustar la frecuencia, las notificaciones y el inicio automático.

Los resultados son una instantánea: la hora de actualización indica su antigüedad. Si la consulta falla, se mantienen los últimos valores y se muestra un aviso. La aplicación no realiza solicitudes al modelo para consultar los límites.

## Desarrollo

```sh
npm install
npm run tauri dev
```

Para compilar el instalador en la plataforma anfitriona:

```sh
npm run tauri build
```

Los instaladores se encuentran en `src-tauri/target/release/bundle/`. macOS debe compilarse y probarse en un Mac; para distribución pública hay que considerar firma y notarización. Los instaladores locales sin firma pueden generar avisos del sistema.
