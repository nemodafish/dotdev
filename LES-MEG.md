# DOTDEV – nettsiden

## Filene

| Fil / mappe | Hva |
|---|---|
| `index.html`, `personvern.html`, `404.html` | Kildefilene. Det er disse dere redigerer. Guiden øverst i `index.html` forklarer alt. |
| `bygg.py` | Lager en publiseringsklar kopi i `dist/` (uten guiden og kommentarene). |
| `dist/` | Det som publiseres. Lages på nytt hver gang, så ikke rediger her. |
| `_headers` | Sikkerhetsheadere og mellomlagring på Netlify. |
| `robots.txt`, `sitemap.xml` | Forteller Google hvilke sider som finnes. |
| `fonter/`, `bilder/`, ikonene | Fonter, skjermbilder og favicon. |

## Publisere en endring

1. Rediger kildefilene.
2. Åpne Terminal i denne mappen og kjør:

   ```
   python3 bygg.py
   ```

3. I Netlify: åpne siden → **Deploys** → dra mappen `dist` inn i feltet.

Publiser alltid `dist/`, ikke hele mappen. Ellers kommer guiden og kommentarene med ut på nettsiden igjen.

## Venter på dere

- **Team:** navn, roller, bilder og LinkedIn. Blokken ✏️ TEAM i SEKSJON: Om oss.
- **Telefon og sosiale medier:** linjene står klare i footeren og som `telephone`/`sameAs` i JSON-LD i `<head>`.
- **Startpris:** skriv den i svaret på «Hva koster en nettside?».
- **Les gjennom de nye tekstene:** tjenestene (særlig AI-eksemplene), «Hvorfor oss» og spørsmål og svar. Alt skal stemme med det dere faktisk leverer.

## Etter publisering

- Legg til dotdev.no i Google Search Console og send inn `https://dotdev.no/sitemap.xml`.
- Sjekk headerne på securityheaders.com og hastigheten i PageSpeed Insights.
- Opprett en Google Business-profil og be fornøyde kunder om omtaler der.
