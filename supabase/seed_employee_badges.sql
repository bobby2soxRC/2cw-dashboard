-- Badge numbers → Connecteam users, transcribed from the Bucking / Deshoje
-- hour sheets of 10/13/26 and 10/14/26 and matched by name to
-- data/connecteam_roster.json. Run after the employee_badges block in
-- schema.sql. Safe to re-run: a badge that's already set (say, corrected in
-- the admin panel) is left alone.
--
-- Left out, set them in admin.html → Labor Rates → Badge #:
--   76  Sixenia Zorita — not in the Connecteam roster
--   75  David Cruz     — roster has both "David Cruz" and "David Cruz Aguilar"
-- Worth a look (sheet spelling differs from Connecteam):
--   87  "Ayerin Sicarios"     → Jesus Ayerin Sicairos
--   171 "Maria Elena Mendoza" → Maria Mendoza
insert into employee_badges (badge_no, employee_id, employee_name, updated_by) values
  ('49',  '18439332', 'Ramona Ortiz',            'hour sheets 10/13–14/26'),
  ('50',  '18440500', 'Gandy Cardenas',          'hour sheets 10/13–14/26'),
  ('58',  '14921128', 'Ernestina Garcia',        'hour sheets 10/13–14/26'),
  ('59',  '18365366', 'Dalett Castro',           'hour sheets 10/13–14/26'),
  ('61',  '14918145', 'Alicia Morales',          'hour sheets 10/13–14/26'),
  ('62',  '14918142', 'Isabel Hernandez',        'hour sheets 10/13–14/26'),
  ('63',  '14918141', 'Maria Toledo',            'hour sheets 10/13–14/26'),
  ('83',  '15234605', 'Rosa Baeza',              'hour sheets 10/13–14/26'),
  ('84',  '18354230', 'Maria Herlinda Zavala',   'hour sheets 10/13–14/26'),
  ('85',  '14920776', 'Raquel Garcia',           'hour sheets 10/13–14/26'),
  ('87',  '4423514',  'Jesus Ayerin Sicairos',   'hour sheets 10/13–14/26'),
  ('88',  '14921124', 'Ana Reyes',               'hour sheets 10/13–14/26'),
  ('89',  '14936779', 'Vianey Zazueta',          'hour sheets 10/13–14/26'),
  ('90',  '14921123', 'Alma Garcia',             'hour sheets 10/13–14/26'),
  ('95',  '18463177', 'Elena Garnica',           'hour sheets 10/13–14/26'),
  ('102', '18523462', 'Yuliana Rivas Garcia',    'hour sheets 10/13–14/26'),
  ('105', '14882653', 'Araceli Martinez',        'hour sheets 10/13–14/26'),
  ('116', '11174789', 'Anastasia Santiago',      'hour sheets 10/13–14/26'),
  ('117', '5761997',  'Carla Gomez Perez',       'hour sheets 10/13–14/26'),
  ('119', '1606577',  'Aurelia Rosales',         'hour sheets 10/13–14/26'),
  ('126', '18868388', 'Sr. Juan Ninche',         'hour sheets 10/13–14/26'),
  ('135', '18888699', 'Flor Sierra',             'hour sheets 10/13–14/26'),
  ('170', '30716953', 'Manuel Sanchez',          'hour sheets 10/13–14/26'),
  ('171', '30716952', 'Maria Mendoza',           'hour sheets 10/13–14/26'),
  ('172', '14918144', 'Araceli Muniz',           'hour sheets 10/13–14/26'),
  ('173', '30716955', 'Amaya Lopez Mendez',      'hour sheets 10/13–14/26'),
  ('174', '30700818', 'Reyli Edgar Mendez Cruz', 'hour sheets 10/13–14/26'),
  ('175', '30716954', 'Samantha Hernandez Cruz', 'hour sheets 10/13–14/26'),
  ('176', '18517523', 'Oscar Cruz Ruiz',         'hour sheets 10/13–14/26'),
  ('177', '30717005', 'Rosa Navarro',            'hour sheets 10/13–14/26')
on conflict (badge_no) do nothing;
