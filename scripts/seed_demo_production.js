// Fills data/production/*.json with one demo lot so the production dashboard
// has something to draw before the floor starts entering real numbers.
//
//   node scripts/seed_demo_production.js          seed
//   node scripts/seed_demo_production.js --clear  empty every stage file again
//
// Run --clear before going live; demo rows are indistinguishable from real ones
// on the dashboard, which is the point of them and also the hazard.

const fs = require('fs');
const path = require('path');
const { stages } = require('./prod_fixture.js');

const DIR = path.join(__dirname, '..', 'data', 'production');
const clear = process.argv.includes('--clear');

Object.keys(stages).forEach((key) => {
  const rows = clear ? [] : stages[key].map((r) => ({
    ...r,
    demo: true,
    submittedAt: `${r.date || '2026-08-01'}T12:00:00.000Z`
  }));
  fs.writeFileSync(path.join(DIR, `${key}.json`), JSON.stringify(rows, null, 2) + '\n');
});

console.log(`${clear ? 'Cleared' : 'Seeded'} ${Object.keys(stages).length} stage files in data/production/`);
