# SimpleShop – naplněnost programů

Google Apps Script napojený na tabulku "Claude Code Naplnenost", který jednou denně:

1. Stáhne seznam aktivních programů (typ 11) ze SimpleShop API.
2. Pro každý spočítá počet nových přihlášek za daný den a celkový počet přihlášek od začátku.
3. Zapíše souhrn do listu `List 1` a přidá řádek do listu `Log` (historie den po dni).

## Nastavení

Ve Vlastnostech skriptu (Project Settings → Script properties) je potřeba nastavit:

- `SIMPLESHOP_EMAIL` – přihlašovací e-mail do SimpleShopu
- `SIMPLESHOP_API_KEY` – API klíč ze SimpleShopu (Nastavení → Propojení → API)

Spouští se přes časový trigger (Triggers → `pullSimpleShopData` → Time-driven → Day timer).
