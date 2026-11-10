// Cierre Diario - lógica de la pantalla (versión web para Netlify + MySQL)
"use strict";
// =====================================================================
//  UTILIDADES
// =====================================================================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const R2 = v => Math.round((v + Math.sign(v) * 1e-9) * 100) / 100;
const N2 = v => Math.abs(R2(v)).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const Mon = (v, s) => (R2(v) < 0 ? "-" : "") + s + N2(v);
const Num = v => (R2(v) < 0 ? "-" : "") + N2(v);
const D = v => Mon(v, "$"), C = v => Mon(v, "C$");
const Texto = v => !v ? "" : String(+(+v).toFixed(4));
function TryNumero(t) {
  t = String(t ?? "").trim();
  if (t === "") return {ok: true, v: 0};
  if (!/^-?(\d+|\d{1,3}(,\d{3})+)?(\.\d+)?$/.test(t) || t === "-" ) return {ok: false, v: 0};
  const v = parseFloat(t.replace(/,/g, ""));
  return isNaN(v) ? {ok: false, v: 0} : {ok: true, v};
}
const hoyISO = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
function sumarDias(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const F = iso => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "";
const sum = (a, f) => a.reduce((s, x) => s + (+f(x) || 0), 0);
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function notificar(txt, color = "var(--exito)") {
  const d = document.createElement("div");
  d.textContent = txt; d.style.background = color;
  $("toast").appendChild(d);
  setTimeout(() => d.remove(), 3200);
}
function preguntar(txt, si = "Aceptar") {
  return new Promise(res => {
    $("dlgTxt").textContent = txt; $("dlgSi").textContent = si; $("dlg").classList.add("ver");
    const fin = v => { $("dlg").classList.remove("ver"); $("dlgSi").onclick = $("dlgNo").onclick = null; res(v); };
    $("dlgSi").onclick = () => fin(true); $("dlgNo").onclick = () => fin(false);
  });
}

// =====================================================================
//  CATÁLOGOS Y CONFIGURACIÓN
// =====================================================================
const DENOMS = [];
[["NIO","BILLETE",[10,20,50,100,200,500,1000]],["NIO","MONEDA",[0.5,1,5]],["USD","BILLETE",[1,5,10,20,50,100]]]
  .forEach(([m, t, vs]) => vs.forEach(v => DENOMS.push({id: m + "-" + t[0] + "-" + v, moneda: m, tipo: t, valor: v})));

function cfgPorDefecto() {
  return {
    nombreAgencia: "MI AGENCIA", direccion: "", telefono: "", ruc: "", responsable: "",
    tasaCambio: 36.79, capitalTrabajoUSD: 0, tarifaMC: 0.29, tarifaVT: 0.21,
    bancos: ["BANPRO","BAC","LAFISE","FICOHSA"].map((n, i) => ({id: "b" + (i + 1), nombre: n, activo: true})),
    cajeros: ["KEN","DERRIK"].map((n, i) => ({id: "j" + (i + 1), nombre: n, activo: true}))
  };
}
let CFG = cfgPorDefecto();

// =====================================================================
//  ALMACÉN: habla con la función /api (Netlify) que guarda en MySQL
// =====================================================================
const TOKEN_KEY = "cierreDiarioToken";
let token = (() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } })();

async function api(metodo, ruta, cuerpo) {
  let res;
  try {
    res = await fetch("/api/" + ruta, {
      method: metodo,
      headers: Object.assign({"Content-Type": "application/json"}, token ? {Authorization: "Bearer " + token} : {}),
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
  } catch {
    throw new Error("No hay conexión con el servidor. Revisa tu internet.");
  }
  let datos = null;
  try { datos = await res.json(); } catch { /* respuesta vacía */ }
  if (res.status === 401 && ruta !== "login") { pedirLogin("Tu sesión terminó. Vuelve a entrar."); throw new Error("Sesión vencida"); }
  if (!res.ok) throw new Error((datos && datos.error) || ("Error del servidor (" + res.status + ")"));
  return datos;
}

const Store = {
  async getConfig() { return (await api("GET", "config")).config; },
  async setConfig(c) { return (await api("PUT", "config", c)).config; },
  async getCierre(f) { return (await api("GET", "cierre?fecha=" + f)).cierre; },
  async setCierre(c) { return (await api("PUT", "cierre", c)).cierre; },
  async anterior(f) { return (await api("GET", "anterior?fecha=" + f)).cierre; },
  async periodo(d, h) { return (await api("GET", "periodo?desde=" + d + "&hasta=" + h)).cierres; },
  async todos() { return this.periodo("1900-01-01", "2999-12-31"); },
  async restaurar(lote) { return await api("POST", "restaurar", lote); }
};

// Descarga un archivo (PDF o respaldo) desde el navegador
function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// =====================================================================
//  MODELO DEL CIERRE
// =====================================================================
function cierreVacio(fecha) {
  return {
    fecha, tasaCambio: CFG.tasaCambio, capitalTrabajoUSD: CFG.capitalTrabajoUSD, estado: "ABIERTO", observaciones: "",
    guardado: false,
    wu: {pagosUSD: 0, pagosNIO: 0, enviosUSD: 0, enviosNIO: 0, billersUSD: 0, billersNIO: 0, airpakDiaAnteriorUSD: 0, anticipoUSD: 0},
    arqueo: {tigoNIO: 0, recargasNIO: 0, datoAirpakUSD: 0},
    util: {montoMC1: 0, montoMC2: 0, tarifaMC: CFG.tarifaMC, ventaKen1: 0, ventaKen2: 0, ventaDerrik1: 0, ventaDerrik2: 0, tarifaVT: CFG.tarifaVT,
           banpro: 0, bac: 0, dhl: 0, loto: 0, comisionesAir: 0, cambioCK: 0, otrosIngresos: 0, ach: 0, difPorMC: 0},
    bancos: [], cajaFuerte: {}, cajas: [], cuentas: []
  };
}

// Bancos/cajeros del día: los activos + los que ese día tenía guardados (como el LEFT JOIN original)
function unirLista(catalogo, guardados, campos) {
  const res = [];
  catalogo.forEach(e => {
    const g = guardados.find(x => x.id === e.id);
    if (e.activo || g) res.push(Object.assign({id: e.id, nombre: e.nombre}, Object.fromEntries(campos.map(k => [k, g ? +g[k] || 0 : 0]))));
  });
  guardados.forEach(g => { if (!res.find(x => x.id === g.id)) res.push(Object.assign({}, g)); });
  return res;
}

// Devuelve el cierre de esa fecha; si no existe, uno nuevo que hereda del último día anterior
async function cargarCierre(fecha) {
  const g = await Store.getCierre(fecha);
  let c;
  if (g) {
    c = Object.assign(cierreVacio(fecha), JSON.parse(JSON.stringify(g)));
    c.wu = Object.assign(cierreVacio(fecha).wu, g.wu); c.arqueo = Object.assign(cierreVacio(fecha).arqueo, g.arqueo);
    c.util = Object.assign(cierreVacio(fecha).util, g.util);
    c.guardado = true;
  } else {
    c = cierreVacio(fecha);
    const ant = await Store.anterior(fecha);
    if (ant) {
      c.tasaCambio = ant.tasaCambio; c.capitalTrabajoUSD = ant.capitalTrabajoUSD;
      c.util.tarifaMC = ant.util?.tarifaMC ?? CFG.tarifaMC; c.util.tarifaVT = ant.util?.tarifaVT ?? CFG.tarifaVT;
      c.cuentas = (ant.cuentas || []).filter(x => +x.monto > 0).map(x => Object.assign({}, x));   // solo pendientes
    }
  }
  c.bancos = unirLista(CFG.bancos, c.bancos || [], ["saldoUSD", "saldoNIO"]);
  c.cajas = unirLista(CFG.cajeros, c.cajas || [], ["montoNIO", "montoUSD"]);
  c.cajaFuerte = c.cajaFuerte || {};
  return c;
}

// =====================================================================
//  FÓRMULAS (las mismas del Excel / Calculos.cs)
// =====================================================================
function calcular(c) {
  const r = {}, w = c.wu, u = c.util, t = +c.tasaCambio || 0;
  r.wuTotalUSD = w.pagosUSD - w.enviosUSD - w.billersUSD;
  r.wuTotalNIO = w.pagosNIO - w.enviosNIO - w.billersNIO;
  r.wuConversionMC = t === 0 ? 0 : r.wuTotalNIO / t;
  r.wuMontoOP = r.wuTotalUSD;
  r.wuBillers = -r.wuConversionMC;
  r.wuTotal = r.wuMontoOP - r.wuBillers - w.airpakDiaAnteriorUSD - w.anticipoUSD;

  r.bancosUSD = sum(c.bancos, b => b.saldoUSD);
  r.bancosNIO = sum(c.bancos, b => b.saldoNIO);

  r.cajaFuerteNIO = sum(DENOMS.filter(d => d.moneda === "NIO"), d => d.valor * (c.cajaFuerte[d.id] || 0));
  r.cajaFuerteUSD = sum(DENOMS.filter(d => d.moneda === "USD"), d => d.valor * (c.cajaFuerte[d.id] || 0));

  r.cuentasNIO = sum(c.cuentas.filter(x => x.moneda === "NIO"), x => x.tipo === "P" ? -x.monto : x.monto);
  r.cuentasUSD = sum(c.cuentas.filter(x => x.moneda === "USD"), x => x.tipo === "P" ? -x.monto : x.monto);

  r.cajasNIO = sum(c.cajas, x => x.montoNIO);
  r.cajasUSD = sum(c.cajas, x => x.montoUSD);

  r.arqueoTotalNIO = r.bancosNIO + r.cajaFuerteNIO + r.cuentasNIO + r.cajasNIO + c.arqueo.tigoNIO + c.arqueo.recargasNIO;
  r.arqueoNIOenUSD = t === 0 ? 0 : r.arqueoTotalNIO / t;
  r.arqueoTotalUSD = r.bancosUSD + r.cajaFuerteUSD + r.cuentasUSD + r.cajasUSD + c.arqueo.datoAirpakUSD;
  r.arqueoTotal = r.arqueoNIOenUSD + r.arqueoTotalUSD;
  r.arqueoDiferencia = r.arqueoTotal - c.capitalTrabajoUSD;
  r.arqueoDiferenciaNIO = r.arqueoDiferencia * t;

  r.utilTotalMC = u.montoMC1 + u.montoMC2;
  r.utilTotalVentas = u.ventaKen1 + u.ventaKen2 + u.ventaDerrik1 + u.ventaDerrik2;
  r.utilMC = r.utilTotalMC * u.tarifaMC;
  r.utilVentas = r.utilTotalVentas * u.tarifaVT;
  r.utilTotal = u.banpro + u.bac + u.dhl + r.utilMC + r.utilVentas + u.loto + u.comisionesAir + u.cambioCK + u.otrosIngresos + u.ach + u.difPorMC;
  return r;
}
const estadoCuenta = m => m > 0 ? "PENDIENTE" : "PAGADO";

// =====================================================================
//  PANTALLA DEL CIERRE
// =====================================================================
let CI = null;          // cierre abierto
let sucio = false, guardando = false;
let campos = [], resultados = [];
let pestanaActual = 0;

function entrada(get, set, extra = "") {
  const i = campos.length;
  campos.push({get, set});
  return `<input class="num" data-c="${i}" inputmode="decimal" ${extra}>`;
}
function resultado(fn, s) {
  const i = resultados.length;
  resultados.push({fn, s});
  return `<span class="res" data-r="${i}"></span>`;
}
const fila = (...cs) => "<tr>" + cs.map((x, i) => `<td${i ? ' class="r"' : ""}>${x}</td>`).join("") + "</tr>";
const filaT = (...cs) => '<tr class="tot">' + cs.map((x, i) => `<td${i ? ' class="r"' : ""}>${i ? x : "<b>" + x + "</b>"}</td>`).join("") + "</tr>";
const cab = (...cs) => "<tr>" + cs.map((x, i) => `<th${i ? ' class="r"' : ""}>${x}</th>`).join("") + "</tr>";
const bloque = (t, html) => `<div class="bloque">${t ? `<h3>${t}</h3>` : ""}<div class="caja"><table class="f">${html}</table></div></div>`;

const HOJAS = [
  ["Movimiento WU", c => {
    const w = c.wu;
    return bloque("MOVIMIENTO DIARIO WU",
      cab("", "Dólares ($)", "Córdobas (C$)") +
      fila("Pagos remesas", entrada(() => w.pagosUSD, v => w.pagosUSD = v), entrada(() => w.pagosNIO, v => w.pagosNIO = v)) +
      fila("Envíos remesas", entrada(() => w.enviosUSD, v => w.enviosUSD = v), entrada(() => w.enviosNIO, v => w.enviosNIO = v)) +
      fila("Billers", entrada(() => w.billersUSD, v => w.billersUSD = v), entrada(() => w.billersNIO, v => w.billersNIO = v)) +
      filaT("TOTALES", resultado(r => r.wuTotalUSD, "$"), resultado(r => r.wuTotalNIO, "C$")) +
      fila("Conversión MC (C$ a $)", "", resultado(r => r.wuConversionMC, "$"))) +
    bloque("SALDOS PENDIENTES",
      fila("Airpak día anterior ($)", entrada(() => w.airpakDiaAnteriorUSD, v => w.airpakDiaAnteriorUSD = v)) +
      fila("Anticipo ($)", entrada(() => w.anticipoUSD, v => w.anticipoUSD = v)) +
      fila("Monto OP", resultado(r => r.wuMontoOP, "$")) +
      fila("Billers", resultado(r => r.wuBillers, "$")) +
      filaT("TOTAL (Monto OP - Billers - Día anterior - Anticipo)", resultado(r => r.wuTotal, "$")));
  }],
  ["Bancos", c => bloque("SALDOS EN BANCOS",
      cab("Banco", "Dólares ($)", "Córdobas (C$)") +
      c.bancos.map(b => fila(esc(b.nombre), entrada(() => b.saldoUSD, v => b.saldoUSD = v), entrada(() => b.saldoNIO, v => b.saldoNIO = v))).join("") +
      filaT("TOTALES", resultado(r => r.bancosUSD, "$"), resultado(r => r.bancosNIO, "C$")))],
  ["Caja fuerte", c => ["NIO", "USD"].map(m => {
      const s = m === "NIO" ? "C$" : "$";
      return bloque(m === "NIO" ? "CÓRDOBAS (C$)" : "DÓLARES ($)",
        cab("Denominación", "Cantidad", "Total") +
        DENOMS.filter(d => d.moneda === m).map(d => fila(
          (d.tipo === "MONEDA" ? "Moneda de " : "Billete de ") + s + d.valor,
          entrada(() => c.cajaFuerte[d.id] || 0, v => c.cajaFuerte[d.id] = Math.round(v)),
          resultado(() => d.valor * (c.cajaFuerte[d.id] || 0), s))).join("") +
        filaT("TOTAL", "", resultado(r => m === "NIO" ? r.cajaFuerteNIO : r.cajaFuerteUSD, s)));
    }).join("")],
  ["Cuentas CxC / CxP", c => `
      <p class="nota">Una cuenta por fila. Las que siguen pendientes (monto mayor que 0) pasan solas al día siguiente.</p>
      <div class="bloque" style="overflow-x:auto"><table class="g" id="gCuentas"><thead><tr><th>Tipo</th><th>Nombre</th><th style="text-align:right">Monto</th><th>Moneda</th><th>Estado</th><th></th></tr></thead><tbody></tbody></table>
      <p><button class="btn sec chico" id="addCuenta">+ Agregar cuenta</button></p></div>` +
      bloque("", filaT("Total C$ (por cobrar - por pagar)", resultado(r => r.cuentasNIO, "C$")) +
                 filaT("Total $ (por cobrar - por pagar)", resultado(r => r.cuentasUSD, "$")))],
  ["Cajas", c => bloque("CONTEO DE CAJAS",
      cab("Cajero", "Dólares ($)", "Córdobas (C$)") +
      c.cajas.map(x => fila(esc(x.nombre), entrada(() => x.montoUSD, v => x.montoUSD = v), entrada(() => x.montoNIO, v => x.montoNIO = v))).join("") +
      filaT("TOTAL", resultado(r => r.cajasUSD, "$"), resultado(r => r.cajasNIO, "C$")))],
  ["Arqueo", c => bloque("ARQUEO",
      cab("Cuenta", "Córdobas (C$)", "Dólares ($)") +
      c.bancos.map(b => fila(esc(b.nombre), resultado(() => b.saldoNIO, "C$"), resultado(() => b.saldoUSD, "$"))).join("") +
      fila("Caja fuerte", resultado(r => r.cajaFuerteNIO, "C$"), resultado(r => r.cajaFuerteUSD, "$")) +
      fila("Cuentas por cobrar - por pagar", resultado(r => r.cuentasNIO, "C$"), resultado(r => r.cuentasUSD, "$")) +
      c.cajas.map(x => fila("Caja " + esc(x.nombre), resultado(() => x.montoNIO, "C$"), resultado(() => x.montoUSD, "$"))).join("") +
      fila("Tigo", entrada(() => c.arqueo.tigoNIO, v => c.arqueo.tigoNIO = v), "") +
      fila("Recargas", entrada(() => c.arqueo.recargasNIO, v => c.arqueo.recargasNIO = v), "") +
      fila("Dato Airpak", "", entrada(() => c.arqueo.datoAirpakUSD, v => c.arqueo.datoAirpakUSD = v)) +
      filaT("TOTAL", resultado(r => r.arqueoTotalNIO, "C$"), resultado(r => r.arqueoTotalUSD, "$"))) +
    bloque("DIFERENCIA CONTRA EL CAPITAL DE TRABAJO",
      fila("Total C$ convertido a $ (tasa del día)", resultado(r => r.arqueoNIOenUSD, "$")) +
      filaT("TOTAL GENERAL ($)", resultado(r => r.arqueoTotal, "$")) +
      fila("Capital de trabajo ($)", entrada(() => c.capitalTrabajoUSD, v => c.capitalTrabajoUSD = v)) +
      filaT("DIFERENCIA ($)", resultado(r => r.arqueoDiferencia, "$")) +
      fila("Diferencia en C$ (a la tasa del día)", resultado(r => r.arqueoDiferenciaNIO, "C$"))) +
    `<div class="bloque"><h3>OBSERVACIONES DEL DÍA</h3><textarea id="obs" rows="3" style="width:min(560px,100%)"></textarea></div>`],
  ["Utilidades", c => {
    const u = c.util, e = (k) => entrada(() => u[k], v => u[k] = v);
    return bloque("MC Y VENTAS (en dólares)",
      fila("Monto MC 1 ($)", e("montoMC1")) + fila("Monto MC 2 ($)", e("montoMC2")) +
      filaT("Total MC ($)", resultado(r => r.utilTotalMC, "$")) +
      fila("Tarifa MC (C$ por cada $)", e("tarifaMC")) +
      fila("Venta $ KEN 1", e("ventaKen1")) + fila("Venta $ KEN 2", e("ventaKen2")) +
      fila("Venta $ DERRIK 1", e("ventaDerrik1")) + fila("Venta $ DERRIK 2", e("ventaDerrik2")) +
      filaT("Total ventas ($)", resultado(r => r.utilTotalVentas, "$")) +
      fila("Puntos VT (C$ por cada $)", e("tarifaVT"))) +
    bloque("UTILIDAD DEL DÍA (en córdobas)",
      fila("BANPRO", e("banpro")) + fila("BAC", e("bac")) + fila("DHL", e("dhl")) +
      fila("MC (total MC x tarifa)", resultado(r => r.utilMC, "C$")) +
      fila("VENTA $ (total ventas x puntos VT)", resultado(r => r.utilVentas, "C$")) +
      fila("LOTO", e("loto")) + fila("COMISIONES AIR", e("comisionesAir")) + fila("CAMBIO CK", e("cambioCK")) +
      fila("OTROS INGRESOS", e("otrosIngresos")) + fila("ACH", e("ach")) + fila("DIF X MC", e("difPorMC")) +
      filaT("TOTAL", resultado(r => r.utilTotal, "C$")));
  }]
];

function construir() {
  campos = []; resultados = [];
  $("pestanas").innerHTML = HOJAS.map((h, i) => `<button data-p="${i}" class="${i === pestanaActual ? "activo" : ""}">${h[0]}</button>`).join("");
  $("hojas").innerHTML = HOJAS.map((h, i) => `<div class="hoja ${i === pestanaActual ? "activa" : ""}">${h[1](CI)}</div>`).join("");
  $("addCuenta").onclick = () => { CI.cuentas.push({tipo: "C", nombre: "", monto: 0, moneda: "NIO"}); pintarCuentas(); marcarSucio(); const ins = document.querySelectorAll("#gCuentas tbody input.txt"); ins[ins.length - 1]?.focus(); };
  $("obs").addEventListener("input", e => { CI.observaciones = e.target.value; marcarSucio(); });
}

function pintarCuentas() {
  const ro = CI.estado === "CERRADO";
  $("gCuentas").querySelector("tbody").innerHTML = CI.cuentas.length ? CI.cuentas.map((x, i) => `<tr data-i="${i}">
    <td><select class="sel" data-f="tipo" ${ro ? "disabled" : ""}><option value="C" ${x.tipo === "C" ? "selected" : ""}>Por cobrar</option><option value="P" ${x.tipo === "P" ? "selected" : ""}>Por pagar</option></select></td>
    <td><input class="txt" data-f="nombre" style="width:240px" value="${esc(x.nombre)}" ${ro ? "readonly" : ""}></td>
    <td><input class="num" data-f="monto" value="${Texto(x.monto)}" ${ro ? "readonly" : ""} style="width:130px"></td>
    <td><select class="sel" data-f="moneda" ${ro ? "disabled" : ""}><option value="NIO" ${x.moneda === "NIO" ? "selected" : ""}>C$</option><option value="USD" ${x.moneda === "USD" ? "selected" : ""}>$</option></select></td>
    <td><span class="pill ${x.monto > 0 ? "p" : "ok"}">${estadoCuenta(x.monto)}</span></td>
    <td>${ro ? "" : '<button class="btn sec chico" data-del title="Borrar">✕</button>'}</td></tr>`).join("")
    : `<tr><td colspan="6" style="color:var(--suave);padding:12px">No hay cuentas.</td></tr>`;
  $("addCuenta").style.display = ro ? "none" : "";
}

function mostrar() {
  $("fecha").value = CI.fecha;
  $("tasa").value = Texto(CI.tasaCambio);
  campos.forEach((c, i) => { const el = document.querySelector(`[data-c="${i}"]`); el.value = Texto(c.get()); el.classList.remove("mal"); });
  $("obs").value = CI.observaciones || "";
  pintarCuentas();
  const ro = CI.estado === "CERRADO";
  document.querySelectorAll("#hojas input.num, #tasa, #obs").forEach(el => el.readOnly = ro);
  $("bGuardar").disabled = ro;
  $("bCerrar").textContent = ro ? "Reabrir día" : "Cerrar día";
  sucio = false;
  actualizarEstado();
}

function recalcular() {
  const r = calcular(CI);
  resultados.forEach((x, i) => {
    const v = R2(x.fn(r)), el = document.querySelector(`[data-r="${i}"]`);
    el.textContent = Mon(v, x.s); el.classList.toggle("neg", v < 0);
  });
  $("kWu").textContent = D(r.wuTotal); $("kWu").style.color = R2(r.wuTotal) < 0 ? "var(--peligro)" : "";
  $("kArq").textContent = D(r.arqueoTotal);
  $("kUtil").textContent = C(r.utilTotal); $("kUtil").style.color = R2(r.utilTotal) < 0 ? "var(--peligro)" : "";
  const dif = R2(r.arqueoDiferencia);
  let col, nota;
  if (dif === 0) { col = "var(--exito)"; nota = "✓ Cuadra con el capital"; }
  else if (dif < 0) { col = "var(--peligro)"; nota = "Faltante  (" + C(r.arqueoDiferenciaNIO) + ")"; }
  else { col = "var(--aviso)"; nota = "Sobrante  (" + C(r.arqueoDiferenciaNIO) + ")"; }
  $("kDif").textContent = D(dif); $("kDif").style.color = col; $("kDifN").textContent = nota; $("kDifN").style.color = col;
  $("kDifT").style.setProperty("--c", col);
}

function actualizarEstado() {
  const e = $("estado"), d = F(CI.fecha);
  if (CI.estado === "CERRADO") { e.textContent = d + " - DÍA CERRADO"; e.style.background = "var(--peligro)"; }
  else if (!CI.guardado) { e.textContent = d + " - día nuevo (sin guardar)"; e.style.background = "var(--aviso)"; }
  else { e.textContent = d + (sucio ? " - cambios sin guardar" : " - día abierto"); e.style.background = sucio ? "var(--aviso)" : "var(--exito)"; }
}
function marcarSucio() { if (!sucio) { sucio = true; actualizarEstado(); } recalcular(); }

// Lee todas las casillas; devuelve false si hay alguna mal escrita
function leerPantalla() {
  let ok = true;
  const t = TryNumero($("tasa").value); $("tasa").classList.toggle("mal", !t.ok); ok &= t.ok; CI.tasaCambio = t.v;
  campos.forEach((c, i) => { const el = document.querySelector(`[data-c="${i}"]`); const n = TryNumero(el.value); el.classList.toggle("mal", !n.ok); ok &= n.ok; c.set(n.v); });
  document.querySelectorAll('#gCuentas input[data-f="monto"]').forEach(el => { const n = TryNumero(el.value); el.classList.toggle("mal", !n.ok); ok &= n.ok; });
  return !!ok;
}

document.addEventListener("input", e => {
  const el = e.target;
  if (!CI) return;
  if (el.dataset.c !== undefined) {
    const n = TryNumero(el.value); el.classList.toggle("mal", !n.ok); campos[+el.dataset.c].set(n.v); marcarSucio();
  } else if (el.id === "tasa") {
    const n = TryNumero(el.value); el.classList.toggle("mal", !n.ok); CI.tasaCambio = n.v; marcarSucio();
  } else if (el.closest("#gCuentas")) {
    const i = +el.closest("tr").dataset.i, f = el.dataset.f, x = CI.cuentas[i];
    if (f === "monto") {
      const n = TryNumero(el.value); el.classList.toggle("mal", !n.ok); x.monto = n.v;
      const p = el.closest("tr").querySelector(".pill"); p.textContent = estadoCuenta(x.monto); p.className = "pill " + (x.monto > 0 ? "p" : "ok");
    } else x[f] = el.value;
    marcarSucio();
  }
});
document.addEventListener("change", e => { if (e.target.closest("#gCuentas") && e.target.tagName === "SELECT") { CI.cuentas[+e.target.closest("tr").dataset.i][e.target.dataset.f] = e.target.value; marcarSucio(); } });
document.addEventListener("click", e => {
  const b = e.target.closest("[data-del]");
  if (b && b.closest("#gCuentas")) { CI.cuentas.splice(+b.closest("tr").dataset.i, 1); pintarCuentas(); marcarSucio(); }
  const p = e.target.closest("[data-p]");
  if (p) {
    pestanaActual = +p.dataset.p;
    document.querySelectorAll("#pestanas button").forEach((x, i) => x.classList.toggle("activo", i === pestanaActual));
    document.querySelectorAll("#hojas .hoja").forEach((x, i) => x.classList.toggle("activa", i === pestanaActual));
  }
});

async function abrirDia(fecha) {
  if (sucio && !(await preguntar("Hay cambios sin guardar en el día " + F(CI.fecha) + ". ¿Quieres descartarlos?", "Descartar"))) { $("fecha").value = CI.fecha; return; }
  try {
    $("hojas").innerHTML = '<div class="cargando">Cargando ' + F(fecha) + "…</div>";
    CI = await cargarCierre(fecha);
  } catch (err) {
    notificar("No se pudo abrir el día: " + (err.message || err), "var(--peligro)");
    if (CI) { construir(); mostrar(); recalcular(); }
    return;
  }
  construir(); mostrar(); recalcular();
}

async function guardar(nuevoEstado) {
  if (guardando || !CI) return false;
  if (!leerPantalla()) { notificar("Hay casillas con números mal escritos (en rosa). Corrígelas y guarda otra vez.", "var(--aviso)"); return false; }
  if (!(CI.tasaCambio > 0)) { notificar("Escribe una tasa de cambio mayor que cero.", "var(--aviso)"); return false; }
  const anterior = CI.estado;
  if (nuevoEstado) CI.estado = nuevoEstado;
  guardando = true;
  try {
    const datos = Object.assign({}, CI, {
      cuentas: CI.cuentas.filter(x => x.nombre.trim() !== "" || x.monto !== 0).map(x => ({tipo: x.tipo, nombre: x.nombre.trim(), monto: x.monto, moneda: x.moneda})),
      actualizado: new Date().toISOString()
    });
    delete datos.guardado;
    if (CI.estado === "CERRADO" && !CI.cerradoEn) datos.cerradoEn = CI.cerradoEn = new Date().toISOString();
    if (CI.estado !== "CERRADO") { delete datos.cerradoEn; delete CI.cerradoEn; }
    const g = await Store.setCierre(datos);
    CI.cuentas = datos.cuentas.map(x => Object.assign({}, x));
    if (g) { CI.bancos = unirLista(CFG.bancos, g.bancos || [], ["saldoUSD", "saldoNIO"]); CI.cajas = unirLista(CFG.cajeros, g.cajas || [], ["montoNIO", "montoUSD"]); construir(); }
    CI.guardado = true; sucio = false;
    return true;
  } catch (err) {
    CI.estado = anterior;
    notificar("No se pudo guardar. " + (err.message || err), "var(--peligro)");
    return false;
  } finally { guardando = false; }
}

$("bGuardar").onclick = async () => { if (CI.estado === "CERRADO") return; if (await guardar()) { mostrar(); recalcular(); notificar("✓  Cierre del " + F(CI.fecha) + " guardado"); } };
$("bCerrar").onclick = async () => {
  const cerrando = CI.estado !== "CERRADO";
  if (!(await preguntar(cerrando ? "¿Cerrar este día? No podrás editarlo hasta que lo reabras." : "¿Reabrir este día para poder editarlo?", cerrando ? "Cerrar día" : "Reabrir"))) return;
  if (await guardar(cerrando ? "CERRADO" : "ABIERTO")) { mostrar(); recalcular(); notificar(cerrando ? "Día cerrado" : "Día reabierto", cerrando ? "var(--neutro)" : "var(--exito)"); }
};
$("bPdf").onclick = () => { leerPantalla(); exportarPdf(repDelDia(CI, sucio || !CI.guardado), "Cierre " + CI.fecha + ".pdf"); };
$("fecha").addEventListener("change", e => { if (e.target.value && e.target.value !== CI.fecha) abrirDia(e.target.value); });
$("bAnt").onclick = () => abrirDia(sumarDias(CI.fecha, -1));
$("bSig").onclick = () => abrirDia(sumarDias(CI.fecha, 1));
$("bHoy").onclick = () => abrirDia(hoyISO());

document.addEventListener("keydown", e => {
  if (!$("v-cierre").classList.contains("activa") || !CI) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); $("bGuardar").click(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); $("bPdf").click(); }
  else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); $("bAnt").click(); }
  else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); $("bSig").click(); }
});
window.addEventListener("beforeunload", e => { if (sucio) { e.preventDefault(); e.returnValue = ""; } });

// =====================================================================
//  NAVEGACIÓN
// =====================================================================
function mostrarVista(v) {
  document.querySelectorAll(".menu nav button").forEach(b => b.classList.toggle("activo", b.dataset.v === v));
  document.querySelectorAll(".vista").forEach(s => s.classList.toggle("activa", s.id === "v-" + v));
  if (v === "config") pintarConfig();
}
document.querySelectorAll(".menu nav button").forEach(b => b.onclick = () => mostrarVista(b.dataset.v));

// =====================================================================
//  REPORTES (misma estructura que Reportes.cs)
// =====================================================================
const REP = {
  dia: "Cierre completo de un día", cuentas: "Cuentas por cobrar y por pagar (un día)", resumen: "Resumen de cierres del período",
  wu: "Movimiento WU del período", bancos: "Saldos en bancos del período", efectivo: "Caja fuerte y cajas del período", util: "Utilidades del período"
};
const nuevaSec = (titulo) => ({titulo, cols: [], filas: [], total: null, fechas: []});
const col = (s, t, num = true, w = 1) => (s.cols.push({t, num, w}), s);
const nuevoRep = o => Object.assign({titulo: "", subtitulo: "", horizontal: false, firmas: false, aviso: "", notas: "", inds: [], secs: []}, o);
const Rango = (d, h) => `Del ${F(d)} al ${F(h)}`;

function secCuentas(c, r, titulo) {
  const s = nuevaSec(titulo); col(s, "Tipo", false); col(s, "Nombre", false, 2.2); col(s, "Moneda", false, .7); col(s, "Monto"); col(s, "Estado", false);
  [...c.cuentas].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.nombre.localeCompare(b.nombre)).forEach(x =>
    s.filas.push([x.tipo === "P" ? "Por pagar" : "Por cobrar", x.nombre, x.moneda === "USD" ? "$" : "C$", Mon(x.monto, x.moneda === "USD" ? "$" : "C$"), estadoCuenta(x.monto)]));
  if (!s.filas.length) s.filas.push(["", "(no hay cuentas)", "", "", ""]);
  s.total = ["NETO", "por cobrar - por pagar", "", C(r.cuentasNIO) + "  /  " + D(r.cuentasUSD), ""];
  return s;
}

function repDelDia(c, borrador = false) {
  const r = calcular(c), u = c.util;
  const rep = nuevoRep({titulo: "CIERRE DIARIO", subtitulo: `Fecha: ${F(c.fecha)}   ·   Tasa: ${(+c.tasaCambio).toFixed(4)}   ·   ${c.estado === "CERRADO" ? "DÍA CERRADO" : "DÍA ABIERTO"}`,
    firmas: true, aviso: borrador ? "BORRADOR - hay cambios sin guardar" : "", notas: c.observaciones});
  rep.inds.push(["Total WU (saldos)", D(r.wuTotal), R2(r.wuTotal) < 0], ["Arqueo total", D(r.arqueoTotal), R2(r.arqueoTotal) < 0],
                ["Diferencia vs capital", D(r.arqueoDiferencia), R2(r.arqueoDiferencia) < 0], ["Utilidad del día", C(r.utilTotal), R2(r.utilTotal) < 0]);
  let s = nuevaSec("1. Movimiento diario WU"); col(s, "Concepto", false, 2); col(s, "Dólares"); col(s, "Córdobas");
  s.filas.push(["Pagos remesas", D(c.wu.pagosUSD), C(c.wu.pagosNIO)], ["Envíos remesas", D(c.wu.enviosUSD), C(c.wu.enviosNIO)],
               ["Billers", D(c.wu.billersUSD), C(c.wu.billersNIO)], ["Conversión MC (C$ a $)", D(r.wuConversionMC), ""]);
  s.total = ["TOTALES", D(r.wuTotalUSD), C(r.wuTotalNIO)]; rep.secs.push(s);
  s = nuevaSec("2. Saldos pendientes WU"); col(s, "Concepto", false, 2); col(s, "Dólares");
  s.filas.push(["Monto OP", D(r.wuMontoOP)], ["Billers", D(r.wuBillers)], ["Airpak día anterior", D(c.wu.airpakDiaAnteriorUSD)], ["Anticipo", D(c.wu.anticipoUSD)]);
  s.total = ["TOTAL", D(r.wuTotal)]; rep.secs.push(s);
  s = nuevaSec("3. Saldos en bancos"); col(s, "Banco", false, 2); col(s, "Dólares"); col(s, "Córdobas");
  c.bancos.forEach(b => s.filas.push([b.nombre, D(b.saldoUSD), C(b.saldoNIO)])); s.total = ["TOTALES", D(r.bancosUSD), C(r.bancosNIO)]; rep.secs.push(s);
  ["NIO", "USD"].forEach(m => {
    const sm = m === "NIO" ? "C$" : "$";
    const cf = nuevaSec(m === "NIO" ? "4. Caja fuerte - Córdobas" : "5. Caja fuerte - Dólares"); col(cf, "Denominación", false, 2); col(cf, "Cantidad"); col(cf, "Total");
    DENOMS.filter(d => d.moneda === m && c.cajaFuerte[d.id]).forEach(d => cf.filas.push([(d.tipo === "MONEDA" ? "Moneda de " : "Billete de ") + sm + d.valor, (c.cajaFuerte[d.id]).toLocaleString("en-US"), Mon(d.valor * c.cajaFuerte[d.id], sm)]));
    if (!cf.filas.length) cf.filas.push(["(sin conteo)", "", ""]);
    cf.total = ["TOTAL", "", m === "NIO" ? C(r.cajaFuerteNIO) : D(r.cajaFuerteUSD)]; rep.secs.push(cf);
  });
  rep.secs.push(secCuentas(c, r, "6. Cuentas por cobrar y por pagar"));
  s = nuevaSec("7. Conteo de cajas"); col(s, "Cajero", false, 2); col(s, "Dólares"); col(s, "Córdobas");
  c.cajas.forEach(x => s.filas.push([x.nombre, D(x.montoUSD), C(x.montoNIO)])); s.total = ["TOTAL", D(r.cajasUSD), C(r.cajasNIO)]; rep.secs.push(s);
  s = nuevaSec("8. Arqueo"); col(s, "Cuenta", false, 2); col(s, "Córdobas"); col(s, "Dólares");
  c.bancos.forEach(b => s.filas.push([b.nombre, C(b.saldoNIO), D(b.saldoUSD)]));
  s.filas.push(["Caja fuerte", C(r.cajaFuerteNIO), D(r.cajaFuerteUSD)], ["Cuentas (cobrar - pagar)", C(r.cuentasNIO), D(r.cuentasUSD)]);
  c.cajas.forEach(x => s.filas.push(["Caja " + x.nombre, C(x.montoNIO), D(x.montoUSD)]));
  s.filas.push(["Tigo", C(c.arqueo.tigoNIO), ""], ["Recargas", C(c.arqueo.recargasNIO), ""], ["Dato Airpak", "", D(c.arqueo.datoAirpakUSD)]);
  s.total = ["TOTAL", C(r.arqueoTotalNIO), D(r.arqueoTotalUSD)]; rep.secs.push(s);
  s = nuevaSec("9. Diferencia contra el capital de trabajo"); col(s, "Concepto", false, 2); col(s, "Valor");
  s.filas.push(["Total C$ convertido a $ (tasa del día)", D(r.arqueoNIOenUSD)], ["Total general", D(r.arqueoTotal)], ["Capital de trabajo", D(c.capitalTrabajoUSD)], ["Diferencia en córdobas", C(r.arqueoDiferenciaNIO)]);
  s.total = ["DIFERENCIA ($)", D(r.arqueoDiferencia)]; rep.secs.push(s);
  s = nuevaSec("10. Utilidades del día"); col(s, "Concepto", false, 2); col(s, "Valor");
  s.filas.push(["Total MC (dólares)", D(r.utilTotalMC)], ["Total ventas (dólares)", D(r.utilTotalVentas)], ["BANPRO", C(u.banpro)], ["BAC", C(u.bac)], ["DHL", C(u.dhl)],
    [`MC (x ${+u.tarifaMC})`, C(r.utilMC)], [`VENTA $ (x ${+u.tarifaVT})`, C(r.utilVentas)], ["LOTO", C(u.loto)], ["COMISIONES AIR", C(u.comisionesAir)],
    ["CAMBIO CK", C(u.cambioCK)], ["OTROS INGRESOS", C(u.otrosIngresos)], ["ACH", C(u.ach)], ["DIF X MC", C(u.difPorMC)]);
  s.total = ["UTILIDAD TOTAL", C(r.utilTotal)]; rep.secs.push(s);
  return rep;
}

function repCuentas(c) {
  const r = calcular(c), q = (t, m) => sum(c.cuentas.filter(x => x.tipo === t && x.moneda === m), x => x.monto);
  const rep = nuevoRep({titulo: "CUENTAS POR COBRAR Y POR PAGAR", subtitulo: "Al " + F(c.fecha)});
  rep.inds.push(["Por cobrar", C(q("C", "NIO")) + " / " + D(q("C", "USD"))], ["Por pagar", C(q("P", "NIO")) + " / " + D(q("P", "USD"))],
                ["Pendientes", String(c.cuentas.filter(x => x.monto > 0).length)]);
  rep.secs.push(secCuentas(c, r, "Detalle de cuentas"));
  return rep;
}

function repResumen(cs, d, h) {
  const rep = nuevoRep({titulo: "RESUMEN DE CIERRES", subtitulo: Rango(d, h), horizontal: true});
  const s = nuevaSec("Cierres guardados"); col(s, "Fecha", false); col(s, "Estado", false); col(s, "Tasa", true, .7);
  ["Total WU $", "Bancos $", "Bancos C$", "Arqueo total $", "Diferencia $", "Utilidad C$"].forEach(t => col(s, t));
  let sw = 0, su = 0;
  cs.forEach(c => { const r = calcular(c); sw += r.wuTotal; su += r.utilTotal;
    s.filas.push([F(c.fecha), c.estado, (+c.tasaCambio).toFixed(2), D(r.wuTotal), D(r.bancosUSD), C(r.bancosNIO), D(r.arqueoTotal), D(r.arqueoDiferencia), C(r.utilTotal)]); s.fechas.push(c.fecha); });
  s.total = ["TOTAL", cs.length + " días", "", D(sw), "", "", "", "", C(su)]; rep.secs.push(s);
  rep.inds.push(["Días guardados", String(cs.length)], ["Días cerrados", String(cs.filter(x => x.estado === "CERRADO").length)],
                ["Utilidad del período", C(su), R2(su) < 0], ["Promedio diario", C(cs.length ? su / cs.length : 0)]);
  return rep;
}

function repWu(cs, d, h) {
  const rep = nuevoRep({titulo: "MOVIMIENTO WU", subtitulo: Rango(d, h), horizontal: true});
  const s = nuevaSec("Movimiento diario WU"); col(s, "Fecha", false);
  ["Pagos $", "Envíos $", "Billers $", "Total $", "Pagos C$", "Envíos C$", "Billers C$", "Total C$", "Conversión $", "TOTAL saldos $"].forEach(t => col(s, t));
  const t = Array(10).fill(0);
  cs.forEach(c => { const r = calcular(c), w = c.wu;
    const v = [w.pagosUSD, w.enviosUSD, w.billersUSD, r.wuTotalUSD, w.pagosNIO, w.enviosNIO, w.billersNIO, r.wuTotalNIO, r.wuConversionMC, r.wuTotal];
    v.forEach((x, i) => t[i] += x);
    s.filas.push([F(c.fecha), D(v[0]), D(v[1]), D(v[2]), D(v[3]), C(v[4]), C(v[5]), C(v[6]), C(v[7]), D(v[8]), D(v[9])]); s.fechas.push(c.fecha); });
  s.total = ["TOTAL", D(t[0]), D(t[1]), D(t[2]), D(t[3]), C(t[4]), C(t[5]), C(t[6]), C(t[7]), D(t[8]), D(t[9])]; rep.secs.push(s);
  rep.inds.push(["Pagos del período", D(t[0]) + " / " + C(t[4])], ["Envíos del período", D(t[1]) + " / " + C(t[5])], ["Billers del período", D(t[2]) + " / " + C(t[6])]);
  return rep;
}

function repBancos(cs, d, h) {
  const rep = nuevoRep({titulo: "SALDOS EN BANCOS", subtitulo: Rango(d, h), horizontal: true});
  const nombres = [...new Set(cs.flatMap(c => c.bancos.map(b => b.nombre)))];
  const s = nuevaSec("Saldo de cada banco al final del día"); col(s, "Fecha", false);
  nombres.forEach(n => { col(s, n + " $"); col(s, n + " C$"); }); col(s, "Total $"); col(s, "Total C$");
  cs.forEach(c => { const f = [F(c.fecha)];
    nombres.forEach(n => { const b = c.bancos.find(x => x.nombre === n); f.push(D(b?.saldoUSD || 0), C(b?.saldoNIO || 0)); });
    f.push(D(sum(c.bancos, x => x.saldoUSD)), C(sum(c.bancos, x => x.saldoNIO))); s.filas.push(f); s.fechas.push(c.fecha); });
  rep.secs.push(s);
  if (cs.length) { const u = cs[cs.length - 1];
    rep.inds.push(["Último saldo $ (" + F(u.fecha) + ")", D(sum(u.bancos, x => x.saldoUSD))], ["Último saldo C$ (" + F(u.fecha) + ")", C(sum(u.bancos, x => x.saldoNIO))]); }
  return rep;
}

function repEfectivo(cs, d, h) {
  const rep = nuevoRep({titulo: "CAJA FUERTE Y CAJAS", subtitulo: Rango(d, h), horizontal: true});
  const cajeros = [...new Set(cs.flatMap(c => c.cajas.map(x => x.nombre)))];
  const s = nuevaSec("Efectivo al final del día"); col(s, "Fecha", false); col(s, "Caja fuerte C$"); col(s, "Caja fuerte $");
  cajeros.forEach(n => { col(s, "Caja " + n + " C$"); col(s, "Caja " + n + " $"); }); col(s, "Tigo C$"); col(s, "Recargas C$"); col(s, "Airpak $");
  cs.forEach(c => { const r = calcular(c), f = [F(c.fecha), C(r.cajaFuerteNIO), D(r.cajaFuerteUSD)];
    cajeros.forEach(n => { const x = c.cajas.find(k => k.nombre === n); f.push(C(x?.montoNIO || 0), D(x?.montoUSD || 0)); });
    f.push(C(c.arqueo.tigoNIO), C(c.arqueo.recargasNIO), D(c.arqueo.datoAirpakUSD)); s.filas.push(f); s.fechas.push(c.fecha); });
  rep.secs.push(s);
  return rep;
}

function repUtil(cs, d, h) {
  const rep = nuevoRep({titulo: "UTILIDADES", subtitulo: Rango(d, h), horizontal: true});
  const s = nuevaSec("Utilidad diaria (córdobas)"); col(s, "Fecha", false); col(s, "MC $"); col(s, "Ventas $");
  ["BANPRO", "BAC", "DHL", "MC", "VENTA $", "LOTO", "COM. AIR", "CAMBIO CK", "OTROS", "ACH", "DIF X MC"].forEach(t => col(s, t)); col(s, "TOTAL", true, 1.2);
  const t = Array(14).fill(0);
  cs.forEach(c => { const r = calcular(c), u = c.util;
    const v = [r.utilTotalMC, r.utilTotalVentas, u.banpro, u.bac, u.dhl, r.utilMC, r.utilVentas, u.loto, u.comisionesAir, u.cambioCK, u.otrosIngresos, u.ach, u.difPorMC, r.utilTotal];
    v.forEach((x, i) => t[i] += x);
    s.filas.push([F(c.fecha), D(v[0]), D(v[1]), ...v.slice(2).map(Num)]); s.fechas.push(c.fecha); });
  s.total = ["TOTAL", D(t[0]), D(t[1]), ...t.slice(2).map(Num)]; rep.secs.push(s);
  rep.inds.push(["Utilidad total", C(t[13]), R2(t[13]) < 0], ["Promedio diario", C(cs.length ? t[13] / cs.length : 0)], ["MC del período", D(t[0])], ["Ventas del período", D(t[1])]);
  return rep;
}

function pintarReporte(rep) {
  const ag = [CFG.direccion, CFG.telefono && "Tel. " + CFG.telefono, CFG.ruc && "RUC " + CFG.ruc].filter(Boolean).join("   ·   ");
  let h = `<div class="hojarep"><div class="ag">${esc(CFG.nombreAgencia)}</div><div class="agd">${esc(ag)}</div>
    <h2>${esc(rep.titulo)}</h2><div class="nota">${esc(rep.subtitulo)}</div>${rep.aviso ? `<div class="aviso">${esc(rep.aviso)}</div>` : ""}
    ${rep.inds.length ? `<div class="inds">${rep.inds.map(i => `<div class="ind"><div class="t">${esc(i[0])}</div><div class="v ${i[2] ? "neg" : ""}">${esc(i[1])}</div></div>`).join("")}</div>` : ""}`;
  rep.secs.forEach(s => {
    h += `<div class="sec"><h4>${esc(s.titulo)}</h4><table class="r"><tr>${s.cols.map(c => `<th class="${c.num ? "n" : ""}">${esc(c.t)}</th>`).join("")}</tr>`;
    if (!s.filas.length) h += `<tr><td colspan="${s.cols.length}" style="color:var(--suave)">No hay cierres guardados en este período.</td></tr>`;
    s.filas.forEach((f, i) => { const fe = s.fechas[i];
      h += `<tr${fe ? ` class="click" data-abrir="${fe}" title="Abrir este día"` : ""}>${f.map((x, j) => `<td class="${s.cols[j]?.num ? "n" : ""}">${esc(x)}</td>`).join("")}</tr>`; });
    if (s.total) h += `<tr class="tt">${s.total.map((x, j) => `<td class="${s.cols[j]?.num ? "n" : ""}">${esc(x)}</td>`).join("")}</tr>`;
    h += "</table></div>";
  });
  if (rep.notas) h += `<div class="sec"><h4>Observaciones</h4><p>${esc(rep.notas)}</p></div>`;
  if (rep.firmas) h += `<div class="firmas"><div>Elaborado por${CFG.responsable ? ": " + esc(CFG.responsable) : ""}</div><div>Revisado por</div></div>`;
  $("rSalida").innerHTML = h + "</div>";
}

let repActual = null, repNombre = "";
async function generarReporte() {
  const tipo = $("rTipo").value;
  $("rSalida").innerHTML = '<div class="hojarep"><div class="cargando">Preparando reporte…</div></div>';
  $("rPdf").disabled = true;
  try {
    if (tipo === "dia" || tipo === "cuentas") {
      const f = $("rDia").value || hoyISO();
      const c = await cargarCierre(f);
      repActual = tipo === "dia" ? repDelDia(c, !c.guardado) : repCuentas(c);
      if (tipo === "dia" && !c.guardado) repActual.aviso = "Este día todavía no se ha guardado";
      repNombre = (tipo === "dia" ? "Cierre " : "Cuentas ") + f + ".pdf";
    } else {
      let d = $("rDesde").value, h = $("rHasta").value;
      if (!d || !h) { notificar("Elige las fechas desde y hasta.", "var(--aviso)"); return; }
      if (d > h) [d, h] = [h, d];
      const cs = (await Store.periodo(d, h)).map(g => { const c = Object.assign(cierreVacio(g.fecha), g); c.wu = Object.assign(cierreVacio(g.fecha).wu, g.wu); c.arqueo = Object.assign(cierreVacio(g.fecha).arqueo, g.arqueo); c.util = Object.assign(cierreVacio(g.fecha).util, g.util); c.bancos = g.bancos || []; c.cajas = g.cajas || []; c.cuentas = g.cuentas || []; c.cajaFuerte = g.cajaFuerte || {}; return c; });
      repActual = ({resumen: repResumen, wu: repWu, bancos: repBancos, efectivo: repEfectivo, util: repUtil})[tipo](cs, d, h);
      repNombre = REP[tipo].replace(/ del período/, "") + " " + d + " a " + h + ".pdf";
    }
    pintarReporte(repActual);
    $("rPdf").disabled = false;
  } catch (err) {
    $("rSalida").innerHTML = `<div class="hojarep"><p class="nota">No se pudo preparar el reporte: ${esc(err.message || err.code || err)}</p></div>`;
  }
}
$("rTipo").innerHTML = Object.entries(REP).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
function ajustarFiltros() { const un = ["dia", "cuentas"].includes($("rTipo").value);
  $("rlDia").style.display = un ? "" : "none"; $("rlDesde").style.display = $("rlHasta").style.display = $("rMes").style.display = un ? "none" : ""; }
$("rTipo").onchange = ajustarFiltros;
$("rMes").onclick = () => { const h = hoyISO(); $("rDesde").value = h.slice(0, 8) + "01"; $("rHasta").value = h; };
$("rVer").onclick = generarReporte;
$("rPdf").onclick = () => repActual && exportarPdf(repActual, repNombre);
$("rSalida").addEventListener("click", async e => { const tr = e.target.closest("[data-abrir]"); if (!tr) return; mostrarVista("cierre"); await abrirDia(tr.dataset.abrir); });

// =====================================================================
//  PDF
// =====================================================================
async function exportarPdf(rep, nombre) {
  if (!window.jspdf) { notificar("No se pudo cargar el generador de PDF. Revisa la conexión y recarga.", "var(--peligro)"); return; }
  const doc = new window.jspdf.jsPDF({orientation: rep.horizontal ? "landscape" : "portrait", unit: "pt", format: "letter"});
  const W = doc.internal.pageSize.getWidth(), M = 36;
  let y = M;
  doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(15, 23, 42); doc.text(CFG.nombreAgencia || "", M, y + 4);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
  const ag = [CFG.direccion, CFG.telefono && "Tel. " + CFG.telefono, CFG.ruc && "RUC " + CFG.ruc].filter(Boolean).join("   ·   ");
  if (ag) doc.text(ag, M, y + 17);
  doc.text("Generado: " + new Date().toLocaleString("es-NI"), W - M, y + 4, {align: "right"});
  y += 26; doc.setDrawColor(37, 99, 235); doc.setLineWidth(1.5); doc.line(M, y, W - M, y); y += 20;
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(15, 23, 42); doc.text(rep.titulo, M, y);
  y += 14; doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(71, 85, 105); doc.text(rep.subtitulo, M, y);
  if (rep.aviso) { y += 16; doc.setFillColor(254, 243, 199); doc.rect(M, y - 10, W - 2 * M, 15, "F"); doc.setTextColor(146, 64, 14); doc.setFont("helvetica", "bold"); doc.text(rep.aviso, M + 6, y); }
  if (rep.inds.length) {
    y += 14; const n = rep.inds.length, gap = 8, bw = (W - 2 * M - gap * (n - 1)) / n;
    rep.inds.forEach((ind, i) => { const x = M + i * (bw + gap);
      doc.setDrawColor(226, 232, 240); doc.setLineWidth(.8); doc.roundedRect(x, y, bw, 40, 4, 4);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(100, 116, 139); doc.text(ind[0].toUpperCase(), x + 8, y + 13, {maxWidth: bw - 12});
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); ind[2] ? doc.setTextColor(220, 38, 38) : doc.setTextColor(15, 23, 42); doc.text(ind[1], x + 8, y + 31, {maxWidth: bw - 12}); });
    y += 48;
  }
  y += 6;
  rep.secs.forEach(s => {
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(37, 99, 235); doc.text(s.titulo, M, y + 8);
    const tw = sum(s.cols, c => c.w), cs = {};
    s.cols.forEach((c, i) => cs[i] = {halign: c.num ? "right" : "left", cellWidth: (W - 2 * M) * c.w / tw});
    doc.autoTable({startY: y + 13, margin: {left: M, right: M}, head: [s.cols.map(c => c.t)],
      body: s.filas.length ? s.filas : [s.cols.map((c, i) => i === 0 ? "(sin datos)" : "")], foot: s.total ? [s.total] : undefined,
      theme: "grid", styles: {fontSize: rep.horizontal ? 7 : 8.5, cellPadding: 3, lineColor: [226, 232, 240], lineWidth: .5, textColor: [15, 23, 42], overflow: "linebreak"},
      headStyles: {fillColor: [30, 58, 138], textColor: 255, fontStyle: "bold"}, footStyles: {fillColor: [239, 246, 255], textColor: [15, 23, 42], fontStyle: "bold"},
      alternateRowStyles: {fillColor: [248, 250, 252]}, columnStyles: cs,
      didParseCell: d => { if (d.section !== "body" && s.cols[d.column.index]) d.cell.styles.halign = s.cols[d.column.index].num ? "right" : "left"; }, showFoot: "lastPage"});
    y = doc.lastAutoTable.finalY + 18;
  });
  const H = doc.internal.pageSize.getHeight();
  if (rep.notas) { if (y > H - 80) { doc.addPage(); y = M; } doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(37, 99, 235); doc.text("Observaciones", M, y);
    doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42); const ls = doc.splitTextToSize(rep.notas, W - 2 * M); doc.text(ls, M, y + 14); y += 20 + ls.length * 11; }
  if (rep.firmas) { if (y > H - 90) { doc.addPage(); y = M; } y += 50; const fw = (W - 2 * M - 60) / 2;
    doc.setDrawColor(51, 65, 85); doc.setLineWidth(.8); doc.line(M, y, M + fw, y); doc.line(W - M - fw, y, W - M, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(51, 65, 85);
    doc.text("Elaborado por" + (CFG.responsable ? ": " + CFG.responsable : ""), M + fw / 2, y + 13, {align: "center"}); doc.text("Revisado por", W - M - fw / 2, y + 13, {align: "center"}); }
  const np = doc.getNumberOfPages();
  for (let i = 1; i <= np; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(148, 163, 184); doc.text(`Página ${i} de ${np}`, W - M, H - 18, {align: "right"}); }
  descargar(doc.output("blob"), nombre);
  notificar("PDF listo: " + nombre, "var(--primario)");
}

// =====================================================================
//  CONFIGURACIÓN
// =====================================================================
let cfgEd = null;
function pintarConfig() {
  cfgEd = JSON.parse(JSON.stringify(CFG));
  $("cNombre").value = cfgEd.nombreAgencia; $("cDir").value = cfgEd.direccion; $("cTel").value = cfgEd.telefono; $("cRuc").value = cfgEd.ruc; $("cResp").value = cfgEd.responsable;
  $("cTasa").value = Texto(cfgEd.tasaCambio); $("cCap").value = Texto(cfgEd.capitalTrabajoUSD); $("cTMC").value = Texto(cfgEd.tarifaMC); $("cTVT").value = Texto(cfgEd.tarifaVT);
  pintarLista("lBancos", cfgEd.bancos); pintarLista("lCajeros", cfgEd.cajeros);
}
function pintarLista(id, lista) {
  $(id).innerHTML = lista.map((e, i) => `<tr class="${e.activo ? "" : "inact"}" data-i="${i}">
    <td><input class="txt" value="${esc(e.nombre)}" data-n style="width:180px"></td>
    <td><button class="btn sec chico" data-mv="-1" ${i === 0 ? "disabled" : ""}>↑</button> <button class="btn sec chico" data-mv="1" ${i === lista.length - 1 ? "disabled" : ""}>↓</button></td>
    <td><button class="btn chico ${e.activo ? "neutro" : "exito"}" data-act>${e.activo ? "Desactivar" : "Activar"}</button></td></tr>`).join("");
}
["lBancos", "lCajeros"].forEach(id => {
  const lista = () => id === "lBancos" ? cfgEd.bancos : cfgEd.cajeros;
  $(id).addEventListener("input", e => { if (e.target.dataset.n !== undefined) lista()[+e.target.closest("tr").dataset.i].nombre = e.target.value.toUpperCase(); });
  $(id).addEventListener("click", e => {
    const tr = e.target.closest("tr"); if (!tr) return; const i = +tr.dataset.i, l = lista();
    if (e.target.dataset.act !== undefined) { l[i].activo = !l[i].activo; pintarLista(id, l); }
    if (e.target.dataset.mv) { const j = i + +e.target.dataset.mv; [l[i], l[j]] = [l[j], l[i]]; pintarLista(id, l); }
  });
});
$("addBanco").onclick = () => { cfgEd.bancos.push({id: uid("b"), nombre: "", activo: true}); pintarLista("lBancos", cfgEd.bancos); const x = $("lBancos").querySelectorAll("input"); x[x.length - 1].focus(); };
$("addCajero").onclick = () => { cfgEd.cajeros.push({id: uid("j"), nombre: "", activo: true}); pintarLista("lCajeros", cfgEd.cajeros); const x = $("lCajeros").querySelectorAll("input"); x[x.length - 1].focus(); };

$("bGuardarCfg").onclick = async () => {
  const nums = {cTasa: "tasaCambio", cCap: "capitalTrabajoUSD", cTMC: "tarifaMC", cTVT: "tarifaVT"};
  let ok = true;
  Object.entries(nums).forEach(([id, k]) => { const n = TryNumero($(id).value); $(id).classList.toggle("mal", !n.ok); ok = ok && n.ok; cfgEd[k] = n.v; });
  if (!ok) { notificar("Hay números mal escritos (en rosa).", "var(--aviso)"); return; }
  if (!(cfgEd.tasaCambio > 0)) { notificar("La tasa de cambio debe ser mayor que cero.", "var(--aviso)"); return; }
  cfgEd.nombreAgencia = $("cNombre").value.trim() || "MI AGENCIA"; cfgEd.direccion = $("cDir").value.trim(); cfgEd.telefono = $("cTel").value.trim();
  cfgEd.ruc = $("cRuc").value.trim(); cfgEd.responsable = $("cResp").value.trim();
  cfgEd.bancos = cfgEd.bancos.filter(b => b.nombre.trim()).map(b => ({...b, nombre: b.nombre.trim()}));
  cfgEd.cajeros = cfgEd.cajeros.filter(b => b.nombre.trim()).map(b => ({...b, nombre: b.nombre.trim()}));
  const dup = l => new Set(l.map(x => x.nombre)).size !== l.length;
  if (dup(cfgEd.bancos) || dup(cfgEd.cajeros)) { notificar("Hay bancos o cajeros con el nombre repetido.", "var(--aviso)"); return; }
  try {
    CFG = Object.assign(cfgPorDefecto(), await Store.setConfig(cfgEd)); $("lblAgencia").textContent = CFG.nombreAgencia;
    notificar("✓  Configuración guardada");
    pintarConfig();
    if (CI && !sucio) { await abrirDia(CI.fecha); } else if (CI) notificar("Guarda el día para ver los bancos o cajeros nuevos", "var(--aviso)");
  } catch (err) { notificar("No se pudo guardar la configuración: " + (err.message || err.code || err), "var(--peligro)"); }
};

// Respaldo
$("bResp").onclick = async () => {
  try {
    const datos = {app: "CierreDiario", version: 2, creado: new Date().toISOString(), config: CFG, cierres: await Store.todos()};
    descargar(new Blob([JSON.stringify(datos, null, 1)], {type: "application/json"}), "Respaldo Cierre Diario " + hoyISO() + ".json");
    notificar("Respaldo descargado (" + datos.cierres.length + " días)", "var(--primario)");
  } catch (err) { notificar("No se pudo crear el respaldo: " + (err.message || err), "var(--peligro)"); }
};
$("fResp").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  let datos;
  try { datos = JSON.parse(await f.text()); if (datos.app !== "CierreDiario" || !Array.isArray(datos.cierres)) throw 0; }
  catch { notificar("Ese archivo no es un respaldo de Cierre Diario.", "var(--peligro)"); return; }
  if (!(await preguntar(`Restaurar ${datos.cierres.length} días y la configuración del respaldo. Los días con la misma fecha se reemplazan. ¿Continuar?`, "Restaurar"))) return;
  try {
    if (datos.config) { CFG = Object.assign(cfgPorDefecto(), await Store.setConfig(Object.assign(cfgPorDefecto(), datos.config))); $("lblAgencia").textContent = CFG.nombreAgencia; }
    const dias = datos.cierres.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || ""));
    let n = 0;
    for (let i = 0; i < dias.length; i += 15) {          // de 15 en 15 para no pasar el tiempo límite del servidor
      n += (await Store.restaurar({cierres: dias.slice(i, i + 15)})).guardados;
      notificar("Restaurando… " + n + " de " + dias.length, "var(--primario)");
    }
    notificar("✓  Restaurados " + n + " días");
    pintarConfig(); sucio = false; await abrirDia(CI ? CI.fecha : hoyISO());
  } catch (err) { notificar("Falló la restauración: " + (err.message || err), "var(--peligro)"); }
};

// =====================================================================
//  ENTRADA (contraseña)
// =====================================================================
let alEntrar = null;
function pedirLogin(msg) {
  token = ""; try { localStorage.removeItem(TOKEN_KEY); } catch {}
  $("loginMsg").textContent = msg || "";
  $("login").classList.add("ver");
  setTimeout(() => $("loginClave").focus(), 50);
}
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginBtn").disabled = true; $("loginMsg").textContent = "";
  try {
    const r = await api("POST", "login", {clave: $("loginClave").value});
    token = r.token; try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    $("loginClave").value = ""; $("login").classList.remove("ver");
    if (alEntrar) { const f = alEntrar; alEntrar = null; f(); }
  } catch (err) { $("loginMsg").textContent = err.message; }
  finally { $("loginBtn").disabled = false; }
});
$("bSalir").onclick = async () => {
  if (sucio && !(await preguntar("Hay cambios sin guardar. ¿Salir de todos modos?", "Salir"))) return;
  sucio = false; pedirLogin("Sesión cerrada.");
};

// =====================================================================
//  INICIO
// =====================================================================
async function iniciar() {
  const h = hoyISO();
  $("rDia").value = h; $("rDesde").value = h.slice(0, 8) + "01"; $("rHasta").value = h; ajustarFiltros();
  if (!token) { alEntrar = iniciar; pedirLogin(); return; }
  try {
    const g = await Store.getConfig();
    if (g) CFG = Object.assign(cfgPorDefecto(), g);
    $("banner").classList.remove("ver");
  } catch (err) {
    if (!token) { alEntrar = iniciar; return; }      // la sesión venció: se pidió la contraseña
    $("banner").textContent = "⚠ No se pudo conectar con la base de datos: " + err.message; $("banner").classList.add("ver");
    $("hojas").innerHTML = '<div class="cargando">Sin conexión con la base de datos. Recarga la página cuando se resuelva.</div>';
    return;
  }
  $("lblAgencia").textContent = CFG.nombreAgencia;
  await abrirDia(h);
}
iniciar();
