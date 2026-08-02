// ======================================================
// VICTORIA: DECIDIR QUIÉN GANÓ, SIN QUE NADIE MIRE
// ======================================================
// Hasta ahora el anfitrión validaba a ojo: se le enseñaba la carta del
// reclamante con sus fichas y él decía sí o no. Funcionaba, pero tenía dos
// problemas que no se arreglan mirando mejor — el anfitrión se validaba a sí
// mismo, y cualquiera podía picar LOTERÍA de broma y parar la partida.
//
// Esto solo se pudo escribir cuando las cartas dejaron de ser imágenes. Con una
// carta como lista de 16 números, el servidor sabe exactamente qué lleva cada
// una, y con el historial sabe qué se ha cantado. Ya no hace falta que nadie
// mire.
//
// No toca red ni base de datos: entra una carta y sale un veredicto. Por eso
// tiene pruebas de verdad, que aquí sí valen la pena — es lógica pura y es la
// que decide a dónde va el dinero.

const { CASILLAS } = require('./generador');

/**
 * Las figuras que dan lotería, por índice de casilla.
 *
 *      0   1   2   3
 *      4   5   6   7
 *      8   9  10  11
 *     12  13  14  15
 *
 * Son veinte: cuatro horizontales, cuatro verticales, dos diagonales, las
 * cuatro esquinas y los nueve cuadros de 2×2.
 *
 * Se generan en vez de escribirse a mano. Una lista de veinte cuartetos copiada
 * a mano es justo donde se cuela un número mal, y eso no daría ningún error:
 * daría una figura que no existe o dejaría fuera una legítima, y el fallo solo
 * aparecería el día que alguien la complete.
 */
function construirFiguras() {
    const lado = 4;
    const figuras = [];
    const en = (fila, col) => fila * lado + col;

    for (let f = 0; f < lado; f++) {
        figuras.push({ tipo: 'horizontal', casillas: [0, 1, 2, 3].map(c => en(f, c)) });
        figuras.push({ tipo: 'vertical',   casillas: [0, 1, 2, 3].map(c => en(c, f)) });
    }

    figuras.push({ tipo: 'diagonal', casillas: [0, 1, 2, 3].map(i => en(i, i)) });
    figuras.push({ tipo: 'diagonal', casillas: [0, 1, 2, 3].map(i => en(i, lado - 1 - i)) });

    figuras.push({ tipo: 'esquinas', casillas: [en(0, 0), en(0, 3), en(3, 0), en(3, 3)] });

    for (let f = 0; f < lado - 1; f++) {
        for (let c = 0; c < lado - 1; c++) {
            figuras.push({
                tipo: 'cuadro',
                casillas: [en(f, c), en(f, c + 1), en(f + 1, c), en(f + 1, c + 1)]
            });
        }
    }
    return figuras;
}

const FIGURAS = construirFiguras();

/** Lo que se le dice a quien tenía la figura pero gritó tarde. */
const SE_TE_PASO = '¡Se te pasó! Había que gritar con esa baraja.';

/** Las cuatro del centro, que es lo que se lleva el Pozo acumulado. */
const CENTRO = [5, 6, 9, 10];

/**
 * Qué hay que completar para ganar, según el modo.
 *
 *   figura    cualquiera de las veinte de arriba
 *   completa  todas las casillas que la carta tenga baraja
 *
 * El Pozo va con `completa` porque sus cartas solo tienen ocho casillas: con
 * figuras se ganaría con las cuatro esquinas, que en esa forma es media carta.
 * El acumulado del Pozo sigue siendo aparte, por llenar el centro.
 */
const CONDICION_POR_MODO = {
    'tradicional': 'figura',
    'doble':       'figura',
    'llena':       'completa',
    'pozo':        'completa'
};

// ==================== EVALUAR ====================

/**
 * ¿Está cantada la baraja de esta casilla?
 *
 * El historial llega como cadenas con ceros ("07"), que es como viajan las
 * barajas por toda la aplicación, y una carta las guarda como números. Comparar
 * sin normalizar daría siempre que no, en silencio y para todo el mundo.
 */
const estaCantada = (baraja, cantadas) =>
    baraja !== null && baraja !== undefined && cantadas.has(Number(baraja));

/**
 * Revisa una carta y dice con qué ganó, si es que ganó.
 *
 * `marcadas` son los índices de casilla donde el jugador puso ficha. Se exige
 * que la figura esté marcada ADEMÁS de cantada: tener las barajas y no darse
 * cuenta no es lotería, igual que en la mesa de verdad.
 *
 * ⚠️ Lo que decide el dinero es que las barajas estén CANTADAS, y eso lo sabe
 * el servidor: el historial es suyo y las barajas de la carta también. Las
 * fichas las manda el navegador y podrían falsearse, pero mentir ahí solo
 * saltaría el requisito de haber estado atento — nunca daría por buena una
 * carta cuyas barajas no hayan salido.
 *
 * Devuelve `{ gano, tipo, casillas, motivo }`.
 */
function evaluarCarta(barajas, cantadas, marcadas, condicion = 'figura', ultima = null) {
    if (!Array.isArray(barajas) || barajas.length !== CASILLAS) {
        return { gano: false, motivo: 'La carta no tiene la forma que debe' };
    }

    const conFicha = new Set((marcadas || []).map(Number));

    /**
     * ¿Se cerró con la baraja que acaban de cantar?
     *
     * En la mesa de verdad, si se te pasa el momento de gritar ya no vale: el
     * que canta sigue y la ocasión se fue. Sin esta regla bastaba con darse
     * cuenta tarde —o esperar a ver si caía algo mejor, como el pozo— y gritar
     * cuando conviniera, con una figura que llevaba tres barajas completa.
     *
     * `ultima` a null desactiva la regla, que es lo que hacen las pruebas de las
     * figuras en sí.
     */
    const aTiempo = (casillas) =>
        ultima === null || casillas.some(i => Number(barajas[i]) === Number(ultima));

    const cumple = (casillas) =>
        casillas.every(i => estaCantada(barajas[i], cantadas) && conFicha.has(i))
        && aTiempo(casillas);

    if (condicion === 'completa') {
        // Solo cuentan las casillas que llevan baraja: en el Pozo son ocho de
        // dieciséis, y exigir las vacías haría la victoria imposible.
        const ocupadas = barajas
            .map((b, i) => (b === null || b === undefined ? null : i))
            .filter(i => i !== null);

        if (cumple(ocupadas)) {
            return { gano: true, tipo: 'completa', casillas: ocupadas };
        }
        const faltan = ocupadas.filter(i => !estaCantada(barajas[i], cantadas)).length;
        const sinFicha = ocupadas.filter(i => estaCantada(barajas[i], cantadas) && !conFicha.has(i)).length;

        // Tenía la carta llena pero no gritó a tiempo: se le pasó.
        if (faltan === 0 && sinFicha === 0) {
            return { gano: false, motivo: SE_TE_PASO };
        }
        return {
            gano: false,
            motivo: faltan > 0
                ? `Faltan ${faltan} barajas por cantar`
                : `Te faltan ${sinFicha} fichas por poner`
        };
    }

    for (const figura of FIGURAS) {
        // Una figura sobre casillas vacías no existe. Pasa en el modo esquinas,
        // donde media rejilla está a null.
        if (figura.casillas.some(i => barajas[i] === null || barajas[i] === undefined)) continue;
        if (cumple(figura.casillas)) {
            return { gano: true, tipo: figura.tipo, casillas: figura.casillas };
        }
    }

    // Para el aviso se busca a qué se quedó más cerca: decir «te faltó una» es
    // muy distinto de «no tenías nada», y es la diferencia entre un despiste y
    // alguien picando el botón por picarlo.
    let masCerca = 5;
    let laTeniaTarde = false;
    for (const figura of FIGURAS) {
        if (figura.casillas.some(i => barajas[i] === null || barajas[i] === undefined)) continue;
        const puestas = figura.casillas.filter(i => estaCantada(barajas[i], cantadas) && conFicha.has(i)).length;
        if (puestas === figura.casillas.length) laTeniaTarde = true;
        masCerca = Math.min(masCerca, figura.casillas.length - puestas);
    }

    // La figura estaba completa: lo que falló fue el momento, no la carta.
    if (laTeniaTarde) return { gano: false, motivo: SE_TE_PASO };

    return {
        gano: false,
        motivo: masCerca === 1
            ? 'Te faltó una para la figura'
            : `Te faltan ${masCerca === 5 ? 4 : masCerca} para cualquier figura`
    };
}

/**
 * Revisa TODAS las cartas de quien reclama y se queda con la primera que gane.
 *
 * `cartas` es `{ id: [16 barajas] }` — las que el servidor tiene guardadas, no
 * las que mande el navegador.
 */
function evaluarReclamo({ cartas, marcadas, historial, modo, exigirUltima = true }) {
    const condicion = CONDICION_POR_MODO[modo] || 'figura';

    // La figura tiene que incluir la ÚLTIMA baraja cantada: si se te pasó el
    // momento, ya no cuenta. Sin esto, alguien que se diera cuenta tarde podía
    // esperar a que cayera algo mejor —el pozo, por ejemplo— y gritar cuando le
    // conviniera con una figura que llevaba tres barajas cerrada.
    const ultima = (exigirUltima && historial && historial.length > 0)
        ? Number(historial[historial.length - 1])
        : null;

    // El historial viaja con ceros; aquí se compara como número una sola vez,
    // en lugar de normalizar dentro de los bucles.
    const cantadas = new Set((historial || []).map(Number));

    // En qué turno salió cada baraja, para saber cuál cerró la figura. El
    // historial se llena por el final, así que el número más alto es la más
    // reciente. Se guarda la PRIMERA vez que salió: una baraja no se repite en
    // una partida, pero si el historial se reiniciara a medias, quedarse con la
    // primera evita señalar un turno que no fue.
    const turno = new Map();
    (historial || []).forEach((b, i) => {
        const n = Number(b);
        if (!turno.has(n)) turno.set(n, i);
    });

    // El motivo que se enseña sale de la carta MÁS cerca de ganar, no de la
    // última que se mire. Con cuatro cartas en la mesa, la que estuvo a punto es
    // la que interesa: decir «te faltan tres» a quien tenía la figura hecha y
    // gritó tarde es contarle otra partida.
    let mejorMotivo = 'No completaste ninguna figura';
    let seLePaso = false;

    for (const [id, barajas] of Object.entries(cartas || {})) {
        const r = evaluarCarta(barajas, cantadas, (marcadas || {})[id], condicion, ultima);
        if (r.gano) {
            // Con cuál se cerró: de las barajas de la figura, la que salió más
            // tarde. Es la que la gente recuerda —«gané con el gallo»— y hasta
            // ahora no se sabía, porque el anfitrión validaba de un vistazo.
            const barajaFinal = r.casillas
                .map(i => Number(barajas[i]))
                .reduce((a, b) => ((turno.get(b) ?? -1) > (turno.get(a) ?? -1) ? b : a));

            return {
                gano: true,
                carta: id,
                tipo: r.tipo,
                casillas: r.casillas,
                barajaFinal,
                // El Pozo acumulado es aparte de ganar la partida: se lleva
                // llenando las cuatro del centro, tenga la forma que tenga.
                ganoCentro: CENTRO.every(i =>
                    estaCantada(barajas[i], cantadas) && new Set((marcadas[id] || []).map(Number)).has(i))
            };
        }
        if (r.motivo === SE_TE_PASO) seLePaso = true;
        else if (r.motivo && !seLePaso) mejorMotivo = r.motivo;
    }
    return { gano: false, motivo: seLePaso ? SE_TE_PASO : mejorMotivo };
}

/** Cómo se llama cada figura de cara a la gente. */
const NOMBRE_FIGURA = {
    horizontal: 'línea horizontal',
    vertical:   'línea vertical',
    diagonal:   'diagonal',
    esquinas:   'cuatro esquinas',
    cuadro:     'cuadro',
    completa:   'carta llena'
};

module.exports = {
    FIGURAS, CENTRO, CONDICION_POR_MODO, NOMBRE_FIGURA, SE_TE_PASO,
    evaluarCarta, evaluarReclamo
};
