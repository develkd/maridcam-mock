'use strict';

/**
 * Erzeugt eine kleine, gültige PDF-Datei als Platzhalter für eine fotografierte/gescannte Quittung.
 * Schrift: Helvetica mit WinAnsiEncoding. Zeichen außerhalb davon (z. B. ş, ğ, ı) werden vereinfacht.
 */
const SIMPLIFY = { ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I' };

function encodeText(text) {
  const simplified = [...String(text)].map((c) => SIMPLIFY[c] ?? c).join('');
  const bytes = [];
  for (const c of simplified) {
    const code = c.codePointAt(0);
    if (c === '€') bytes.push(0x80);
    else if (code < 256) bytes.push(code);
    else bytes.push(0x3f); // '?'
  }
  return Buffer.from(bytes)
    .toString('latin1')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function pdfFromLines(lines) {
  const textOps = lines
    .map(([size, text], i) => `BT /F1 ${size} Tf 56 ${780 - i * 28} Td (${encodeText(text)}) Tj ET`)
    .join('\n');
  const stream = `0.93 0.95 1 rg 40 560 515 250 re f\n0 0 0 rg\n${textOps}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * PDF-Beleg einer Testquittung. `withDates: false` lässt Datum und Monate weg – für den Liquibase-Export, dessen
 * Datumswerte erst beim Start relativ zu „heute“ berechnet werden.
 */
function receiptPdf(receipt, { withDates = true } = {}) {
  const person = receipt.person ? `${receipt.person.firstName} ${receipt.person.lastName}` : '–';
  const amount = Number(receipt.amount).toFixed(2).replace('.', ',');
  return pdfFromLines([
    [20, `Quittung ${receipt.receiptNumber.toUpperCase()}`],
    [12, 'Mariendorf Moschee e.V. - Barzahlung Mitgliedsbeitrag'],
    ...(withDates ? [[12, `Datum: ${receipt.receiptDate}`]] : []),
    [12, `Betrag: ${amount} €`],
    ...(withDates ? [[12, `Beitragsmonat(e): ${receipt.months.join(', ')}`]] : []),
    [12, `Für: ${person}`],
    [12, `Eingezahlt von: ${receipt.payerName}`],
    [10, 'MOCKDATEN - kein echter Beleg (maridcam-mock)'],
  ]);
}

module.exports = { receiptPdf, pdfFromLines };
