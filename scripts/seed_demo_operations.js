// Fills data/operations/*.json with one demo lot so the operations dashboard
// has something to draw before the floor starts entering real numbers.
//
//   node scripts/seed_demo_operations.js          seed
//   node scripts/seed_demo_operations.js --clear  empty every stage file again
//
// Run --clear before going live; demo rows are indistinguishable from real ones
// on the dashboard, which is the point of them and also the hazard.

const fs = require('fs');
const path = require('path');
const { stages } = require('./ops_fixture.js');

const DIR = path.join(__dirname, '..', 'data', 'operations');
const clear = process.argv.includes('--clear');

Object.keys(stages).forEach((key) => {
  const rows = clear ? [] : stages[key].map((r) => ({
    ...r,
    demo: true,
    submittedAt: `${r.date || '2026-08-01'}T12:00:00.000Z`
  }));
  fs.writeFileSync(path.join(DIR, `${key}.json`), JSON.stringify(rows, null, 2) + '\n');
});

console.log(`${clear ? 'Cleared' : 'Seeded'} ${Object.keys(stages).length} stage files in data/operations/`);
