# Impressive Leads – Apify scraper

Node.js-script som samlar svenska B2B-leads via två Apify-actors och exporterar en färdig CSV.

## Vad den gör

1. **Google Maps Scraper** (`nwua9Gu5YkAT85Sp6`) – 480 sökningar
   (30 orter × 4 branscher × 4 söktermer, max 10 resultat/sökning)
2. Deduplicerar unika hemsidor
3. **Website Contact Scraper** (`nFiAnXSwprBHCvVco`) – hämtar e-postadresser
4. Skriver CSV med kolumnerna **Företag, Stad, Bransch, Hemsida, Epost** till
   `~/Desktop/impressive_leads.csv`

Mellansteg sparas som JSON i `checkpoints/` för felsökning.

## Kör

```bash
cd maps-scraper
npm install
export APIFY_TOKEN=apify_api_DIN_TOKEN
node index.js
```

`APIFY_TOKEN` **måste** sättas som miljövariabel – scriptet avbryter annars.
Tokenen committas aldrig till git.

## Körtid & kostnad

- Google Maps-delen tar normalt 20–60 min.
- Website Contact-delen körs i batcher om 500 URL:er; varje batch kan ta 10–30 min.
- Apify-debitering sker per actor-run enligt ditt konto.

## Orter & branscher

30 orter: Stockholm, Göteborg, Malmö, Uppsala, Västerås, Örebro, Linköping,
Helsingborg, Jönköping, Norrköping, Lund, Umeå, Gävle, Borås, Eskilstuna,
Södertälje, Karlstad, Halmstad, Växjö, Sundsvall, Luleå, Trollhättan, Östersund,
Kalmar, Falun, Visby, Karlskrona, Kristianstad, Skellefteå, Uddevalla.

4 branscher med 4 termer vardera:
- **Camping/Stugby**: camping, stugby, husbilscamping, stuguthyrning
- **Restaurang/Krog**: restaurang, krog, bistro, pub
- **Aktivitet/Upplevelse**: aktivitet, upplevelse, äventyr, turistaktivitet
- **Mäklare**: mäklare, fastighetsmäklare, bostadsmäklare, mäklarbyrå
