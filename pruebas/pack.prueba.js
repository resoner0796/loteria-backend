#!/usr/bin/env node
/**
 * Pruebas de la compra de un pack de tablas.
 *
 * No se toca Firestore: se reproduce aquí el flujo tal como está en server.js
 * —comprobar el tope, cobrar en transacción, generar sin repetir, guardar— con
 * un almacén de mentira. Lo que se comprueba son las reglas que reparten dinero:
 * que no se cobre de más, que no se entregue sin cobrar, y que un modo inventado
 * no deje la compra a medias.
 */

const generador = require('../generador');

const PACK_TABLAS = { precio: 20, cuantas: 4 };
const TOPE_TABLAS_POR_USUARIO = 40;

let fallos = 0, pruebas = 0;
const ok = (n, c, d = '') => {
    pruebas++; if (!c) fallos++;
    console.log(`  ${c ? '✅' : '❌'} ${n}${d ? `\n       ${d}` : ''}`);
};
const seccion = t => console.log(`\n  ${t}\n  ${'─'.repeat(56)}`);

/** Firestore de mentira, con lo justo para este flujo. */
function almacen(monedas, tablas = []) {
    return {
        monedas,
        tablas: [...tablas],
        movimientos: []
    };
}

/** El mismo flujo que hay en server.js, contra el almacén de arriba. */
function comprarPack(db, modo) {
    if (!generador.MODOS.includes(modo)) {
        return { error: 'Ese tipo de tablas no existe' };
    }
    if (db.tablas.length + PACK_TABLAS.cuantas > TOPE_TABLAS_POR_USUARIO) {
        return { error: `Ya tienes ${db.tablas.length} tablas` };
    }
    if (db.monedas < PACK_TABLAS.precio) {
        return { error: `Necesitas $${PACK_TABLAS.precio} monedas` };
    }

    db.monedas -= PACK_TABLAS.precio;

    const firmas = db.tablas.map(t => t.firma);
    const nuevas = generador.generarPack(PACK_TABLAS.cuantas, modo, firmas);
    nuevas.forEach(cartas => {
        db.tablas.push({ cartas, modo, firma: generador.firmaDeTabla(cartas) });
    });
    db.movimientos.push({ tipo: 'compra', monto: PACK_TABLAS.precio });

    return { entregadas: nuevas.length };
}

// ==================== EL COBRO ====================

seccion('Se cobra lo que vale, ni más ni menos');
{
    const db = almacen(100);
    const r = comprarPack(db, 'normal');
    ok('la compra sale bien', !r.error);
    ok('cobra exactamente 20', db.monedas === 80, `quedó en ${db.monedas}`);
    ok('entrega 4 tablas', db.tablas.length === 4);
    ok('deja el movimiento en el historial', db.movimientos.length === 1);
}

seccion('Sin saldo no se entrega nada');
{
    const db = almacen(19);
    const r = comprarPack(db, 'normal');
    ok('la compra se rechaza', !!r.error);
    ok('NO se cobró nada', db.monedas === 19);
    ok('NO se entregó ninguna tabla', db.tablas.length === 0);
}

seccion('Justo con el precio exacto');
{
    const db = almacen(20);
    comprarPack(db, 'normal');
    ok('se puede comprar con lo justo', db.tablas.length === 4);
    ok('el saldo queda en cero', db.monedas === 0);
}

// ==================== EL MODO ====================

seccion('El modo lo elige quien compra, de una lista cerrada');
{
    for (const modo of generador.MODOS) {
        const db = almacen(100);
        comprarPack(db, modo);
        ok(`modo "${modo}" entrega 4 tablas`, db.tablas.length === 4);
        ok(`  y todas son de ese modo`, db.tablas.every(t => t.modo === modo));
    }

    const db = almacen(100);
    const r = comprarPack(db, 'inventado');
    ok('un modo que no existe se rechaza', !!r.error);
    ok('  y no cobra', db.monedas === 100);
}

// ==================== NO REPETIR ====================

seccion('Nunca se vende dos veces la misma tabla');
{
    const db = almacen(500);
    for (let i = 0; i < 8; i++) comprarPack(db, 'normal');

    ok('32 tablas tras ocho packs', db.tablas.length === 32);
    const firmas = db.tablas.map(t => t.firma);
    ok('todas distintas', new Set(firmas).size === firmas.length,
        `${firmas.length - new Set(firmas).size} repetidas`);
}

// ==================== EL TOPE ====================

seccion('Hay un tope de tablas por persona');
{
    const db = almacen(1000);
    let compras = 0;
    while (!comprarPack(db, 'normal').error && compras < 30) compras++;

    ok('deja de vender al llegar al tope',
        db.tablas.length <= TOPE_TABLAS_POR_USUARIO,
        `acabó con ${db.tablas.length}, tope ${TOPE_TABLAS_POR_USUARIO}`);

    const saldoAntes = db.monedas;
    const r = comprarPack(db, 'normal');
    ok('el intento de más se rechaza', !!r.error);
    ok('  y NO cobra', db.monedas === saldoAntes);
}

// ==================== FORMA DE LO GUARDADO ====================

seccion('Lo que se guarda tiene la forma que espera el juego');
{
    const db = almacen(100);
    comprarPack(db, 'esquinas');
    const t = db.tablas[0];

    ok('guarda las cartas', Array.isArray(t.cartas));
    ok('son 16 casillas', t.cartas.length === 16);
    ok('guarda el modo', t.modo === 'esquinas');
    ok('guarda la firma, para no repetir', typeof t.firma === 'string' && t.firma.length > 0);
    ok('las cartas son números o null',
        t.cartas.every(c => c === null || (Number.isInteger(c) && c >= 1 && c <= 54)));
}

console.log('\n' + '═'.repeat(62));
console.log(fallos === 0
    ? `  ✅ ${pruebas} comprobaciones, todas bien`
    : `  ❌ ${fallos} de ${pruebas} fallaron`);
console.log('═'.repeat(62) + '\n');
process.exit(fallos === 0 ? 0 : 1);
