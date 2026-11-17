import fs from 'node:fs';

const CHAPTER_COLORS = {
  'Company Profile': '#38BDF8',
  'Business Process': '#2EE59D',
  'Visited Experience': '#C4B5FD',
  'Business Challenge': '#FF6B6B',
};

function parseCsvRfc4180(rawText) {
  const text = rawText.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }

  return rows;
}

const csvPath = new URL('./bingo-7x7-tanjung-priok.csv', import.meta.url);
const [headerRow, ...dataRows] = parseCsvRfc4180(fs.readFileSync(csvPath, 'utf8'));
const colIdx = Object.fromEntries(headerRow.map((h, i) => [h.trim(), i]));

export const TILES = dataRows.map((cols, idx) => {
  const no = Number(cols[colIdx.no]);
  const bab = cols[colIdx.bab].trim();
  const kataKunci = cols[colIdx.kata_kunci].trim();
  const clueKocak = cols[colIdx.clue_kocak].trim();
  return {
    id: idx,
    no,
    bab,
    shortLabel: kataKunci,
    cluePrompt: clueKocak,
    answerDetail: kataKunci,
  };
});

const seenChapters = [];
for (const tile of TILES) {
  if (!seenChapters.includes(tile.bab)) seenChapters.push(tile.bab);
}

export const CHAPTERS = seenChapters.map((name) => ({
  name,
  color: CHAPTER_COLORS[name] || '#38BDF8',
}));

export const GRID_CONFIGS = {
  5: { size: 5, headers: ['P', 'R', 'I', 'O', 'K'], label: '5×5 P·R·I·O·K' },
  7: { size: 7, headers: ['P', 'E', 'L', 'I', 'N', 'D', 'O'], label: '7×7 P·E·L·I·N·D·O' },
};
