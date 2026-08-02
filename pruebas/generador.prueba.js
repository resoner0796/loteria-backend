#!/usr/bin/env node
/**
 * Pruebas del generador de tablas.
 *
 * No hacen falta ni Firestore ni red: el generador es una función pura salvo por
 * el azar, así que se comprueba lo que debe cumplirse SIEMPRE (una tabla tiene
 * 16 casillas, las cartas no se repiten…) y, para lo aleatorio, se mide la
 * distribución sobre muchas repeticiones.
 *
 *   npm test
 */

const g = require('../generador');

let fallos = 0;
const total = () => pruebas;
let pruebas = 0;

function ok(nombre, condicion, detalle = '') {
    pruebas++;
    if (!condicion) fallos++;
    console.log(`  ${condicion ? '✅' : '❌'} ${nombre}${detalle ? `\n       ${detalle}` : ''}`);
}

function seccion(titulo) {
    console.log(`\n  ${titulo}\n  ${'─'.repeat(56)}`);
}

// ==================== EL BARAJADO ====================

seccion('El barajado reparte por igual');

{
    // El generador original usaba sort(() => Math.random() - 0.5), que NO da
    // permutaciones uniformes: la primera carta acababa primera un 90% más de lo
    // que le tocaba. Aquí se mide que eso ya no pasa.
    const CARTAS = 10;
    const VUELTAS = 60000;
    const TOLERANCIA = 5;          // %

    const veces = new Array(CARTAS + 1).fill(0);
    for (let i = 0; i < VUELTAS; i++) {
        const lista = [];
        for (let k = 1; k <= CARTAS; k++) lista.push(k);
        veces[g.barajar(lista)[0]]++;
    }

    const esperado = VUELTAS / CARTAS;
    const desvios = veces.slice(1).map(v => Math.abs(v - esperado) / esperado * 100);
    const peor = Math.max(...desvios);

    ok(`ninguna carta se queda primera más de un ${TOLERANCIA}% de lo que le toca`,
        peor < TOLERANCIA, `mayor desvío medido: ${peor.toFixed(1)}%`);

    // Y que de verdad mezcla: dos barajados seguidos no pueden salir iguales.
    const a = g.barajar([1,2,3,4,5,6,7,8,9,10]).join();
    const b = g.barajar([1,2,3,4,5,6,7,8,9,10]).join();
    ok('dos barajados seguidos no dan el mismo resultado', a !== b);
}

// ==================== LOS MODOS ====================

seccion('Modo normal: 16 cartas distintas');
{
    const t = g.generarTabla('normal');
    ok('tiene 16 casillas', t.length === 16);
    ok('ninguna queda vacía', t.every(c => c !== null));
    ok('las 16 cartas son distintas', new Set(t).size === 16);
    ok('todas están entre 1 y 54', t.every(c => c >= 1 && c <= g.TOTAL_BARAJAS));
}

seccion('Modo esquinas: solo 8 casillas (para el Pozo)');
{
    const t = g.generarTabla('esquinas');
    const ocupadas = t.map((c, i) => c !== null ? i : null).filter(i => i !== null);
    ok('tiene 16 casillas', t.length === 16);
    ok('exactamente 8 llevan carta', ocupadas.length === 8);
    ok('y son las esquinas y el centro',
        JSON.stringify(ocupadas) === JSON.stringify(g.CASILLAS_ESQUINAS));
    ok('las 8 son distintas', new Set(t.filter(c => c !== null)).size === 8);
}

seccion('Modo dobles: una carta repetida en el centro');
{
    const t = g.generarTabla('dobles');
    const veces = {};
    t.forEach(c => { veces[c] = (veces[c] || 0) + 1; });
    const repetidas = Object.entries(veces).filter(([, n]) => n > 1);

    ok('ninguna casilla queda vacía', t.every(c => c !== null));
    ok('hay UNA sola carta repetida', repetidas.length === 1);
    ok('y aparece exactamente dos veces', repetidas[0] && repetidas[0][1] === 2);
    ok('la repetida ocupa las dos del centro', t[5] === t[6] && t[5] !== null);
    ok('en total hay 15 cartas distintas', new Set(t).size === 15);
}

// ==================== LOS PACKS ====================

seccion('Packs: tablas distintas entre sí y de las que ya tienes');
{
    const pack = g.generarPack(4, 'normal');
    const firmas = pack.map(g.firmaDeTabla);

    ok('un pack trae las tablas pedidas', pack.length === 4);
    ok('las cuatro son distintas entre sí', new Set(firmas).size === 4);

    const otro = g.generarPack(4, 'normal', firmas);
    ok('un pack nuevo no repite ninguna que ya tuvieras',
        otro.map(g.firmaDeTabla).every(f => !firmas.includes(f)));

    // La firma ordena las cartas: dos tablas con las MISMAS cartas colocadas
    // distinto son la misma tabla, aunque se marquen en otro sitio. Se llenan a
    // la vez, así que venderlas como distintas sería engañoso.
    const unaOrden = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
    const otraOrden = [16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];
    ok('la firma no depende del orden de las casillas',
        g.firmaDeTabla(unaOrden) === g.firmaDeTabla(otraOrden));
}

seccion('Un modo que no existe no devuelve basura');
{
    let reventó = false;
    try { g.generarTabla('inventado'); } catch { reventó = true; }
    ok('lanza error en vez de devolver una tabla rara', reventó);
}

// ==================== RESULTADO ====================

console.log('\n' + '═'.repeat(62));
console.log(fallos === 0
    ? `  ✅ ${pruebas} comprobaciones, todas bien`
    : `  ❌ ${fallos} de ${pruebas} fallaron`);
console.log('═'.repeat(62) + '\n');

process.exit(fallos === 0 ? 0 : 1);
