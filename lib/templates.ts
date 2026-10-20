/** Sample Excel formats people can download, fill and upload back. */
import * as XLSX from 'xlsx';
import type { Src } from './mapping';

interface Template { file: string; title: string; note: string; headers: string[]; rows: (string | number)[][] }

/** the SAP ZMMBE export as it comes now (40 columns) */
const ZMMBE_HEADERS = ['Plant', 'St Location', 'Material Type', 'Sales Order Status', 'Material', 'SO', 'LI', 'Size/Grid', 'Material Description', 'Batch', 'UOM', 'Last goods Received Date',
  'Sales order UR Stock', 'UR Stock Batch', 'SO QI stock', 'QI stock', 'SO Blocked stock Stock', 'Blocked Stock Batch', 'Total stock', 'FG Code', 'Style', 'Bin Location', 'SO Plant',
  'Net ST Price', 'Purchasing Group', 'ST Price', 'Price Unit', 'Value', 'Batch Created Date', 'Customer', 'Material group', 'FG Ext. Mat.group', 'Vendor code', 'FG Ext. Mat.grp Description',
  'Customer Color Code', 'Customer Color Desc', 'Vendor Name', 'PCD', 'Req Del on PCD', 'Stock Category', 'Assigned Qty'];
const STOCK_HEADERS = ['Plant', 'St Location', 'SO Plant', 'SO', 'LI', 'UR', 'Material', 'Batch', 'Style', 'Type', 'QI', 'Block', 'Assigned', 'Total'];

export const TEMPLATES: Record<Src, Template> = {
  plan: {
    file: 'Day_Plan_Format.xlsx', title: 'Day plan',
    note: 'One row per SO line. On upload you choose the day, the plant and the Pick No (1, 2 …); Date and Plant in the file are optional.',
    headers: ['SO', 'LI', 'Item Code', 'Date', 'QTY', 'Plant', 'Remarks'],
    rows: [[1001724370, 10, 1000042935, '2026-10-12', 3, 'C051', ''], [1001733165, 10, 1000256506, '2026-10-13', 40, 'C051', '1st priority Last pallet']],
  },
  zmmbe: {
    file: 'ZMMBE.xlsx', title: 'ZMMBE (full stock)',
    note: 'SAP ZMMBE export (new layout). Used: Plant, St Location, SO, LI, Material, Batch, Style, SO Plant, Sales order UR Stock (UR), SO QI stock (QI), SO Blocked stock Stock (Block), Total stock, Assigned Qty (Assigned). The other columns are allowed and left out. The older layouts still work too.',
    headers: ZMMBE_HEADERS,
    rows: [
      ['C065', '0042', 'ZFAB', 'A', '1000272464', 'E101720417', '50', '', '53/47_MERINO/RPES_2009098720_FWBE_52.75"', '0131013106', 'YD', '2026-08-28', 100.7, 0, 0, 0, 0, 0, 100.7, '7001534814', '44636', '', 'C065', 8.55, 'HW9', 8.55, 1, 860.99, '2026-08-28', '56', 'FAB0002', '56', '101585', 'Patagonia', 'FWBE', 'FWBE', 'Global Merino', '2026-11-05', '2026-10-31', '', 0],
      ['C065', '0042', 'ZFAB', 'A', '1000274604', 'E101702873', '40', '', '89/11 RNYL/SPX_2733000010_NGRY_52', '0131022592', 'YD', '2026-08-29', 24.225, 0, 0, 0, 0, 0, 24.225, '7001534216', '32125', '', 'C065', 4.301, 'HV9', 43.01, 10, 104.19, '2026-08-29', '56', 'FAB0002', '56', '100968', 'Patagonia', 'SWLC', 'SWLC', 'Stantex Corporation', '2026-10-26', '2026-10-21', '', 24.225],
    ],
  },
  kfc: {
    file: 'ZMMBE_KFC.xlsx', title: 'ZMMBE KFC',
    note: 'Same columns as ZMMBE, filtered to KFC storage locations.',
    headers: STOCK_HEADERS,
    rows: [['C050', 203, 'C051', 1001730394, 10, 0.359, 1000091737, 112434091, '22MN', '', 0, 0, 0, 0.359]],
  },
  pfc: {
    file: 'ZMMBE_PFC.xlsx', title: 'ZMMBE PFC',
    note: 'Same columns as ZMMBE, filtered to PFC storage locations.',
    headers: STOCK_HEADERS,
    rows: [['C056', 41, 'C051', 1001758748, 10, 3311.246, 1000256531, 132599766, 'IV1462', '', 0, 0, 0, 3311.246]],
  },
  plant: {
    file: 'PLANT.xlsx', title: 'PLANT report',
    note: 'Stock at the plant. The Total column (N) is used as "At plant".',
    headers: STOCK_HEADERS,
    rows: [['C051', 40, 'C051', 1001740066, 10, 0.374, 1000106069, 101570279, 'IX5952', 'M', 0, 0, 0, 0.374]],
  },
  trr: {
    file: 'TRR.xlsx', title: 'TRR (transfer notes)',
    note: 'One row per TN line. TN QTY is summed per SO / LI / Material.',
    headers: ['TN', 'TN Date', 'Created By', 'SO', 'LI', 'From Plant', 'From SLoc', 'Material', 'To Plant', 'To SLoc', 'QTY', 'Reason'],
    rows: [[1756082, '08.10.2026', 'CHAMODK', 1001712906, 10, 'C051', 203, 1000212186, 'C050', 203, 77.112, 'BOM change request']],
  },
};

/** Data sheet names the upload screen recognises on their own. */
const SHEET_NAME: Record<Src, string> = { plan: 'Plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT', trr: 'TRR' };

export function downloadTemplate(src: Src) {
  const t = TEMPLATES[src];
  const ws = XLSX.utils.aoa_to_sheet([t.headers, ...t.rows]);
  ws['!cols'] = t.headers.map((h) => ({ wch: Math.max(10, h.length + 3) }));
  const help = XLSX.utils.aoa_to_sheet([
    [`${t.title} — upload format`], [], [t.note], [],
    ['Keep the header names in row 1. Column order can change; the upload screen finds the columns by name.'],
    ['Delete the sample rows before pasting your data.'],
    ['Upload it on the Uploads page of MAS Weekly Plan Tracker. The calculation runs as soon as it is saved.'],
  ]);
  help['!cols'] = [{ wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME[src]);
  XLSX.utils.book_append_sheet(wb, help, 'How to use');
  XLSX.writeFile(wb, t.file);
}
