// ======================================================
// BOTS: JUGADORES QUE VIVEN EN EL SERVIDOR
// ======================================================
// Un bot es un jugador más de la sala. Elige cartas, apuesta, va tapando las
// barajas que le cantan y grita lotería cuando cree tener figura. La diferencia
// con una persona es que no tiene socket y que su dinero es de la banca.
//
// Existe porque el problema real del juego no es el juego: es juntar gente. Una
// sala de dos no tiene gracia y una de uno no arranca.
//
// Solo se pudo escribir cuando el servidor aprendió a validar solo. Un bot no
// puede «mirar» su carta: necesita que alguien sepa, en datos, si una figura
// está completa. Esa función ya existe —es la misma que juzga a las personas—
// y el bot no tiene una versión propia a propósito: si tuviera la suya, podría
// ganar con reglas distintas.
//
// ⚠️ Lo que un bot NO hace: saltarse la validación. Grita lotería por el mismo
// camino que todo el mundo (`procesarLoteria`) y el servidor lo juzga igual. Un
// bot mal programado que grite sin tener nada se lleva el mismo «aún no» que
// una persona.

const crypto = require('crypto');

/**
 * Cómo juega cada bot.
 *
 *   atencion   probabilidad de darse cuenta de que la baraja está en su carta.
 *              Por debajo de 1 se le pasan barajas, igual que a la gente.
 *   reflejos   cuánto tarda en poner la ficha, en milisegundos. Se sortea entre
 *              los dos valores.
 *   grito      lo que tarda en reaccionar cuando ya tiene figura.
 *
 * El nivel `distraido` existe a propósito y no es un bot roto: una sala donde
 * todos los bots juegan perfecto no es divertida, es una sala donde no ganas
 * nunca. Que se les pasen barajas es lo que deja hueco a la gente.
 */
const NIVELES = {
    distraido: { atencion: 0.55, reflejos: [1400, 3600], grito: [1200, 2600] },
    normal:    { atencion: 0.85, reflejos: [700, 2000],  grito: [600, 1500] },
    experto:   { atencion: 0.97, reflejos: [300, 900],   grito: [250, 700] }
};

/** Nombres de la lotería, para que se note quién es quién en la lista. */
const NOMBRES = [
    'Doña Cuca', 'El Catrín', 'La Sirena', 'El Valiente', 'La Dama',
    'El Borracho', 'La Muerte', 'El Diablito', 'La Chalupa', 'El Gallo',
    'La Luna', 'El Corazón', 'La Rana', 'El Nopal', 'La Bota'
];

/** Cuántos bots caben en una sala. Más que esto y la lista no se lee. */
const MAXIMO_BOTS = 6;

const alAzar = (n) => crypto.randomInt(n);
const entre = ([min, max]) => min + alAzar(Math.max(1, max - min));

/**
 * ¿Ocurre algo con esta probabilidad? Con azar criptográfico, no `Math.random`.
 *
 * Podría parecer exagerado para un despiste de un bot, pero esto acaba
 * decidiendo quién se lleva el bote: un bot que se da cuenta gana, y uno que no,
 * no. La regla del proyecto es que lo que reparte dinero no se sortea con un
 * generador predecible, y esto lo reparte.
 */
const ocurre = (probabilidad) => crypto.randomInt(10000) < probabilidad * 10000;

const esBot = (id) => typeof id === 'string' && id.startsWith('bot:');

/** Los bots que hay ahora mismo en una sala. */
const botsDeLaSala = (salaInfo) =>
    Object.values(salaInfo.jugadores || {}).filter(j => j.esBot);

/**
 * Mete un bot en la sala.
 *
 * Devuelve `{ ok, motivo }`. El bot queda como un jugador normal en
 * `salaInfo.jugadores`, con las mismas propiedades, para que todo lo que ya
 * recorre esa lista —el reparto del bote, las rachas, la lista de la sala— lo
 * trate igual sin saber que es un bot.
 */
function agregarBot(salaInfo, nivel = 'normal') {
    if (!NIVELES[nivel]) return { ok: false, motivo: 'Ese nivel no existe' };
    if (salaInfo.juegoIniciado) return { ok: false, motivo: 'La partida ya empezó' };
    if (botsDeLaSala(salaInfo).length >= MAXIMO_BOTS) {
        return { ok: false, motivo: `No caben más de ${MAXIMO_BOTS} bots` };
    }

    const usados = new Set(Object.values(salaInfo.jugadores).map(j => j.nickname));
    const libres = NOMBRES.filter(n => !usados.has(n));
    if (libres.length === 0) return { ok: false, motivo: 'No quedan nombres libres' };

    const id = `bot:${crypto.randomUUID()}`;
    salaInfo.jugadores[id] = {
        id,
        nickname: libres[alAzar(libres.length)],
        esBot: true,
        nivel,
        // Sin email: nunca se escribe en Firestore. Es lo que mantiene el
        // dinero del bot separado del de las personas.
        email: null,
        cartas: [],
        monedas: 0,
        apostado: false,
        cantidadApostada: 0,
        racha: 0,
        host: false,
        pozoActivo: false,
        // Dónde ha puesto sus fichas: { cartaId: Set(casillas) }. Es su tablero,
        // y es lo que viaja al validar, igual que las fichas de una persona.
        marcadas: {},
        // Los relojes que tiene en marcha, para poder pararlos al quitarlo. Sin
        // esto, un bot borrado seguiría poniendo fichas sobre una sala que ya no
        // existe.
        relojes: []
    };
    return { ok: true, bot: salaInfo.jugadores[id] };
}

/** Saca un bot de la sala y para todo lo que tuviera pendiente. */
function quitarBot(salaInfo, id) {
    const bot = salaInfo.jugadores[id];
    if (!bot || !bot.esBot) return false;
    pararRelojes(bot);
    delete salaInfo.jugadores[id];
    return true;
}

function pararRelojes(bot) {
    (bot.relojes || []).forEach(clearTimeout);
    bot.relojes = [];
}

/** Para todos los bots de una sala. Al terminar una ronda y al cerrar la sala. */
function pararBots(salaInfo) {
    botsDeLaSala(salaInfo).forEach(pararRelojes);
}

/**
 * Reparte cartas a los bots que no tengan.
 *
 * Coge de las que quedan libres: un bot no puede llevarse una carta que ya
 * eligió alguien, igual que nadie puede. Se hace justo antes de apostar, y no
 * al añadirlo, para que la gente elija primero — si el bot pica antes, se lleva
 * las cartas que quería la persona y eso se siente mal.
 */
function elegirCartas(salaInfo, bot, disponibles, cuantas = 2) {
    if (bot.cartas.length > 0) return;

    const ocupadas = new Set(
        Object.values(salaInfo.jugadores).flatMap(j => j.cartas || [])
    );
    const libres = disponibles.filter(id => !ocupadas.has(id));

    for (let i = 0; i < cuantas && libres.length > 0; i++) {
        bot.cartas.push(libres.splice(alAzar(libres.length), 1)[0]);
    }
}

/**
 * Los bots ponen su apuesta.
 *
 * ⚠️ El dinero sale de la BANCA, no de una cuenta. Un bot no tiene email, así
 * que nada de esto se escribe en Firestore: solo engorda el bote. Si gana un
 * bot, ese bote vuelve a la banca y la cuenta queda a cero; si gana una
 * persona, la banca ha EMITIDO monedas nuevas.
 *
 * Eso es a propósito —es lo que hace que jugar con bots valga la pena— pero es
 * dinero de verdad saliendo, así que se devuelve cuánto se puso para que quien
 * llame lo registre.
 */
function apostarBots(salaInfo, disponibles) {
    const costo = salaInfo.costoCarta || 1;
    let puesto = 0;

    botsDeLaSala(salaInfo).forEach(bot => {
        if (bot.apostado) return;
        elegirCartas(salaInfo, bot, disponibles);
        if (bot.cartas.length === 0) return;

        const total = costo * bot.cartas.length;
        bot.apostado = true;
        bot.cantidadApostada = total;
        bot.marcadas = {};
        salaInfo.bote += total;
        puesto += total;
    });

    return puesto;
}

/**
 * Cantaron una baraja: cada bot mira si la tiene y, si se da cuenta, la tapa.
 *
 * No marca al instante ni siempre. Un bot que tapa todo en el mismo milisegundo
 * en que se canta gana siempre y no hay partida — y además se nota que es una
 * máquina. El retardo y los despistes son lo que lo hace jugable.
 *
 * `barajasDeCarta` resuelve un id de carta a sus 16 números; lo pasa el
 * servidor, que es quien sabe de dónde salen.
 */
function alCantarBaraja(sala, salaInfo, baraja, barajasDeCarta, alPonerFicha) {
    const numero = Number(baraja);

    botsDeLaSala(salaInfo).forEach(bot => {
        if (!bot.apostado) return;
        const nivel = NIVELES[bot.nivel] || NIVELES.normal;

        bot.cartas.forEach(cartaId => {
            const barajas = barajasDeCarta(cartaId);
            if (!barajas) return;

            barajas.forEach((b, casilla) => {
                if (Number(b) !== numero) return;
                // Se le pasa: ni se entera de que la tenía.
                if (!ocurre(nivel.atencion)) return;

                const reloj = setTimeout(() => {
                    if (!salaInfo.jugadores[bot.id]) return;   // lo quitaron
                    if (!bot.marcadas[cartaId]) bot.marcadas[cartaId] = new Set();
                    bot.marcadas[cartaId].add(casilla);
                    // Se avisa en CADA ficha, no solo cuando hay figura: el bot
                    // no sabe si la tiene. Lo comprueba el servidor por el mismo
                    // camino que juzga a las personas, y si no la tiene no pasa
                    // nada. Darle al bot su propia comprobación sería tener dos
                    // versiones de la regla que reparte el dinero.
                    alPonerFicha(bot, nivel);
                }, entre(nivel.reflejos));

                bot.relojes.push(reloj);
            });
        });
    });
}

/**
 * El tablero del bot, con la forma que espera la validación.
 *
 * Las fichas se ponen en el centro de su casilla. No hacen falta para decidir
 * —eso va por `marcadas`— pero sí para que la sala vea la carta ganadora del
 * bot con sus fichas encima, igual que la de cualquiera.
 */
function tableroDe(bot) {
    const marcadas = {};
    const chips = {};

    for (const [cartaId, casillas] of Object.entries(bot.marcadas)) {
        marcadas[cartaId] = [...casillas];
        chips[cartaId] = [...casillas].map(c => ({
            left: `${(c % 4) * 25 + 12.5}%`,
            top: `${Math.floor(c / 4) * 25 + 12.5}%`
        }));
    }

    return { cards: bot.cartas, marcadas, chips, skin: null };
}

module.exports = {
    NIVELES, NOMBRES, MAXIMO_BOTS,
    esBot, botsDeLaSala, agregarBot, quitarBot, pararBots, pararRelojes,
    apostarBots, alCantarBaraja, tableroDe, entre
};
