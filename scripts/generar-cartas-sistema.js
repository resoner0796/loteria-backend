#!/usr/bin/env node
/**
 * Genera las cartas fijas del sistema — las que ve todo el mundo en la pantalla
 * de selección.
 *
 *   node scripts/generar-cartas-sistema.js [cuantas]
 *
 * Escribe `cartas-sistema.json`, que el servidor carga al arrancar. Se ejecuta
 * A MANO y su resultado se commitea: las cartas del sistema tienen que ser las
 * mismas para todos y no cambiar entre despliegues. Si se generaran al arrancar,
 * cada reinicio de Render repartiría cartas distintas a media partida.
 *
 * ── Qué se busca ─────────────────────────────────────────────────────────────
 *
 * No basta con barajar 60 veces. Un reparto al azar deja cartas con ventaja y
 * cartas condenadas, y eso en un juego con dinero no vale. Se persiguen dos
 * cosas a la vez:
 *
 *   EQUILIBRIO   cada una de las 54 barajas aparece el mismo número de veces en
 *                el conjunto. Si «el gallo» sale en 30 cartas y «la sirena» en 5,
 *                las que llevan gallo van con ventaja partida tras partida.
 *
 *   SEPARACIÓN   dos cartas comparten las menos barajas posibles. Cuantas más
 *                comparten, más veces se llenan a la vez, y un empate obliga a
 *                repartir el bote. Con 16 de 54, dos cartas al azar comparten
 *                unas 4,7 barajas; el objetivo es quedar por debajo de eso.
 *
 * Las dos tiran en direcciones contrarias —repartir parejo obliga a reutilizar—
 * así que se busca el punto medio en vez del óptimo de una sola.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CASILLAS, TOTAL_BARAJAS, firmaDeTabla } = require('../generador');

const CUANTAS = parseInt(process.argv[2], 10) || 60;
const SALIDA = path.join(__dirname, '..', 'cartas-sistema.json');

/** Cuántas barajas puede compartir una carta con otra, como mucho. */
const SOLAPAMIENTO_MAXIMO = 6;

/** Intentos por carta antes de aflojar la exigencia. */
const INTENTOS = 400;

// ==================== HERRAMIENTAS ====================

function barajar(lista) {
    const copia = [...lista];
    for (let i = copia.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia;
}

/** Cuántas barajas tienen en común dos cartas. */
function comparten(a, b) {
    const enA = new Set(a);
    return b.filter(c => enA.has(c)).length;
}

/**
 * Reparte las apariciones de forma EXACTA, no aproximada.
 *
 * Hay 60×16 = 960 casillas que llenar con 54 barajas: 960 = 54×17 + 42, así que
 * 42 barajas salen 18 veces y las otras 12 salen 17. Es el reparto más parejo
 * que permite la aritmética: la diferencia entre la más y la menos usada es 1.
 *
 * El reparto se hace por "a la que más le queda": para cada carta se cogen las
 * 16 barajas con más apariciones pendientes. No es un capricho — es lo que
 * garantiza que se pueda terminar. Yendo al azar, las últimas cartas se
 * encuentran con que solo quedan pendientes barajas que ya llevan puestas, y no
 * hay forma de completarlas sin repetir.
 *
 * Las cartas salen de aquí parecidas entre sí; separarlas es trabajo de la fase
 * siguiente, que ya no puede tocar este reparto.
 */
function repartoExacto(cuantasCartas) {
    const casillasTotales = cuantasCartas * CASILLAS;
    const base = Math.floor(casillasTotales / TOTAL_BARAJAS);
    const conUnaMas = casillasTotales % TOTAL_BARAJAS;

    const pendientes = new Map();
    barajar([...Array(TOTAL_BARAJAS)].map((_, i) => i + 1))
        .forEach((baraja, i) => pendientes.set(baraja, i < conUnaMas ? base + 1 : base));

    const cartas = [];
    for (let n = 0; n < cuantasCartas; n++) {
        const carta = barajar([...pendientes.keys()])
            .sort((x, y) => pendientes.get(y) - pendientes.get(x))
            .slice(0, CASILLAS);
        carta.forEach(b => pendientes.set(b, pendientes.get(b) - 1));
        cartas.push(carta);
    }
    return cartas;
}

// ==================== GENERACIÓN ====================

console.log(`\n  Generando ${CUANTAS} cartas del sistema...\n`);

const cartas = repartoExacto(CUANTAS);

// ==================== AFINAR ====================
//
// La MEDIA de barajas compartidas no se puede bajar: con 60 cartas de 16 sobre
// 54 barajas y reparto parejo, sale 4,55 por pura aritmética. Está calculado, no
// estimado: cada baraja aparece en ~17,8 cartas, y eso crea un número fijo de
// parejas que la comparten.
//
// Lo que sí se puede bajar es el MÁXIMO — que no haya dos cartas concretas
// compartiendo 8 barajas mientras el resto comparte 4. Esas dos se llenarían a
// la vez muy a menudo y el bote acabaría partido.
//
// Se hace intercambiando barajas ENTRE dos cartas: A suelta una que solo tiene
// ella y coge otra que solo tenía B, y B al revés. Como cada baraja cambia de
// carta pero sigue apareciendo las mismas veces en total, el equilibrio exacto
// de arriba se mantiene intacto y ninguna carta acaba con una baraja repetida.
//
// ⚠️ Lo que NO puede hacerse es mover una baraja COMPARTIDA: si A le pasa a B
// algo que B ya tiene, B acaba con la misma baraja dos veces. Esa versión se
// probó y hundía el resultado —cartas con 16 casillas repetidas y solapes de
// media 0,11, que es imposible— porque la medida bajaba a costa de romper las
// cartas.

/**
 * Lo mal que está el reparto, en un solo número.
 *
 * Se suman los solapes AL CUADRADO. Elevar al cuadrado es lo que hace que
 * compense: una pareja que comparte 8 pesa 64, y bajar esa a 7 quita más de lo
 * que suma llevar otra de 4 a 5. Sumando a secas todo daría igual —la media
 * está fijada por la aritmética— y no habría nada que optimizar.
 *
 * `indices` limita la cuenta a las cartas que un intercambio toca, que son dos.
 * Recalcular las 1.770 parejas en cada una de las 200.000 pasadas tardaría
 * minutos; así son segundos.
 */
function coste(lista, indices) {
    let total = 0;
    for (const i of indices) {
        for (let j = 0; j < lista.length; j++) {
            if (i === j) continue;
            const c = comparten(lista[i], lista[j]);
            total += c * c;
        }
    }
    return total;
}

const PASADAS = 200000;
let mejoras = 0;

for (let paso = 0; paso < PASADAS; paso++) {
    // Se toma cualquier pareja, no la peor: insistir solo en la peor deja el
    // algoritmo atascado en cuanto hay varias empatadas en lo alto —bajar una
    // no mueve el máximo y todo intercambio se rechaza.
    const a = crypto.randomInt(0, cartas.length);
    const b = crypto.randomInt(0, cartas.length);
    if (a === b) continue;

    const A = cartas[a], B = cartas[b];
    const enA = new Set(A), enB = new Set(B);
    const soloA = A.filter(c => !enB.has(c));
    const soloB = B.filter(c => !enA.has(c));
    if (soloA.length === 0 || soloB.length === 0) continue;

    const x = soloA[crypto.randomInt(0, soloA.length)];
    const y = soloB[crypto.randomInt(0, soloB.length)];

    const antes = coste(cartas, [a, b]);
    cartas[a] = A.map(c => (c === x ? y : c));
    cartas[b] = B.map(c => (c === y ? x : c));

    // Se aceptan también los empates. Sin eso el afinado se para casi enseguida
    // —448 cambios en 200.000 pasadas— porque llega a una meseta donde ningún
    // intercambio suelto mejora nada. Dejar que se mueva de lado por la meseta
    // es lo que le permite encontrar la siguiente bajada.
    if (coste(cartas, [a, b]) <= antes) {
        mejoras++;
    } else {
        cartas[a] = A;
        cartas[b] = B;
    }
}

// ==================== MEDIR LO QUE SALIÓ ====================

// Los usos se recuentan sobre las cartas FINALES: medir el mapa que quedó de la
// generación daría una foto anterior a los intercambios.
const usos = new Map();
for (let b = 1; b <= TOTAL_BARAJAS; b++) usos.set(b, 0);
cartas.forEach(c => c.forEach(b => usos.set(b, usos.get(b) + 1)));

const cuentas = [...usos.values()];
const minUso = Math.min(...cuentas);
const maxUso = Math.max(...cuentas);
const mediaUso = cuentas.reduce((a, b) => a + b, 0) / cuentas.length;

const solapes = [];
for (let i = 0; i < cartas.length; i++) {
    for (let j = i + 1; j < cartas.length; j++) {
        solapes.push(comparten(cartas[i], cartas[j]));
    }
}
const solapeMax = Math.max(...solapes);
const solapeMedio = solapes.reduce((a, b) => a + b, 0) / solapes.length;
const alAzar = (CASILLAS * CASILLAS) / TOTAL_BARAJAS;

console.log('  EQUILIBRIO — cuántas veces aparece cada baraja');
console.log(`    entre ${minUso} y ${maxUso} veces (media ${mediaUso.toFixed(1)})`);
console.log(`    diferencia entre la más y la menos usada: ${maxUso - minUso}`);
console.log('');
console.log('  SEPARACIÓN — barajas en común entre dos cartas');
console.log(`    como mucho ${solapeMax}, de media ${solapeMedio.toFixed(2)}`);
console.log(`    (al azar saldría ${alAzar.toFixed(2)} de media)`);
console.log('');
const repetidas = CUANTAS - new Set(cartas.map(firmaDeTabla)).size;
console.log(`  Cartas repetidas: ${repetidas}`);
console.log(`  Intercambios aceptados: ${mejoras} de ${PASADAS}`);
console.log('');
console.log('  Reparto de las 1.770 parejas de cartas:');
for (let v = Math.min(...solapes); v <= solapeMax; v++) {
    const n = solapes.filter(s => s === v).length;
    if (n === 0) continue;
    console.log(`    comparten ${v}: ${String(n).padStart(4)} parejas  ${'█'.repeat(Math.round(n / 20))}`);
}

// Ninguna carta puede llevar una baraja dos veces ni ser copia de otra: si algo
// de esto falla, el archivo no se escribe. Es la red que faltaba la vez que el
// intercambio movía barajas compartidas y salieron once cartas duplicadas.
const conRepetidas = cartas.filter(c => new Set(c).size !== c.length).length;
if (conRepetidas > 0 || repetidas > 0 || maxUso - minUso > 1) {
    console.error(`\n  ❌ El resultado no es válido, no se escribe nada.`);
    console.error(`     cartas con barajas repetidas dentro: ${conRepetidas}`);
    console.error(`     cartas duplicadas: ${repetidas}`);
    console.error(`     desequilibrio: ${maxUso - minUso}`);
    process.exit(1);
}

// ==================== GUARDAR ====================

const salida = {
    generadas: new Date().toISOString(),
    cuantas: cartas.length,
    // El id es el número de la carta, con ceros, como los que ya usa el juego:
    // así el resto del sistema —selección, apuestas, validación— sigue hablando
    // de "la 07" y no hay que tocar nada de lo que ya funciona.
    cartas: cartas.map((c, i) => ({
        id: String(i + 1).padStart(2, '0'),
        cartas: c,
        modo: 'normal'
    }))
};

fs.writeFileSync(SALIDA, JSON.stringify(salida, null, 2));
console.log(`\n  ✅ Escrito en ${path.relative(process.cwd(), SALIDA)}\n`);
