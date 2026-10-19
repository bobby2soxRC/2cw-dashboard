// Tests for day_plan.js (Master Schedule's "Import day plan"). Run with:
//   node scripts/test_day_plan.js
// The grid is the template's layout (templates/Plan_Proyectos_Template.xlsx)
// with names spelled the way the crew lead types them.

const D = require('../day_plan.js');
const { WORK_LOCATIONS } = require('../operations_stations.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}

const roster = [
  { userId: '1', name: 'Dalett Castro' }, { userId: '2', name: 'Juan J. Parra' }, { userId: '3', name: 'Maria Mendoza' },
  { userId: '4', name: 'Maria Mendoza' }, { userId: '5', name: 'Araceli Martinez' }, { userId: '6', name: 'Anastasia  Santiago' },
  { userId: '7', name: 'Ana Reyes' }, { userId: '8', name: 'David Cruz' }, { userId: '9', name: 'Jorge Rojas' },
  { userId: '10', name: 'Jorge Santiago Calvo' }, { userId: '11', name: 'Ernestina Garcia' }, { userId: '12', name: 'Kevin Sicairos' }
];

console.log('\ntimes');
check('7am', D.parseTime('7am'), '07:00');
check('5:30 pm', D.parseTime('5:30 pm'), '17:30');
check('7 a.m.', D.parseTime('7 a.m.'), '07:00');
check('16:00', D.parseTime('16:00'), '16:00');
check('Google Sheets 7:00:00 AM', D.parseTime('7:00:00 AM'), '07:00');
check('12am is midnight', D.parseTime('12am'), '00:00');
check('a spreadsheet time value', D.parseTime(0.3125), '07:30');
check('nonsense', D.parseTime('temprano'), null);
check('a range', D.parseRange('5:30pm-2am'), ['17:30', '02:00']);
check('a note is not a range', D.parseRange('sale 5am'), null);
check('date serial', D.parseDate(46314), '2026-10-19');
check('US date', D.parseDate('10/19/2026'), '2026-10-19');

console.log('\nnames');
const m = (n) => { const r = D.matchPerson(n, roster); return [r.how, r.person && r.person.name]; };
check('exact, case and accents aside', m('dalett castro'), ['exact', 'Dalett Castro']);
check('a spelling slip', m('Dalet Castro'), ['close', 'Dalett Castro']);
check('a middle initial left out', m('Juan Parra'), ['close', 'Juan J. Parra']);
check('two slips', m('Areceli Martines'), ['close', 'Araceli Martinez']);
check('two people with one name: someone picks', m('Maria Mendoza'), ['pick', null]);
check('one word is never taken on its own', m('Anastasia'), ['pick', null]);
check('“Ana” is not Anastasia', D.matchPerson('Anastasia', roster).candidates.map((p) => p.name), ['Anastasia  Santiago']);
check('an extra word: offered, not taken', m('David Cruz Cruz'), ['pick', null]);
check('first name only: several', D.matchPerson('Jorge', roster).candidates.length, 2);
check('not on the roster', m('Steve'), ['none', null]);

console.log('\nthe sheet');
// Column A labels, then 2-column blocks; G:H stands in for the hidden helper columns.
const grid = [
  ['PLAN DEL DÍA', 'Fecha / Date:', 46314],
  ['Escribe solo en las celdas crema…'],
  ['Proyecto / Project', 'Harvest Intake', '', 'Harvest', '', '', 'x'],
  ['Sitio / Site', 'Adobe', '', 'Wiltcat', ''],
  ['Horario: inicio | fin', '5am', '2pm', '4pm', '12:30am'],
  ['Líder / Lead', '', '', 'Juan Parra', ''],
  ['Contratista 1: nombre | cuántos', 'Juan', 8, 'Juan', 10],
  ['Contratista 1: inicio | fin', '', ''],
  ['Contratista 2: nombre | cuántos', 'Juan', 15],
  ['Contratista 2: inicio | fin', '5:30pm', '2am'],
  ['Notas / Notes', 'Kevin en cuartos', ''],
  ['Nombrados (incl. líder)', 3, '', 2],
  ['TOTAL (con contratistas)', 26, '', 12],
  ['Responsabilidad | Nombre ↓', 'Responsabilidad', 'Nombre', 'Responsabilidad', 'Nombre', '', 'Colgar', 'helper'],
  [1, 'Colgar', 'Jorge Santiago Calvo', '', 'Dalet Castro', '', 'Colgar'],
  [2, '', 'Kevin Sicairos', 'Chofer', 'Jorge Rojas (sale 5am)'],
  [3, 'Pesar cajas (6am-2pm)', 'Ernestina Garcia', '', 'Jorge Rojas'],
  [4, 'Metrc', '', '', '']
];
const g = D.parseGrid(grid);
check('the date', g.date, '2026-10-19');
check('two blocks, helper columns ignored', g.blocks.map((b) => b.name), ['Harvest Intake', 'Harvest']);
const ctx = { roster, locations: WORK_LOCATIONS };
const a = D.buildProject(g.blocks[0], g.date, ctx).fields;
check('name gets the date', a.name, 'Harvest Intake 10/19');
check('location', [a.location, a.locationName], ['adobe', '']);
check('hours', [a.startTime, a.endTime, a.end], ['05:00', '14:00', '2026-10-19']);
check('blank responsibility = the one above', a.roles.map((r) => [r.name, r.people.map((p) => p.name)]),
  [['Colgar', ['Jorge Santiago Calvo', 'Kevin Sicairos']], ['Pesar cajas', ['Ernestina Garcia']], ['Metrc', []]]);
check('responsibility processes', a.roles.map((r) => r.process), ['intake_wet', 'intake_wet', '']);
check('a responsibility’s own hours, only where different', [a.roles[1].startTime, a.roles[1].endTime], ['06:00', '']);
check('project process from its responsibilities', a.process, 'intake_wet');
check('one contractor, two times', a.contractors.map((c) => [c.name, c.shifts.map((x) => [x.count, x.startTime, x.endTime])]),
  [['Juan', [[8, '', ''], [15, '17:30', '02:00']]]]);
check('people carry their Connecteam id', a.roles[0].people[0], { userId: '10', name: 'Jorge Santiago Calvo' });
check('notes', a.notes, 'Kevin en cuartos');
const bres = D.buildProject(g.blocks[1], g.date, ctx), b = bres.fields;
check('a misspelled site', b.location, 'wildcat');
check('overnight ends the next morning', [b.startTime, b.endTime, b.end], ['16:00', '00:30', '2026-10-20']);
check('lead matched', b.lead, { userId: '2', name: 'Juan J. Parra' });
check('nobody above Dalett: “Personal”, and flagged', [b.roles[0].name, bres.issues.map((x) => x.code)], ['Personal', ['noRole']]);
check('a person once per responsibility; their note kept', [b.roles[1].people.length, b.notes], [1, 'Jorge Rojas: sale 5am']);
check('picks from the import screen win', D.buildProject(g.blocks[1], g.date, { ...ctx, resolve: (raw) => raw === 'Juan Parra' ? { userId: '', name: 'Juan Parra' } : undefined }).fields.lead,
  { userId: '', name: 'Juan Parra' });

console.log('\nproblems');
const bad = D.parseGrid([['Proyecto', ''], ['Sitio', ''], ['Horario', 'temprano'], ['Contratista 1: nombre | cuántos', 'Juan', ''],
  ['Responsabilidad', 'Responsabilidad', 'Nombre'], ['', 'Trim', 'Ana Reyes']]);
check('errors for a block that can’t be saved', D.buildProject(bad.blocks[0], '2026-10-19', ctx).issues.filter((x) => x.level === 'error').map((x) => x.code),
  ['noName', 'noSite', 'badTime', 'flcCount']);
check('not the day plan', D.parseGrid([['a', 'b'], ['c']]).problems, ['noHeader']);
check('pasted text', D.fromText('a\tb\r\nc\t').map((r) => r.length), [2, 2]);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
