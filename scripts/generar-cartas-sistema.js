#!/usr/bin/env node
/**
 * Genera las cartas fijas del sistema — las que ve todo el mundo en la pantalla
 * de selección.
 *
 *   node scripts/generar-cartas-sistema.js
 *
 * Escribe `cartas-sistema.json`, que el servidor carga al arrancar. Se ejecuta
 * A MANO y su resultado se commitea: las cartas del sistema tienen que ser las
 * mismas para todos y no cambiar entre despliegues. Si se generaran al arrancar,
 * cada reinicio de Render repartiría cartas distintas a media partida.
 *
 * ── Qué se busca ─────────────────────────────────────────────────────────────
 *
 * No basta con barajar sesenta veces. Un reparto al azar deja cartas con ventaja
 * y cartas condenadas, y eso en un juego con dinero no vale. Se persiguen dos
 * cosas a la vez:
 *
 *   EQUILIBRIO   cada una de las 54 barajas aparece el mismo número de veces en
 *                el conjunto. Si «el gallo» sale en 30 cartas y «la sirena» en 5,
 *                las que llevan gallo van con ventaja partida tras partida.
 *
 *   SEPARACIÓN   dos cartas comparten las menos barajas posibles. Cuantas más
 *                comparten, más veces se llenan a la vez, y un empate obliga a
 *                repartir el bote.
 *
 * Las dos tiran en direcciones contrarias —repartir parejo obliga a reutilizar—
 * así que se busca el punto medio en vez del óptimo de una sola.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    CASILLAS, TOTAL_BARAJAS, CASILLAS_ESQUINAS, firmaDeTabla
} = require('../generador');

const SALIDA = path.join(__dirname, '..', 'cartas-sistema.json');

/**
 * Los conjuntos que se generan, uno por forma de carta.
 *
 * `huecos` dice en qué casillas de la rejilla 4×4 van las barajas. El modo
 * normal las llena todas; el de esquinas solo ocho, que es con lo que se juega
 * el Pozo. Son conjuntos SEPARADOS: el Pozo nunca mezcla sus cartas con las
 * otras, así que equilibrarlos juntos no tendría sentido.
 */
const CONJUNTOS = [
    { nombre: 'normal',   cuantas: 60, huecos: [...Array(CASILLAS).keys()] },
    { nombre: 'esquinas', cuantas: 20, huecos: CASILLAS_ESQUINAS }
];

/** Cuántos intercambios se prueban al afinar cada conjunto. */
const PASADAS = 200000;

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
 * Con 60 cartas de 16 hay 960 casillas que llenar con 54 barajas, y
 * 960 = 54×17 + 42: 42 barajas salen 18 veces y las otras 12 salen 17. Es el
 * reparto más parejo que permite la aritmética, y la diferencia entre la más y
 * la menos usada es exactamente 1.
 *
 * Se hace por «a la que más le queda»: para cada carta se cogen las barajas con
 * más apariciones pendientes. No es un capricho — es lo que garantiza que se
 * pueda terminar. Yendo al azar, las últimas cartas se encuentran con que solo
 * quedan pendientes barajas que ya llevan puestas, y no hay forma de
 * completarlas sin repetir.
 *
 * Las cartas salen de aquí parecidas entre sí; separarlas es trabajo de
 * `afinar()`, que ya no puede tocar este reparto.
 */
function repartoExacto(cuantasCartas, porCarta) {
    const casillasTotales = cuantasCartas * porCarta;
    const base = Math.floor(casillasTotales / TOTAL_BARAJAS);
    const conUnaMas = casillasTotales % TOTAL_BARAJAS;

    const pendientes = new Map();
    barajar([...Array(TOTAL_BARAJAS)].map((_, i) => i + 1))
        .forEach((baraja, i) => pendientes.set(baraja, i < conUnaMas ? base + 1 : base));

    const cartas = [];
    for (let n = 0; n < cuantasCartas; n++) {
        const carta = barajar([...pendientes.keys()])
            .sort((x, y) => pendientes.get(y) - pendientes.get(x))
            .slice(0, porCarta);
        carta.forEach(b => pendientes.set(b, pendientes.get(b) - 1));
        cartas.push(carta);
    }
    return cartas;
}

/**
 * Lo mal que está el reparto, en un solo número.
 *
 * Se suman los solapes AL CUADRADO. Elevar al cuadrado es lo que hace que
 * compense: una pareja que comparte 8 pesa 64, y bajar esa a 7 quita más de lo
 * que suma llevar otra de 4 a 5. Sumando a secas todo daría igual —la media está
 * fijada por la aritmética— y no habría nada que optimizar.
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

/**
 * Separa las cartas sin deshacer el equilibrio.
 *
 * La MEDIA de barajas compartidas no se puede bajar: con reparto parejo sale
 * fijada por la aritmética. Lo que sí se puede bajar es el MÁXIMO — que no haya
 * dos cartas concretas compartiendo ocho barajas mientras el resto comparte
 * cuatro. Esas dos se llenarían a la vez muy a menudo y el bote acabaría partido.
 *
 * Se hace intercambiando barajas ENTRE dos cartas: A suelta una que solo tiene
 * ella y coge otra que solo tenía B, y B al revés. Como cada baraja cambia de
 * carta pero sigue apareciendo las mismas veces en total, el equilibrio exacto
 * se mantiene intacto y ninguna carta acaba con una baraja repetida.
 *
 * ⚠️ Lo que NO puede hacerse es mover una baraja COMPARTIDA: si A le pasa a B
 * algo que B ya tiene, B acaba con la misma baraja dos veces. Esa versión se
 * probó y hundía el resultado —cartas con 16 casillas repetidas y solapes de
 * media 0,11, que es imposible— porque la medida bajaba a costa de romper las
 * cartas. Por eso el reparto se comprueba entero antes de escribir el archivo.
 */
function afinar(cartas) {
    let aceptados = 0;

    for (let paso = 0; paso < PASADAS; paso++) {
        // Se toma cualquier pareja, no la peor: insistir solo en la peor deja el
        // algoritmo atascado en cuanto hay varias empatadas en lo alto —bajar
        // una no mueve el máximo y todo intercambio se rechaza.
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

        // Se aceptan también los empates. Sin eso el afinado se para casi
        // enseguida, porque llega a una meseta donde ningún intercambio suelto
        // mejora nada; moverse de lado por la meseta es lo que le permite
        // encontrar la siguiente bajada.
        if (coste(cartas, [a, b]) <= antes) {
            aceptados++;
        } else {
            cartas[a] = A;
            cartas[b] = B;
        }
    }
    return aceptados;
}

// ==================== MEDIR ====================

function medir(cartas, porCarta) {
    const usos = new Map();
    for (let b = 1; b <= TOTAL_BARAJAS; b++) usos.set(b, 0);
    cartas.forEach(c => c.forEach(b => usos.set(b, usos.get(b) + 1)));
    const cuentas = [...usos.values()];

    const solapes = [];
    for (let i = 0; i < cartas.length; i++) {
        for (let j = i + 1; j < cartas.length; j++) {
            solapes.push(comparten(cartas[i], cartas[j]));
        }
    }

    return {
        minUso: Math.min(...cuentas),
        maxUso: Math.max(...cuentas),
        mediaUso: cuentas.reduce((a, b) => a + b, 0) / cuentas.length,
        solapes,
        solapeMax: Math.max(...solapes),
        solapeMedio: solapes.reduce((a, b) => a + b, 0) / solapes.length,
        // Lo que saldría barajando sin más: sirve de vara de medir.
        alAzar: (porCarta * porCarta) / TOTAL_BARAJAS,
        conRepetidas: cartas.filter(c => new Set(c).size !== c.length).length,
        duplicadas: cartas.length - new Set(cartas.map(firmaDeTabla)).size
    };
}

function informar(conjunto, m) {
    console.log(`\n  ── ${conjunto.nombre.toUpperCase()} · ${conjunto.cuantas} cartas de ${conjunto.huecos.length} casillas ──\n`);
    console.log('  EQUILIBRIO — cuántas veces aparece cada baraja');
    console.log(`    entre ${m.minUso} y ${m.maxUso} veces (media ${m.mediaUso.toFixed(1)})`);
    console.log(`    diferencia entre la más y la menos usada: ${m.maxUso - m.minUso}`);
    console.log('');
    console.log('  SEPARACIÓN — barajas en común entre dos cartas');
    console.log(`    como mucho ${m.solapeMax}, de media ${m.solapeMedio.toFixed(2)}`);
    console.log(`    (barajando sin más saldría ${m.alAzar.toFixed(2)} de media)`);
    console.log('');
    for (let v = Math.min(...m.solapes); v <= m.solapeMax; v++) {
        const n = m.solapes.filter(s => s === v).length;
        if (n === 0) continue;
        const barra = '█'.repeat(Math.max(1, Math.round(n / (m.solapes.length / 40))));
        console.log(`    comparten ${v}: ${String(n).padStart(4)} parejas  ${barra}`);
    }
}

// ==================== HACERLO ====================

console.log('\n  Generando las cartas del sistema...');

const salida = {
    generadas: new Date().toISOString(),
    conjuntos: {}
};
let problemas = 0;

for (const conjunto of CONJUNTOS) {
    const cartas = repartoExacto(conjunto.cuantas, conjunto.huecos.length);
    const aceptados = afinar(cartas);
    const m = medir(cartas, conjunto.huecos.length);

    informar(conjunto, m);
    console.log(`\n    intercambios aceptados: ${aceptados} de ${PASADAS}`);

    if (m.conRepetidas > 0 || m.duplicadas > 0 || m.maxUso - m.minUso > 1) {
        console.error(`    ❌ este conjunto no vale:`);
        console.error(`       cartas con barajas repetidas dentro: ${m.conRepetidas}`);
        console.error(`       cartas duplicadas: ${m.duplicadas}`);
        console.error(`       desequilibrio: ${m.maxUso - m.minUso}`);
        problemas++;
    }

    // Las barajas se colocan en la rejilla de 16 justo aquí. Hasta este punto
    // una carta es una lista suelta —así el equilibrio y la separación se
    // calculan igual para las dos formas— y es al guardarla cuando toma la
    // forma que espera el juego, con null en las casillas que no se usan.
    salida.conjuntos[conjunto.nombre] = cartas.map((barajas, i) => {
        const rejilla = new Array(CASILLAS).fill(null);
        conjunto.huecos.forEach((casilla, n) => { rejilla[casilla] = barajas[n]; });
        return {
            // El id es el número de la carta, con ceros, como los que ya usa el
            // juego: así el resto del sistema —selección, apuestas, validación—
            // sigue hablando de «la 07» y no hay que tocar nada de lo que ya
            // funciona.
            id: String(i + 1).padStart(2, '0'),
            cartas: rejilla,
            modo: conjunto.nombre
        };
    });
}

if (problemas > 0) {
    console.error(`\n  ❌ ${problemas} conjunto(s) sin validez. No se escribe nada.\n`);
    process.exit(1);
}

fs.writeFileSync(SALIDA, JSON.stringify(salida, null, 2));
console.log(`\n  ✅ Escrito en ${path.relative(process.cwd(), SALIDA)}\n`);
