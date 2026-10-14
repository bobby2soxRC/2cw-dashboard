// Master Service Agreement generator — fills the 2CW post-harvest MSA with a
// customer's details and saves it as a PDF, built in the browser with jsPDF.
//
// Used from the Drying Schedule editor (drying_schedule.html, filled from the
// request the client sent in) and from a customer's Documents sheet on the
// Customer IDs tab (information_hub.html). Both call MSA.open(data, opts):
// a dialog shows every blank so the office can check and complete it, then
// "Download PDF" builds the agreement.
//
// The wording below is the 10-1-2026 agreement (MSA_2CW_10-1-2026.docx).
// When the lawyer changes the agreement, change it here too — and bump
// CACHE_VERSION in sw.js. Rates in Exhibit A are written out as in the
// agreement; the Exhibit B defaults come from DRYING_SERVICES
// (drying_services.js) via EXB below.
(function () {
  const COMPANY = {
    name: '2CW Productions, Inc.', address: '4820 Loasa Road', city: 'Kelseyville, CA 95451',
    phone: '(707) 889-4067', email: 'Contracts@2CWProductions.com',
    signer: 'Edward Fussell', title: 'CEO'
  };

  const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
    IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
    MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
    NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

  // How the opening paragraph describes the customer: "X, a Texas Limited
  // Liability Company". Guessed from the legal name, changeable in the dialog.
  const ENTITIES = ['Corporation', 'Limited Liability Company', 'Limited Partnership', 'General Partnership', 'Sole Proprietorship'];
  function guessEntity(name) {
    const n = String(name || '');
    if (/\bL\.?\s?L\.?\s?C\.?(?=\s|$|,)/i.test(n) || /limited liability/i.test(n)) return 'Limited Liability Company';
    if (/\b(L\.?L\.?P|L\.?P)\.?(?=\s|$|,)/i.test(n) || /limited partnership/i.test(n)) return 'Limited Partnership';
    return 'Corporation';
  }

  // Exhibit B line for each service key in DRYING_SERVICES: unit of measure
  // and rate as the agreement words them.
  const EXB = {
    drying:        { unit: 'Per wet pound', rate: '$3.00' },
    farm_labor:    { unit: 'Per hour, per person', rate: '$25.00' },
    hand_bucking:  { unit: 'Per pound', rate: '$7.00' },
    hand_trim:     { unit: 'Per pound', rate: '$75.00' },
    machine_trim:  { unit: 'Per pound', rate: '$65.00' },
    trim_smalls:   { unit: 'Per pound', rate: '$35.00' },
    batching:      { unit: 'Per bag', rate: '$3.00', notes: 'Bags and packaging billed at cost' },
    dry_storage:   { unit: 'Per 4x4 box (16 sq. ft.) per month', rate: '$15.00', notes: 'Days 1–30 after drying at no cost' },
    cargo_van:     { unit: 'Per hour', rate: '$125.00', notes: 'Not available for on-farm harvest transport' },
    box_truck:     { unit: 'Per hour', rate: '$175.00', notes: '$150.00/hr for bookings of 8 hours or more' },
    reefer:        { unit: 'Per hour', rate: '$300.00' },
    rd_potency:    { unit: 'Per sample', rate: '$100.00' },
    rd_full_panel: { unit: 'Per sample', rate: '$420.00' }
  };
  const SERVICE_LIST = () => (typeof DRYING_SERVICES !== 'undefined' ? DRYING_SERVICES : []).flatMap((g) => g.items);
  const serviceLabel = (k) => (SERVICE_LIST().find((s) => s.k === k) || {}).l || k;

  const fmtN = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const fmtDate = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const fmtShort = (iso, addDays = 0) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + addDays * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  };
  const fmtPhone = (p) => {
    const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || '').trim();
  };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const windowText = (w) => {
    const days = Math.max(1, Math.round(Number(w.days) || 1));
    return days > 1 ? `${fmtShort(w.start)}–${fmtShort(w.start, days - 1)}` : fmtShort(w.start);
  };

  // A drying_intakes row (or the editor's current values, same shape) →
  // the agreement's fill-ins.
  function fromIntake(r) {
    r = r || {};
    const harvests = (Array.isArray(r.harvests) ? r.harvests : []).filter((h) => h && h.start);
    const support = (Array.isArray(r.farm_support) ? r.farm_support : []).filter((s) => s && s.start);
    const lbSum = harvests.reduce((a, h) => a + (Number(h.lb) || 0), 0);
    const lbs = Number(r.est_wet_lb) || lbSum || null;
    const services = (Array.isArray(r.services) && r.services.length ? r.services : ['drying']).filter((k) => EXB[k]);
    const legal = (r.legal_business_name || r.farm_name || '').trim();
    return {
      effective_date: today(),
      legal_name: legal,
      entity: guessEntity(legal),
      state: (r.state_incorporated || '').toUpperCase(),
      address: '',
      city: '',
      phone: fmtPhone(r.contact_phone),
      email: r.signer_email || r.contact_email || '',
      signer_name: [r.signer_first_name, r.signer_last_name].filter(Boolean).join(' ') || r.contact_name || '',
      signer_title: '',
      lines: services.map((k) => {
        const line = { label: serviceLabel(k), unit: EXB[k].unit, qty: '', rate: EXB[k].rate, notes: EXB[k].notes || '' };
        if (k === 'drying') {
          if (lbs) line.qty = `${fmtN(lbs)} (est.)`;
          if (harvests.length) line.notes = 'Est. harvests: ' + harvests.map((h) => windowText(h) + (Number(h.lb) ? ` (${fmtN(h.lb)} lbs)` : '')).join('; ');
        }
        if (k === 'farm_labor' && support.length) {
          line.notes = support.map((s) => windowText(s) + (s.people ? `, ${s.people} ${Number(s.people) === 1 ? 'person' : 'people'}` : '')).join('; ');
        }
        return line;
      })
    };
  }

  // ── The agreement text ─────────────────────────────────────────────────
  // Blocks: p (paragraph; **bold** inline), h (numbered section heading),
  // li (lv 1 = A., 2 = a., 3 = bullet; label '' continues the item above),
  // plus the special blocks notices / sig / exb and page (new page).
  // Asterisks are stripped from filled-in values so they can't toggle bold.
  function blocks(d) {
    const v = (s, blank = '____________________') => (String(s || '').replace(/\*/g, '').trim() || blank);
    const stateName = STATES[d.state] || d.state;
    const intro = `${v(d.legal_name)}, a ${stateName ? `${stateName} ` : ''}${d.entity || 'Corporation'}`;
    const dateTxt = fmtDate(d.effective_date) || '____________________';
    const L1 = (label, text) => ({ t: 'li', lv: 1, label, text });
    const L2 = (label, text) => ({ t: 'li', lv: 2, label, text });
    const B = (text) => ({ t: 'li', lv: 3, label: '•', text });
    return [
      { t: 'title', text: 'MASTER SERVICE AGREEMENT FOR POST-HARVESTING PROCESSING' },
      { t: 'p', text: `This Master Services Agreement**,** including exhibits attached hereto (the **“Agreement”**), is made and entered into effective as of ${dateTxt} (the **“Effective Date”**) by and between 2CW Productions, Inc., a California Corporation, (**“Company”**) and ${intro} (**“Customer”**). Company and Customer are the only parties to this Agreement and are sometimes referred to herein singularly as a “**Party**” and collectively as the “**Parties**.”` },
      { t: 'h', n: '1.', text: 'Recitals' },
      { t: 'p', text: 'WHEREAS:', style: 'bolditalic' },
      L1('A.', 'Company operates a licensed facility in California that provides post-harvest services for cannabis, including drying, storage, transportation, trimming and processing;'),
      L1('B.', 'Company possesses the experience, expertise, and resources necessary to perform such services in compliance with industry standards and applicable regulations;'),
      L1('C.', 'Company is duly licensed as a commercial cannabis business under the laws of the State of California, including but not limited to the Medicinal and Adult-Use Cannabis Regulation and Safety Act and the regulations issued by the California Department of Cannabis Control (“DCC”);'),
      L1('D.', 'Company also maintains a Lake County Major Use Permit authorizing the processing, and distribution of cannabis and cannabis products;'),
      L1('E.', 'Customer holds a valid Cannabis license in the State of California issued by the Department of Cannabis Control (“DCC”); and'),
      L1('F.', 'Customer desires to engage Company to provide one or more of the foregoing services for Customer’s cannabis product, subject to the terms and conditions of this Agreement.'),

      { t: 'h', n: '2.', text: 'General Agreement' },
      { t: 'p', text: 'NOW, THEREFORE, in consideration of the mutual covenants contained herein, and for other good and valuable consideration, the receipt and sufficiency of which are acknowledged, the Parties agree as follows:' },
      L1('A.', 'Incorporation of Recitals - The Recitals set forth above are true and correct, and are incorporated into this Agreement as though fully stated herein.'),
      L1('B.', 'Engagement of Company - Customer hereby engages Company, and Company accepts such engagement, to provide the services outlined in Exhibit B (the “Services”) on a non-exclusive basis. All Services shall be performed in accordance with the terms and conditions set forth herein, applicable laws, and the regulations of the California Department of Cannabis Control (“DCC”).'),
      L1('C.', 'Facilities and Equipment - Company shall provide and maintain all facilities, equipment, and resources necessary to perform the Services. In the event of a power outage, Customer shall be responsible, at its sole cost and discretion, for sourcing and delivering a backup generator that meets the specifications required by the Facility. Company will provide the necessary adapter and designated location for connection of the generator.'),
      L1('D.', 'Drying Services - Company shall perform drying services for Customer’s cannabis. Typical drying time ranges from 7 to 10 days, depending on material conditions.'),
      L2('a.', 'Company reserves the right to adjust drying times as necessary to meet industry standards for properly dried product. Drying times shall not be reduced to less than 7 days except where Company determines, based on the condition of the product, that it has been appropriately and safely dried in fewer days.'),
      L2('b.', 'Company is not responsible for pre-existing pests, pathogens, or other quality issues present in Customer’s material.'),
      L1('E.', 'Intake & Quality Control - Prior to intake, Company shall conduct a site visit to Customer’s property to perform a preliminary quality control check to assess for contamination or suitability.'),
      L2('a.', 'Upon delivery to the Facility, Company shall intake, weigh, and record the wet biomass (net of tare weight).'),
      L2('b.', 'Company reserves the right to reject any material deemed to pose a contamination risk to the Facility.'),
      L2('c.', 'Customer may access its product during normal business hours with at least 24 hours’ written notice, and may observe weigh-in and weigh-out procedures.'),
      L2('d.', 'Final intake weights shall be provided to Customer within 24 hours via METRC and invoice.'),
      L2('e.', 'Customer shall provide Company with estimated delivery dates for each harvest at least fourteen (14) days in advance. For large-scale grows involving multiple harvests, Customer shall provide a schedule of expected delivery dates. These estimates are for planning purposes only; however, Customer acknowledges that timely notice is required for Company to allocate facility space, labor, and equipment. Company shall not be liable for delays or inability to perform Services if Customer fails to provide reasonable notice of harvest and delivery schedules.'),
      L1('F.', 'Environmental Conditions - During the initial intake period, humidity levels may rise, potentially exacerbating pre-existing pest or pathogen issues. Company will gradually stabilize temperature and humidity over a three-day period to ensure optimal drying conditions. Company shall not be responsible for pest or pathogen issues present before, during, or after intake.'),
      L1('G.', 'Compliance - Both Parties shall comply with all applicable DCC rules and regulations, including all track-and-trace (METRC) requirements.'),

      { t: 'h', n: '3.', text: 'Term' },
      L1('A.', 'This Agreement shall commence on the Effective Date, being the date of execution by both Company and Customer, and shall remain in effect until completion of the Services, unless earlier terminated in accordance with this Agreement. If Customer elects not to proceed with the Services after execution, Customer shall remain responsible for payment in full for all work performed by Company up to the date of cancellation. All deposits are non-refundable, except in the event that performance is prevented or materially hindered by a force majeure event, or where such circumstances eliminate Customer’s need for drying services. In those cases, deposits shall be refunded in full.'),
      L1('B.', 'Deposit and Payment Terms –'),
      L2('a.', 'Deposit: Within seven (7) calendar days of signing this Agreement, Customer shall remit a deposit equal to twenty percent (20%) of the total value of the Drying Services fees.'),
      L2('b.', 'Progress Payment and Release of Product: Full payment of all amounts due under this Agreement is required before any of Customer’s finished product leaves the Facility. Company may, at its sole discretion, release up to fifty percent (50%) of Customer’s finished product prior to receipt of full payment; in that event, the remaining balance due shall be paid in full within sixty (60) days of drying completion, subject to Sections 3.B.c through 3.B.f below.'),
      L2('c.', 'Final Balance and Default: Where Company has released a portion of Customer’s finished product under subsection (b) above, the remaining balance shall be due within sixty (60) days of drying completion. Any balance not paid when due under this Agreement, including under this subsection, is subject to the grace period, interest, suspension, and default/resale provisions set forth in Section 3.E (Late Fees) below, which together constitute the sole default process under this Agreement.'),
      L2('d.', 'Costs and Supplies: The total amount due shall include any incidental costs or supplies requested by Customer, including but not limited to shipping boxes and totes. Turkey bag batching services are billed at the rate specified in Exhibit A, not at cost. Physical turkey bags and other packaging materials furnished by Company are likewise billed to Customer at cost; the per-bag fee set forth in Exhibit A is a separate batching-service-and-labor charge, not a charge for the bags themselves.'),
      L2('e.', 'Storage Fees: Storage charges will apply beginning on the thirty-first (31st) day after notice of completion of drying, in accordance with Section 3. D. of this Agreement.'),
      L2('f.', 'Valuation of Released Product: Notwithstanding subsection (b), if the fair market value of fifty percent (50%) of Customer’s finished product is less than the outstanding balance due, Company may withhold additional product until the value of the portion retained reasonably secures the unpaid balance. The value shall be determined in good faith by Company based on prevailing wholesale market rates at the time of drying completion.'),
      L1('C.', 'Services –'),
      L1('', 'Company agrees to provide post-harvest services, which include drying, storage, transportation, and trimming, as further described in Exhibit A.'),
      L2('a.', 'Labor Allocation: The per wet pound fee for drying includes facility space and the following standard labor: (i) one forklift operator, (ii) two managers, (iii) one compliance personnel, and (iv) labor necessary for METRC track-and-trace compliance. All other labor required for handling, including but not limited to hanging, moving, and taking down plants, shall be treated as a pass-through cost and billed to Customer at the Farm Labor rate specified in Exhibit A.'),
      L1('D.', 'Storage –'),
      L1('', 'Following notice of completion of drying services, Customer is entitled to up to thirty (30) days of complimentary storage. Beginning on the thirty-first (31st) day, storage charges will accrue in accordance with the rates specified in Exhibit A.'),
      L1('E.', 'Late Fees –'),
      L2('a.', 'Grace Period: Payment of all outstanding balances are due upon completion of Services. (or, where Company has released a portion of Customer’s finished product under Section 3.B.b, within sixty (60) days of drying completion) A grace period of ten (10) business days from the applicable due date will be provided.'),
      L2('b.', 'Suspension of Services: If payment is not received within the grace period, Company may suspend all additional Services for Customer until the account is brought current.'),
      L2('c.', 'Interest: Beginning on the eleventh (11th) business day after completion of Services, unpaid balances shall accrue interest at the rate of 1.5% per month, compounded monthly, or the maximum rate permitted by California law. Payments shall be applied first to accrued interest, then to principal.'),
      L2('d.', 'Default After Thirty Days: If any balance, including accrued interest, remains unpaid thirty (30) calendar days after the expiration of the grace period, Company may resell a portion of Customer’s product at current market value to recover all outstanding amounts, including but not limited to costs of repackaging, compliance, testing, and sales. Company shall not resell inventory under Customer’s brand. An additional fifteen percent (15%) service charge will be added to the outstanding balance if resale is required.'),

      { t: 'h', n: '4.', text: 'General Terms and Conditions' },
      L1('A.', 'Facility and Equipment -'),
      L2('a.', 'Facility Maintenance: Company shall keep, maintain, and repair the Facility in compliance with all applicable state and local laws, regulations, and the terms of this Agreement. Company shall also provide all necessary utilities and services to perform the Services at the Facility. A climate-controlled environment will be maintained to ensure proper storage of the Product(s).'),
      L2('b.', 'Inspection Rights Customer may inspect the Facility during normal business hours upon providing reasonable advance notice. If Customer notifies Company of an emergency or potential emergency, Company shall make reasonable accommodations for access at other times.'),
      L2('c.', 'Company Equipment: Company shall provide, operate, and maintain all equipment required to perform the Services (“Company Equipment”). Customer shall bear no responsibility for the Company Equipment. Company retains the right to use such equipment for purposes other than providing Services under this Agreement.'),
      L2('d.', 'Damage to Equipment: In the event Company Equipment is damaged due to the gross negligence of Customer, Customer shall be responsible for the cost of repair or replacement.'),
      L1('B.', 'Warranty; Delivery and Acceptance; Non-Conforming Products -'),
      L2('a.', 'Company warrants that all Services provided under this Agreement shall:'),
      B('Be performed in compliance with all applicable DCC regulations, Lake County regulations, and the specifications agreed to by the Parties;'),
      B('Use only raw cannabis materials provided and approved by Customer; and'),
      B('If applicable, be packaged and labeled only in packaging approved by Customer (the “Warranty”).'),
      L2('b.', 'Company acknowledges that Customer has a vital interest in protecting the reputation and goodwill associated with its Product(s). If Company has a reasonable basis to believe that any issue with the Product(s) may pose a risk to public health or safety, or could attract negative attention from regulators, consumers, or other third parties (a “Negative Event”), Company shall immediately notify Customer in writing.'),
      L1('C.', 'Release for Homogeneity –'),
      L2('a.', 'Customer acknowledges that natural variations may occur in cannabis products and agrees to release Company, its employees, contractors, agents, owners, vendors, and affiliates (“Company Personnel”) from any claims, demands, or liabilities arising specifically from issues of consistency or uniformity (homogeneity) of the Product(s).'),
      L1('D.', 'Limitation of Liability -'),
      L2('a.', 'Except as expressly provided in this Agreement, the total liability of Company and its affiliates, officers, directors, employees, and representatives for any claims or damages arising under this Agreement shall not exceed the total amount actually paid by Customer to Company under this Agreement.'),
      L2('b.', 'In no event shall Company be liable for indirect, incidental, consequential, special, exemplary, or punitive damages, including but not limited to loss of profits, revenue, data, or business opportunities, even if Company has been advised of the possibility of such damages.'),
      L2('c.', 'The Parties acknowledge that these limitations of liability are a material basis of the bargain and that, without such limitations, the terms of this Agreement would be substantially different.'),
      L1('E.', 'Representations, Warranties, and Covenants -'),
      L2('a.', 'Company represents, warrants, and covenants that:'),
      B('It holds all necessary permits, licenses, and approvals required by the DCC, Lake County, and other authorities to provide the Services (“Required Approvals”), and will maintain such approvals at its sole expense during the Term of this Agreement;'),
      B('It will comply at all times with all applicable laws and regulations, including labor, employment, and tax laws;'),
      B('Its execution and performance of this Agreement does not conflict with or violate any other agreement, order, or legal obligation to which Company is bound; and'),
      B('It has full power and authority to enter into and perform its obligations under this Agreement.'),
      L2('b.', 'Customer represents, warrants, and covenants that:'),
      B('Its execution and performance of this Agreement does not conflict with or violate any other agreement, order, or legal obligation to which Customer is bound;'),
      B('This Agreement is a valid and binding obligation, enforceable according to its terms; and'),
      B('Customer has full power and authority to enter into this Agreement and to grant to Company the rights set forth herein, free and clear of competing rights, claims, or encumbrances.'),
      L1('F.', 'No Other Representations –'),
      L1('', 'Except as expressly stated in this Agreement, Company makes no representations or warranties, whether express, implied, statutory, or otherwise. Customer acknowledges that cannabis processing inherently involves natural variations and that perfect homogeneity cannot be guaranteed. Services are provided “as is” and “with all faults.” Company specifically disclaims any implied warranties of merchantability, fitness for a particular purpose, or those arising from trade usage or custom.'),
      L1('G.', 'Regulatory Compliance - Both Parties acknowledge that all Services and operations under this Agreement must comply with all applicable state and local cannabis laws, rules, and regulations.'),
      L1('H.', 'Confidential Information - Each Party agrees to maintain in strict confidence all proprietary or confidential information obtained from the other Party in connection with this Agreement. Such information shall not be disclosed without prior written consent, except as required by law. This obligation shall survive termination of the Agreement for a period of two (2) years.'),
      L1('I.', 'Indemnification –'),
      L2('a.', 'Customer shall indemnify and hold Company harmless from any claims, damages, costs, or expenses (including attorney’s fees) arising from Customer’s acts or omissions, or those of its employees or agents.'),
      L2('b.', 'Company shall indemnify and hold Customer harmless from any claims, damages, costs, or expenses (including attorney’s fees) arising from Company’s acts or omissions, or those of its employees or agents.'),
      L1('J.', 'Waiver, Modification, and Amendment – No provision of this Agreement may be waived except in a written instrument signed by both Parties. Waiver of one provision shall not constitute waiver of any other. This Agreement may only be modified or amended in writing, executed by both Parties.'),
      L1('K.', 'Assignment –'),
      L1('', 'Neither Party may assign this Agreement or any of its rights or obligations without the prior written consent of the other Party.'),
      L1('L.', 'Counterparts – This Agreement may be executed in multiple counterparts, each of which shall be deemed an original, and all of which together shall constitute one binding agreement. Execution and delivery by electronic transmission of a PDF copy shall be deemed valid and binding.'),
      L1('M.', 'Force Majeure – Neither Party shall be liable for delay or failure to perform its obligations under this Agreement if such delay or failure is caused by events beyond its reasonable control, including but not limited to natural disasters, fire, flood, pandemic, acts of war, terrorism, government orders, or other similar events (“Force Majeure”).'),
      L1('', 'The affected Party shall promptly notify the other Party of the occurrence and expected duration of the Force Majeure event. Performance shall be suspended only for the period reasonably necessary to overcome the impact of such event.'),
      L1('', 'If a Force Majeure event continues for more than thirty (30) days, either Party may terminate this Agreement without further obligation or liability, and any deposits paid by Customer for unperformed Services shall be refunded in full.'),
      L1('N.', 'Security – Company maintains a high level of security at its Facility, including cameras, alarm system with motion detection, and remote surveillance. In addition, Company provides an on-site loss prevention specialist. The Company shall not be liable for loss or damage to Product(s) resulting from robbery, vandalism, or events of force majeure as defined in Section 4.M. However, Company will make reasonable efforts to cooperate with Customer and local law enforcement to assist in the recovery of any stolen Product(s).'),
      L1('O.', 'Severability – If any provision of this Agreement is found to be invalid or unenforceable, the remaining provisions shall remain in full force and effect, and any outstanding obligations shall continue to be enforceable to the fullest extent permitted by law.'),
      L1('P.', 'Governing Law – This Agreement shall be governed by and construed in accordance with the laws of the State of California and the County of Lake, without regard to conflict-of-law rules. California law shall control the interpretation and enforcement of this Agreement, even if another jurisdiction’s law might otherwise apply.'),
      L1('Q.', 'Dispute Resolution –'),
      L2('a.', 'Negotiation: Except for requests for injunctive relief or other provisional remedies available from a court, any dispute, claim, or controversy arising out of or relating to this Agreement shall first be addressed through written notice by one Party to the other, setting forth its claims and position. If the Parties are unable to resolve the dispute within thirty (30) days of such notice, the matter shall proceed to arbitration as described below.'),
      L2('b.', 'Arbitration: Any unresolved dispute shall be settled by binding arbitration (or, if mutually agreed, mediation) in California, or at another location agreed upon by the Parties. Arbitration shall be conducted on a confidential basis in accordance with the Commercial Arbitration Rules of the American Arbitration Association. The arbitrator shall be a single neutral party with experience in commercial contracts. The arbitrator’s decision shall be in writing, include findings of fact and law, and may award costs, expenses, and reasonable attorneys’ fees. The Parties reserve the right to object to the selection of an arbitrator employed by or affiliated with a competing business. Any arbitration award may be entered as a judgment in a court of competent jurisdiction.'),
      L1('R.', 'Confidentiality of Agreement – The terms and contents of this Agreement are confidential. No Party shall disclose any information relating to this Agreement or its performance except: (i) to its attorneys, accountants, or advisors; (ii) as required by law or governmental authority (including tax authorities); or (iii) as necessary to enforce the rights set forth in this Agreement.'),
      L1('S.', 'Notices – All notices, communications, and deliveries under this Agreement shall be in writing, signed by the issuing Party, and shall reference the Section of this Agreement under which they are made. Notices shall be either delivered personally or sent by prepaid registered mail or sent by electronic transmission to a functioning email account to the following or to such other addresses and/or email account as shall have been furnished to the other party in writing from time to time. Any such notice, if delivered personally or sent by electronic transmission shall be deemed to have been received the day of delivery or if sent by prepaid registered mail, on the third (3rd) day there is postal delivery following the day on which such notice is mailed.'),
      { t: 'notices', rows: [
        ['Name:', COMPANY.name, v(d.legal_name, '')],
        ['Address:', COMPANY.address, v(d.address, '')],
        ['City, State, Zip:', COMPANY.city, v(d.city, '')],
        ['Phone:', COMPANY.phone, v(d.phone, '')],
        ['Email:', COMPANY.email, v(d.email, '')]] },
      L1('T.', 'Legal Counsel; Interpretation; Costs – Each Party acknowledges that it has had the opportunity to seek independent legal advice regarding this Agreement. This Agreement shall be interpreted without regard to any presumption or rule that would construe ambiguities against the Party drafting or causing it to be drafted. Each Party shall bear its own costs related to the negotiation and preparation of this Agreement.'),
      L1('U.', 'Further Assurances – Each Party agrees to execute and deliver any additional documents and take such further actions as may be reasonably necessary to fully implement and carry out the purposes of this Agreement.'),
      L1('V.', 'Nature of Relationship – Company shall have sole discretion over the methods, means, and supervision of its personnel. Nothing in this Agreement shall be construed to create an agency, partnership, joint venture, or other similar relationship between the Parties. Neither Party has authority to bind or obligate the other, except as expressly provided in this Agreement.'),
      L1('W.', 'Taxes – Each Party shall be solely responsible for the payment of its own federal, state, and local taxes, social security contributions, unemployment insurance, and any other assessments or obligations arising from its activities under this Agreement.'),
      L1('X.', 'No Franchise or Business Opportunity Agreement – The Parties expressly acknowledge that this Agreement does not create a franchise, partnership, joint venture, agency, or business opportunity relationship. Each Party remains solely responsible for the actions and supervision of its personnel, including wage rates, tax withholding, and employment benefits. Company shall retain exclusive discretion over its methods of operation, accounting practices, personnel policies, advertising, promotion, and service delivery. The relationship created under this Agreement is strictly that of independent contracting parties. If any provision of this Agreement is deemed to establish a franchise relationship, Customer may immediately terminate this Agreement.'),
      L1('Y.', 'Entire Agreement – This Agreement constitutes the complete and exclusive agreement between the Parties with respect to its subject matter and supersedes all prior or contemporaneous agreements, representations, or understandings, whether written or oral. No other agreements shall be binding unless expressly set forth in a written instrument signed by both Parties.'),
      { t: 'p', text: 'Signature page to follow:', keep: true },

      { t: 'page' },
      { t: 'p', text: 'IN WITNESS WHEREOF the parties have duly executed this Agreement as of the date first above written:' },
      { t: 'sig', head: '2CW PRODUCTIONS, INC.', name: COMPANY.signer, title: COMPANY.title },
      { t: 'sig', head: `CUSTOMER: ${v(d.legal_name, '').toUpperCase()}`.replace(/: $/, ''), name: v(d.signer_name, ''), title: v(d.signer_title, '') },

      { t: 'page' },
      { t: 'center', text: 'EXHIBIT A' },
      { t: 'center', text: 'PRICING SHEET' },
      { t: 'p', text: '**Drying Services**' },
      B('$3.00 per wet pound'),
      B('Typical drying time: 7–10 days'),
      { t: 'p', text: '**Storage Services**' },
      B('$15.00 per 4x4 box (16 sq. ft.) per month'),
      B('Charges begin Day 31 after notice of completion (Days 1–30 at no cost)'),
      { t: 'p', text: '**Transportation Services**' },
      B('$125.00 per hour, cargo van'),
      B('$175.00 per hour, 24’–26’ box truck with liftgate ($150.00 per hour effective rate for bookings of 8 hours or more)'),
      B('$300.00 per hour, 40’ reefer trailer'),
      B('Drivers do not load or unload product; loading and unloading are Customer’s responsibility unless separately arranged.'),
      B('Drivers are subject to an eight (8) hour maximum driving limit per day.'),
      B('The cargo van is not available for on-farm harvest transport.'),
      { t: 'p', text: '**Testing Services**' },
      B('$100.00 per sample – potency testing'),
      B('$420.00 per sample – full panel with terpenes'),
      { t: 'p', text: '**Trimming Services**' },
      B('$75.00 per pound – hand trim'),
      B('$65.00 per pound – machine trim, two passes, with hand finish'),
      B('$35.00 per pound – cleaning smalls'),
      B('$7.00 per pound – hand bucking'),
      { t: 'p', text: '**Labor Allocation. The per wet pound drying fee includes facility space and standard labor for METRC compliance, one forklift operator, two managers, and one compliance personnel. Any additional labor required, including but not limited to hanging, moving, and taking down plants, will be billed as a pass-through cost to Customer at the Farm Labor rate of $25.00 per hour, per person.**' },
      { t: 'p', text: '**Batching. Turkey bag batching services are billed at $3.00 per bag, inclusive of labor. Physical bags and other packaging materials furnished by Company are billed separately, at cost.**' },
      { t: 'p', text: '**Finished Product Storage. There is no additional charge for storage of Customer’s finished or trimmed product. Company may review alternative arrangements if such product remains at the Facility for more than sixty (60) days.**' },

      { t: 'page' },
      { t: 'center', text: 'EXHIBIT B' },
      { t: 'center', text: 'SCHEDULE OF SERVICES AND PRICING' },
      { t: 'exb', lines: d.lines || [] },
      { t: 'p', text: '**Additional Terms**' },
      L1('1.', 'Customer is responsible to have biomass in a condition suitable for processing.'),
      L1('2.', 'Services are invoiced in accordance with the payment terms set forth in the Agreement.'),
      L1('3.', 'Any additional supplies or incidental costs requested by Customer (e.g., boxes, totes, turkey bags) will be billed at cost.'),
      L1('4.', 'Harvest Scheduling: Customer shall provide estimated delivery dates for each harvest at least fourteen (14) days in advance. For large-scale grows involving multiple harvests, Customer shall provide a schedule of expected deliveries. Failure to provide reasonable notice may delay Services and limit available capacity.'),
      L1('5.', 'Rates are subject to change only by written amendment signed by both Parties.')
    ];
  }

  // ── PDF layout ─────────────────────────────────────────────────────────
  // Letter, 1" margins, Times 11 pt. jsPDF's built-in Times covers the
  // curly quotes and dashes the agreement uses.
  const PAGE_W = 612, PAGE_H = 792, M = 72, TOP = 72, BOTTOM = PAGE_H - 72;
  const FS = 11, LH = FS * 1.25, GAP = 5;
  const INDENT = { 0: [0, 0], 1: [18, 40], 2: [40, 62], 3: [62, 78] };   // [label x, text x] past the margin

  // jsPDF's built-in Times only has the WinAnsi characters — swap the
  // few others that turn up (primes in "24′–26′", odd spaces).
  const clean = (s) => String(s == null ? '' : s).replace(/[\u2032\u2035]/g, '’').replace(/[\u2033\u2036]/g, '”')
    .replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ').replace(/[^\x00-\xff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/g, '?');

  function build(jsPDF, d) {
    d = { ...d, lines: (d.lines || []).map((l) => Object.fromEntries(Object.entries(l).map(([k, x]) => [k, clean(x)]))) };
    for (const k of Object.keys(d)) if (typeof d[k] === 'string') d[k] = clean(d[k]);
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    let y = TOP;
    const font = (style) => doc.setFont('times', style || 'normal');
    const room = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = TOP; } };

    // Lays out text with **bold** runs, wrapping at word boundaries.
    // base = 'normal' | 'bold' | 'italic' | 'bolditalic'.
    function rich(text, x, width, base = 'normal', align = 'left') {
      const pieces = [];
      String(text).split('**').forEach((seg, i) => {
        const bold = i % 2 === 1;
        const style = bold ? (base === 'italic' ? 'bolditalic' : 'bold') : base;
        seg.split(/(\s+)/).forEach((p) => { if (p) pieces.push({ p, style, space: /^\s+$/.test(p) }); });
      });
      const words = [];   // each word: pieces glued together, with spaceBefore
      let cur = null, pendingSpace = false;
      for (const pc of pieces) {
        if (pc.space) { pendingSpace = true; cur = null; continue; }
        if (!cur) { cur = { parts: [], spaceBefore: pendingSpace && words.length > 0 }; words.push(cur); pendingSpace = false; }
        font(pc.style); cur.parts.push({ ...pc, w: doc.getTextWidth(pc.p) });
      }
      font('normal');
      const spaceW = doc.getTextWidth(' ');
      const lines = [];
      let line = [], lw = 0;
      for (const w of words) {
        const ww = w.parts.reduce((a, p) => a + p.w, 0);
        const add = (line.length && w.spaceBefore ? spaceW : 0) + ww;
        if (line.length && lw + add > width) { lines.push({ words: line, w: lw }); line = []; lw = 0; }
        lw += (line.length && w.spaceBefore ? spaceW : 0) + ww;
        line.push(w);
      }
      if (line.length) lines.push({ words: line, w: lw });
      // Each line goes out as one text call per run of the same style, so
      // the viewer places the spaces itself (its stand-in for Times may be
      // a little wider or narrower than jsPDF's metrics).
      lines.forEach((ln) => {
        room(LH);
        const runs = [];
        ln.words.forEach((w, i) => w.parts.forEach((p, j) => {
          const t = (i && j === 0 && w.spaceBefore ? ' ' : '') + p.p;
          const last = runs[runs.length - 1];
          if (last && last.style === p.style) last.text += t; else runs.push({ style: p.style, text: t });
        }));
        let cx = align === 'center' ? x + (width - ln.w) / 2 : x;
        runs.forEach((r) => { font(r.style); doc.text(r.text, cx, y + FS); cx += doc.getTextWidth(r.text); });
        y += LH;
      });
      font('normal');
    }

    // A simple table: cells wrap; header row bold; borders optional.
    function table(cols, rows, { header, borders, boldFirstCol } = {}) {
      const pad = borders ? 4 : 2;
      const all = header ? [header, ...rows] : rows;
      all.forEach((cells, ri) => {
        const isHead = header && ri === 0;
        const wrapped = cells.map((c, ci) => {
          font(isHead || (boldFirstCol && ci === 0) ? 'bold' : 'normal');
          return doc.splitTextToSize(String(c || ''), cols[ci] - pad * 2);
        });
        const h = Math.max(1, ...wrapped.map((w) => w.length)) * LH + pad * 2 - (LH - FS) + 2;
        room(h);
        let x = M;
        wrapped.forEach((w, ci) => {
          font(isHead || (boldFirstCol && ci === 0) ? 'bold' : 'normal');
          w.forEach((t, li) => doc.text(t, x + pad, y + pad + FS + li * LH - 1));
          if (borders) doc.rect(x, y, cols[ci], h);
          x += cols[ci];
        });
        y += h;
      });
      font('normal');
      y += GAP;
    }

    const W = PAGE_W - M * 2;
    blocks(d).forEach((b) => {
      switch (b.t) {
        case 'title':
          doc.setFontSize(13); font('bold'); rich(`**${b.text}**`, M, W, 'normal', 'center'); doc.setFontSize(FS); y += GAP * 2; break;
        case 'center':
          room(LH * 3); rich(`**${b.text}**`, M, W, 'normal', 'center'); y += GAP; break;
        case 'h':
          y += GAP; room(LH * 3); font('bold'); doc.text(b.n, M, y + FS); rich(`**${b.text}**`, M + 18, W - 18); y += GAP; break;
        case 'p':
          if (b.keep && y + LH > BOTTOM) y = BOTTOM - LH;   // squeeze onto the page rather than strand it
          rich(b.text, M, W, b.style || 'normal'); y += GAP; break;
        case 'li': {
          const [lx, tx] = INDENT[b.lv];
          if (b.label) { room(LH); font('normal'); doc.text(b.label, M + lx, y + FS); }
          rich(b.text, M + tx, W - tx); y += b.lv === 3 ? 2 : GAP; break;
        }
        case 'notices':
          table([120, 174, 174], b.rows, { header: ['', 'Company:', 'Customer:'], boldFirstCol: true }); break;
        case 'sig': {
          room(LH * 7); y += LH;
          rich(`**${b.head}**`, M, W); y += LH;
          doc.text('By:', M, y + FS); doc.line(M + 24, y + FS + 2, M + 260, y + FS + 2); y += LH * 1.6;
          doc.text(`Name: ${b.name}`, M, y + FS); if (!b.name) doc.line(M + 34, y + FS + 2, M + 260, y + FS + 2); y += LH * 1.6;
          doc.text(`Title: ${b.title}`, M, y + FS); if (!b.title) doc.line(M + 30, y + FS + 2, M + 260, y + FS + 2); y += LH * 1.6;
          doc.text('Date:', M, y + FS); doc.line(M + 30, y + FS + 2, M + 260, y + FS + 2); y += LH * 1.6;
          break;
        }
        case 'exb':
          y += GAP;
          table([104, 108, 62, 62, 132],
            (b.lines.length ? b.lines : [{}]).map((l) => [l.label, l.unit, l.qty, l.rate, l.notes]),
            { header: ['Service', 'Unit of Measure', 'Quantity', 'Rate', 'Notes'], borders: true });
          y += GAP; break;
        case 'page':
          doc.addPage(); y = TOP; break;
      }
    });

    const n = doc.getNumberOfPages();
    doc.setFontSize(9); font('normal');
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.text(`Master Service Agreement — ${d.legal_name || 'Customer'}`, M, PAGE_H - 40);
      doc.text(`Page ${i} of ${n}`, PAGE_W - M, PAGE_H - 40, { align: 'right' });
    }
    return doc;
  }

  const fileName = (d) => `2CW MSA - ${String(d.legal_name || 'Customer').replace(/[\\/:*?"<>|]+/g, '').trim()} - ${d.effective_date || today()}.pdf`;

  let jsPdfPromise = null;
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
    jsPdfPromise = jsPdfPromise || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => { jsPdfPromise = null; reject(new Error('Couldn’t load the PDF maker — check the connection and try again.')); };
      document.head.appendChild(s);
    });
    return jsPdfPromise;
  }

  async function download(d) {
    const jsPDF = await loadJsPdf();
    const doc = build(jsPDF, d);
    const name = fileName(d);
    const file = new File([doc.output('blob')], name, { type: 'application/pdf' });
    // Phones: the share sheet (Save to Files, Mail, AirDrop). Desktop: download.
    if (navigator.canShare && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    doc.save(name);
  }

  // ── The dialog ─────────────────────────────────────────────────────────
  // Self-contained (own overlay and styles) so any page can use it.
  // opts.intakes: drying requests to offer under "Fill from a drying
  // request" (the Customer IDs tab passes these); opts.pick: id to preselect.
  const CSS = `
    .msa-bg{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2000;overflow-y:auto;padding:calc(12px + env(safe-area-inset-top)) 12px 40px}
    .msa{background:var(--surface,#13151a);color:var(--text,#e8eaf0);border:1px solid var(--border,#1e2129);border-radius:14px;max-width:720px;margin:3vh auto;padding:20px;font-family:inherit}
    .msa h2{font-size:1.1rem;margin:0 0 4px}
    .msa .msa-sub{color:var(--subtext,#9aa0b0);font-size:.85rem;margin-bottom:14px}
    .msa .msa-sect{font-family:'DM Mono',monospace;font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--blue,#5a9fd4);margin:14px 0 10px;padding-top:10px;border-top:1px solid var(--border,#1e2129)}
    .msa .msa-g{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .msa label{display:block;font-family:'DM Mono',monospace;font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:var(--subtext,#9aa0b0);margin-bottom:4px}
    .msa input,.msa select{width:100%;box-sizing:border-box;background:#0c0d0f;border:1px solid var(--border,#1e2129);color:var(--text,#e8eaf0);border-radius:8px;padding:.55rem .65rem;font-family:inherit;font-size:.9rem;outline:none}
    .msa input:focus,.msa select:focus{border-color:var(--blue,#5a9fd4)}
    .msa .msa-line{display:grid;grid-template-columns:1.3fr 1.3fr .8fr .7fr 1.6fr auto;gap:6px;margin-bottom:6px;align-items:center}
    .msa .msa-line input{font-size:.82rem;padding:.45rem .5rem}
    .msa .msa-x{background:none;border:1px solid var(--border,#1e2129);color:var(--subtext,#9aa0b0);border-radius:8px;width:30px;height:30px;cursor:pointer}
    .msa .msa-hd{font-family:'DM Mono',monospace;font-size:.55rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#5a6070)}
    .msa .msa-btn{padding:.55rem .9rem;border:1px solid var(--border,#1e2129);border-radius:8px;font-family:'DM Mono',monospace;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;font-weight:700;cursor:pointer;background:transparent;color:var(--text,#e8eaf0)}
    .msa .msa-go{background:var(--blue,#5a9fd4);color:#0c0d0f;border-color:var(--blue,#5a9fd4)}
    .msa .msa-btn:disabled{opacity:.5;cursor:default}
    .msa .msa-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px}
    .msa .msa-warn{color:var(--gold,#d4a843);font-size:.82rem;margin-top:10px;display:none}
    .msa .msa-err{color:var(--red,#ef5350);font-size:.85rem;margin-top:10px;display:none}
    @media (max-width:600px){ .msa .msa-g{grid-template-columns:1fr} .msa .msa-line{grid-template-columns:1fr 1fr;padding:8px 0;border-top:1px solid var(--border,#1e2129)} .msa .msa-line .msa-x{justify-self:end} .msa .msa-hdrow{display:none} }`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function open(data, opts = {}) {
    if (!document.getElementById('msa-css')) {
      const st = document.createElement('style'); st.id = 'msa-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    let d = { ...fromIntake({}), ...data };
    const bg = document.createElement('div');
    bg.className = 'msa-bg';
    document.body.appendChild(bg);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = () => { bg.remove(); document.body.style.overflow = prevOverflow; document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

    const intakes = opts.intakes || [];
    const fld = (k, label, attrs = '') => `<div><label for="msa-${k}">${label}</label><input id="msa-${k}" data-k="${k}" value="${esc(d[k])}" ${attrs}/></div>`;
    const lineRow = (l, i) => `<div class="msa-line" data-i="${i}">
      <input data-l="label" value="${esc(l.label)}" placeholder="Service"/>
      <input data-l="unit" value="${esc(l.unit)}" placeholder="Unit"/>
      <input data-l="qty" value="${esc(l.qty)}" placeholder="Qty"/>
      <input data-l="rate" value="${esc(l.rate)}" placeholder="Rate"/>
      <input data-l="notes" value="${esc(l.notes)}" placeholder="Notes"/>
      <button type="button" class="msa-x" data-rm="${i}" title="Remove">×</button></div>`;
    const read = () => {
      bg.querySelectorAll('[data-k]').forEach((el) => { d[el.dataset.k] = el.value.trim(); });
      d.lines = [...bg.querySelectorAll('.msa-line[data-i]')].map((row) => {
        const l = {}; row.querySelectorAll('[data-l]').forEach((el) => { l[el.dataset.l] = el.value.trim(); }); return l;
      }).filter((l) => Object.values(l).some(Boolean));
    };
    const draw = () => {
      const unused = SERVICE_LIST().filter((s) => EXB[s.k] && !d.lines.some((l) => l.label === s.l));
      bg.innerHTML = `<div class="msa" role="dialog" aria-label="Service Agreement">
        <h2>Service Agreement</h2>
        <div class="msa-sub">Check the details, fill in anything missing, then download the filled-in agreement as a PDF. Blanks print as signature-style lines.</div>
        ${intakes.length ? `<div><label for="msa-src">Fill from a drying request</label><select id="msa-src"><option value="">—</option>${intakes.map((r) =>
          `<option value="${esc(r.id)}" ${r.id === opts.pick ? 'selected' : ''}>${esc(r.legal_business_name || r.farm_name)}${r.legal_business_name && r.farm_name && r.legal_business_name !== r.farm_name ? ` (${esc(r.farm_name)})` : ''} · ${esc(new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</option>`).join('')}</select></div>` : ''}
        <div class="msa-sect">Customer</div>
        <div class="msa-g">
          ${fld('legal_name', 'Legal business name')}
          <div><label for="msa-entity">Entity type</label><select id="msa-entity" data-k="entity">${ENTITIES.map((e) => `<option ${e === d.entity ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
          <div><label for="msa-state">State of formation</label><select id="msa-state" data-k="state"><option value="">—</option>${Object.entries(STATES).map(([c, n]) => `<option value="${c}" ${c === d.state ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          ${fld('effective_date', 'Effective date', 'type="date"')}
        </div>
        <div class="msa-sect">Notices (section 4.S)</div>
        <div class="msa-g">
          ${fld('address', 'Mailing address', 'placeholder="Street"')}
          ${fld('city', 'City, state, zip')}
          ${fld('phone', 'Phone', 'type="tel"')}
          ${fld('email', 'Email', 'type="email"')}
        </div>
        <div class="msa-sect">Signer</div>
        <div class="msa-g">
          ${fld('signer_name', 'Name')}
          ${fld('signer_title', 'Title', 'placeholder="e.g. Owner, CEO, Managing Member"')}
        </div>
        <div class="msa-sect">Exhibit B — services &amp; pricing</div>
        <div class="msa-line msa-hdrow"><span class="msa-hd">Service</span><span class="msa-hd">Unit</span><span class="msa-hd">Qty</span><span class="msa-hd">Rate</span><span class="msa-hd">Notes</span><span></span></div>
        ${d.lines.map(lineRow).join('')}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          ${unused.length ? `<select id="msa-add" style="flex:1 1 220px"><option value="">+ Add a service…</option>${unused.map((s) => `<option value="${s.k}">${esc(s.l)}</option>`).join('')}</select>` : ''}
          <button type="button" class="msa-btn" id="msa-blank">+ Blank line</button>
        </div>
        <div class="msa-warn" id="msa-warn"></div>
        <div class="msa-err" id="msa-err"></div>
        <div class="msa-acts">
          <button type="button" class="msa-btn" id="msa-cancel">Close</button>
          <button type="button" class="msa-btn msa-go" id="msa-go">Download PDF</button>
        </div></div>`;
      const missing = [['legal_name', 'legal name'], ['state', 'state'], ['address', 'mailing address'], ['city', 'city/state/zip'], ['signer_name', 'signer'], ['signer_title', 'signer’s title']]
        .filter(([k]) => !d[k]).map(([, l]) => l);
      const warn = bg.querySelector('#msa-warn');
      if (missing.length) { warn.textContent = `Still blank: ${missing.join(', ')}. Those print as blank lines to fill in by hand.`; warn.style.display = 'block'; }
      bg.querySelector('#msa-cancel').onclick = close;
      bg.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { read(); d.lines.splice(Number(b.dataset.rm), 1); draw(); }; });
      bg.querySelector('#msa-blank').onclick = () => { read(); d.lines.push({ label: '', unit: '', qty: '', rate: '', notes: '' }); draw(); };
      const add = bg.querySelector('#msa-add');
      if (add) add.onchange = () => {
        read();
        const k = add.value; if (!k) return;
        d.lines.push({ label: serviceLabel(k), unit: EXB[k].unit, qty: '', rate: EXB[k].rate, notes: EXB[k].notes || '' });
        draw();
      };
      const src = bg.querySelector('#msa-src');
      if (src) src.onchange = () => {
        const r = intakes.find((x) => x.id === src.value);
        if (!r) return;
        read();
        const f = fromIntake(r);
        // Keep what the office typed that a request can't supply.
        d = { ...f, effective_date: d.effective_date || f.effective_date, address: d.address, city: d.city, signer_title: d.signer_title };
        opts.pick = r.id;
        draw();
      };
      bg.querySelector('#msa-go').onclick = async (e) => {
        const btn = e.currentTarget, err = bg.querySelector('#msa-err');
        read(); err.style.display = 'none';
        btn.disabled = true; btn.textContent = 'Making PDF…';
        try { await download(d); }
        catch (ex) { err.textContent = ex.message || String(ex); err.style.display = 'block'; }
        btn.disabled = false; btn.textContent = 'Download PDF';
      };
    };
    draw();
  }

  const api = { open, fromIntake, build, blocks, guessEntity, fileName };
  if (typeof window !== 'undefined') window.MSA = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
