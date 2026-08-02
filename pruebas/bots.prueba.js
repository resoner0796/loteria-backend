#!/usr/bin/env node
/**
 * Pruebas de los bots.
 *
 * Lo que se comprueba es lo que puede costar dinero o romper una sala: que un
 * bot no se lleve una carta que ya tiene alguien, que su apuesta salga de donde
 * debe, que sus relojes se puedan parar, y que su nivel de habilidad se note.
 *
 * El azar se mide sobre muchas repeticiones, igual que en el generador: un bot
 * «distraído» que acertara siempre no sería distraído, y eso no se ve en una
 * sola pasada.
 *
 *   npm test
 */

const b = require('../bots');

let fallos = 0, pruebas = 0;

function ok(nombre, condicion, detalle = '') {
    pruebas++;
    if (!condicion) fallos++;
    console.log(`  ${condicion ? '✅' : '❌'} ${nombre}${detalle ? `\n       ${detalle}` : ''}`);
}

function seccion(titulo) {
    console.log(`\n  ${titulo}\n  ${'─'.repeat(56)}`);
}

/** Una sala de mentira, con lo justo que miran los bots. */
function salaFalsa(extra = {}) {
    return {
        jugadores: {},
        bote: 0,
        costoCarta: 2,
        modoJuego: 'tradicional',
        juegoIniciado: false,
        historial: [],
        ...extra
    };
}

const IDS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0'));

// ==================== AÑADIR Y QUITAR ====================

seccion('Añadir bots a una sala');

{
    const sala = salaFalsa();
    const r = b.agregarBot(sala, 'normal');

    ok('se puede añadir un bot', r.ok);
    ok('queda en la lista de jugadores', Object.keys(sala.jugadores).length === 1);
    ok('se marca como bot', r.bot.esBot === true);
    ok('y NO tiene email — es lo que lo mantiene fuera de Firestore',
        r.bot.email === null);
    ok('tiene nickname', typeof r.bot.nickname === 'string' && r.bot.nickname.length > 0);
    ok('su id se distingue', b.esBot(r.bot.id));

    // Nombres sin repetir: dos bots con el mismo nombre en la lista confunden.
    const sala2 = salaFalsa();
    for (let i = 0; i < b.MAXIMO_BOTS; i++) b.agregarBot(sala2, 'normal');
    const nombres = Object.values(sala2.jugadores).map(j => j.nickname);
    ok('los nombres no se repiten', new Set(nombres).size === nombres.length);

    const deMas = b.agregarBot(sala2, 'normal');
    ok(`no caben más de ${b.MAXIMO_BOTS}`, !deMas.ok);
    ok('y dice por qué', typeof deMas.motivo === 'string');

    const malNivel = b.agregarBot(salaFalsa(), 'inventado');
    ok('un nivel que no existe se rechaza', !malNivel.ok);

    const enJuego = b.agregarBot(salaFalsa({ juegoIniciado: true }), 'normal');
    ok('no se puede añadir a media partida', !enJuego.ok);
}

seccion('Quitar bots');

{
    const sala = salaFalsa();
    const { bot } = b.agregarBot(sala, 'normal');

    // Un reloj vivo apuntando a una sala que ya no existe revienta al dispararse.
    bot.relojes.push(setTimeout(() => { throw new Error('este reloj no debía correr'); }, 50));

    ok('se puede quitar', b.quitarBot(sala, bot.id));
    ok('desaparece de la lista', Object.keys(sala.jugadores).length === 0);
    ok('y sus relojes se paran', bot.relojes.length === 0);

    ok('quitar algo que no es bot no hace nada', !b.quitarBot(sala, 'no-existe'));
}

// ==================== LAS CARTAS ====================

seccion('Un bot no se lleva una carta que ya tiene alguien');

{
    const sala = salaFalsa();
    // Una persona con dos cartas ya elegidas.
    sala.jugadores['humano'] = { id: 'humano', nickname: 'Yo', cartas: ['01', '02'] };
    b.agregarBot(sala, 'normal');
    b.agregarBot(sala, 'normal');

    b.apostarBots(sala, IDS);

    const deLosBots = b.botsDeLaSala(sala).flatMap(x => x.cartas);
    ok('los bots cogieron cartas', deLosBots.length > 0);
    ok('ninguna es la de la persona',
        !deLosBots.includes('01') && !deLosBots.includes('02'));
    ok('y no se pisan entre ellos',
        new Set(deLosBots).size === deLosBots.length);
}

seccion('Con pocas cartas libres, los bots cogen lo que haya');

{
    const sala = salaFalsa();
    b.agregarBot(sala, 'normal');
    b.agregarBot(sala, 'normal');

    // Solo quedan tres cartas para dos bots que quieren dos cada uno.
    b.apostarBots(sala, ['01', '02', '03']);
    const cartas = b.botsDeLaSala(sala).flatMap(x => x.cartas);

    ok('no inventa cartas que no existen', cartas.every(c => ['01','02','03'].includes(c)));
    ok('y sigue sin repetir', new Set(cartas).size === cartas.length);
}

// ==================== EL DINERO ====================

seccion('La apuesta del bot sale de la banca y se puede medir');

{
    const sala = salaFalsa();
    b.agregarBot(sala, 'normal');
    b.agregarBot(sala, 'normal');

    const puesto = b.apostarBots(sala, IDS);
    const cartasTotales = b.botsDeLaSala(sala).reduce((n, x) => n + x.cartas.length, 0);

    ok('devuelve cuánto puso, para poder apuntarlo',
        puesto === cartasTotales * sala.costoCarta,
        `puso ${puesto}, esperaba ${cartasTotales * sala.costoCarta}`);
    ok('y el bote creció justo eso', sala.bote === puesto);
    ok('los bots quedan como que apostaron',
        b.botsDeLaSala(sala).every(x => x.apostado));

    // Llamarlo dos veces no puede cobrar dos veces.
    const otraVez = b.apostarBots(sala, IDS);
    ok('apostar dos veces no vuelve a cobrar', otraVez === 0);
    ok('y el bote no se mueve', sala.bote === puesto);
}

// ==================== LA HABILIDAD ====================

seccion('El nivel se nota: un distraído se pierde barajas');

{
    // Una carta donde la casilla i lleva la baraja i+1.
    const CARTA = Array.from({ length: 16 }, (_, i) => i + 1);
    const barajasDeCarta = () => CARTA;

    function cuantasTapa(nivel, vueltas) {
        let tapadas = 0;
        for (let v = 0; v < vueltas; v++) {
            const sala = salaFalsa();
            const { bot } = b.agregarBot(sala, nivel);
            bot.cartas = ['01'];
            bot.apostado = true;

            // Se cantan las 16 barajas de su carta.
            for (let baraja = 1; baraja <= 16; baraja++) {
                b.alCantarBaraja('x', sala, baraja, barajasDeCarta, () => {});
            }
            // Los relojes no han corrido: se cuenta cuántos LLEGÓ a programar.
            tapadas += bot.relojes.length;
            b.pararRelojes(bot);
        }
        return tapadas / (vueltas * 16);
    }

    const distraido = cuantasTapa('distraido', 60);
    const experto = cuantasTapa('experto', 60);

    ok('el distraído se pierde bastantes',
        distraido > 0.40 && distraido < 0.70,
        `tapó el ${(distraido * 100).toFixed(0)}%, se esperaba cerca del 55%`);
    ok('el experto casi no falla',
        experto > 0.90,
        `tapó el ${(experto * 100).toFixed(0)}%, se esperaba cerca del 97%`);
    ok('y el experto tapa más que el distraído', experto > distraido);
}

seccion('Un bot no marca lo que no tiene');

{
    const CARTA = Array.from({ length: 16 }, (_, i) => i + 1);   // barajas 1..16
    const sala = salaFalsa();
    const { bot } = b.agregarBot(sala, 'experto');
    bot.cartas = ['01'];
    bot.apostado = true;

    // La 40 no está en su carta.
    b.alCantarBaraja('x', sala, 40, () => CARTA, () => {});
    ok('no programa nada por una baraja que no lleva', bot.relojes.length === 0);

    // Un bot que no apostó no juega.
    const { bot: mirón } = b.agregarBot(sala, 'experto');
    mirón.cartas = ['02'];
    b.alCantarBaraja('x', sala, 1, () => CARTA, () => {});
    ok('un bot que no apostó no marca nada', mirón.relojes.length === 0);
}

// ==================== EL TABLERO QUE MANDA ====================

seccion('El tablero del bot tiene la forma que espera la validación');

{
    const sala = salaFalsa();
    const { bot } = b.agregarBot(sala, 'normal');
    bot.cartas = ['01', '02'];
    bot.marcadas = { '01': new Set([0, 1, 2, 3]), '02': new Set([5]) };

    const t = b.tableroDe(bot);

    ok('lleva sus cartas', t.cards.join(',') === '01,02');
    ok('las casillas marcadas son una lista, no un Set',
        Array.isArray(t.marcadas['01']));
    ok('con los números correctos', t.marcadas['01'].join(',') === '0,1,2,3');
    ok('y una ficha por casilla, para poder pintarlo',
        t.chips['01'].length === 4 && t.chips['02'].length === 1);

    // Las fichas van al centro de su casilla: casilla 0 → 12.5%, casilla 5 → 37.5%.
    ok('la ficha de la casilla 0 cae en su cuadro',
        t.chips['01'][0].left === '12.5%' && t.chips['01'][0].top === '12.5%');
    ok('la de la casilla 5 también',
        t.chips['02'][0].left === '37.5%' && t.chips['02'][0].top === '37.5%');
}

// ==================== BOT + VALIDACIÓN ====================

seccion('Lo que produce un bot es lo que la validación sabe leer');

{
    // Esta es la costura que importa: si el bot marcara de una forma y la
    // validación esperara otra, el bot no ganaría NUNCA y nadie se enteraría —
    // parecería que simplemente tiene mala suerte.
    const v = require('../victoria');
    const CARTA = Array.from({ length: 16 }, (_, i) => i + 1);

    const sala = salaFalsa();
    const { bot } = b.agregarBot(sala, 'experto');
    bot.cartas = ['07'];
    bot.marcadas = { '07': new Set([0, 1, 2, 3]) };

    const tablero = b.tableroDe(bot);
    const r = v.evaluarReclamo({
        cartas: { '07': CARTA },
        marcadas: tablero.marcadas,
        historial: ['01', '02', '03', '04'],
        modo: 'tradicional'
    });

    ok('el bot gana con lo que él mismo marcó', r.gano, `motivo: ${r.motivo}`);
    ok('y por la figura correcta', r.tipo === 'horizontal', `dijo: ${r.tipo}`);
    ok('con la carta que era', r.carta === '07');

    // Y al revés: un bot que solo tapó tres no gana, igual que una persona.
    bot.marcadas = { '07': new Set([0, 1, 2]) };
    const casi = v.evaluarReclamo({
        cartas: { '07': CARTA },
        marcadas: b.tableroDe(bot).marcadas,
        historial: ['01', '02', '03', '04'],
        modo: 'tradicional'
    });
    ok('un bot al que le faltó una NO gana', !casi.gano);

    // Un bot distraído que se perdió la baraja tampoco: es lo que le da hueco
    // a la gente.
    bot.marcadas = {};
    const nada = v.evaluarReclamo({
        cartas: { '07': CARTA },
        marcadas: b.tableroDe(bot).marcadas,
        historial: ['01', '02', '03', '04'],
        modo: 'tradicional'
    });
    ok('un bot que no marcó nada tampoco gana, aunque tenga las barajas',
        !nada.gano);
}

// ==================== RESULTADO ====================

console.log('\n' + '═'.repeat(62));
console.log(fallos === 0
    ? `  ✅ ${pruebas} comprobaciones, todas bien`
    : `  ❌ ${fallos} de ${pruebas} fallaron`);
console.log('═'.repeat(62) + '\n');

process.exit(fallos === 0 ? 0 : 1);
