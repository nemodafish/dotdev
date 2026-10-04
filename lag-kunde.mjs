#!/usr/bin/env node
// Lager innlogging til kundeportalen (dotdev.no/kunde). Kjøres på egen PC med Node.js.
// Skriptet lagrer ingenting og sender ingenting noe sted: det skriver ut det dere skal
// lime inn i Netlify, og legger verdien og passordet på utklippstavlen etter tur, så
// ingenting må markeres og kopieres fra terminalen (lange linjer blir ofte brutt der).
// Ikke lim verdiene inn i GitHub (repoet er offentlig).
//
//   node lag-kunde.mjs --epost post@kunde.no --nettsted kunde.no --navn "Kunde AS"
//       Ny kunde, eller nytt passord til en kunde (samme e-post gir samme variabelnavn).
//       Nettstedet skal skrives nøyaktig som i Plausible (uten https:// og www.).
//
//   node lag-kunde.mjs --nokkel
//       Lager PORTAL_NOKKEL, nøkkelen som signerer innloggingene. Trengs én gang.
//
// Se LES-MEG.md («Kundeportalen») for hele oppskriften.

import { randomBytes, randomInt, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';

// Samme innstillinger som kontrolleres i netlify/functions/kunde-api.mjs
const N = 131072, R = 8, P = 1;
// Små bokstaver og tall, uten tegn som er lette å forveksle (0/o, 1/l/i, 2/z, 5/s).
// Lett å skrive av fra en SMS på mobilen.
const TEGN = 'abcdefghjkmnpqrtuvwxy346789';

// Legger tekst på utklippstavlen (Windows og Mac). Teksten sendes via en miljøvariabel,
// så æ, ø og å kommer riktig med. Gir false hvis det ikke går.
function kopier(tekst) {
    try {
        if (process.platform === 'win32') {
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:DD_KOPI'],
                { env: { ...process.env, DD_KOPI: tekst }, stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
            execFileSync('pbcopy', { input: tekst });
        } else return false;
        return true;
    } catch {
        return false;
    }
}

function arg(navn) {
    const i = process.argv.indexOf('--' + navn);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1].trim() : '';
}

function stopp(melding) {
    console.error('\n  ' + melding + '\n');
    process.exit(1);
}

if (process.argv.includes('--nokkel')) {
    console.log('\nLegg inn i Netlify (Project configuration → Environment variables → Add a variable):\n');
    console.log('  Key:    PORTAL_NOKKEL');
    const nokkel = randomBytes(32).toString('base64url');
    console.log('  Value:  ' + nokkel);
    if (kopier(nokkel)) console.log('\n  ✓ Verdien er kopiert. Lim den inn i Netlify med Ctrl+V.');
    console.log('\nHuk av «Contains secret values» og fyll bare inn verdien for Production (scope Functions hvis valget finnes).');
    console.log('Publiser på nytt etterpå (Deploys → Trigger deploy → Deploy project).');
    console.log('Bytter dere nøkkelen senere, blir alle logget ut.\n');
    process.exit(0);
}

const epost = arg('epost').toLowerCase();
const nettsted = arg('nettsted').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const navn = arg('navn') || nettsted;

if (!epost || !nettsted) {
    stopp('Bruk: node lag-kunde.mjs --epost post@kunde.no --nettsted kunde.no --navn "Kunde AS"\n  eller: node lag-kunde.mjs --nokkel');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost) || epost.length > 254) stopp('E-posten ser ikke riktig ut: ' + epost);
if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9._~-]+)?$/i.test(nettsted)) stopp('Nettstedet skal skrives som i Plausible, for eksempel kunde.no: ' + nettsted);

// 5 grupper à 5 tegn: omtrent 119 bits tilfeldighet. Kan ikke gjettes, selv uten sperre.
const passord = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => TEGN[randomInt(TEGN.length)]).join('')).join('-');
const salt = randomBytes(16);
const hash = scryptSync(passord.normalize('NFKC'), salt, 32, { N, r: R, p: P, maxmem: 512 * 1024 * 1024 });

const variabel = 'KUNDE_' + epost.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
const verdi = JSON.stringify({
    epost,
    nettsted,
    navn,
    passord: `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`,
});

console.log(`
1) Legg inn i Netlify (Project configuration → Environment variables → Add a variable).
   Huk av «Contains secret values» og fyll bare inn verdien for Production (scope Functions hvis valget finnes).
   Finnes variabelen fra før, trykk Edit og bytt verdien. Det erstatter den gamle innloggingen
   for denne e-posten (brukes ved nytt passord). Én e-post gir tilgang til ett nettsted.

   Key:    ${variabel}
   Value:  ${verdi}

2) Publiser på nytt: Deploys → Trigger deploy → Deploy project.

3) Send innloggingen til kunden. Send passordet i en annen kanal enn e-post (for eksempel SMS):

   Adresse:  https://dotdev.no/kunde
   E-post:   ${epost}
   Passord:  ${passord}

   Passordet vises bare her og lagres ikke noe sted. Mister kunden det, kjør skriptet på nytt.
   Husk at ${nettsted} må finnes i samme Plausible-konto som API-nøkkelen.
`);

// Verdien og passordet på utklippstavlen etter tur, så ingenting må kopieres fra terminalen
if (process.stdin.isTTY && kopier(verdi)) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('  ✓ Value er kopiert. Lim den inn i Netlify med Ctrl+V nå (hele linjen er med).');
    await rl.question('    Trykk Enter når variabelen er lagret, så kopieres passordet … ');
    if (kopier(passord)) console.log('  ✓ Passordet er kopiert. Lim det inn i SMS-en til kunden med Ctrl+V.');
    await rl.question('    Trykk Enter når SMS-en er sendt, så tømmes utklippstavlen … ');
    kopier(' ');
    rl.close();
    console.log('  ✓ Utklippstavlen er tømt. Har du utklippshistorikk på (Win+V), slett passordet der også.\n');
}
