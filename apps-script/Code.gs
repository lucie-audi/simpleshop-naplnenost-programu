function parseCsvLine(line) {
  var result = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ';') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function isDiscountLine(name) {
  // Slevy/kupóny se v exportu objevují jako samostatná položka na faktuře
  // (např. "Sleva (790 CZK)", "Sleva (30 %)") – není to koupený program, je to
  // úprava ceny objednávky, kterou nesmíme počítat jako přihlášku.
  return /^sleva\b/i.test((name || '').trim());
}

var CZECH_MONTHS = /(ledna|února|unora|března|brezna|dubna|května|kvetna|června|cervna|července|cervence|srpna|září|zari|října|rijna|listopadu|prosince)/i;

function normalizeItemName(name) {
  var n = (name || '').trim();
  // Obecný tvar bývá "Prefix (Varianta)". U položek s konkrétním termínem
  // (konzultace na kalendáři, "(4. května 17:00-18:00)") je ale to, co je v
  // závorce, jen datum schůzky – ne rozlišující varianta programu. V tom
  // případě naopak zahodíme závorku a použijeme jen prefix, aby se všechny
  // termíny sečetly do jednoho programu.
  var m = n.match(/^(.*?)\(([^)]*)\)\s*$/);
  if (m) {
    var prefix = m[1].trim();
    var inner = m[2].trim();
    var isSchedule = CZECH_MONTHS.test(inner) || /\d{1,2}:\d{2}/.test(inner);
    if (isSchedule && prefix) {
      n = prefix;
    } else if (inner) {
      n = inner;
    }
  }
  // Odstraní příponu platebního plánu, např. "Mentoring Standard – Platba na 2 měsíční splátky"
  n = n.replace(/\s*[–-]\s*Platba na \d+ měsíční splátky.*$/i, '');
  // Odstraní běžné cenové/slevové přípony u produktů, které nemají variantu, ale jen jiný název
  // podle ceny (např. "Akademie: Jak začít podnikat (plná cena)" / "(splátky)" / "- 30% sleva")
  n = n.replace(/\s*\((plná cena|splátky|2\. splátky)[^)]*\)\s*$/i, '');
  n = n.replace(/\s*-\s*\d+%\s*sleva.*$/i, '');
  n = n.replace(/\s*\(stipendia\)\s*$/i, '');
  return n.trim();
}

function pullSimpleShopData() {
  var props = PropertiesService.getScriptProperties();
  var EMAIL = props.getProperty('SIMPLESHOP_EMAIL');
  var API_KEY = props.getProperty('SIMPLESHOP_API_KEY');
  var auth = Utilities.base64Encode(EMAIL + ':' + API_KEY);
  var base = 'https://api.simpleshop.cz/2.0/';
  var opts = { headers: { 'Authorization': 'Basic ' + auth }, muteHttpExceptions: true };

  var tz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');

  var products = JSON.parse(UrlFetchApp.fetch(base + 'product/', opts).getContentText());
  var active = products.filter(function (p) {
    return (p.archived === false || p.archived === 'False' || p.archived === '') && p.type === '11';
  });

  var summaryRows = [];
  var logRows = [];

  // Skutečné programy napříč produkty: klíč = normalizovaný název položky ("Položka" v exportu),
  // hodnota = { emails: {...}, emailsToday: {...} }. Tohle sjednocuje např. "Mentoring Standard"
  // koupené za plnou cenu i se slevou/stipendiem do jednoho programu, protože jde o stejnou
  // položku, jen prodávanou přes jiný produkt/checkout stránku s jinou cenou.
  var programs = {};

  active.forEach(function (p) {
    var resp = UrlFetchApp.fetch(base + 'export/who-bought/product/' + p.id + '/?strict=1', opts);
    var total = 0, newToday = 0;
    try {
      var csv = JSON.parse(resp.getContentText()).csv || '';
      var lines = csv.split('\n').filter(function (l) { return l.trim().length > 0; });
      // Počítáme distinct e-maily se stavem "Uhrazeno" – ne řádky. Platba na splátky
      // generuje víc faktur (řádků) pro jednoho člověka, takže bez deduplikace
      // by se stejný člověk počítal víckrát.
      var paidAll = {};
      var paidToday = {};
      for (var i = 1; i < lines.length; i++) {
        var cols = parseCsvLine(lines[i]);
        var stav = cols[8];       // sloupec "Stav"
        if (stav !== 'Uhrazeno') continue;
        var email = cols[4];      // sloupec "E-mail"
        var polozka = cols[2];    // sloupec "Položka" (skutečně koupená věc)
        var uhrazeno = cols[24];  // sloupec "Uhrazeno" (datum platby)
        paidAll[email] = true;
        if (uhrazeno && uhrazeno.indexOf(todayStr) === 0) paidToday[email] = true;

        if (isDiscountLine(polozka)) continue; // sleva/kupón, ne skutečný program
        var canon = normalizeItemName(polozka);
        if (!programs[canon]) programs[canon] = { emails: {}, emailsToday: {}, revenue: 0 };
        programs[canon].emails[email] = true;
        if (uhrazeno && uhrazeno.indexOf(todayStr) === 0) programs[canon].emailsToday[email] = true;
        // "Cena položky celkem" – skutečná zaplacená částka za tuhle položku, ne
        // jen katalogová cena produktu (u slev/stipendií jsou jiné).
        var lineTotal = parseFloat((cols[3] || '0').replace(',', '.'));
        if (!isNaN(lineTotal)) programs[canon].revenue += lineTotal;
      }
      total = Object.keys(paidAll).length;
      newToday = Object.keys(paidToday).length;
    } catch (e) {}
    summaryRows.push([p.id, p.name, p.price, newToday, total, todayStr]);
    logRows.push([todayStr, p.id, p.name, newToday]);
  });

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var sheet = ss.getSheetByName('List 1');
  sheet.clear();
  sheet.getRange(1, 1, 1, 6).setValues([['ID produktu', 'Produkt/checkout', 'Cena', 'Nových dnes', 'Celkem přihlášeno', 'Poslední aktualizace']]);
  if (summaryRows.length > 0) sheet.getRange(2, 1, summaryRows.length, 6).setValues(summaryRows);

  var log = ss.getSheetByName('Log') || ss.insertSheet('Log');
  if (log.getLastRow() === 0) log.appendRow(['Datum', 'ID produktu', 'Program', 'Nových přihlášek']);
  log.getRange(log.getLastRow() + 1, 1, logRows.length, 4).setValues(logRows);

  var programList = Object.keys(programs).map(function (name) {
    var p = programs[name];
    return {
      name: name,
      enrollments: Object.keys(p.emails).length,
      newToday: Object.keys(p.emailsToday).length,
      revenue: Math.round(p.revenue),
    };
  }).sort(function (a, b) { return b.enrollments - a.enrollments; });

  var progRows = programList.map(function (p) {
    return [p.name, p.newToday, p.enrollments, p.revenue, todayStr];
  });

  var progSheet = ss.getSheetByName('Programy') || ss.insertSheet('Programy');
  progSheet.clear();
  progSheet.getRange(1, 1, 1, 5).setValues([['Program', 'Nových dnes', 'Celkem přihlášeno', 'Tržby', 'Poslední aktualizace']]);
  if (progRows.length > 0) progSheet.getRange(2, 1, progRows.length, 5).setValues(progRows);

  pushToDashboard(programList, todayStr);
}

function pushToDashboard(programList, todayStr) {
  var url = PropertiesService.getScriptProperties().getProperty('DASHBOARD_INGEST_URL');
  var secret = PropertiesService.getScriptProperties().getProperty('DASHBOARD_INGEST_SECRET');
  if (!url || !secret) return; // dashboard push not configured, skip silently

  var payload = {
    updatedAt: todayStr,
    programs: programList.map(function (p) {
      return { name: p.name, price: p.enrollments ? Math.round(p.revenue / p.enrollments) : 0, enrollments: p.enrollments, newToday: p.newToday };
    }),
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}
