// Fast drop-in replacement for csv-reader 1.0.0's readCsv.
// Returns byte-identical {columns, rows, errors} for every input, but scans with
// native indexOf jumps and string slices instead of char-by-char concatenation.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Scratch outputs for the field readers.
  let fValue = '';
  let fEnded = 0; // 0 = comma, 1 = line break, 2 = end
  let fAdded = 0;

  function readUnquoted(initial) {
    let value = initial;
    let added = 0;
    let segStart = pos;
    let scan = pos;
    while (true) {
      const iC = text.indexOf(',', scan);
      const iN = text.indexOf('\n', scan);
      const iR = text.indexOf('\r', scan);
      let idx = -1;
      let kind = 0; // 0 comma, 1 LF, 2 CR
      if (iC !== -1) { idx = iC; kind = 0; }
      if (iN !== -1 && (idx === -1 || iN < idx)) { idx = iN; kind = 1; }
      if (iR !== -1 && (idx === -1 || iR < idx)) { idx = iR; kind = 2; }
      if (idx === -1) {
        value += text.slice(segStart, n);
        added += n - segStart;
        pos = n;
        fValue = value; fEnded = 2; fAdded = added;
        return;
      }
      if (kind === 0) {
        value += text.slice(segStart, idx);
        added += idx - segStart;
        pos = idx + 1;
        fValue = value; fEnded = 0; fAdded = added;
        return;
      }
      if (kind === 1) {
        value += text.slice(segStart, idx);
        added += idx - segStart;
        pos = idx + 1;
        line += 1;
        fValue = value; fEnded = 1; fAdded = added;
        return;
      }
      // CR
      if (text.charCodeAt(idx + 1) === 10) { // CRLF ends the field
        value += text.slice(segStart, idx);
        added += idx - segStart;
        pos = idx + 2;
        line += 1;
        fValue = value; fEnded = 1; fAdded = added;
        return;
      }
      // stray CR: dropped with an error; the field goes on
      value += text.slice(segStart, idx);
      added += idx - segStart;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      scan = idx + 1;
      segStart = scan;
    }
  }

  // Ends a quoted field whose content is `value` and whose closing quote has
  // just been consumed (pos is right after it).
  function afterClose(value) {
    if (pos >= n) { fValue = value; fEnded = 2; fAdded = 0; return; }
    const nc = text[pos];
    if (nc === ',') { pos += 1; fValue = value; fEnded = 0; fAdded = 0; return; }
    if (nc === '\n') { pos += 1; line += 1; fValue = value; fEnded = 1; fAdded = 0; return; }
    if (nc === '\r' && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; fValue = value; fEnded = 1; fAdded = 0; return;
    }
    // Junk after the closing quote: appended as it stands (unquoted rules).
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = open + 1;

    // Fast path: the next quote is the closing quote (no doubled quote right
    // after it) and the content holds no CR (which would need rewriting to LF).
    const close = text.indexOf('"', start);
    if (close !== -1 && text.charCodeAt(close + 1) !== 34) {
      const inner = text.slice(start, close);
      if (inner.indexOf('\r') === -1) {
        // Count the LFs inside; they stay in the value as they are.
        let i = inner.indexOf('\n');
        while (i !== -1) { line += 1; i = inner.indexOf('\n', i + 1); }
        pos = close + 1;
        afterClose(inner);
        return;
      }
    }

    // General path: token scan with cuts at quotes and CRs.
    pos = start;
    let segStart = pos;
    let scan = pos;
    let parts = null;
    while (true) {
      const iQ = text.indexOf('"', scan);
      const iN = text.indexOf('\n', scan);
      const iR = text.indexOf('\r', scan);
      let idx = -1;
      let kind = 0; // 0 quote, 1 LF, 2 CR
      if (iQ !== -1) { idx = iQ; kind = 0; }
      if (iN !== -1 && (idx === -1 || iN < idx)) { idx = iN; kind = 1; }
      if (iR !== -1 && (idx === -1 || iR < idx)) { idx = iR; kind = 2; }
      if (idx === -1) {
        // The quote never closes: literal character, re-read as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (kind === 1) { // LF inside quotes: kept as-is, counts a line, no cut
        line += 1;
        scan = idx + 1;
        continue;
      }
      if (kind === 2) { // CR or CRLF inside quotes: read as one LF
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, idx), '\n');
        line += 1;
        scan = idx + (text.charCodeAt(idx + 1) === 10 ? 2 : 1);
        segStart = scan;
        continue;
      }
      // quote
      if (text.charCodeAt(idx + 1) === 34) { // doubled quote -> one literal quote
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, idx), '"');
        scan = idx + 2;
        segStart = scan;
        continue;
      }
      // closing quote
      let value;
      if (parts === null) value = text.slice(segStart, idx);
      else { parts.push(text.slice(segStart, idx)); value = parts.join(''); }
      pos = idx + 1;
      afterClose(value);
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text[pos];
      if (c === '\n') { pos += 1; line += 1; }
      else if (c === '\r' && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record on one line with no quotes and no CRs except a
    // trailing CRLF. Covers plain CSV lines outright.
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = n;
    let lineEnd = eol;
    // Strip a trailing CR only when it is half of a CRLF (an LF exists); a
    // trailing CR at end of text is a stray CR and belongs to the general path.
    if (eol !== n && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    const seg = text.slice(pos, lineEnd);
    if (seg.length > 0 && seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      const fields = seg.split(',');
      pos = eol === n ? n : eol + 1;
      if (eol !== n) line += 1;
      if (width < 0) width = fields.length;
      if (header && columns === null) { columns = fields; continue; }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // General path: field-by-field with the exact reference semantics.
    const fields = [];
    let quoted = false;
    do {
      quoted = text[pos] === '"';
      if (quoted) readQuoted(); else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === 0);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
