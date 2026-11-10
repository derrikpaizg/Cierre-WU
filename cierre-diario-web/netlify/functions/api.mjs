// =====================================================================
//  CIERRE DIARIO - API (Netlify Function) que guarda en MySQL
//
//  La página (public/js/app.js) llama a /api/... y esta función habla
//  con MySQL. Es el equivalente web de CierreRepositorio.cs y Parametros.cs.
//
//  Variables de entorno (se ponen en Netlify, NUNCA en el código):
//    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
//    DB_SSL       "true" para servidores en la nube (TiDB Cloud, Aiven...)
//    DB_SSL_CA    (opcional) certificado CA en texto, si tu proveedor lo pide
//    APP_CLAVE    contraseña para entrar a la página
//    APP_SECRETO  texto largo al azar para firmar las sesiones
// =====================================================================
import mysql from "mysql2/promise";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

// ---------------------------------------------------------------------
//  Conexión (se reutiliza entre llamadas mientras la función siga viva)
// ---------------------------------------------------------------------
let pool = null;
function obtenerPool() {
  if (pool) return pool;
  const usarSsl = env("DB_SSL", "true").toLowerCase() !== "false";
  const ca = env("DB_SSL_CA").replace(/\\n/g, "\n");
  pool = mysql.createPool({
    host: env("DB_HOST"),
    port: Number(env("DB_PORT", "3306")) || 3306,
    user: env("DB_USER"),
    password: env("DB_PASSWORD"),
    database: env("DB_NAME", "cierre_diario"),
    ssl: usarSsl ? Object.assign({ minVersion: "TLSv1.2", rejectUnauthorized: true }, ca ? { ca } : {}) : undefined,
    connectionLimit: 3,
    waitForConnections: true,
    decimalNumbers: true,      // DECIMAL llega como número, no como texto
    dateStrings: true,         // DATE llega como "2026-11-10"
    connectTimeout: 8000
  });
  return pool;
}

// ---------------------------------------------------------------------
//  Respuestas y validaciones
// ---------------------------------------------------------------------
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
class ErrorUsuario extends Error { constructor(m, s = 400) { super(m); this.status = s; } }

const esFecha = f => typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(Date.parse(f + "T00:00:00Z"));
function numero(v, nombre) {
  const n = v === "" || v === null || v === undefined ? 0 : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new ErrorUsuario("Número no válido en " + nombre);
  return Math.round(n * 10000) / 10000;
}
const texto = (v, max) => String(v ?? "").trim().slice(0, max);

// ---------------------------------------------------------------------
//  Sesión: contraseña única (APP_CLAVE) y token firmado por 12 horas
// ---------------------------------------------------------------------
const secreto = () => env("APP_SECRETO") || ("cierre#" + env("APP_CLAVE"));
const firmar = s => crypto.createHmac("sha256", secreto()).update(s).digest("hex");
function igualSeguro(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function crearToken() {
  const exp = String(Date.now() + 12 * 3600 * 1000);
  return exp + "." + firmar(exp);
}
function tokenValido(req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, firma] = t.split(".");
  return !!exp && !!firma && Number(exp) > Date.now() && igualSeguro(firma, firmar(exp));
}

// ---------------------------------------------------------------------
//  CONFIGURACIÓN (tabla Parametro + catálogos Banco y Cajero)
// ---------------------------------------------------------------------
const PARAMS = {
  nombreAgencia: "NombreAgencia", direccion: "Direccion", telefono: "Telefono", ruc: "RUC",
  responsable: "Responsable", tasaCambio: "TasaCambio", capitalTrabajoUSD: "CapitalTrabajoUSD",
  tarifaMC: "TarifaMC", tarifaVT: "TarifaVT"
};
const PARAMS_NUM = ["tasaCambio", "capitalTrabajoUSD", "tarifaMC", "tarifaVT"];

async function leerConfig(cn) {
  const cfg = { nombreAgencia: "MI AGENCIA", direccion: "", telefono: "", ruc: "", responsable: "",
                tasaCambio: 36.79, capitalTrabajoUSD: 0, tarifaMC: 0.29, tarifaVT: 0.21 };
  const [ps] = await cn.query("SELECT Clave, Valor FROM Parametro");
  for (const [k, clave] of Object.entries(PARAMS)) {
    const p = ps.find(x => x.Clave.toLowerCase() === clave.toLowerCase());
    if (p) cfg[k] = PARAMS_NUM.includes(k) ? (Number(p.Valor) || 0) : p.Valor;
  }
  const [bs] = await cn.query("SELECT BancoId AS id, Nombre AS nombre, Activo AS activo FROM Banco ORDER BY Orden, BancoId");
  const [js] = await cn.query("SELECT CajeroId AS id, Nombre AS nombre, Activo AS activo FROM Cajero ORDER BY Orden, CajeroId");
  cfg.bancos = bs.map(b => ({ ...b, activo: !!b.activo }));
  cfg.cajeros = js.map(b => ({ ...b, activo: !!b.activo }));
  return cfg;
}

async function guardarCatalogo(cn, tabla, idCol, lista) {
  if (!Array.isArray(lista)) return;
  const limpios = lista.map(e => ({ id: Number.isInteger(+e.id) && +e.id > 0 ? +e.id : 0, nombre: texto(e.nombre, 50).toUpperCase(), activo: e.activo !== false }))
                       .filter(e => e.nombre);
  if (new Set(limpios.map(e => e.nombre)).size !== limpios.length) throw new ErrorUsuario("Hay nombres repetidos en " + tabla.toLowerCase() + "s");
  const [existentes] = await cn.query(`SELECT ${idCol} AS id FROM ${tabla}`);
  const ids = new Set(existentes.map(x => x.id));
  // Nombres temporales para permitir intercambiar nombres sin chocar con UNIQUE
  for (const e of limpios) if (ids.has(e.id)) await cn.query(`UPDATE ${tabla} SET Nombre = CONCAT('~tmp~', ${idCol}) WHERE ${idCol} = ?`, [e.id]);
  let orden = 1;
  for (const e of limpios) {
    if (ids.has(e.id)) {
      await cn.query(`UPDATE ${tabla} SET Nombre = ?, Orden = ?, Activo = ? WHERE ${idCol} = ?`, [e.nombre, orden, e.activo ? 1 : 0, e.id]);
    } else {
      const [ya] = await cn.query(`SELECT ${idCol} AS id FROM ${tabla} WHERE Nombre = ?`, [e.nombre]);
      if (ya.length) await cn.query(`UPDATE ${tabla} SET Orden = ?, Activo = ? WHERE ${idCol} = ?`, [orden, e.activo ? 1 : 0, ya[0].id]);
      else await cn.query(`INSERT INTO ${tabla} (Nombre, Orden, Activo) VALUES (?, ?, ?)`, [e.nombre, orden, e.activo ? 1 : 0]);
    }
    orden++;
  }
  // Los que quedaron con nombre temporal (no venían en la lista) recuperan un nombre válido
  await cn.query(`UPDATE ${tabla} SET Nombre = CONCAT('SIN NOMBRE ', ${idCol}), Activo = 0 WHERE Nombre LIKE '~tmp~%'`);
}

async function guardarConfig(cn, c) {
  for (const [k, clave] of Object.entries(PARAMS)) {
    if (c[k] === undefined) continue;
    const valor = PARAMS_NUM.includes(k) ? String(numero(c[k], k)) : texto(c[k], 200);
    await cn.query("INSERT INTO Parametro (Clave, Valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE Valor = ?", [clave, valor, valor]);
  }
  if (c.tasaCambio !== undefined && !(numero(c.tasaCambio) > 0)) throw new ErrorUsuario("La tasa de cambio debe ser mayor que cero");
  await guardarCatalogo(cn, "Banco", "BancoId", c.bancos);
  await guardarCatalogo(cn, "Cajero", "CajeroId", c.cajeros);
}

// ---------------------------------------------------------------------
//  CIERRES: leer (uno o varios) con todas sus hojas
// ---------------------------------------------------------------------
const claveDenom = d => `${d.Moneda}-${d.Tipo[0]}-${Number(d.Valor)}`;

async function leerCierres(cn, where, params, extra = "ORDER BY Fecha") {
  const [cab] = await cn.query(
    `SELECT CierreId, DATE_FORMAT(Fecha, '%Y-%m-%d') AS fecha, TasaCambio, CapitalTrabajoUSD, Estado, Observaciones,
            DATE_FORMAT(CerradoEn, '%Y-%m-%dT%H:%i:%sZ') AS cerradoEn, DATE_FORMAT(ActualizadoEn, '%Y-%m-%dT%H:%i:%sZ') AS actualizado
     FROM Cierre WHERE ${where} ${extra}`, params);
  if (!cab.length) return [];
  const ids = cab.map(x => x.CierreId);
  const porId = new Map(cab.map(x => [x.CierreId, {
    fecha: x.fecha, tasaCambio: x.TasaCambio, capitalTrabajoUSD: x.CapitalTrabajoUSD, estado: x.Estado,
    observaciones: x.Observaciones || "", cerradoEn: x.cerradoEn || undefined, actualizado: x.actualizado,
    wu: {}, arqueo: {}, util: {}, bancos: [], cajaFuerte: {}, cajas: [], cuentas: []
  }]));

  const [wu] = await cn.query("SELECT * FROM MovimientoWU WHERE CierreId IN (?)", [ids]);
  wu.forEach(w => Object.assign(porId.get(w.CierreId).wu, {
    pagosUSD: w.PagosUSD, pagosNIO: w.PagosNIO, enviosUSD: w.EnviosUSD, enviosNIO: w.EnviosNIO,
    billersUSD: w.BillersUSD, billersNIO: w.BillersNIO, airpakDiaAnteriorUSD: w.AirpakDiaAnteriorUSD, anticipoUSD: w.AnticipoUSD }));

  const [aq] = await cn.query("SELECT * FROM CierreArqueo WHERE CierreId IN (?)", [ids]);
  aq.forEach(a => Object.assign(porId.get(a.CierreId).arqueo, { tigoNIO: a.TigoNIO, recargasNIO: a.RecargasNIO, datoAirpakUSD: a.DatoAirpakUSD }));

  const [ut] = await cn.query("SELECT * FROM CierreUtilidad WHERE CierreId IN (?)", [ids]);
  ut.forEach(u => Object.assign(porId.get(u.CierreId).util, {
    montoMC1: u.MontoMC1, montoMC2: u.MontoMC2, tarifaMC: u.TarifaMC, ventaKen1: u.VentaKen1, ventaKen2: u.VentaKen2,
    ventaDerrik1: u.VentaDerrik1, ventaDerrik2: u.VentaDerrik2, tarifaVT: u.TarifaVT, banpro: u.Banpro, bac: u.Bac, dhl: u.Dhl,
    loto: u.Loto, comisionesAir: u.ComisionesAir, cambioCK: u.CambioCK, otrosIngresos: u.OtrosIngresos, ach: u.Ach, difPorMC: u.DifPorMC }));

  const [bs] = await cn.query(
    `SELECT cb.CierreId, b.BancoId, b.Nombre, cb.SaldoUSD, cb.SaldoNIO FROM CierreBanco cb
     JOIN Banco b ON b.BancoId = cb.BancoId WHERE cb.CierreId IN (?) ORDER BY b.Orden, b.BancoId`, [ids]);
  bs.forEach(b => porId.get(b.CierreId).bancos.push({ id: b.BancoId, nombre: b.Nombre, saldoUSD: b.SaldoUSD, saldoNIO: b.SaldoNIO }));

  const [cf] = await cn.query(
    `SELECT cf.CierreId, d.Moneda, d.Tipo, d.Valor, cf.Cantidad FROM CierreCajaFuerte cf
     JOIN Denominacion d ON d.DenominacionId = cf.DenominacionId WHERE cf.CierreId IN (?)`, [ids]);
  cf.forEach(d => { if (d.Cantidad) porId.get(d.CierreId).cajaFuerte[claveDenom(d)] = d.Cantidad; });

  const [cj] = await cn.query(
    `SELECT cc.CierreId, j.CajeroId, j.Nombre, cc.MontoNIO, cc.MontoUSD FROM CierreCaja cc
     JOIN Cajero j ON j.CajeroId = cc.CajeroId WHERE cc.CierreId IN (?) ORDER BY j.Orden, j.CajeroId`, [ids]);
  cj.forEach(x => porId.get(x.CierreId).cajas.push({ id: x.CajeroId, nombre: x.Nombre, montoNIO: x.MontoNIO, montoUSD: x.MontoUSD }));

  const [cu] = await cn.query("SELECT CierreId, Tipo, Nombre, Monto, Moneda FROM CuentaPendiente WHERE CierreId IN (?) ORDER BY CuentaId", [ids]);
  cu.forEach(x => porId.get(x.CierreId).cuentas.push({ tipo: x.Tipo, nombre: x.Nombre, monto: x.Monto, moneda: x.Moneda }));

  return ids.map(id => porId.get(id));
}

// ---------------------------------------------------------------------
//  CIERRES: guardar (todo o nada, dentro de una transacción)
// ---------------------------------------------------------------------
// Encuentra el Id de un banco o cajero por Id o por nombre; si no existe, lo crea.
async function resolverCatalogo(cn, tabla, idCol, cache, e) {
  if (!cache.lista) { const [r] = await cn.query(`SELECT ${idCol} AS id, Nombre AS nombre FROM ${tabla}`); cache.lista = r; }
  const nombre = texto(e.nombre, 50).toUpperCase();
  let x = cache.lista.find(z => z.id === Number(e.id)) || cache.lista.find(z => z.nombre === nombre);
  if (x) return x.id;
  if (!nombre) return null;
  const [r] = await cn.query(`INSERT INTO ${tabla} (Nombre, Orden, Activo) VALUES (?, 999, 1)`, [nombre]);
  cache.lista.push({ id: r.insertId, nombre });
  return r.insertId;
}

async function guardarCierre(cn, c) {
  if (!c || !esFecha(c.fecha)) throw new ErrorUsuario("Fecha no válida");
  const tasa = numero(c.tasaCambio, "tasa");
  if (!(tasa > 0)) throw new ErrorUsuario("La tasa de cambio debe ser mayor que cero");
  const estado = c.estado === "CERRADO" ? "CERRADO" : "ABIERTO";
  const w = c.wu || {}, a = c.arqueo || {}, u = c.util || {};

  const [ex] = await cn.query("SELECT CierreId FROM Cierre WHERE Fecha = ? FOR UPDATE", [c.fecha]);
  let id;
  if (ex.length) {
    id = ex[0].CierreId;
    await cn.query(
      `UPDATE Cierre SET TasaCambio = ?, CapitalTrabajoUSD = ?, Estado = ?, Observaciones = ?, ActualizadoEn = UTC_TIMESTAMP(),
              CerradoEn = CASE WHEN ? = 'CERRADO' THEN COALESCE(CerradoEn, UTC_TIMESTAMP()) ELSE NULL END
       WHERE CierreId = ?`,
      [tasa, numero(c.capitalTrabajoUSD, "capital"), estado, texto(c.observaciones, 500), estado, id]);
  } else {
    const [r] = await cn.query(
      `INSERT INTO Cierre (Fecha, TasaCambio, CapitalTrabajoUSD, Estado, Observaciones, CreadoEn, ActualizadoEn, CerradoEn)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), CASE WHEN ? = 'CERRADO' THEN UTC_TIMESTAMP() END)`,
      [c.fecha, tasa, numero(c.capitalTrabajoUSD, "capital"), estado, texto(c.observaciones, 500), estado]);
    id = r.insertId;
  }

  for (const t of ["MovimientoWU", "CierreArqueo", "CierreUtilidad", "CierreBanco", "CierreCajaFuerte", "CierreCaja", "CuentaPendiente"])
    await cn.query(`DELETE FROM ${t} WHERE CierreId = ?`, [id]);

  await cn.query(
    `INSERT INTO MovimientoWU (CierreId, PagosUSD, PagosNIO, EnviosUSD, EnviosNIO, BillersUSD, BillersNIO, AirpakDiaAnteriorUSD, AnticipoUSD)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ...["pagosUSD", "pagosNIO", "enviosUSD", "enviosNIO", "billersUSD", "billersNIO", "airpakDiaAnteriorUSD", "anticipoUSD"].map(k => numero(w[k], k))]);

  await cn.query("INSERT INTO CierreArqueo (CierreId, TigoNIO, RecargasNIO, DatoAirpakUSD) VALUES (?, ?, ?, ?)",
    [id, numero(a.tigoNIO, "Tigo"), numero(a.recargasNIO, "Recargas"), numero(a.datoAirpakUSD, "Airpak")]);

  const ku = ["montoMC1", "montoMC2", "tarifaMC", "ventaKen1", "ventaKen2", "ventaDerrik1", "ventaDerrik2", "tarifaVT",
              "banpro", "bac", "dhl", "loto", "comisionesAir", "cambioCK", "otrosIngresos", "ach", "difPorMC"];
  await cn.query(
    `INSERT INTO CierreUtilidad (CierreId, MontoMC1, MontoMC2, TarifaMC, VentaKen1, VentaKen2, VentaDerrik1, VentaDerrik2, TarifaVT,
                                 Banpro, Bac, Dhl, Loto, ComisionesAir, CambioCK, OtrosIngresos, Ach, DifPorMC)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ...ku.map(k => numero(u[k] ?? (k === "tarifaMC" ? 0.29 : k === "tarifaVT" ? 0.21 : 0), k))]);

  const cacheB = {}, cacheJ = {}, usados = new Set();
  for (const b of Array.isArray(c.bancos) ? c.bancos : []) {
    const bid = await resolverCatalogo(cn, "Banco", "BancoId", cacheB, b);
    if (!bid || usados.has("b" + bid)) continue; usados.add("b" + bid);
    await cn.query("INSERT INTO CierreBanco (CierreId, BancoId, SaldoUSD, SaldoNIO) VALUES (?, ?, ?, ?)",
      [id, bid, numero(b.saldoUSD, "banco"), numero(b.saldoNIO, "banco")]);
  }
  for (const x of Array.isArray(c.cajas) ? c.cajas : []) {
    const jid = await resolverCatalogo(cn, "Cajero", "CajeroId", cacheJ, x);
    if (!jid || usados.has("j" + jid)) continue; usados.add("j" + jid);
    await cn.query("INSERT INTO CierreCaja (CierreId, CajeroId, MontoNIO, MontoUSD) VALUES (?, ?, ?, ?)",
      [id, jid, numero(x.montoNIO, "caja"), numero(x.montoUSD, "caja")]);
  }

  const [dens] = await cn.query("SELECT DenominacionId, Moneda, Tipo, Valor FROM Denominacion");
  const filasCF = [];
  for (const d of dens) {
    const cant = Math.round(numero((c.cajaFuerte || {})[claveDenom(d)], "caja fuerte"));
    if (cant < 0) throw new ErrorUsuario("La cantidad de billetes no puede ser negativa");
    if (cant) filasCF.push([id, d.DenominacionId, cant]);
  }
  if (filasCF.length) await cn.query("INSERT INTO CierreCajaFuerte (CierreId, DenominacionId, Cantidad) VALUES ?", [filasCF]);

  const filasCu = (Array.isArray(c.cuentas) ? c.cuentas : [])
    .map(x => [id, x.tipo === "P" ? "P" : "C", texto(x.nombre, 100), numero(x.monto, "cuenta"), x.moneda === "USD" ? "USD" : "NIO"])
    .filter(f => f[2] !== "" || f[3] !== 0);
  if (filasCu.length) await cn.query("INSERT INTO CuentaPendiente (CierreId, Tipo, Nombre, Monto, Moneda) VALUES ?", [filasCu]);
  return id;
}

async function enTransaccion(fn) {
  const cn = await obtenerPool().getConnection();
  try {
    await cn.beginTransaction();
    const r = await fn(cn);
    await cn.commit();
    return r;
  } catch (e) {
    try { await cn.rollback(); } catch { /* nada */ }
    throw e;
  } finally { cn.release(); }
}

// ---------------------------------------------------------------------
//  RUTAS
// ---------------------------------------------------------------------
export default async (req) => {
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)\/?/, "").replace(/\/$/, "");
  const q = k => url.searchParams.get(k) || "";
  const cuerpo = async () => { try { return await req.json(); } catch { throw new ErrorUsuario("Datos no válidos"); } };

  try {
    // ---- Rutas sin sesión
    if (ruta === "salud") {
      const faltan = ["DB_HOST", "DB_USER", "DB_PASSWORD", "APP_CLAVE"].filter(k => !env(k));
      if (faltan.length) return json(500, { ok: false, error: "Faltan variables de entorno: " + faltan.join(", ") });
      await obtenerPool().query("SELECT 1 FROM Cierre LIMIT 1");
      return json(200, { ok: true, mensaje: "Conexión con MySQL correcta" });
    }
    if (ruta === "login" && req.method === "POST") {
      if (!env("APP_CLAVE")) return json(500, { error: "Falta configurar APP_CLAVE en Netlify" });
      const { clave } = await cuerpo();
      await new Promise(r => setTimeout(r, 400));               // frena intentos repetidos
      if (!igualSeguro(clave || "", env("APP_CLAVE"))) return json(401, { error: "Contraseña incorrecta" });
      return json(200, { token: crearToken() });
    }

    // ---- Todo lo demás pide sesión
    if (!tokenValido(req)) return json(401, { error: "Sesión vencida" });
    const p = obtenerPool();

    if (ruta === "config" && req.method === "GET") return json(200, { config: await leerConfig(p) });
    if (ruta === "config" && req.method === "PUT") {
      const c = await cuerpo();
      await enTransaccion(cn => guardarConfig(cn, c));
      return json(200, { config: await leerConfig(p) });
    }
    if (ruta === "cierre" && req.method === "GET") {
      if (!esFecha(q("fecha"))) throw new ErrorUsuario("Fecha no válida");
      const [c] = await leerCierres(p, "Fecha = ?", [q("fecha")]);
      return json(200, { cierre: c || null });
    }
    if (ruta === "anterior" && req.method === "GET") {
      if (!esFecha(q("fecha"))) throw new ErrorUsuario("Fecha no válida");
      const [c] = await leerCierres(p, "Fecha < ?", [q("fecha")], "ORDER BY Fecha DESC LIMIT 1");
      return json(200, { cierre: c || null });
    }
    if (ruta === "cierre" && req.method === "PUT") {
      const c = await cuerpo();
      await enTransaccion(cn => guardarCierre(cn, c));
      const [g] = await leerCierres(p, "Fecha = ?", [c.fecha]);
      return json(200, { cierre: g });
    }
    if (ruta === "periodo" && req.method === "GET") {
      if (!esFecha(q("desde")) || !esFecha(q("hasta"))) throw new ErrorUsuario("Fechas no válidas");
      const cs = await leerCierres(p, "Fecha BETWEEN ? AND ?", [q("desde"), q("hasta")], "ORDER BY Fecha LIMIT 2000");
      return json(200, { cierres: cs });
    }
    if (ruta === "restaurar" && req.method === "POST") {
      const { cierres } = await cuerpo();
      if (!Array.isArray(cierres) || cierres.length > 50) throw new ErrorUsuario("Envía de 1 a 50 días por vez");
      let n = 0;
      for (const c of cierres) { await enTransaccion(cn => guardarCierre(cn, c)); n++; }
      return json(200, { guardados: n });
    }
    return json(404, { error: "Ruta no encontrada" });
  } catch (e) {
    if (e instanceof ErrorUsuario) return json(e.status, { error: e.message });
    console.error(e);
    const msg = e && (e.code === "ER_DUP_ENTRY" ? "Ya existe un registro con ese nombre"
      : ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST"].includes(e.code) ? "No se pudo conectar con MySQL (" + e.code + ")"
      : e.code === "ER_ACCESS_DENIED_ERROR" ? "Usuario o contraseña de MySQL incorrectos"
      : e.code === "ER_NO_SUCH_TABLE" ? "Faltan las tablas: ejecuta base-de-datos/crear_base_datos_mysql.sql"
      : e.code === "ER_BAD_DB_ERROR" ? "No existe la base de datos indicada en DB_NAME"
      : null);
    return json(500, { error: msg || "Error interno del servidor" });
  }
};
