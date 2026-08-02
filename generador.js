// ======================================================
// GENERADOR DE TABLAS
// ======================================================
// Crea las tablas que se venden en packs. Vive en el SERVIDOR y no es negociable
// que sea así: si el cliente pudiera decidir qué lleva su tabla, y el día que el
// servidor valide las loterías solo, cualquiera se fabricaría una tabla con las
// cartas que acaban de cantarse. Es dinero decidido en el navegador, que es
// justo el patrón que costó cerrar seis veces en este backend.
//
// Está portado de `generador/index.html` del repo del frontend, que era una
// herramienta para imprimir tablas. De sus 560 líneas, lo que servía eran unas
// cuarenta; el resto era interfaz para sacar PDF y ZIP.
//
// Una tabla es una LISTA DE 16 NÚMEROS (o null en las casillas vacías), no una
// imagen. Ese es el cambio de fondo: con las tablas como datos, el servidor sabe
// qué lleva cada una.

const crypto = require('crypto');

/** Casillas de una tabla: una rejilla de 4×4. */
const CASILLAS = 16;

/** La baraja completa: 54 cartas, numeradas del 1 al 54. */
const TOTAL_BARAJAS = 54;

/**
 * Dónde van las cartas en el modo `esquinas`.
 *
 * Son las cuatro esquinas y las cuatro del centro; el resto de la tabla queda
 * vacío. Encaja con el modo Pozo del juego, que ya se gana llenando el centro.
 *
 *     ●  ·  ·  ●        0   1   2   3
 *     ·  ●  ●  ·        4   5   6   7
 *     ·  ●  ●  ·        8   9  10  11
 *     ●  ·  ·  ●       12  13  14  15
 */
const CASILLAS_ESQUINAS = [0, 3, 5, 6, 9, 10, 12, 15];

/** En el modo `dobles`, la carta repetida ocupa estas dos casillas del centro. */
const CASILLAS_DOBLE = [5, 6];

const MODOS = ['normal', 'dobles', 'esquinas'];

/**
 * Baraja de verdad, con Fisher-Yates y azar criptográfico.
 *
 * ⚠️ El generador original usaba `sort(() => Math.random() - 0.5)`, que es un
 * error clásico: NO da permutaciones uniformes. Medido sobre 10 cartas y 60.000
 * repeticiones, la primera carta acababa en primera posición un 90% más de lo
 * que le tocaba y la novena un 39% menos. Para tablas que se imprimen da igual;
 * para tablas que se venden y deciden quién gana, no.
 *
 * `crypto.randomInt` en vez de `Math.random` por lo mismo que en el resto del
 * backend: lo que reparte dinero no se sortea con un generador predecible.
 */
function barajar(lista) {
    const copia = [...lista];
    for (let i = copia.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia;
}

/** La baraja entera, mezclada. */
function barajasMezcladas() {
    const todas = [];
    for (let i = 1; i <= TOTAL_BARAJAS; i++) todas.push(i);
    return barajar(todas);
}

/**
 * Crea una tabla del modo pedido.
 *
 * Devuelve un array de 16 posiciones. Las casillas vacías van a `null`, que solo
 * ocurre en el modo `esquinas`.
 */
function generarTabla(modo = 'normal') {
    if (!MODOS.includes(modo)) {
        throw new Error(`Modo de tabla desconocido: ${modo}`);
    }

    const barajas = barajasMezcladas();

    if (modo === 'normal') {
        return barajas.slice(0, CASILLAS);
    }

    if (modo === 'esquinas') {
        const tabla = new Array(CASILLAS).fill(null);
        CASILLAS_ESQUINAS.forEach((casilla, i) => { tabla[casilla] = barajas[i]; });
        return tabla;
    }

    // dobles: una carta se repite en el centro y las otras catorce son distintas.
    const tabla = new Array(CASILLAS).fill(null);
    const repetida = barajas[0];
    const resto = barajas.filter(c => c !== repetida);

    CASILLAS_DOBLE.forEach(casilla => { tabla[casilla] = repetida; });

    let siguiente = 0;
    for (let i = 0; i < CASILLAS; i++) {
        if (CASILLAS_DOBLE.includes(i)) continue;
        tabla[i] = resto[siguiente++];
    }
    return tabla;
}

/**
 * Firma de una tabla, para no repetir.
 *
 * Se ordenan las cartas antes de firmar, así que dos tablas con las MISMAS
 * cartas colocadas distinto cuentan como la misma. Es a propósito y difiere del
 * generador original, que comparaba el orden: dos tablas con idénticas cartas se
 * llenan a la vez y ganarían siempre juntas, y venderlas como distintas sería
 * engañoso. Combinaciones hay de sobra —elegir 16 de 54 son más de 2×10^14— así
 * que ser estricto no cuesta nada.
 */
function firmaDeTabla(tabla) {
    return tabla.filter(c => c !== null).slice().sort((a, b) => a - b).join('-');
}

/**
 * Genera un pack de tablas distintas entre sí.
 *
 * `firmasExistentes` son las tablas que la persona ya tiene, para no venderle
 * dos veces la misma.
 */
function generarPack(cuantas, modo = 'normal', firmasExistentes = []) {
    const vistas = new Set(firmasExistentes);
    const pack = [];

    // Tope de reintentos por si el modo tuviera pocas combinaciones posibles: es
    // preferible entregar el pack aunque repita a quedarse dando vueltas.
    const MAXIMO_INTENTOS = 200;

    for (let n = 0; n < cuantas; n++) {
        let tabla = null;
        for (let intento = 0; intento < MAXIMO_INTENTOS; intento++) {
            const candidata = generarTabla(modo);
            const firma = firmaDeTabla(candidata);
            if (!vistas.has(firma)) {
                vistas.add(firma);
                tabla = candidata;
                break;
            }
        }
        pack.push(tabla || generarTabla(modo));
    }
    return pack;
}

module.exports = {
    CASILLAS, TOTAL_BARAJAS, MODOS, CASILLAS_ESQUINAS, CASILLAS_DOBLE,
    barajar, generarTabla, generarPack, firmaDeTabla
};


/**
 * Comprueba una tabla que arma la persona a mano.
 *
 * El navegador ya avisa mientras se construye, pero eso es comodidad, no
 * seguridad: quien quiera puede mandar el evento a mano desde la consola. Aquí
 * se vuelve a mirar TODO, porque de esto depende que una tabla sea jugable y
 * llegue a repartir dinero.
 *
 * Devuelve `{ ok: true, cartas }` con la tabla ya normalizada, o
 * `{ ok: false, motivo }`.
 */
function validarTablaManual(cartas, modo = 'normal') {
    if (!MODOS.includes(modo)) {
        return { ok: false, motivo: 'Ese tipo de tabla no existe' };
    }
    if (!Array.isArray(cartas) || cartas.length !== CASILLAS) {
        return { ok: false, motivo: `Una tabla son ${CASILLAS} casillas` };
    }

    // Se normaliza antes de mirar nada: por la red pueden llegar cadenas
    // ("12") o undefined, y comparar sin normalizar deja pasar duplicados.
    const limpias = cartas.map(c => {
        if (c === null || c === undefined || c === '') return null;
        const n = Number(c);
        return Number.isInteger(n) ? n : NaN;
    });

    if (limpias.some(c => Number.isNaN(c))) {
        return { ok: false, motivo: 'Hay casillas con algo que no es una carta' };
    }
    if (limpias.some(c => c !== null && (c < 1 || c > TOTAL_BARAJAS))) {
        return { ok: false, motivo: `Las cartas van de 1 a ${TOTAL_BARAJAS}` };
    }

    const puestas = limpias.filter(c => c !== null);

    if (modo === 'normal') {
        if (puestas.length !== CASILLAS) {
            return { ok: false, motivo: 'Faltan casillas por llenar' };
        }
        if (new Set(puestas).size !== puestas.length) {
            return { ok: false, motivo: 'No puedes repetir una carta' };
        }
    }

    if (modo === 'esquinas') {
        const ocupadas = limpias.map((c, i) => c !== null ? i : null).filter(i => i !== null);
        if (JSON.stringify(ocupadas) !== JSON.stringify(CASILLAS_ESQUINAS)) {
            return { ok: false, motivo: 'En este tipo solo se llenan las esquinas y el centro' };
        }
        if (new Set(puestas).size !== puestas.length) {
            return { ok: false, motivo: 'No puedes repetir una carta' };
        }
    }

    if (modo === 'dobles') {
        if (puestas.length !== CASILLAS) {
            return { ok: false, motivo: 'Faltan casillas por llenar' };
        }
        const [a, b] = CASILLAS_DOBLE;
        if (limpias[a] === null || limpias[a] !== limpias[b]) {
            return { ok: false, motivo: 'Las dos del centro tienen que ser la misma carta' };
        }
        // Quitando una de las dos del centro, el resto no puede repetirse.
        const sinLaSegunda = limpias.filter((_, i) => i !== b);
        if (new Set(sinLaSegunda).size !== sinLaSegunda.length) {
            return { ok: false, motivo: 'Solo puede repetirse la carta del centro' };
        }
    }

    return { ok: true, cartas: limpias };
}

module.exports.validarTablaManual = validarTablaManual;
