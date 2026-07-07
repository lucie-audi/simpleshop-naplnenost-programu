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
        var uhrazeno = cols[24];  // sloupec "Uhrazeno" (datum platby)
        paidAll[email] = true;
        if (uhrazeno && uhrazeno.indexOf(todayStr) === 0) paidToday[email] = true;
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
  sheet.getRange(1, 1, 1, 6).setValues([['ID produktu', 'Program', 'Cena', 'Nových dnes', 'Celkem přihlášeno', 'Poslední aktualizace']]);
  if (summaryRows.length > 0) sheet.getRange(2, 1, summaryRows.length, 6).setValues(summaryRows);

  var log = ss.getSheetByName('Log') || ss.insertSheet('Log');
  if (log.getLastRow() === 0) log.appendRow(['Datum', 'ID produktu', 'Program', 'Nových přihlášek']);
  log.getRange(log.getLastRow() + 1, 1, logRows.length, 4).setValues(logRows);
}
