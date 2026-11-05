/**
 * v152: SAP knowledge for the Smart Coach — the reports this system reads and the standard SAP steps that fix the usual
 * problems. The Z reports are this company's own (names as the system reads them); standard SAP transactions are given for
 * checking and for the SAP team. Postings (MIGO, usage decisions) are done by the authorised SAP / QA users only.
 */
export type SapStep = { en: string; si: string };
export type KbEntry = { id: string; name: string; kind: 'report' | 'tcode' | 'term'; en: string; si: string; fields?: string; tags: string };

export const SAP_KB: KbEntry[] = [
  { id: 'zmmbe', name: 'ZMMBE', kind: 'report', tags: 'stock ur qi block assigned so li batch sloc plant',
    en: 'Stock by SO / LI / Material / Batch / Storage Location. UR here = Total − SO QI − SO Blocked − Assigned. The pick can never take more than the UR of the SO line.',
    si: 'SO / LI / Material / Batch / Storage Location අනුව stock. මෙහි UR = Total − SO QI − SO Blocked − Assigned. SO line එකේ UR එකට වඩා pick කරන්න බැහැ.',
    fields: 'Sales Order, Line Item, Material, Material Description, Batch, Storage Location, Plant, SO Plant, Total, QI, Blocked, Assigned' },
  { id: 'zinsr', name: 'ZINSR / ZINR', kind: 'report', tags: 'inspection lot insp lot quantity vendor batch invoice po',
    en: 'Inspection lots: each lot has its SO / LI / Material / Batch, the Insp. Lot Quantity, the Vendor Batch (= Korber Lot Number), Vendor Invoice No and PO. A SO line never takes more from a batch than its lot quantity.',
    si: 'Inspection lots: හැම lot එකකටම SO / LI / Material / Batch, Insp. Lot Quantity, Vendor Batch (= Korber Lot Number), Invoice, PO තියෙනවා. SO line එකකට batch එකකින් lot quantity එකට වඩා ගන්න බැහැ.',
    fields: 'Inspection Lot, Sales Order, Line Item, Material, Batch, Insp. Lot Quantity, Vendor Batch, Vendor Invoice No, Purchasing Document' },
  { id: 'zcoment', name: 'ZCOMENT VIEW', kind: 'report', tags: 'shade report barcode roll vendor roll no hu',
    en: 'Shade report per roll: Inspection lot, Barcode Number (= Korber Pallet), Vendor Roll No (= Korber Supplier Hu), Vendor Batch and Shade. Only "Shade Report" rows are used.',
    si: 'Roll එකින් එක shade report: Inspection lot, Barcode Number (= Korber Pallet), Vendor Roll No (= Supplier Hu), Vendor Batch, Shade. "Shade Report" rows විතරයි ගන්නේ.' },
  { id: 'zrollmgt', name: 'ZROLLMGT', kind: 'report', tags: 'roll management storage bin system batch available status qm comment expo-fix fixed',
    en: 'SAP roll management: each roll\'s Barcode Number, StorageBin, System Batch, Available Quantity, Status and QM Comment 1 (the Report Number of offsite rolls). A roll is picked only at the allowed StorageBin (e.g. EXPO-FIX) and in the SO line\'s ZMMBE batch.',
    si: 'SAP roll management: roll එකේ Barcode, StorageBin, System Batch, Available Qty, Status, QM Comment 1 (offsite Report Number). Pick කරන්නේ අවසර තියෙන StorageBin එකේ (උදා: EXPO-FIX) සහ SO line එකේ ZMMBE batch එකේ rolls විතරයි.' },
  { id: 'zmmtrr', name: 'ZMM_TRR', kind: 'report', tags: 'transfer request tn to so',
    en: 'Transfer requests: stock asked to move to a Sales Order (TN, To SO / LI, Material, QTY, Status). Shown as TRANSFER NOTE on the plan.',
    si: 'Transfer requests: SO එකකට stock මාරු කරන්න ඉල්ලපු ඒවා (TN, To SO / LI, Material, QTY, Status). Plan එකේ TRANSFER NOTE විදිහට පෙන්නනවා.' },
  { id: 'korber', name: 'Korber Inventory', kind: 'report', tags: 'wms physical pallet lot supplier hu location pick id fifo',
    en: 'The physical rolls in the warehouse (WMS): Pallet, Item, Lot Number (= Vendor Batch), Supplier Hu, Actual Qty, Location, Pick Id (must be 0) and FIFO date. The pick QTY comes from here.',
    si: 'Warehouse එකේ ඇත්ත rolls (WMS): Pallet, Item, Lot Number (= Vendor Batch), Supplier Hu, Actual Qty, Location, Pick Id (0 වෙන්න ඕනේ), FIFO. Pick QTY එක ගන්නේ මෙතනින්.' },
  { id: 'mmbe', name: 'MMBE', kind: 'tcode', tags: 'stock overview',
    en: 'Stock overview of a material (by plant / storage location / batch, incl. sales order stock E). Use it to see where the stock really is.',
    si: 'Material එකක stock overview එක (plant / storage location / batch, SO stock E එකත් එක්ක). Stock එක ඇත්තටම තියෙන්නේ කොහෙද බලන්න.' },
  { id: 'mb52', name: 'MB52', kind: 'tcode', tags: 'warehouse stock list',
    en: 'List of warehouse stocks on hand — many materials at once, with special stock (E = sales order).',
    si: 'Warehouse stock list එක — materials ගොඩක් එකපාර, special stock (E = sales order) එක්ක.' },
  { id: 'msc3n', name: 'MSC3N', kind: 'tcode', tags: 'batch display vendor batch',
    en: 'Display a batch: its vendor batch, characteristics and status — check a roll\'s batch when SAP and Korber do not agree.',
    si: 'Batch එකක් බලන්න: vendor batch, characteristics, status — SAP සහ Korber එකඟ නැති වෙලාවට roll එකේ batch එක බලන්න.' },
  { id: 'qa03', name: 'QA03 / QA32', kind: 'tcode', tags: 'inspection lot display list usage decision',
    en: 'Display an inspection lot (QA03) or list them (QA32) — lot quantity, status and whether a usage decision was made.',
    si: 'Inspection lot එකක් බලන්න (QA03) හෝ list එක (QA32) — lot quantity, status, usage decision දීලද කියලා.' },
  { id: 'qa11', name: 'QA11', kind: 'tcode', tags: 'usage decision qi to ur release quality',
    en: 'Usage decision of an inspection lot — QA posts the stock from Quality Inspection (QI) to unrestricted (UR). Done by QA, not by the picker.',
    si: 'Inspection lot එකට usage decision එක — QA කෙනෙක් QI stock එක UR එකට post කරනවා. මේක කරන්නේ QA, picker නෙවෙයි.' },
  { id: 'migo', name: 'MIGO (311 / 321 / 343 / 413 E)', kind: 'tcode', tags: 'transfer posting movement type storage location qi blocked sales order',
    en: 'Goods movements. Common transfer postings: 311 storage location → storage location, 321 QI → UR, 343 Blocked → UR, 413 E to a sales order stock. Posted by the authorised SAP user only.',
    si: 'Goods movements. සාමාන්‍ය transfer postings: 311 storage location → storage location, 321 QI → UR, 343 Blocked → UR, 413 E sales order stock එකකට. Post කරන්නේ අවසර තියෙන SAP user විතරයි.' },
  { id: 'mb51', name: 'MB51', kind: 'tcode', tags: 'material document list history movements',
    en: 'Material documents of a material / batch — see when and how the stock moved (GR, transfers, issues).',
    si: 'Material / batch එකක material documents — stock එක කවදා, කොහොම මාරු උනාද බලන්න (GR, transfers, issues).' },
  { id: 'va03', name: 'VA03', kind: 'tcode', tags: 'sales order display line item',
    en: 'Display a sales order and its line items — check the SO / LI and plant of a plan line.',
    si: 'Sales order එකක් සහ line items බලන්න — plan line එකේ SO / LI, plant හරිද බලන්න.' },
  { id: 'ur', name: 'UR / QI / Blocked', kind: 'term', tags: 'unrestricted quality inspection blocked stock',
    en: 'UR = unrestricted (can be issued), QI = in quality inspection (needs a usage decision), Blocked = cannot be used until released. Only UR is picked.',
    si: 'UR = unrestricted (නිකුත් කරන්න පුළුවන්), QI = quality inspection (usage decision ඕනේ), Blocked = release කරනකම් පාවිච්චි කරන්න බැහැ. Pick කරන්නේ UR විතරයි.' },
  { id: 'sostock', name: 'Sales order stock (E)', kind: 'term', tags: 'special stock e so li assigned',
    en: 'Stock that belongs to one SO / LI (special stock E). Another SO cannot use it unless the SAP team transfers it (e.g. MIGO 413 E).',
    si: 'එක SO / LI එකකට අයිති stock (special stock E). SAP team එක මාරු නොකරන්නේ නම් (උදා: MIGO 413 E) වෙන SO එකකට ගන්න බැහැ.' },
];

/** SAP steps for each problem the coach knows */
export const SAP_FIX: Record<string, SapStep[]> = {
  noUr: [
    { en: 'Check ZMMBE / MMBE for the SO stock (E) of this SO / LI: is it in QI, Blocked or Assigned?', si: 'මේ SO / LI එකේ SO stock (E) එක ZMMBE / MMBE එකෙන් බලන්න: QI, Blocked, Assigned වලද තියෙන්නේ?' },
    { en: 'QI → ask QA for the usage decision (QA11). Blocked → the SAP team releases it (MIGO 343).', si: 'QI නම් → QA ට usage decision (QA11) දෙන්න කියන්න. Blocked නම් → SAP team එක release කරනවා (MIGO 343).' },
    { en: 'Not in SAP at all → the goods receipt is not done yet (check MB51 / ask stores).', si: 'SAP එකේ කොහෙවත් නැත්නම් → GR එක තාම කරලා නැහැ (MB51 බලන්න / stores එකෙන් අහන්න).' },
    { en: 'Stock under another SO → the planner decides; the SAP team transfers it (MIGO 413 E).', si: 'වෙන SO එකක stock නම් → planner තීරණය කරනවා; SAP team එක මාරු කරනවා (MIGO 413 E).' },
  ],
  ur: [
    { en: 'The difference is usually QI / Blocked / Assigned — see the ZMMBE columns of this line.', si: 'වෙනස සාමාන්‍යයෙන් QI / Blocked / Assigned — මේ line එකේ ZMMBE columns බලන්න.' },
    { en: 'After the QA usage decision (QA11) or a release, upload a fresh ZMMBE.', si: 'QA usage decision (QA11) එකෙන් හෝ release එකෙන් පස්සේ අලුත් ZMMBE එකක් upload කරන්න.' },
  ],
  nolot: [
    { en: 'Check the inspection lots of this material / batch in QA32 (or QA03 by lot).', si: 'මේ material / batch එකේ inspection lots QA32 (හෝ QA03) එකෙන් බලන්න.' },
    { en: 'No lot → the GR was posted without inspection, or the lot is under another SO — ask QA.', si: 'Lot නැත්නම් → inspection නැතුව GR කරලා, නැත්නම් lot එක වෙන SO එකක — QA ගෙන් අහන්න.' },
  ],
  lotfull: [
    { en: 'Pick from the batch the coach names — SAP issues the SO line by batch, so the batch QTY stays right.', si: 'Coach කියන batch එකෙන් pick කරන්න — SAP issue කරන්නේ batch අනුව, එතකොට batch QTY හරියටම තියෙනවා.' },
    { en: 'If the lot quantity itself looks wrong, QA checks the inspection lot (QA03).', si: 'Lot quantity එකම වැරදි නම්, QA inspection lot එක (QA03) check කරනවා.' },
  ],
  bin: [
    { en: 'In ZROLLMGT move the roll to the allowed StorageBin (e.g. EXPO-FIX), then upload a fresh ZROLLMGT.', si: 'ZROLLMGT එකේ roll එක අවසර තියෙන StorageBin එකට (උදා: EXPO-FIX) මාරු කරලා, අලුත් ZROLLMGT එකක් upload කරන්න.' },
    { en: 'Status not UR → the roll is in QI / Blocked in SAP: QA decides (QA11).', si: 'Status UR නැත්නම් → roll එක SAP එකේ QI / Blocked: QA තීරණය කරනවා (QA11).' },
  ],
  wms: [{ en: 'The roll is on another Korber pick (Pick Id ≠ 0): finish or cancel that pick in Korber, then upload a fresh Korber Inventory.', si: 'Roll එක වෙන Korber pick එකක (Pick Id ≠ 0): ඒ pick එක Korber එකේ ඉවර කරන්න හෝ cancel කරන්න, ඊට පස්සේ අලුත් Korber Inventory එකක් upload කරන්න.' }],
  confirm: [{ en: 'Compare the roll label with ZCOMENT VIEW (Vendor Roll No, Vendor Batch) and MSC3N for the batch.', si: 'Roll label එක ZCOMENT VIEW (Vendor Roll No, Vendor Batch) සහ batch එකට MSC3N එක්ක සසඳන්න.' }],
  none: [
    { en: 'Check that this Pick\'s Korber Inventory was uploaded after the rolls were put away.', si: 'Rolls put away කලාට පස්සේ මේ Pick එකේ Korber Inventory එක upload කලාද බලන්න.' },
    { en: 'Check MMBE for the batch and its storage location — the rolls may be at the plant already.', si: 'Batch එකයි storage location එකයි MMBE එකෙන් බලන්න — rolls දැනටමත් plant එකට ගිහින් වෙන්න පුළුවන්.' },
  ],
  notInSap: [{ en: 'Korber has the roll but ZROLLMGT does not: check the barcode in ZROLLMGT; if SAP is missing the roll, the SAP team adds / corrects it, then upload a fresh ZROLLMGT.', si: 'Korber එකේ roll එක තියෙනවා, ZROLLMGT එකේ නැහැ: ZROLLMGT එකේ barcode එක බලන්න; SAP එකේ roll එක නැත්නම් SAP team එක add / හදනවා, ඊට පස්සේ අලුත් ZROLLMGT upload කරන්න.' }],
  notInKorber: [{ en: 'SAP has the roll but Korber does not: find it on the shelf; put it away / receive it in Korber, or the label differs. Then upload a fresh Korber Inventory.', si: 'SAP එකේ roll එක තියෙනවා, Korber එකේ නැහැ: shelf එකේ හොයන්න; Korber එකට put away / receive කරන්න, නැත්නම් label එක වෙනස්. ඊට පස්සේ අලුත් Korber Inventory upload කරන්න.' }],
  qtyDiff: [{ en: 'Korber Actual Qty ≠ ZROLLMGT. The pick uses the Korber (physical) QTY; ask the SAP team to correct the roll quantity so the SAP batch stock stays right.', si: 'Korber Actual Qty ≠ ZROLLMGT. Pick එක Korber (physical) QTY එක ගන්නවා; SAP batch stock එක හරියට තියාගන්න roll quantity එක හදන්න SAP team එකට කියන්න.' }],
  otherBatch: [{ en: 'The roll\'s SAP batch is not a batch of the plan\'s SO lines: it cannot be picked for them. If it should belong to this SO, the SAP team transfers it (MIGO 413 E).', si: 'Roll එකේ SAP batch එක plan එකේ SO lines වල batch එකක් නෙවෙයි: ඒවට pick කරන්න බැහැ. මේ SO එකට අයිති වෙන්න ඕන නම් SAP team එක මාරු කරනවා (MIGO 413 E).' }],
  location: [{ en: 'The Korber location is blocked in Settings → Locations: move the roll in Korber, or change the rule if it is wrong.', si: 'Korber location එක Settings → Locations එකේ block කරලා: Korber එකේ roll එක මාරු කරන්න, නැත්නම් rule එක වැරදි නම් හදන්න.' }],
};
