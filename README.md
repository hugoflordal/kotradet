# Koträdet

Stamträd för en nötdjursbesättning, ritat från utdrag ur CDB (Jordbruksverkets
centrala djurdatabas).

Skriptet läser alla utdrag av typen *Djurinnehav* (PDF) i en mapp och ritar ett träd
där varje djur är kopplat till sin mor, ordnat efter födelseår. Det markerar bland annat
djur som har försvunnit ur besättningen, betäckta kvigor och kor, kor som borde ha
kalvat och djur som ännu inte är färdigställda som ekologiska. Resultatet blir en
bild (`cattle_genealogy.png`) och en interaktiv webbsida
(`cattle_genealogy_interactive.html`) där man kan sätta namn och anteckningar på
djuren.

## Webbversion

Mappen `web/` är samma verktyg som en webbsida som körs helt i webbläsaren. Man läser
in utdragen som PDF på sidan (eller drar dit dem), ställer in sommarbete och
omställningsdatum under *Inställningar* och sätter namn och anteckningar direkt på
djuren. PDF:erna laddas inte upp någonstans, och allt sparas automatiskt i
webbläsaren. Gamla anteckningar från `notes.json` kan importeras under
*Inställningar*.

Provkör lokalt med `make web` och öppna `http://localhost:8001/`. Sidan behöver
ingen byggprocess: `index.html`, `app.js`, `kotrad.js` och `storage.js` kan läggas
på vilken webbserver som helst.

- `kotrad.js`: tolkning av utdragen och analysen av besättningen (rena funktioner,
  ger samma resultat som `cdb.py`).
- `storage.js`: var datan sparas: i webbläsaren, eller på användarens konto i
  Supabase när `config.js` har en nyckel.
- `config.js`: Supabase-projektets adress och publika nyckel. Tom nyckel betyder
  att allt bara sparas i webbläsaren.
- `app.js`: sidan, med PDF-läsning (pdf.js), layout (Graphviz som WebAssembly) och
  ritning (Cytoscape.js).

### Inloggning och lagring (Supabase)

Med en nyckel i `config.js` loggar man in med en länk i mejlet, och allt sparas på
kontot i tabellen `herds`. Varje användare kan bara läsa och skriva sin egen rad.
Uppsättning:

1. Kör `supabase/schema.sql` i Supabase → SQL Editor.
2. Lägg projektets publika nyckel (anon/publishable) i `web/config.js`. Den får vara
   publik; `service_role`-nyckeln får aldrig hamna här.
3. Authentication → URL Configuration: Site URL och Redirect URLs =
   sidans adress (t.ex. `https://proverhugo.github.io/kotradet/`) och
   `http://localhost:8001/`.
4. Logga in en gång och stäng sedan av nya registreringar om ingen annan ska
   använda sidan.

Sidan publiceras på GitHub Pages av `.github/workflows/pages.yml` (Settings →
Pages → Source: GitHub Actions). Gratisplanen i Supabase har inga backuper att
återställa själv: använd *Exportera allt* under *Inställningar*.

## Python-version

1. Ladda ned *Djurinnehav*-utdrag från CDB som PDF och lägg dem i en mapp.
2. Kopiera `config.example.json` till `config.json` i samma mapp och fyll i:
   - `summer_pasture`: produktionsplatsnummer för betet där tjur och kor går ihop.
     Används för att avgöra vilka djur som är betäckta.
   - `eco_date`: datum då produktionen blev ekologisk.
3. Kör:

   ```sh
   make DATA=/sökväg/till/mappen
   ```

   eller `make serve DATA=...` för att visa den interaktiva sidan på
   `http://<datorn>:8000/`.

Kräver Python 3 och Graphviz (`dot`).

## Data

Utdragen innehåller djurhållarens personnummer och produktionsplatsnummer. Lägg aldrig
PDF-filer, `notes.json` eller `config.json` i repot. `.gitignore` stoppar dem.
