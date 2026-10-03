# DOTDEV – nettsiden

## Filene

| Fil / mappe | Hva |
|---|---|
| `index.html`, `personvern.html`, `404.html` | Kildefilene. Det er disse dere redigerer. Guiden øverst i `index.html` forklarer alt. |
| `bygg.py` | Lager en publiseringsklar kopi i `dist/` (uten guiden og kommentarene). |
| `netlify.toml` | Får Netlify til å kjøre `bygg.py` og publisere bare `dist/`. |
| `dist/` | Det som publiseres. Netlify lager den på nytt hver gang, så den ligger ikke i GitHub. Ikke rediger her. |
| `_headers` | Sikkerhetsheadere og mellomlagring på Netlify. |
| `robots.txt`, `sitemap.xml` | Forteller Google hvilke sider som finnes. |
| `fonter/`, `bilder/`, ikonene | Fonter, skjermbilder og favicon. |

## Publisere en endring

1. Rediger kildefilene.
2. Last dem opp til GitHub (`main`).
3. Netlify kjører `python3 bygg.py` og publiserer `dist/` automatisk (se `netlify.toml`). Etter et par minutter er endringen ute.

Bare `dist/` blir publisert, så guiden, kommentarene, `LES-MEG.md` og `bygg.py` er ikke synlige på nettsiden. Feiler byggingen, blir forrige versjon liggende ute, og feilen står under **Deploys** i Netlify.

## Venter på dere

- **Team:** navn, roller, bilder og LinkedIn. Blokken ✏️ TEAM i SEKSJON: Om oss.
- **Telefon og sosiale medier:** linjene står klare i footeren og som `telephone`/`sameAs` i JSON-LD i `<head>`.
- **Startpris:** skriv den i svaret på «Hva koster en nettside?».
- **Les gjennom de nye tekstene:** tjenestene (særlig AI-eksemplene), Om oss og spørsmål og svar. Alt skal stemme med det dere faktisk leverer.

## Etter publisering

- Legg til dotdev.no i Google Search Console og send inn `https://dotdev.no/sitemap.xml`.
- Sjekk headerne på securityheaders.com og hastigheten i PageSpeed Insights.
- Opprett en Google Business-profil og be fornøyde kunder om omtaler der.
