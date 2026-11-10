# Cierre Diario: versión web (Netlify + MySQL)

Es el mismo Cierre Diario de escritorio, ahora como página web. Tiene las 7 hojas, las tarjetas de resumen, los reportes con PDF y la Configuración. Entras con una contraseña y los datos se guardan en MySQL.

## Qué hay en la carpeta

```
cierre-diario-web/
├── public/                      ← la página (lo que ve el usuario)
│   ├── index.html
│   ├── css/estilos.css
│   └── js/app.js                ← pantallas, fórmulas del Excel, reportes y PDF
├── netlify/functions/api.mjs    ← el "servidor": conecta la página con MySQL
├── base-de-datos/
│   └── crear_base_datos_mysql.sql   ← crea las tablas (ejecutar 1 vez)
├── netlify.toml                 ← configuración de Netlify
├── package.json                 ← dice que se necesita el paquete mysql2
└── .env.example                 ← ejemplo de variables (solo para probar en tu PC)
```

**Por qué hay un "servidor":** la página no puede conectarse directo a MySQL. Si lo hiciera, la contraseña de la base quedaría visible para cualquiera. Por eso la página llama a `/api/...`, y la función de Netlify es la que entra a MySQL con la contraseña guardada en secreto.

---

## GUÍA PARA SUBIRLO A PRODUCCIÓN

Necesitas 3 cuentas gratuitas: **TiDB Cloud** (la base MySQL), **GitHub** (guarda el código) y **Netlify** (publica la página).

> Netlify no tiene MySQL propio. TiDB Cloud Starter es compatible con MySQL y tiene un plan gratis. Si ya tienes otro MySQL accesible desde internet (por ejemplo, un hosting con cPanel que permita "MySQL remoto"), también sirve: salta al paso 1.4 con sus datos.

### PASO 1: Crear la base de datos MySQL (TiDB Cloud)

1. Entra a <https://tidbcloud.com> y crea tu cuenta (puedes usar tu cuenta de Google o GitHub).
2. Crea una instancia **Starter** en modo **MySQL Compatible**. Elige una región cercana (por ejemplo, us-east-1). Deja el **límite de gasto (spending limit) en 0** para que siga siendo gratis.
3. Cuando esté lista, pulsa **Connect**. Anota estos datos:
   - **Host** (algo como `gateway01.us-east-1.prod.aws.tidbcloud.com`)
   - **Port**: `4000`
   - **User** (algo como `2abcDEF.root`)
   - **Password**: pulsa *Generate password* y **guárdala**, porque solo se muestra una vez.
4. Crea las tablas: abre el **SQL Editor** de TiDB y pega **todo** el contenido de `base-de-datos/crear_base_datos_mysql.sql`. Ejecútalo. Al final debe mostrar 12 tablas, y los bancos y cajeros iniciales.
   - También lo puedes ejecutar con MySQL Workbench o DBeaver. Conéctate con SSL activado.

### PASO 2: Subir el código a GitHub

1. Entra a <https://github.com> y pulsa **New repository**. Ponle de nombre `cierre-diario-web` y márcalo como **Private**. Créalo.
2. En el repositorio vacío pulsa **uploading an existing file**.
3. Arrastra **todo lo que está dentro** de la carpeta `cierre-diario-web` (las carpetas `public`, `netlify` y `base-de-datos`, y los archivos `netlify.toml`, `package.json`, `.gitignore`, etc.). **No** subas un archivo `.env` si lo creaste.
4. Pulsa **Commit changes**.

> Revisa que en GitHub se vean `netlify.toml` y `package.json` en la raíz, y no metidos dentro de otra carpeta.

### PASO 3: Publicar en Netlify

1. Entra a <https://app.netlify.com> e inicia sesión **con tu cuenta de GitHub**.
2. Pulsa **Add new project → Import an existing project → GitHub**, autoriza y elige `cierre-diario-web`.
3. En la configuración del build no cambies nada: Netlify lo lee de `netlify.toml` (*Publish directory* = `public`, *Functions* = `netlify/functions`).
4. **Antes de publicar**, o justo después, ve a **Project configuration → Environment variables** y agrega estas variables:

   | Variable | Valor |
   |---|---|
   | `DB_HOST` | el Host de TiDB |
   | `DB_PORT` | `4000` (o `3306` en un MySQL normal) |
   | `DB_USER` | el User de TiDB (con el punto, ej. `2abcDEF.root`) |
   | `DB_PASSWORD` | la contraseña de TiDB |
   | `DB_NAME` | `cierre_diario` |
   | `DB_SSL` | `true` (pon `false` solo si tu MySQL no usa SSL) |
   | `APP_CLAVE` | la contraseña para entrar a la página (invéntala, que sea fuerte) |
   | `APP_SECRETO` | un texto largo al azar, de 40 letras o más (ej. `kq8Z...`) |

   Si Netlify te pregunta el alcance (*scope*), deja **All scopes** o incluye **Functions**.
5. Ve a **Deploys → Trigger deploy → Deploy project**. Esto vuelve a publicar con las variables nuevas. Cada vez que cambies una variable tienes que volver a publicar.
6. Cuando termine, Netlify te da una dirección como `https://cierre-diario-abc123.netlify.app`. Puedes cambiar el nombre en **Project configuration → Change project name**.

### PASO 4: Comprobar que funciona

1. Abre `https://TU-SITIO.netlify.app/api/salud`.
   - Si dice `"ok": true`, la conexión con MySQL funciona.
   - Si muestra un error, búscalo en la tabla de **Problemas comunes** de abajo.
2. Abre `https://TU-SITIO.netlify.app`, escribe la contraseña (`APP_CLAVE`) y listo.
3. Ve a **Configuración** y pon los datos de tu agencia, la tasa y el capital inicial.

### PASO 5 (opcional): Pasar los datos que ya tienes

- **De la página que te publiqué antes en Claude:** ábrela, ve a Configuración y pulsa **Descargar respaldo**. Después, en la página de Netlify, ve a Configuración y pulsa **Restaurar respaldo** con ese archivo.
- **De tu SQL Server (programa de escritorio):** pídele a Claude el script que exporta tus cierres de SQL Server al formato de respaldo.

---

## Cómo actualizarlo después

Cambia el archivo en GitHub (lo abres, pulsas el lápiz, editas y haces **Commit**). Netlify lo vuelve a publicar solo en 1 o 2 minutos.

## Probarlo en tu computadora (opcional)

Necesitas tener instalado Node.js 20 o más nuevo.

```bash
npm install
npm install -g netlify-cli
cp .env.example .env      # y escribe tus datos reales en .env
netlify dev               # abre http://localhost:8888
```

## Problemas comunes

| Mensaje | Qué hacer |
|---|---|
| `Faltan variables de entorno: ...` | Agrega las variables que faltan en Netlify y vuelve a publicar (Trigger deploy). |
| `Usuario o contraseña de MySQL incorrectos` | Revisa `DB_USER` (en TiDB lleva el prefijo con punto) y `DB_PASSWORD`. |
| `No se pudo conectar con MySQL (ETIMEDOUT / ENOTFOUND)` | Revisa `DB_HOST` y `DB_PORT`. En un hosting con cPanel, activa "MySQL remoto" y permite el acceso desde cualquier IP (`%`). |
| Error de SSL o certificado | Con TiDB deja `DB_SSL=true`. Si tu proveedor te da un archivo CA, pega su contenido en `DB_SSL_CA`. Con un MySQL sin SSL pon `DB_SSL=false`. |
| `No existe la base de datos indicada en DB_NAME` | Ejecuta el script SQL (crea `cierre_diario`) o pon en `DB_NAME` el nombre de tu base. |
| `Faltan las tablas` | Ejecuta `base-de-datos/crear_base_datos_mysql.sql`. |
| `Cannot find module 'mysql2'` en los logs | Revisa que `package.json` esté en la raíz del repositorio. No uses "arrastrar carpeta" (Netlify Drop) porque así no se instalan los paquetes: publica desde GitHub. |
| La página pide la contraseña cada día | Es normal: la sesión dura 12 horas. |

Para ver los errores del servidor ve a Netlify: **Logs → Functions → api**.

## Seguridad

- Las contraseñas de MySQL y de la página **solo** van en las variables de Netlify, nunca en el código ni en GitHub.
- Todos los que entran comparten una misma contraseña (`APP_CLAVE`). Para sacar a alguien, cambia `APP_CLAVE` y `APP_SECRETO` y vuelve a publicar. Eso cierra todas las sesiones abiertas.
- El plan gratis de TiDB guarda copias de respaldo solo por 1 día. Usa el botón **Descargar respaldo** de vez en cuando y guarda el archivo en un lugar seguro.
