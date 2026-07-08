// Parsuje celý CSV text najednou (ne po řádcích rozdělených '\n') – pole
// v uvozovkách (např. víceřádková poznámka u objednávky) můžou obsahovat
// skutečný znak nového řádku, a naivní split('\n') by takovou objednávku
// rozsekal na několik nesmyslných "řádků" a rozbil tak celý export.
function parseCsv(text) {
  var rows = [];
  var row = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ';') {
      row.push(cur); cur = '';
    } else if (c === '\r') {
      // ignorovat
    } else if (c === '\n') {
      row.push(cur); rows.push(row); row = []; cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
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
      var rows = parseCsv(csv).filter(function (r) { return r.length > 1 || (r.length === 1 && r[0].trim().length > 0); });
      // Vlastní pole "Vyber si běh" (pokud ho produkt má) sedí za standardními
      // sloupci na pozici, kterou zjistíme z hlavičky – u různých produktů se liší.
      var header = rows.length ? rows[0] : [];
      var behIdx = -1;
      for (var h = 0; h < header.length; h++) {
        if (/běh/i.test(header[h])) { behIdx = h; break; }
      }
      // Počítáme distinct e-maily se stavem "Uhrazeno" – ne řádky. Platba na splátky
      // generuje víc faktur (řádků) pro jednoho člověka, takže bez deduplikace
      // by se stejný člověk počítal víckrát.
      var paidAll = {};
      var paidToday = {};
      for (var i = 1; i < rows.length; i++) {
        var cols = rows[i];
        var stav = cols[8];       // sloupec "Stav"
        var email = cols[4];      // sloupec "E-mail"
        var polozka = cols[2];    // sloupec "Položka" (skutečně koupená věc)
        var uhrazeno = cols[24];  // sloupec "Uhrazeno" (datum platby)

        if (isDiscountLine(polozka)) continue; // sleva/kupón, ne skutečný program
        var canon = normalizeItemName(polozka);

        // Neuhrazené objednávky se nepočítají do žádných hlavních součtů (ty
        // zůstávají jen "Uhrazeno"), ale zaznamenáme si je zvlášť u běhu, aby
        // šlo vidět, kolik lidí ještě nedokončilo platbu.
        if (stav === 'Neuhrazeno' && behIdx !== -1) {
          var behValPending = (cols[behIdx] || '').trim();
          if (behValPending) {
            if (!programs[canon]) programs[canon] = { emails: {}, emailsToday: {}, revenue: 0, runs: {} };
            if (!programs[canon].runs[behValPending]) programs[canon].runs[behValPending] = { emails: {}, paidEmails: {}, freeEmails: {}, pendingEmails: {}, revenue: 0 };
            programs[canon].runs[behValPending].pendingEmails[email] = true;
          }
        }

        if (stav !== 'Uhrazeno') continue;
        paidAll[email] = true;
        if (uhrazeno && uhrazeno.indexOf(todayStr) === 0) paidToday[email] = true;

        if (!programs[canon]) programs[canon] = { emails: {}, emailsToday: {}, revenue: 0, runs: {} };
        programs[canon].emails[email] = true;
        if (uhrazeno && uhrazeno.indexOf(todayStr) === 0) programs[canon].emailsToday[email] = true;
        // "Cena položky celkem" – skutečná zaplacená částka za tuhle položku, ne
        // jen katalogová cena produktu (u slev/stipendií jsou jiné).
        var lineTotal = parseFloat((cols[3] || '0').replace(',', '.'));
        if (!isNaN(lineTotal)) programs[canon].revenue += lineTotal;

        if (behIdx !== -1) {
          var behVal = (cols[behIdx] || '').trim();
          if (behVal) {
            if (!programs[canon].runs[behVal]) programs[canon].runs[behVal] = { emails: {}, paidEmails: {}, freeEmails: {}, pendingEmails: {}, revenue: 0 };
            programs[canon].runs[behVal].emails[email] = true;
            if (!isNaN(lineTotal)) programs[canon].runs[behVal].revenue += lineTotal;
            // Placeno = položka se skutečnou částkou > 0, zdarma = 0 Kč (stipendium/voucher na 100 %).
            if (lineTotal > 0) programs[canon].runs[behVal].paidEmails[email] = true;
            else programs[canon].runs[behVal].freeEmails[email] = true;
          }
        }
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
    var runs = Object.keys(p.runs).map(function (r) {
      return {
        name: r,
        enrollments: Object.keys(p.runs[r].emails).length,
        paid: Object.keys(p.runs[r].paidEmails).length,
        free: Object.keys(p.runs[r].freeEmails).length,
        pending: Object.keys(p.runs[r].pendingEmails).length,
        revenue: Math.round(p.runs[r].revenue),
      };
    }).sort(function (a, b) { return b.enrollments - a.enrollments; });
    return {
      name: name,
      enrollments: Object.keys(p.emails).length,
      newToday: Object.keys(p.emailsToday).length,
      revenue: Math.round(p.revenue),
      runs: runs,
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

// Čte cílovou kapacitu jednorázových akcí z plánovací tabulky "2026 Budget
// vzdělávání" (list "Školení", sekce "Plán", sloupec F = "Reálný počet
// účastníků"). SimpleShop kapacitu nikde neeviduje, takže bez tohohle
// zdroje nejde spočítat skutečnou naplněnost v %, jen holý počet přihlášek.
function extractDateKey(cellValue, tz) {
  // Sloupec B je ve skutečnosti nakonfigurovaný jako datum (ne text) – getValues()
  // ho proto vrací jako JS Date objekt, ne jako string "19. 1. 2026".
  if (Object.prototype.toString.call(cellValue) === '[object Date]') {
    return Utilities.formatDate(cellValue, tz, 'yyyy-MM-dd');
  }
  var s = String(cellValue || '').trim();
  var m = s.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!m) return null;
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

function loadCapacityTargets() {
  var targets = {};
  try {
    var budgetSs = SpreadsheetApp.openById('1Alv22uvq4mkotC034qG0DSbN_lP4pFr72KzxNC3ivwo');
    var tz = budgetSs.getSpreadsheetTimeZone();
    var sheet = budgetSs.getSheetByName('Školení');
    var data = sheet.getDataRange().getValues();
    var inPlan = false;
    for (var i = 0; i < data.length; i++) {
      var cell = data[i][1]; // sloupec B (Datum / popisek sekce)
      var labelStr = typeof cell === 'string' ? cell.trim() : '';
      if (labelStr === 'Plán') { inPlan = true; continue; }
      if (labelStr === 'Realita') break; // konec sekce Plán
      if (!inPlan) continue;
      var key = extractDateKey(cell, tz);
      if (!key) continue; // přeskočí "CELKEM", prázdné řádky apod.
      var target = data[i][5]; // sloupec F
      if (typeof target === 'number' && target > 0) targets[key] = target;
    }
  } catch (e) {
    Logger.log('Nepodařilo se načíst cílovou kapacitu: ' + e.message);
  }
  return targets;
}

function pushToDashboard(programList, todayStr) {
  var url = PropertiesService.getScriptProperties().getProperty('DASHBOARD_INGEST_URL');
  var secret = PropertiesService.getScriptProperties().getProperty('DASHBOARD_INGEST_SECRET');
  if (!url || !secret) return; // dashboard push not configured, skip silently

  var payload = {
    updatedAt: todayStr,
    programs: programList.map(function (p) {
      return { name: p.name, price: p.enrollments ? Math.round(p.revenue / p.enrollments) : 0, enrollments: p.enrollments, newToday: p.newToday, runs: p.runs };
    }),
    capacityByDate: loadCapacityTargets(),
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}
