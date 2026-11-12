'use client';
/**
 * v192: README — how the system works, in one place. The long explanations that used to sit under each page title live
 * here now (Sinhala and English), so the working pages stay clean.
 */
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { APP_VERSION } from '@/lib/api';

export default function Page() {
  return <Shell><Readme /></Shell>;
}

type Lang = 'si' | 'en';
interface Sec { id: string; icon: string; title: { si: string; en: string }; si: React.ReactNode; en: React.ReactNode; page?: { href: string; label: string } }

const SECTIONS: Sec[] = [
  {
    id: 'flow', icon: '🧭', title: { si: 'දවසේ වැඩ පිළිවෙල', en: 'The daily flow' }, page: { href: '/upload/', label: 'Uploads' },
    si: <>
      <ol>
        <li><b>Day</b> එක හදන්න, ඊට පස්සේ plant එකේ <b>Pick</b> එකක් (Pick 1, 2 …) හදන්න.</li>
        <li>ඒ Pick එකට <b>Plan</b> සහ <b>ZMMBE</b> දාන්න (Uploads page එකේ පහළට drop කරන්න), ඊට පස්සේ Pick card එකෙන් <b>ZINSR, ZROLLMGT, Korber Inventory</b> (TN තියෙනවා නම් <b>ZMM_TRR</b>) upload කරන්න.</li>
        <li><b>Pick &amp; Dispatch</b> එකේ Day එකයි Pick එකයි තෝරලා <b>⚡ Pick all matched</b> හරි line එකින් line එක pick කරන්න.</li>
        <li><b>Packing List</b> එක download කරන්න. දවස ඉවර වුණාම <b>Day End</b> එක කරන්න.</li>
      </ol>
      <p>හැම Pick එකකටම තමන්ගේම Plan, ZMMBE, ZINSR, ZROLLMGT, Korber තියෙනවා. Matching එකට ඒ Pick එකේ reports විතරයි ගන්නේ. Report එකක් ආයෙත් upload කළාම ඒ Pick එකේ කලින් data එක විතරක් replace වෙනවා, අනිත් Picks වලට අත තියන්නේ නැහැ. Calculation එක ආයෙත් run වෙලා open කරලා තියෙන හැම dashboard එකක්ම live update වෙනවා.</p>
      <p>Pick history එක හැම Pick එකකටම, හැම user කෙනෙක්ටම <b>එකක්</b>. ඒ නිසා Pallet එකක් දෙපාරක් pick වෙන්නේ නැහැ, Cut Roll එකක ඉතුරු ප්‍රමාණය විතරයි ආයෙත් pick කරන්න පුළුවන්.</p>
      <p>Dispatch / pick files (JAN0190…) දාන්නේ <b>Pick &amp; Dispatch</b> page එකට.</p>
    </>,
    en: <>
      <ol>
        <li>Create the <b>day</b>, then a <b>Pick</b> for the plant (Pick 1, 2 …).</li>
        <li>Upload that Pick&apos;s <b>Plan</b> and <b>ZMMBE</b> (drop them at the bottom of Uploads), then <b>ZINSR, ZROLLMGT, Korber Inventory</b> (and <b>ZMM_TRR</b> for transfer notes) in the Pick card.</li>
        <li>On <b>Pick &amp; Dispatch</b> choose the day and the Pick, then <b>⚡ Pick all matched</b> or pick line by line.</li>
        <li>Download the <b>Packing List</b>; at the end of the day run <b>Day End</b>.</li>
      </ol>
      <p>Every Pick has its own Plan, ZMMBE, ZINSR, ZROLLMGT and Korber, and its matching uses only those. Uploading a report again replaces only that Pick&apos;s previous data — the other Picks stay. The calculation runs again and every open dashboard updates live.</p>
      <p>The pick history is <b>one</b> for all Picks and users: a pallet is never picked twice, only a cut roll&apos;s balance.</p>
      <p>Dispatch / pick files (JAN0190…) go on the <b>Pick &amp; Dispatch</b> page.</p>
    </>,
  },
  {
    id: 'reports', icon: '📥', title: { si: 'Upload කරන reports', en: 'The reports' }, page: { href: '/upload/', label: 'Uploads' },
    si: <>
      <table className="rm-t" data-nofilter=""><thead><tr><th>Report</th><th>මොකටද</th><th>ඕනේ columns</th></tr></thead><tbody>
        <tr><td><b>Plan</b></td><td>Day / plant / Pick No එකට pick කරන්න ඕනේ SO lines</td><td>SO, LI, Item Code, QTY, Date, Plant</td></tr>
        <tr><td><b>ZMMBE</b></td><td>SO UR / QI / Block stock (batch අනුව). එක ZMMBE එකකින් ZMMBE KFC සහ PFC storage location අනුව බෙදෙනවා</td><td>Plant, St Location, Material, SO, LI, Batch, stock</td></tr>
        <tr><td><b>ZINSR</b></td><td>Inspection Lots: Lot එකේ QTY (Insp. Lot Quantity), Vendor Batch, Invoice, PO</td><td>Inspection Lot, Batch, Material, SO, LI, Vendor Batch, Insp. Lot Quantity, <b>Material Document</b></td></tr>
        <tr><td><b>ZROLLMGT</b></td><td>හැම Roll එකකම Barcode, StorageBin, Status, System Batch. <b>Mat. Doc</b> එකෙන් Roll එක මොන Lot එකටද කියලා හොයනවා</td><td>Barcode Number, StorageBin, Material, System Batch, Vendor Batch, <b>Mat. Doc</b></td></tr>
        <tr><td><b>Korber Inventory</b></td><td>Shelf එකේ තියෙන Rolls: Pallet, Lot Number, Actual Qty, Location</td><td>Pallet, Item Number, Lot Number, Actual Qty</td></tr>
        <tr><td><b>ZMM_TRR</b></td><td>Transfer Notes (TN)</td><td>Transfer Request Number, To SO, Material, Batch, Transfer Quantity, From SO Report No</td></tr>
        <tr><td><b>ZCMNTVIEW</b> <span className="pill mute">optional</span></td><td>අවශ්‍ය නැහැ. කලින් issue කරපු Roll (Plan Check) හරි re-inspection shade හරි බලන්න විතරයි</td><td>Inspection #, Barcode Number, Shade</td></tr>
      </tbody></table>
      <p><b>Templates</b> tab එකෙන් format එක download කරලා headers යටට data paste කරලා upload කරන්න. හැම file එකකම &quot;How to use&quot; sheet එකක් තියෙනවා.</p>
    </>,
    en: <>
      <table className="rm-t" data-nofilter=""><thead><tr><th>Report</th><th>What for</th><th>Columns needed</th></tr></thead><tbody>
        <tr><td><b>Plan</b></td><td>The SO lines to pick for a day / plant / Pick No</td><td>SO, LI, Item Code, QTY, Date, Plant</td></tr>
        <tr><td><b>ZMMBE</b></td><td>SO UR / QI / Block stock by batch. One ZMMBE also fills ZMMBE KFC and PFC, split by storage location</td><td>Plant, St Location, Material, SO, LI, Batch, stock</td></tr>
        <tr><td><b>ZINSR</b></td><td>Inspection lots: the lot&apos;s QTY (Insp. Lot Quantity), Vendor Batch, invoice, PO</td><td>Inspection Lot, Batch, Material, SO, LI, Vendor Batch, Insp. Lot Quantity, <b>Material Document</b></td></tr>
        <tr><td><b>ZROLLMGT</b></td><td>Each roll&apos;s Barcode, StorageBin, Status, System Batch — and by <b>Mat. Doc</b> its inspection lot</td><td>Barcode Number, StorageBin, Material, System Batch, Vendor Batch, <b>Mat. Doc</b></td></tr>
        <tr><td><b>Korber Inventory</b></td><td>The rolls on the shelf: Pallet, Lot Number, Actual Qty, Location</td><td>Pallet, Item Number, Lot Number, Actual Qty</td></tr>
        <tr><td><b>ZMM_TRR</b></td><td>Transfer notes (TN)</td><td>Transfer Request Number, To SO, Material, Batch, Transfer Quantity, From SO Report No</td></tr>
        <tr><td><b>ZCMNTVIEW</b> <span className="pill mute">optional</span></td><td>Not needed — only to look up rolls already issued (Plan Check) or re-inspection shades</td><td>Inspection #, Barcode Number, Shade</td></tr>
      </tbody></table>
      <p>On the <b>Templates</b> tab download a format, paste your data under the headers and upload it. Each file has a &quot;How to use&quot; sheet.</p>
    </>,
  },
  {
    id: 'match', icon: '🔗', title: { si: 'Roll matching', en: 'Roll matching' },
    si: <>
      <p className="rm-chain">ZMMBE (SO, LI, Batch, UR) → <b>ZINSR Lot</b> (Insp. Lot Quantity) → Material Document = <b>ZROLLMGT Mat. Doc</b> (+ Material, System Batch, Vendor Batch) → Barcode Number = <b>Korber Pallet</b></p>
      <ul>
        <li>Roll එකක් pick වෙන්නේ මේ ඔක්කොම ගැලපෙනවා නම් විතරයි: <b>Barcode = Pallet</b>, <b>Vendor Batch = Korber Lot Number</b>, Vendor Invoice No = Invoice Number, Purchasing Document = Po Number.</li>
        <li>ZROLLMGT rule: Roll එක <b>Settings → Pick rules</b> එකේ තියෙන StorageBin එකේ (උදා: EXPO-FIX) සහ Status <b>UR</b> වෙන්න ඕනේ. FIXED වගේ වෙන bin එකක තියෙන Roll pick වෙන්නේ නැහැ.</li>
        <li>Korber Pick Id 0 වෙන්න ඕනේ. Settings එකේ block කරලා තියෙන Wh Id + Location Id වල Roll කවදාවත් pick වෙන්නේ නැහැ.</li>
        <li>Lot එකකින් pick කරන්න පුළුවන් උපරිමය ඒ Lot එකේ <b>Insp. Lot Quantity</b> එක. ඉතුරු ප්‍රමාණය Lot කිහිපයක තියෙනවා නම් Lot එකකට Roll එක බැගින් Cut කරනවා.</li>
        <li><b>Shared lot:</b> එකම Rolls SO Lines කිහිපයකට අයිති නම්, අනිත් Lines වලට ප්‍රමාණවත් Roll ඉතුරු වෙනවා නම් විතරයි Auto-pick කරන්නේ. නැත්නම් &quot;Select suggested&quot; එකෙන් tick කරන්න ඕනේ.</li>
        <li>QTY වෙනස් නම් &quot;Confirmed&quot; ඕනේ. Barcode නැති Roll Invoice + Item + Lot එකෙන් ගලපනවා.</li>
        <li>SAP batch එක Packing List එකේ ඒ Roll එකේ Lot එකටම (Vendor Batch = Lot Number) ගැලපෙන්න හදනවා. <b>Lot Check</b> sheet එකෙන් හැම Roll එකක්ම validate වෙනවා.</li>
      </ul>
    </>,
    en: <>
      <p className="rm-chain">ZMMBE (SO, LI, Batch, UR) → <b>ZINSR lot</b> (Insp. Lot Quantity) → Material Document = <b>ZROLLMGT Mat. Doc</b> (+ Material, System Batch, Vendor Batch) → Barcode Number = <b>Korber Pallet</b></p>
      <ul>
        <li>A roll is matched only when all agree: <b>Barcode = Pallet</b>, <b>Vendor Batch = Korber Lot Number</b>, Vendor Invoice No = Invoice Number, Purchasing Document = Po Number.</li>
        <li>ZROLLMGT rule: the roll must be in the StorageBin set in <b>Settings → Pick rules</b> (e.g. EXPO-FIX) with Status <b>UR</b>; a roll in another bin (e.g. FIXED) is not picked.</li>
        <li>Korber Pick Id must be 0. A roll at a blocked Wh Id + Location Id (Settings) is never picked.</li>
        <li>A lot gives at most its <b>Insp. Lot Quantity</b>. When the rest is in several lots, one roll is cut per lot.</li>
        <li><b>Shared lot:</b> rolls listed for several SO lines are auto-picked only when the rolls left still cover the other lines; otherwise tick them with &quot;Select suggested&quot;.</li>
        <li>QTY differences need &quot;Confirmed&quot;. A roll with no barcode is matched on Invoice + Item + Lot.</li>
        <li>On the Packing List each roll&apos;s SAP batch follows its lot (Vendor Batch = Lot Number); the <b>Lot Check</b> sheet validates every roll.</li>
      </ul>
    </>,
  },
  {
    id: 'pick', icon: '🚚', title: { si: 'Pick & Dispatch', en: 'Pick & Dispatch' }, page: { href: '/dispatch/', label: 'Pick & Dispatch' },
    si: <>
      <ul>
        <li>Day එකයි Pick එකයි (plant එකේ Pick No) තෝරන්න. ඒ plan එකේ lines විතරයි පෙන්නන්නේ. Pick කරපු QTY එක <b>Dispatched</b> විදිහට ගණන් වෙනවා, Packing List එක හැදෙන්නේ picks වලින්.</li>
        <li><b>Auto match</b> = match වුණ Rolls වලින් QTY එක පිරෙනවා (⚡ Pick all matched). <b>Needs manual</b> = හේතුව එක්ක අතින් pick කරන්න ඕනේ. <b>Balance</b> = QTY − picked.</li>
        <li><b>Picks of the day:</b> හැමෝගෙම picks. මුළු Roll එකම pick කරපු එකක් ආයෙත් pick කරන්න බැහැ, Cut Roll එකක ඉතුරු ප්‍රමාණය විතරයි. <b>Cancel</b> කළාම ඒ pick එක delete වෙලා Rolls ආපහු ලැබෙනවා.</li>
        <li><b>Rejects:</b> ප්‍රශ්නයක් නිසා pick එකෙන් ඉවත් කරපු Rolls. Reject කරපු Pallet එකක් ආයෙත් pick වෙන්නේ නැහැ. ඒ වෙනුවට එකම Material එකේ Korber Roll එකක් assign කරන්න පුළුවන්.</li>
        <li><b>Import Packing List:</b> මේ system එකේ format එකේ තියෙන PL එකක Rolls ඒ Pick එකේ picks විදිහට save කරනවා. කලින් save කරපු ඒවා skip වෙනවා.</li>
        <li><b>Search the pick history:</b> pallet, SO, material, lot, batch, inspection lot, HJ Pick No, shade, user, plan, invoice වගේ ඕනෑම value එකක් type කරන්න.</li>
        <li><b>Week plan:</b> Week, Day, Plant තෝරලා Pick එකක තියෙන matching එකෙන්ම pick කරනවා. Week එකේ reports, නැත්නම් shared reports ගන්නවා.</li>
      </ul>
    </>,
    en: <>
      <ul>
        <li>Choose the day and the Pick (a plant&apos;s Pick No): only that plan&apos;s lines show. Picked QTY counts as <b>Dispatched</b>; the Packing List is built from the picks.</li>
        <li><b>Auto match</b> = the matched rolls cover the QTY (⚡ Pick all matched). <b>Needs manual</b> = pick by hand, with the reason. <b>Balance</b> = QTY − picked.</li>
        <li><b>Picks of the day:</b> everyone&apos;s picks. A fully picked roll can&apos;t be picked again; a part-picked roll keeps only its balance. <b>Cancel</b> deletes a pick and frees its rolls.</li>
        <li><b>Rejects:</b> rolls taken off a pick for a problem — never picked again. Assign a Korber roll of the same Material instead.</li>
        <li><b>Import Packing List:</b> a Packing List in this system&apos;s format is saved as picks of the Pick; rolls already saved are skipped.</li>
        <li><b>Search the pick history:</b> type any value — pallet, SO, material, lot, batch, inspection lot, HJ Pick No, shade, user, plan, invoice.</li>
        <li><b>Week plan:</b> choose week, day and plant — picked with the same matching as a Pick, from the week&apos;s own reports, else the shared ones.</li>
      </ul>
    </>,
  },
  {
    id: 'cut', icon: '✂️', title: { si: 'Cut roll balance සහ Minimum cut', en: 'Cut roll balance and minimum cut' },
    si: <>
      <ul>
        <li>Cut Roll එකක ඉතුරු ප්‍රමාණය මුලින්ම යන්නේ ඒ Roll එක cut කරපු SO line එකට (ඒ line එකේ තාම UR තියෙනවා නම්).</li>
        <li>නැත්නම් වෙන SO line එකකට: SO Plant = Pick plant එකේ code එක, එකම Material සහ LI, ZMMBE එකේ UR, සහ Vendor Batch = Roll එකේ Korber Lot Number තියෙන ZINSR lot එකක්. වෙනස් වෙන්න පුළුවන් SAP batch එක විතරයි.</li>
        <li>Roll එකක් cut කරන්න ඕනේ වුණාම, කලින් cut කරපු Roll එකකින් මුලින් ගන්නවා. එතකොට cut වෙන Roll ගණන අඩුයි.</li>
        <li><b>Minimum cut 0.5:</b> 0.5ට වඩා අඩු cut එකක් 0.5 කරනවා. වැඩිපුර ප්‍රමාණය cut roll balance විදිහට වෙන SO line එකකට යනවා (Normal සහ Offsite දෙකටම, TN Rolls වලට නැහැ).</li>
      </ul>
    </>,
    en: <>
      <ul>
        <li>A cut roll&apos;s balance goes first to the SO line it was cut for, while that line still has UR.</li>
        <li>Else to another SO line whose SO Plant is the Pick plant&apos;s code: same Material and LI, UR in ZMMBE, and a ZINSR lot whose Vendor Batch is the roll&apos;s Korber Lot Number. Only the SAP batch may differ.</li>
        <li>When a roll has to be cut, a roll already cut is used first, so fewer rolls are cut.</li>
        <li><b>Minimum cut 0.5:</b> a cut under 0.5 becomes 0.5; the extra goes as a cut roll balance to another SO line (Normal and Offsite, not TN rolls).</li>
      </ul>
    </>,
  },
  {
    id: 'korber', icon: '📦', title: { si: 'Korber Actual Qty සහ pick history', en: 'Korber Actual Qty and the pick history' },
    si: <>
      <p className="rm-chain">Available = Roll QTY (පළමු pick එකේදී) − කලින් pick කරපු QTY (හැම user ම, හැම Pick එකම)</p>
      <ul>
        <li>Korber upload කළාම Pallet එකෙන් Pallet එක check කරනවා: Korber Actual Qty එක History එකේ ඉතුරු ප්‍රමාණයට <b>සමාන හෝ වැඩි</b> නම් History එකම තියාගන්නවා. <b>අඩු</b> නම් (system එකෙන් පිටින් ගත්තොත්) Korber Actual Qty එක ගන්නවා. Korber upload කළාට පස්සේ කරපු picks ඒකෙන් අඩු කරනවා.</li>
        <li>Roll එකේ ඉතුරු ප්‍රමාණයට වඩා save කරන්න හැදුවොත් system එක ඒක නවත්තනවා (&quot;only X left&quot;). Cancel කරපු picks ඒ QTY එක ආපහු දෙනවා.</li>
        <li>Upload message එකේ <b>same / LESS in Korber / not out of Korber yet</b> කියන ගණන් පෙන්නනවා.</li>
      </ul>
    </>,
    en: <>
      <p className="rm-chain">Available = roll QTY (at its first pick) − QTY picked before (every user, every Pick)</p>
      <ul>
        <li>Each Korber upload is checked pallet by pallet: Korber Actual Qty the <b>same as or more than</b> the history leaves → the history stays; <b>less</b> (taken off outside the system) → the Korber Actual Qty is used, less what was picked after that upload.</li>
        <li>Saving more than the roll has left is refused (&quot;only X left&quot;). A cancelled pick gives its QTY back.</li>
        <li>The upload message shows the <b>same / LESS in Korber / not out of Korber yet</b> counts.</li>
      </ul>
    </>,
  },
  {
    id: 'tn', icon: '🔁', title: { si: 'Transfer Notes (TN)', en: 'Transfer notes (TN)' },
    si: <ul>
      <li>ZMM_TRR → ZROLLMGT: Material = Material, Batch = System Batch, Transfer Quantity = Original Roll Qty, From SO Report No = QM Comment 1 (brackets සහ spaces නොසලකා).</li>
      <li>ZROLLMGT → Korber: Material = Item Number, Vendor Batch = Lot Number, Vendor Roll = Supplier Hu, Del. Note Num = Invoice Number, Barcode = Pallet (Pallet එක නොගැලපුණත් අනිත් ඒවා ගැලපෙනවා නම් pick කරන්න පුළුවන්).</li>
      <li>Packing List එකේ TN Rolls &quot;TN · Transfer Request Number&quot; කියලා mark වෙනවා. <b>Transfer Notes</b> සහ <b>TN Balance</b> sheets වල pick කරපු ප්‍රමාණයයි ඉතුරු ප්‍රමාණයයි පෙන්නනවා.</li>
    </ul>,
    en: <ul>
      <li>ZMM_TRR → ZROLLMGT: Material = Material, Batch = System Batch, Transfer Quantity = Original Roll Qty, From SO Report No = QM Comment 1 (brackets and spaces ignored).</li>
      <li>ZROLLMGT → Korber: Material = Item Number, Vendor Batch = Lot Number, Vendor Roll = Supplier Hu, Del. Note Num = Invoice Number, Barcode = Pallet (pickable when the pallet differs but the rest agree).</li>
      <li>TN rolls are marked &quot;TN · Transfer Request Number&quot; on the Packing List; the <b>Transfer Notes</b> and <b>TN Balance</b> sheets show what was picked and what is left.</li>
    </ul>,
  },
  {
    id: 'terms', icon: '📊', title: { si: 'Plan report සහ Plant summary වචන', en: 'Plan report and plant summary terms' },
    si: <table className="rm-t" data-nofilter=""><tbody>
      <tr><td><b>AVALABALE</b></td><td>ZMMBE එකේ SO UR stock (හැම storage location එකකම)</td></tr>
      <tr><td><b>ALRADY SEND</b></td><td>Plant storage locations වල තියෙන ඒ stock එක</td></tr>
      <tr><td><b>Pending</b></td><td>QTY − ALRADY SEND</td></tr>
      <tr><td><b>POSIBAL PENDING</b></td><td>Warehouse එකේ free UR තියෙන Pending (Assigned Qty free නැහැ)</td></tr>
      <tr><td><b>QI / BLOCK</b></td><td>SO QI / SO Blocked stock</td></tr>
      <tr><td><b>TRANSFER NOTE</b></td><td>ZMM_TRR</td></tr>
      <tr><td><b>UR → QI → Block → NIH</b></td><td>යවන්න තියෙන QTY එක cover කරන්නේ මොකෙන්ද (NIH = not in house)</td></tr>
      <tr><td><b>SOLI</b></td><td>SO / LI lines. W/H = UR SOLI ÷ පැයකට SOLI ගණන. Total = UR + Adhoc</td></tr>
    </tbody></table>,
    en: <table className="rm-t" data-nofilter=""><tbody>
      <tr><td><b>AVALABALE</b></td><td>SO UR stock in ZMMBE (every storage location)</td></tr>
      <tr><td><b>ALRADY SEND</b></td><td>The same at the plant storage locations</td></tr>
      <tr><td><b>Pending</b></td><td>QTY − ALRADY SEND</td></tr>
      <tr><td><b>POSIBAL PENDING</b></td><td>Pending the warehouse has free UR for (Assigned Qty is not free)</td></tr>
      <tr><td><b>QI / BLOCK</b></td><td>SO QI / SO Blocked stock</td></tr>
      <tr><td><b>TRANSFER NOTE</b></td><td>ZMM_TRR</td></tr>
      <tr><td><b>UR → QI → Block → NIH</b></td><td>What covers the QTY still to send (NIH = not in house)</td></tr>
      <tr><td><b>SOLI</b></td><td>SO / LI lines. W/H = UR SOLI ÷ SOLI per hour. Total = UR + Adhoc</td></tr>
    </tbody></table>,
  },
  {
    id: 'pages', icon: '🗂️', title: { si: 'අනිත් pages', en: 'The other pages' },
    si: <ul>
      <li><b>Data:</b> Pick එකේ ZROLLMGT, Pallet search (හැම pick එකක්ම, rejects; Admin / Head ට history delete කරන්න පුළුවන්), Cut rolls (කොටසක් pick කරපු Rolls සහ ඉතුරු ප්‍රමාණය).</li>
      <li><b>Inventory:</b> SAP stock සහ Korber Inventory <b>Unic</b> = Plant-Location-Material අනුව tally කරනවා (SAP C065-0042-W1000272692 = Korber C065-0042-1000272692). PFC (MASKTR · 0041 / OFST / OMET / XLLT) සහ KFC (MASKRE · 0042) වෙන වෙනම. Browser එකේම වැඩ කරන්නේ, database එකට යන්නේ නැහැ.</li>
      <li><b>Plan Check:</b> Plan_Format එකක් upload කළාම හැම line එකක්ම system එක කලින් යවපු picks එක්ක check කරනවා (Sent / Partly sent / Not sent, යවපු QTY, balance, Rolls). <b>🩺 Pick diagnosis</b> එකෙන් line එකක් pick නොවෙන්නේ ඇයි කියලා සිංහලෙන් පෙන්නනවා.</li>
      <li><b>Week plan:</b> Day plans වලින් වෙනම. Week plan file එක (plan sheet + ZMMBE, ZMM_TRR, ZINSR, SHADE, ZROLLMGT, KORBER) හරි reports විතරක් හරි upload කරන්න පුළුවන්.</li>
      <li><b>Korber ↔ SAP tally:</b> Pick එකේ හැම Material එකකටම SAP UR, ZROLLMGT Rolls සහ Korber Rolls Roll එකින් Roll එක ගලපනවා. ගණන් විතරයි, කිසිම දෙයක් වෙනස් කරන්නේ නැහැ.</li>
      <li><b>Assign dispatch:</b> Plan එකේ නැති dispatch කරපු items plan line එකකට assign කරන්න.</li>
    </ul>,
    en: <ul>
      <li><b>Data:</b> the Pick&apos;s ZROLLMGT, pallet search (every pick and reject; Admin / Head can delete a pallet&apos;s history) and cut rolls (part-picked rolls and their balance).</li>
      <li><b>Inventory:</b> SAP stock and the Korber Inventory tallied by <b>Unic</b> = Plant-Location-Material (SAP C065-0042-W1000272692 = Korber C065-0042-1000272692), with PFC (MASKTR · 0041 / OFST / OMET / XLLT) and KFC (MASKRE · 0042) apart. Worked out in the browser — nothing goes into the database.</li>
      <li><b>Plan Check:</b> upload a Plan_Format; every line is checked against the picks already sent (Sent / Partly sent / Not sent, QTY sent, balance, rolls). <b>🩺 Pick diagnosis</b> says in Sinhala why a line is not picked.</li>
      <li><b>Week plan:</b> kept apart from the day plans. Upload the week plan file (plan sheet + ZMMBE, ZMM_TRR, ZINSR, SHADE, ZROLLMGT, KORBER) or the reports alone.</li>
      <li><b>Korber ↔ SAP tally:</b> each Material of a Pick — SAP UR, ZROLLMGT rolls and Korber rolls matched roll by roll. Counts only; nothing changes.</li>
      <li><b>Assign dispatch:</b> dispatched items that are not in the plan are assigned to a plan line.</li>
    </ul>,
  },
  {
    id: 'settings', icon: '⚙️', title: { si: 'Settings සහ users', en: 'Settings and users' },
    si: <ul>
      <li><b>Roles:</b> Admin = system settings. Head = හැම user කෙනෙක්ගෙම plans සහ picks. User = තමන්ගේ plan එක විතරයි. Viewer = බලන්න විතරයි.</li>
      <li><b>Pick rules:</b> Pick window එක හැමෝටම වැඩ කරන විදිහ (StorageBin rule, ZROLLMGT Available cap …). <b>Blocked locations:</b> Wh Id + Location Id (STAGE* වගේ * එකෙන් පටන් ගන්න ඒවා).</li>
      <li><b>Plants &amp; target times:</b> Plan එකේ plant code → නම, වගකියන කෙනා, target time (target එකට පස්සේ ආව plan රතු පාටින් පේනවා). <b>SO Plants:</b> plant එකක Picks stock ගන්න SO Plants (C068, C050 වගේ).</li>
      <li><b>Data Manager:</b> මාසෙට Cloudflare D1 rows read ප්‍රමාණය plan එක ඇතුළේ තියාගන්නවා (Saver / Strict). Pick rules, checks, saves කවදාවත් වෙනස් වෙන්නේ නැහැ.</li>
      <li><b>Users:</b> Users එකතු කරන්න. තියෙන username එකකට අලුත් password එකක් දැම්මොත් ඒක reset වෙනවා. Passwords hashed (PBKDF2).</li>
      <li><b>Backup / Files:</b> Backup එක plans, pick history, PL data, reports, plants, settings තියෙන .json file එකක්. Users සහ passwords ඒකට එන්නේ නැහැ. Upload කරපු Excel files ඒ විදිහටම තියාගන්නවා (report එකකට අලුත්ම 15).</li>
    </ul>,
    en: <ul>
      <li><b>Roles:</b> Admin = system settings. Head = every user&apos;s plans and picks. User = own plan only. Viewer = view only.</li>
      <li><b>Pick rules:</b> how the Pick window behaves for everyone (StorageBin rule, ZROLLMGT Available cap …). <b>Blocked locations:</b> Wh Id + Location Id (end with * for a prefix, e.g. STAGE*).</li>
      <li><b>Plants &amp; target times:</b> plant code → name, who is responsible, target time (a plan after the target shows red). <b>SO Plants:</b> the SO Plants a plant&apos;s Picks take stock from (e.g. C068, C050).</li>
      <li><b>Data Manager:</b> keeps the month&apos;s Cloudflare D1 rows read inside the plan (Saver / Strict). Pick rules, checks and saves never change.</li>
      <li><b>Users:</b> add people; an existing username with a new password resets it. Passwords are hashed (PBKDF2).</li>
      <li><b>Backup / Files:</b> a backup is one .json with plans, pick history, PL data, reports, plants and settings — never users or passwords. Uploaded Excel files are kept as they were (newest 15 of each report).</li>
    </ul>,
  },
  {
    id: 'data', icon: '🔒', title: { si: 'Data ආරක්ෂාව', en: 'Keeping data safe' },
    si: <ul>
      <li>Dashboards, screenshots, Packing Lists, reports, backups වල ඇත්ත SO / stock data තියෙනවා. ඒවා <b>internal වැඩ වලට විතරයි</b>. Team එකෙන් පිට share කරන්න එපා.</li>
      <li>Company data පාවිච්චි කරන්න IT / management අවසරය ඕනේ.</li>
    </ul>,
    en: <ul>
      <li>Dashboards, screenshots, Packing Lists, reports and backups hold real SO / stock data — <b>internal use only</b>; don&apos;t share outside the team.</li>
      <li>Company data needs IT / management permission.</li>
    </ul>,
  },
];

/** the plain text of a section, for the search box */
function textOf(n: React.ReactNode): string {
  if (n === null || n === undefined || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(' ');
  if (typeof n === 'object' && 'props' in (n as object)) return textOf((n as { props: { children?: React.ReactNode } }).props.children);
  return '';
}

function Readme() {
  const [lang, setLang] = useState<Lang>('si');
  const [q, setQ] = useState('');
  const [on, setOn] = useState(SECTIONS[0].id);
  useEffect(() => { try { const v = localStorage.getItem('mas-readme-lang'); if (v === 'si' || v === 'en') setLang(v); } catch { /* private mode */ } }, []);
  const pick = (l: Lang) => { setLang(l); try { localStorage.setItem('mas-readme-lang', l); } catch { /* private mode */ } };
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return SECTIONS;
    return SECTIONS.filter((s) => `${s.title.si} ${s.title.en} ${textOf(s.si)} ${textOf(s.en)}`.toLowerCase().includes(t));
  }, [q]);
  // the section in view lights up in the contents
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setOn(v.target.id.replace(/^rm-/, '')); }, { rootMargin: '-90px 0px -60% 0px' });
    SECTIONS.forEach((s) => { const el = document.getElementById(`rm-${s.id}`); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [lang]);
  return (
    <main className="page anim rm-page">
      <div className="page-head">
        <div><h1>README</h1></div>
        <div className="rm-tools">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={lang === 'si' ? 'සොයන්න…' : 'Search…'} aria-label="Search the README" />
          <div className="seg" role="group" aria-label="Language">
            <button type="button" className={lang === 'si' ? 'on' : ''} onClick={() => pick('si')}>සිංහල</button>
            <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => pick('en')}>English</button>
          </div>
        </div>
      </div>
      <div className="rm-grid">
        <nav className="rm-toc card" aria-label="Contents">
          {SECTIONS.map((s) => <a key={s.id} href={`#rm-${s.id}`} className={on === s.id ? 'on' : ''}><span aria-hidden>{s.icon}</span>{s.title[lang]}</a>)}
          <span className="rm-ver">{APP_VERSION}</span>
        </nav>
        <div className="rm-body">
          {list.map((s) => (
            <section key={s.id} id={`rm-${s.id}`} className={`card rm-sec ${lang === 'si' ? 'rm-si' : ''}`}>
              <div className="rm-h"><h2><span aria-hidden>{s.icon}</span> {s.title[lang]}</h2>{s.page && <Link className="btn sm" href={s.page.href}>{s.page.label} →</Link>}</div>
              {s[lang]}
            </section>
          ))}
          {!list.length && <p className="muted">{lang === 'si' ? 'කිසිවක් හම්බුණේ නැහැ.' : 'Nothing found.'}</p>}
        </div>
      </div>
    </main>
  );
}
