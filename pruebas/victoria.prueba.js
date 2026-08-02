#!/usr/bin/env node
/**
 * Pruebas de la validación automática de victoria.
 *
 * Aquí sí tiene sentido probar función por función, al revés que en el cliente:
 * esto es lógica pura, determinista, y es lo que decide a dónde va el bote. Un
 * fallo no se ve en pantalla — se ve en el saldo de alguien.
 *
 *   npm test
 */

const v = require('../victoria');

let fallos = 0, pruebas = 0;

function ok(nombre, condicion, detalle = '') {
    pruebas++;
    if (!condicion) fallos++;
    console.log(`  ${condicion ? '✅' : '❌'} ${nombre}${detalle ? `\n       ${detalle}` : ''}`);
}

function seccion(titulo) {
    console.log(`\n  ${titulo}\n  ${'─'.repeat(56)}`);
}

/** Una carta llena, con las barajas 1..16 en orden: la casilla i lleva i+1. */
const CARTA = Array.from({ length: 16 }, (_, i) => i + 1);

/** Todas las barajas cantadas, para aislar lo que se está probando. */
const TODAS = new Set(Array.from({ length: 54 }, (_, i) => i + 1));

// ==================== LAS FIGURAS ====================

seccion('Las veinte figuras están todas, y son las que deben ser');

{
    ok('hay exactamente 20 figuras', v.FIGURAS.length === 20, `hay ${v.FIGURAS.length}`);

    const porTipo = {};
    v.FIGURAS.forEach(f => { porTipo[f.tipo] = (porTipo[f.tipo] || 0) + 1; });

    ok('4 horizontales', porTipo.horizontal === 4);
    ok('4 verticales', porTipo.vertical === 4);
    ok('2 diagonales', porTipo.diagonal === 2);
    ok('1 de cuatro esquinas', porTipo.esquinas === 1);
    ok('9 cuadros de 2×2', porTipo.cuadro === 9);

    ok('todas son de 4 casillas', v.FIGURAS.every(f => f.casillas.length === 4));
    ok('ninguna repite casilla', v.FIGURAS.every(f => new Set(f.casillas).size === 4));
    ok('todas caen dentro de la rejilla',
        v.FIGURAS.every(f => f.casillas.every(c => c >= 0 && c < 16)));
    ok('no hay dos figuras iguales',
        new Set(v.FIGURAS.map(f => f.casillas.slice().sort((a, b) => a - b).join('-'))).size === 20);

    // Las conocidas, a mano: si el generador se tuerce, estas lo cazan.
    const tiene = (cs) => v.FIGURAS.some(f =>
        f.casillas.slice().sort((a, b) => a - b).join('-') === cs.join('-'));
    ok('está la primera fila', tiene([0, 1, 2, 3]));
    ok('está la última columna', tiene([3, 7, 11, 15]));
    ok('está la diagonal principal', tiene([0, 5, 10, 15]));
    ok('está la diagonal inversa', tiene([3, 6, 9, 12]));
    ok('están las cuatro esquinas', tiene([0, 3, 12, 15]));
    ok('está el cuadro del centro', tiene([5, 6, 9, 10]));
    ok('NO está una fila en diagonal inventada', !tiene([0, 1, 2, 4]));
}

// ==================== GANAR POR FIGURA ====================

seccion('Gana quien completa una figura, y solo esa persona');

{
    // Fila de arriba: casillas 0..3, barajas 1..4.
    const r = v.evaluarCarta(CARTA, new Set([1, 2, 3, 4]), [0, 1, 2, 3]);
    ok('una fila horizontal da lotería', r.gano);
    ok('y dice qué figura fue', r.tipo === 'horizontal', `dijo: ${r.tipo}`);

    const diag = v.evaluarCarta(CARTA, new Set([1, 6, 11, 16]), [0, 5, 10, 15]);
    ok('la diagonal también', diag.gano && diag.tipo === 'diagonal');

    const esq = v.evaluarCarta(CARTA, new Set([1, 4, 13, 16]), [0, 3, 12, 15]);
    ok('las cuatro esquinas también', esq.gano && esq.tipo === 'esquinas');

    const cuadro = v.evaluarCarta(CARTA, new Set([6, 7, 10, 11]), [5, 6, 9, 10]);
    ok('el cuadro del centro también', cuadro.gano && cuadro.tipo === 'cuadro');

    const vert = v.evaluarCarta(CARTA, new Set([1, 5, 9, 13]), [0, 4, 8, 12]);
    ok('la columna también', vert.gano && vert.tipo === 'vertical');
}

seccion('No gana quien no ha completado nada');

{
    // Tres de cuatro: el caso que más va a pasar de verdad.
    const casi = v.evaluarCarta(CARTA, new Set([1, 2, 3]), [0, 1, 2]);
    ok('tres de cuatro NO es lotería', !casi.gano);
    ok('y se le dice que le faltó una', /faltó una/.test(casi.motivo), casi.motivo);

    // Cuatro barajas cantadas, pero sueltas por la carta: no forman figura.
    const sueltas = v.evaluarCarta(CARTA, new Set([1, 3, 9, 12]), [0, 2, 8, 11]);
    ok('cuatro sueltas que no forman figura NO es lotería', !sueltas.gano);

    // Picar LOTERÍA sin nada: lo que motivó todo esto.
    const broma = v.evaluarCarta(CARTA, new Set([50]), []);
    ok('picar el botón sin tener nada NO es lotería', !broma.gano);
    ok('y no revienta, da un motivo', typeof broma.motivo === 'string' && broma.motivo.length > 0);
}

seccion('Las fichas hacen falta: tener las barajas no basta');

{
    // Las cuatro cantadas, pero sin marcar ninguna.
    const sinFichas = v.evaluarCarta(CARTA, new Set([1, 2, 3, 4]), []);
    ok('con las barajas cantadas pero sin fichas NO gana', !sinFichas.gano);

    // Tres marcadas de las cuatro.
    const faltaUna = v.evaluarCarta(CARTA, new Set([1, 2, 3, 4]), [0, 1, 2]);
    ok('con una ficha de menos tampoco', !faltaUna.gano);

    // Y al revés: marcar casillas cuya baraja NO se ha cantado no vale.
    const marcaDeMas = v.evaluarCarta(CARTA, new Set([1, 2]), [0, 1, 2, 3]);
    ok('marcar fichas de barajas no cantadas no da la victoria', !marcaDeMas.gano);
}

// ==================== CARTA LLENA Y POZO ====================

seccion('Modo llena: hacen falta las 16');

{
    const todas = Array.from({ length: 16 }, (_, i) => i);
    const llena = v.evaluarCarta(CARTA, TODAS, todas, 'completa');
    ok('con las 16 marcadas gana', llena.gano && llena.tipo === 'completa');

    const casi = v.evaluarCarta(CARTA, TODAS, todas.slice(0, 15), 'completa');
    ok('con 15 no gana', !casi.gano);
    ok('y le dice cuántas fichas le faltan', /1 fichas?/.test(casi.motivo), casi.motivo);

    // Una figura no basta cuando el modo pide la carta entera.
    const figura = v.evaluarCarta(CARTA, TODAS, [0, 1, 2, 3], 'completa');
    ok('una fila NO gana en modo llena', !figura.gano);
}

seccion('Modo pozo: la carta tiene huecos y solo cuentan sus ocho casillas');

{
    // Como las de `esquinas`: llenas 0,3,5,6,9,10,12,15 y el resto a null.
    const HUECOS = [0, 3, 5, 6, 9, 10, 12, 15];
    const cartaPozo = new Array(16).fill(null);
    HUECOS.forEach((c, i) => { cartaPozo[c] = i + 1; });

    const gana = v.evaluarCarta(cartaPozo, TODAS, HUECOS, 'completa');
    ok('con sus ocho casillas marcadas gana', gana.gano);
    ok('y no exige las vacías', gana.casillas.length === 8);

    const falta = v.evaluarCarta(cartaPozo, TODAS, HUECOS.slice(0, 7), 'completa');
    ok('con siete no gana', !falta.gano);

    // Por figuras, una carta de esquinas solo puede hacer dos: las cuatro
    // esquinas y el cuadro del centro. Una fila es imposible, está medio vacía.
    const porFigura = v.evaluarCarta(cartaPozo, TODAS, [0, 3, 12, 15], 'figura');
    ok('por figuras, las cuatro esquinas sí se pueden hacer', porFigura.gano);

    const filaImposible = v.evaluarCarta(cartaPozo, TODAS, [0, 1, 2, 3], 'figura');
    ok('pero una fila con casillas vacías no cuenta como figura',
        !filaImposible.gano || filaImposible.tipo !== 'horizontal');
}

// ==================== EL RECLAMO COMPLETO ====================

seccion('Un reclamo mira todas las cartas del jugador');

{
    const cartas = {
        '01': CARTA,
        '02': Array.from({ length: 16 }, (_, i) => i + 20)     // barajas 20..35
    };

    // Gana con la SEGUNDA carta: fila de arriba, barajas 20..23.
    const r = v.evaluarReclamo({
        cartas,
        marcadas: { '01': [], '02': [0, 1, 2, 3] },
        historial: ['20', '21', '22', '23'],
        modo: 'tradicional'
    });
    ok('encuentra la victoria aunque esté en la segunda carta', r.gano);
    ok('y dice con cuál ganó', r.carta === '02', `dijo: ${r.carta}`);

    const nada = v.evaluarReclamo({
        cartas,
        marcadas: { '01': [0], '02': [0] },
        historial: ['01', '20'],
        modo: 'tradicional'
    });
    ok('sin figura en ninguna, no gana', !nada.gano);
    ok('y da un motivo que se puede enseñar', typeof nada.motivo === 'string');
}

seccion('El historial llega con ceros y la carta con números');

{
    // Esta es la que se rompería en silencio: "01" !== 1, y nadie ganaría nunca.
    const r = v.evaluarReclamo({
        cartas: { '01': CARTA },
        marcadas: { '01': [0, 1, 2, 3] },
        historial: ['01', '02', '03', '04'],
        modo: 'tradicional'
    });
    ok('compara bien "01" con 1', r.gano, `motivo: ${r.motivo}`);
}

seccion('El Pozo del centro se detecta aparte de ganar');

{
    const r = v.evaluarReclamo({
        cartas: { '01': CARTA },
        marcadas: { '01': [0, 1, 2, 3, 5, 6, 9, 10] },
        historial: ['01', '02', '03', '04', '06', '07', '10', '11'],
        modo: 'tradicional'
    });
    ok('gana por la fila de arriba', r.gano);
    ok('y además se lleva el pozo por el centro', r.ganoCentro);

    const sinCentro = v.evaluarReclamo({
        cartas: { '01': CARTA },
        marcadas: { '01': [0, 1, 2, 3] },
        historial: ['01', '02', '03', '04'],
        modo: 'tradicional'
    });
    ok('ganar sin el centro no da el pozo', sinCentro.gano && !sinCentro.ganoCentro);
}

seccion('Entradas raras no revientan');

{
    ok('una carta que no es lista', !v.evaluarCarta('no soy carta', TODAS, [0]).gano);
    ok('una carta de menos casillas', !v.evaluarCarta([1, 2, 3], TODAS, [0]).gano);
    ok('sin fichas', !v.evaluarCarta(CARTA, TODAS, null).gano);
    ok('sin historial', !v.evaluarReclamo({ cartas: { '01': CARTA }, marcadas: {}, modo: 'tradicional' }).gano);
    ok('sin cartas', !v.evaluarReclamo({ historial: ['01'], modo: 'tradicional' }).gano);
    ok('un modo que no existe usa figuras',
        v.evaluarReclamo({
            cartas: { '01': CARTA }, marcadas: { '01': [0, 1, 2, 3] },
            historial: ['01', '02', '03', '04'], modo: 'inventado'
        }).gano);

    // Índices de ficha fuera de la rejilla: mandados a mano desde la consola.
    ok('índices de ficha imposibles no dan la victoria',
        !v.evaluarCarta(CARTA, TODAS, [99, 100, 101, 102]).gano);
}

// ==================== RESULTADO ====================

console.log('\n' + '═'.repeat(62));
console.log(fallos === 0
    ? `  ✅ ${pruebas} comprobaciones, todas bien`
    : `  ❌ ${fallos} de ${pruebas} fallaron`);
console.log('═'.repeat(62) + '\n');

process.exit(fallos === 0 ? 0 : 1);
