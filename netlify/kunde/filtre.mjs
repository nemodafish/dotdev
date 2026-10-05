// DOTDEV · kundeportalen: filtrene kunden kan legge på (URL «f», kan gjentas, høyst 10).
//
//   f=<op>,<dim>,<v1>,<v2>…   op: is | is_not | contains | contains_not
//
// Hver verdi, og nøkkelen i egenskap:<nøkkel>, er kodet med encodeURIComponent, så komma i en
// verdi er trygt. Alt sjekkes mot faste lister her, så ingen spørring kan få Plausible til å
// svare 400: land, region og by bare med is/is_not og riktig format, mål bare med is/is_not/contains
// og bare mål som finnes, egenskaper bare de nettstedet har (og Plausibles egne url, path og
// search_query). Nettstedet kan aldri velges med et filter.
//
// «Mål er ikke» sendes som Plausibles has_not_done (besøk som ikke har fullført målet), slik
// dashbordet gjør. Det er ikke et målfilter i vanlig forstand: tallene øverst og listene beholder
// vanlige besøkstall (ingen konverteringsrate).

import { Ugyldig } from './perioder.mjs';

const ALLE = ['is', 'is_not', 'contains', 'contains_not'];
const ER = ['is', 'is_not'];

// Portalnavn → Plausible-dimensjon
export const FILTER_DIMENSJONER = {
    side: { dim: 'event:page', ops: ALLE },
    inngang: { dim: 'visit:entry_page', ops: ALLE },
    utgang: { dim: 'visit:exit_page', ops: ALLE },
    vert: { dim: 'event:hostname', ops: ALLE },
    kilde: { dim: 'visit:source', ops: ALLE },
    kanal: { dim: 'visit:channel', ops: ALLE },
    henvisning: { dim: 'visit:referrer', ops: ALLE },
    utm_medium: { dim: 'visit:utm_medium', ops: ALLE },
    utm_source: { dim: 'visit:utm_source', ops: ALLE },
    utm_campaign: { dim: 'visit:utm_campaign', ops: ALLE },
    utm_content: { dim: 'visit:utm_content', ops: ALLE },
    utm_term: { dim: 'visit:utm_term', ops: ALLE },
    land: { dim: 'visit:country', ops: ER, monster: /^[A-Z]{2}$/ },                // ISO 3166-1, «NO»
    region: { dim: 'visit:region', ops: ER, monster: /^[A-Z]{2}-[A-Z0-9]{1,3}$/ },  // ISO 3166-2, «NO-03»
    by: { dim: 'visit:city', ops: ER, monster: /^[1-9]\d{0,9}$/, heltall: true },  // GeoNames-id
    skjerm: { dim: 'visit:device', ops: ER },
    nettleser: { dim: 'visit:browser', ops: ALLE },
    nettleserversjon: { dim: 'visit:browser_version', ops: ALLE },
    os: { dim: 'visit:os', ops: ALLE },
    osversjon: { dim: 'visit:os_version', ops: ALLE },
    mal: { dim: 'event:goal', ops: ['is', 'is_not', 'contains'] },                // is_not → has_not_done (se over)
};

// Egenskaper Plausible alltid tillater (Plausible.Props.internal_keys): url for utgående lenker og
// nedlastinger, path for 404 og skjema, search_query for søk. De står ikke i Sites API-listen.
export const INTERNE_EGENSKAPER = ['url', 'path', 'search_query'];
export const kjentEgenskap = (navn, egenskaper) => INTERNE_EGENSKAPER.includes(navn) || (Array.isArray(egenskaper) && egenskaper.includes(navn));

export const MAKS_FILTRE = 10;
const MAKS_VERDIER = 10;
const MAKS_LENGDE = 300;
const MAKS_RAA = 12000;
const KONTROLLTEGN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const HENDELSE = new Set(['side', 'vert', 'mal']);      // filtre på hendelser (resten er på besøket)

export class MalUkjent extends Error {}               // mållisten kunne ikke hentes, så is-filteret kan ikke sjekkes

function dekod(s) {
    try { return decodeURIComponent(s); } catch { throw new Ugyldig('Ugyldige tegn i et filter.'); }
}

// raa: alle «f»-verdiene. oppsett: { mal: [navn…] | null, egenskaper: [nøkkel…] | null }
export function lesFiltre(raa, oppsett) {
    if (raa.length > MAKS_FILTRE) throw new Ugyldig(`Høyst ${MAKS_FILTRE} filtre om gangen.`);
    const sett = new Set();
    const ut = [];
    for (const f of raa) {
        if (f.length > MAKS_RAA) throw new Ugyldig('Filteret er for langt.');
        const [op, dimRaa = '', ...kodet] = f.split(',');
        let nokkel, def;
        if (dimRaa.startsWith('egenskap:')) {
            const navn = dekod(dimRaa.slice(9));
            if (!kjentEgenskap(navn, oppsett.egenskaper)) throw new Ugyldig('Ukjent egenskap i filteret.');
            nokkel = 'egenskap:' + navn;
            def = { dim: 'event:props:' + navn, ops: ALLE };
        } else if (Object.hasOwn(FILTER_DIMENSJONER, dimRaa)) {
            nokkel = dimRaa;
            def = FILTER_DIMENSJONER[dimRaa];
        } else {
            throw new Ugyldig('Ukjent filter.');
        }
        if (!def.ops.includes(op)) throw new Ugyldig('Ugyldig filtertype.');
        if (kodet.length < 1 || kodet.length > MAKS_VERDIER) throw new Ugyldig(`Et filter må ha 1–${MAKS_VERDIER} verdier.`);
        const verdier = kodet.map(dekod);
        for (const v of verdier) {
            if (!v.length || v.length > MAKS_LENGDE || KONTROLLTEGN.test(v)) throw new Ugyldig('Ugyldig verdi i et filter.');
            if (def.monster && !def.monster.test(v)) throw new Ugyldig('Ugyldig verdi i et filter.');
            if (def.heltall && Number(v) > 4294967295) throw new Ugyldig('Ugyldig verdi i et filter.');
        }
        if (nokkel === 'mal' && (op === 'is' || op === 'is_not')) {
            // Plausible svarer 400 på mål som ikke finnes (også inni has_not_done), så de sjekkes her først
            if (!Array.isArray(oppsett.mal)) throw new MalUkjent('Fikk ikke hentet målene.');
            if (verdier.some((v) => !oppsett.mal.includes(v))) throw new Ugyldig('Ukjent mål i filteret.');
        }
        const id = op + ' ' + nokkel;
        if (sett.has(id)) throw new Ugyldig('Samme filter står to ganger.');
        sett.add(id);
        ut.push({ op, nokkel, dim: def.dim, verdier: def.heltall ? verdier.map(Number) : verdier });
    }
    return ut;
}

export const tilPlausible = (filtre) => filtre.map((f) => (f.nokkel === 'mal' && f.op === 'is_not'
    ? ['has_not_done', ['is', f.dim, f.verdier]]
    : [f.op, f.dim, f.verdier]));
export const erEgenskap = (f) => f.nokkel.startsWith('egenskap:');
// Målfilter som gjør visningen til en konverteringsvisning (is/contains, ikke «er ikke»)
export const erMalFilter = (f) => f.nokkel === 'mal' && f.op !== 'is_not';

// Hva filtrene betyr for metrikkene (som hasConversionGoalFilter, hasPageFilter og
// hasEventFilters i Plausibles dashbord). Sidefilter med is_not teller også, ellers ville
// views_per_visit gitt 400 hos Plausible. «Mål er ikke» (has_not_done) er ikke et
// konverteringsfilter, men teller som hendelsesfilter (som i dashbordet).
export function kontekst(filtre, sanntid) {
    return {
        sanntid,
        mal: filtre.some(erMalFilter),
        side: filtre.some((f) => f.nokkel === 'side'),
        hendelse: filtre.some((f) => HENDELSE.has(f.nokkel) || erEgenskap(f)),
    };
}

// Plausible regner konverteringsrate mot alle besøkende uten mål- og egenskapsfiltrene på
// øverste nivå (Query.remove_top_level_filters). has_not_done ligger ikke på øverste nivå og blir stående.
export const utenMalOgEgenskap = (filtre) => filtre.filter((f) => !erMalFilter(f) && !erEgenskap(f));

// revenueAvailable i dashbordet: målfilteret nevner inntektsmål, og alle har samme valuta
export function inntektIFilter(filtre, inntektsmal) {
    const navn = new Set(filtre.filter(erMalFilter).flatMap((f) => f.verdier));
    const treff = (inntektsmal || []).filter((m) => navn.has(m.navn));
    return treff.length > 0 && treff.every((m) => m.valuta === treff[0].valuta);
}
