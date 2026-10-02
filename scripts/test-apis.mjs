/**
 * scripts/test-apis.mjs
 * 
 * Standalone verification script for GIPDP (Government IT Procurement Discovery Platform).
 * Tests connectivity, data parsing, and character integrity across two primary government endpoints:
 * 1. e-GP RSS XML Feed (process3.gprocurement.go.th)
 * 2. Open Government Data CKAN REST API (data.go.th)
 *
 * Operational Constraints:
 * - Rate Limiting (PR-03): Minimum 1,000ms delay between consecutive HTTP requests.
 * - Resilience (NFR-02): Independent try/catch handlers for each test block.
 * - Thai Encoding: Decodes Windows-874/TIS-620 natively, validates Thai character rendering.
 *
 * Usage:
 *   node scripts/test-apis.mjs
 *   node scripts/test-apis.mjs --deptId 30501
 *   node scripts/test-apis.mjs --limit 5
 *   node scripts/test-apis.mjs --only egp
 *   node scripts/test-apis.mjs --only datago
 *   node scripts/test-apis.mjs --mock
 */

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

// ==========================================
// Endpoint Configurations & Constants
// ==========================================

// 1. e-GP RSS XML Feed
const EGP_BASE_URL = 'https://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml';
const EGP_ANNOUNCEMENT_TYPES = [
  { code: 'B0', name: 'Draft TOR (ร่างประกาศและร่างเอกสารประกวดราคา)' },
  { code: 'D0', name: 'Invitation to Bid (ประกาศเชิญชวน)' },
  { code: '15', name: 'Reference Price (ราคากลาง)' },
];

// 2. Open Government Data CKAN REST API (data.go.th)
const DATA_GO_TH_BASE_URL = 'https://data.go.th/api/3/action';
// Resource ID for summary_cgdcontract (Fiscal Year 2568 - latest procurement contract summary)
const DEFAULT_CGD_RESOURCE_ID = 'ef2c6a07-afdf-4b3a-b8d3-223a2bc2ad83';
// Fallback Resource ID (Fiscal Year 2567)
const FALLBACK_CGD_RESOURCE_ID = 'fb90d773-51e9-431a-ac30-18a100f9cdd9';

const USER_AGENT = 'GIPDP-DiscoveryBot/1.0 (+https://gipdp.local/bot; contact@gipdp.local)';
const REQUEST_TIMEOUT_MS = 10000;
const RATE_LIMIT_DELAY_MS = 1000;

// Sample XML fixture for offline verification or when live RSS feeds return 0 items
const SAMPLE_MOCK_XML = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0">
  <channel>
    <title>ประกาศจัดซื้อจัดจ้างภาครัฐ</title>
    <link>http://process.gprocurement.go.th</link>
    <description>ประกาศจัดซื้อจัดจ้างภาครัฐล่าสุด</description>
    <language>th-TH</language>
    <item>
      <title>จ้างพัฒนาระบบคลาวด์กลางและโครงสร้างพื้นฐานดิจิทัลภาครัฐ ประจำปีงบประมาณ 2569</title>
      <link>http://process.gprocurement.go.th/egp/project?id=69010012345</link>
      <description>ประกวดราคาจ้างพัฒนาระบบคลาวด์กลางและโครงสร้างพื้นฐานดิจิทัล ด้วยวิธีประกวดราคาอิเล็กทรอนิกส์ (e-bidding) ราคากลาง 15,000,000 บาท</description>
      <pubDate>Fri, 04 Sep 2026 09:30:00 +0700</pubDate>
    </item>
    <item>
      <title>ซื้อครุภัณฑ์คอมพิวเตอร์และอุปกรณ์เครือข่ายความปลอดภัยสูง สำนักงานปลัดกระทรวง</title>
      <link>http://process.gprocurement.go.th/egp/project?id=69010054321</link>
      <description>จัดซื้อครุภัณฑ์คอมพิวเตอร์แม่ข่าย (Server) และ Firewall ประจำศูนย์ข้อมูล จำนวน 1 ชุด</description>
      <pubDate>Thu, 03 Sep 2026 14:15:00 +0700</pubDate>
    </item>
    <item>
      <title>จ้างที่ปรึกษาพัฒนาระบบปัญญาประดิษฐ์ (AI) เพื่อวิเคราะห์ข้อมูลจัดซื้อจัดจ้าง</title>
      <link>http://process.gprocurement.go.th/egp/project?id=69010098765</link>
      <description>จ้างที่ปรึกษาออกแบบและพัฒนาโมเดล AI สำหรับตรวจจับความผิดปกติในการเสนอราคาโครงการจัดซื้อจัดจ้างภาครัฐ</description>
      <pubDate>Wed, 02 Sep 2026 11:00:00 +0700</pubDate>
    </item>
  </channel>
</rss>`;

// Sample JSON fixture for offline mock verification of data.go.th
const SAMPLE_MOCK_DATA_GO_JSON = {
  help: 'https://data.go.th/api/3/action/help_show?name=datastore_search',
  success: true,
  result: {
    resource_id: DEFAULT_CGD_RESOURCE_ID,
    total: 12450,
    limit: 3,
    fields: [
      { id: '_id', type: 'int' },
      { id: 'ลำดับ', type: 'numeric' },
      { id: 'รหัสหน่วยงาน', type: 'numeric' },
      { id: 'ชื่อหน่วยงาน', type: 'text' },
      { id: 'รหัสหน่วยงานย่อย', type: 'numeric' },
      { id: 'ชื่อหน่วยงานย่อย', type: 'text' },
      { id: 'จำนวนโครงการ', type: 'numeric' },
      { id: 'วงเงินงบประมาณ (บาท)', type: 'numeric' }
    ],
    records: [
      {
        _id: 1,
        'ลำดับ': 1,
        'รหัสหน่วยงาน': 500,
        'ชื่อหน่วยงาน': 'สำนักงานสาธารณสุขจังหวัดอ่างทอง',
        'รหัสหน่วยงานย่อย': 50015000000,
        'ชื่อหน่วยงานย่อย': 'โรงพยาบาลแสวงหา',
        'จำนวนโครงการ': 12,
        'วงเงินงบประมาณ (บาท)': 4500000
      },
      {
        _id: 2,
        'ลำดับ': 2,
        'รหัสหน่วยงาน': 800,
        'ชื่อหน่วยงาน': 'สำนักงานสาธารณสุขจังหวัดชัยนาท',
        'รหัสหน่วยงานย่อย': 80018000000,
        'ชื่อหน่วยงานย่อย': 'โรงพยาบาลสรรคบุรี',
        'จำนวนโครงการ': 8,
        'วงเงินงบประมาณ (บาท)': 2800000
      },
      {
        _id: 3,
        'ลำดับ': 3,
        'รหัสหน่วยงาน': 1000,
        'ชื่อหน่วยงาน': 'สำนักงานสาธารณสุขจังหวัดชลบุรี',
        'รหัสหน่วยงานย่อย': 100020000000,
        'ชื่อหน่วยงานย่อย': 'โรงพยาบาลบางละมุง',
        'จำนวนโครงการ': 25,
        'วงเงินงบประมาณ (บาท)': 18200000
      }
    ]
  }
};

// ==========================================
// Helper Utilities
// ==========================================

/**
 * Enforces rate limiting delay between consecutive HTTP requests (PR-03).
 * @param {number} ms 
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses CLI arguments.
 * Flags:
 *   --deptId <id>, -d <id>       : e-GP department code (default: 02000)
 *   --limit <num>, -l <num>     : Record limit for data.go.th (default: 3)
 *   --resourceId <id>           : Resource ID for data.go.th datastore
 *   --only <egp|datago|all>     : Filter which API suite to run
 *   --mock                      : Run using local mock fixtures (offline test)
 */
function parseCliArgs() {
  const args = process.argv.slice(2);
  let deptId = '02000'; // Default sample department code (Office of the Permanent Secretary)
  let limit = 3;
  let resourceId = DEFAULT_CGD_RESOURCE_ID;
  let only = 'all';
  let isMock = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mock') {
      isMock = true;
    } else if (arg.startsWith('--deptId=')) {
      deptId = arg.split('=')[1];
    } else if ((arg === '--deptId' || arg === '-d') && i + 1 < args.length) {
      deptId = args[++i];
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10) || 3;
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < args.length) {
      limit = parseInt(args[++i], 10) || 3;
    } else if (arg.startsWith('--resourceId=')) {
      resourceId = arg.split('=')[1];
    } else if (arg === '--resourceId' && i + 1 < args.length) {
      resourceId = args[++i];
    } else if (arg.startsWith('--only=')) {
      only = arg.split('=')[1].toLowerCase();
    } else if (arg === '--only' && i + 1 < args.length) {
      only = args[++i].toLowerCase();
    } else if (!arg.startsWith('-')) {
      deptId = arg;
    }
  }

  return { deptId, limit, resourceId, only, isMock };
}

/**
 * Decodes raw XML buffer into string and checks for Thai character integrity.
 * e-GP endpoints frequently deliver single-byte Windows-874 / TIS-620.
 * In strict UTF-8 mode, raw Windows-874 bytes fail UTF-8 validation (fatal: true).
 * This function tries UTF-8 first; if invalid, falls back to Windows-874.
 * 
 * @param {ArrayBuffer|Buffer} buffer 
 * @returns {{ xmlText: string, encoding: string, isCorrupted: boolean }}
 */
function decodeThaiXml(buffer) {
  const rawBytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  
  let xmlText = '';
  let usedEncoding = 'utf-8';

  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    xmlText = utf8Decoder.decode(rawBytes);
    usedEncoding = 'utf-8';
  } catch {
    const win874Decoder = new TextDecoder('windows-874');
    xmlText = win874Decoder.decode(rawBytes);
    usedEncoding = 'windows-874';
  }

  const hasReplacementChar = xmlText.includes('\uFFFD');
  const hasMojibakePattern = /เธ[ก-ฮ]/.test(xmlText);
  const isCorrupted = hasReplacementChar || hasMojibakePattern;

  return { xmlText, encoding: usedEncoding, isCorrupted };
}

/**
 * Verifies that Thai characters in a string render legibly.
 * @param {string} text 
 */
function verifyThaiString(text) {
  if (!text) return { hasThai: false, isLegible: true };
  const hasThai = /[\u0E00-\u0E7F]/.test(text);
  const isCorrupted = text.includes('\uFFFD') || /เธ[ก-ฮ]/.test(text);
  return { hasThai, isLegible: !isCorrupted };
}

/**
 * Truncates and cleans string snippets for readable console previews.
 * @param {any} val 
 * @param {number} maxLen 
 */
function cleanSnippet(val, maxLen = 120) {
  if (val === null || val === undefined) return 'N/A';
  const cleaned = String(val).replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.substring(0, maxLen)}...` : cleaned;
}

// ==========================================
// Test Suite 1: e-GP RSS XML Feed
// ==========================================

async function testEgpRssFeed({ deptId, isMock, summaryList }) {
  console.log('\n' + '='.repeat(74));
  console.log(' [SUITE 1] e-GP RSS XML Feed Verification (process3.gprocurement.go.th)');
  console.log('='.repeat(74));
  console.log(`Endpoint URL   : ${EGP_BASE_URL}`);
  console.log(`Department Code: ${deptId || '(None - National Feed)'}`);
  console.log(`Test Types     : ${EGP_ANNOUNCEMENT_TYPES.map(t => t.code).join(', ')}`);
  console.log('-'.repeat(74));

  // Initialize fast-xml-parser with isArray constraint
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    isArray: (name) => name === 'item',
  });

  for (let i = 0; i < EGP_ANNOUNCEMENT_TYPES.length; i++) {
    const annType = EGP_ANNOUNCEMENT_TYPES[i];
    console.log(`\n[1.${i + 1}] Querying Type: ${annType.code} - ${annType.name}`);

    const requestUrl = new URL(EGP_BASE_URL);
    if (deptId) {
      requestUrl.searchParams.set('deptId', deptId);
    }
    requestUrl.searchParams.set('anounceType', annType.code);
    const fullUrlString = requestUrl.toString();

    console.log(`  -> Request URL: ${fullUrlString}`);

    let itemsCount = 0;
    let statusLog = 'FAILED';
    let encodingStatus = 'N/A';

    try {
      let xmlText = '';
      let encoding = 'utf-8';
      let isCorrupted = false;

      if (isMock) {
        console.log('  -> Response Status: 200 OK (Mock Fixture)');
        const simulatedBuffer = Buffer.from(SAMPLE_MOCK_XML, 'utf-8');
        const decoded = decodeThaiXml(simulatedBuffer);
        xmlText = decoded.xmlText;
        encoding = decoded.encoding;
        isCorrupted = decoded.isCorrupted;
      } else {
        const response = await axios.get(fullUrlString, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          },
          timeout: REQUEST_TIMEOUT_MS,
          responseType: 'arraybuffer',
          maxRedirects: 5,
          validateStatus: (status) => status >= 200 && status < 400,
        });

        console.log(`  -> Response Status: ${response.status} ${response.statusText || 'OK'}`);
        const decoded = decodeThaiXml(response.data);
        xmlText = decoded.xmlText;
        encoding = decoded.encoding;
        isCorrupted = decoded.isCorrupted;
      }

      encodingStatus = `${encoding} (${isCorrupted ? 'CORRUPTED' : 'VALID'})`;
      console.log(`  -> Encoding: ${encoding} | Thai Character Check: ${isCorrupted ? 'WARNING: Corrupted' : 'OK (Valid)'}`);

      // Parse XML to JSON
      const parsed = parser.parse(xmlText);
      const channel = parsed?.rss?.channel;
      const items = channel?.item || [];
      itemsCount = Array.isArray(items) ? items.length : 0;
      statusLog = 'SUCCESS';

      if (itemsCount === 0) {
        console.log(`  -> Result: 0 items found for announcement type ${annType.code}. (Normal for off-hours/weekends)`);
      } else {
        console.log(`  -> Result: ${itemsCount} items found! Previewing first ${Math.min(3, itemsCount)} item(s):`);
        const previewLimit = Math.min(3, itemsCount);
        for (let j = 0; j < previewLimit; j++) {
          const item = items[j];
          console.log(`\n     ---------------- [Item #${j + 1}] ----------------`);
          console.log(`     Title     : ${cleanSnippet(item.title, 120)}`);
          console.log(`     Link      : ${item.link || 'N/A'}`);
          console.log(`     PubDate   : ${item.pubDate || 'N/A'}`);
          if (item.description) {
            console.log(`     Snippet   : ${cleanSnippet(item.description, 140)}`);
          }
        }
      }
    } catch (err) {
      statusLog = 'ERROR';
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        console.error(`  [ERROR] Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${err.message}`);
      } else if (err.response) {
        console.error(`  [ERROR] HTTP Error ${err.response.status}: ${err.response.statusText}`);
      } else {
        console.error(`  [ERROR] Feed query failed: ${err.message}`);
      }
    }

    summaryList.push({
      service: 'e-GP RSS',
      target: `Type ${annType.code} (${annType.name.split(' (')[0]})`,
      status: statusLog,
      encoding: encodingStatus,
      count: itemsCount,
    });

    // Enforce Rate Limiting (PR-03): minimum 1,000ms delay between requests
    console.log(`  -> Rate Limiter: Waiting ${RATE_LIMIT_DELAY_MS}ms...`);
    await delay(RATE_LIMIT_DELAY_MS);
  }
}

// ==========================================
// Test Suite 2: Open Government Data REST API (data.go.th)
// ==========================================

async function testOpenDataApi({ resourceId, limit, isMock, summaryList }) {
  console.log('\n' + '='.repeat(74));
  console.log(' [SUITE 2] Open Government Data REST API Verification (data.go.th CKAN)');
  console.log('='.repeat(74));
  console.log(`Base URL       : ${DATA_GO_TH_BASE_URL}`);
  console.log(`Action Endpoint: ${DATA_GO_TH_BASE_URL}/datastore_search`);
  console.log(`Target Dataset : CGDContract (Fiscal Summary: ${resourceId})`);
  console.log(`Record Limit   : ${limit}`);
  console.log('-'.repeat(74));

  const datastoreUrl = `${DATA_GO_TH_BASE_URL}/datastore_search?resource_id=${encodeURIComponent(resourceId)}&limit=${limit}`;
  console.log(`  -> Request URL: ${datastoreUrl}`);

  let statusLog = 'FAILED';
  let encodingStatus = 'N/A';
  let recordCount = 0;

  try {
    let payload = null;

    if (isMock) {
      console.log('  -> Response Status: 200 OK (Mock Fixture)');
      payload = SAMPLE_MOCK_DATA_GO_JSON;
    } else {
      const response = await axios.get(datastoreUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      console.log(`  -> Response Status: ${response.status} ${response.statusText || 'OK'}`);
      payload = response.data;
    }

    if (!payload?.success) {
      throw new Error(`CKAN API reported unsuccessful query: ${JSON.stringify(payload?.error || 'Unknown error')}`);
    }

    const result = payload.result;
    const fields = result?.fields || [];
    const records = result?.records || [];
    recordCount = records.length;
    statusLog = 'SUCCESS';

    // Verify Thai encoding on agency names
    const sampleAgencyName = records[0]?.['ชื่อหน่วยงาน'] || records[0]?.['ชื่อหน่วยงานย่อย'] || '';
    const thaiCheck = verifyThaiString(sampleAgencyName);
    encodingStatus = `utf-8 (${thaiCheck.isLegible ? 'VALID' : 'CORRUPTED'})`;

    console.log(`  -> CKAN Success   : ${payload.success}`);
    console.log(`  -> Total Records  : ${result.total !== undefined ? result.total : 'N/A'}`);
    console.log(`  -> Returned Count : ${recordCount}`);
    console.log(`  -> Thai Text Check: ${thaiCheck.isLegible ? 'OK (Legible Thai rendered)' : 'WARNING: Corrupted'}`);

    // Print Schema Overview
    console.log('\n  -> [Schema Preview: Fields & Types]');
    fields.forEach((f) => {
      console.log(`     - ${f.id.padEnd(26)} : ${f.type || 'text'}`);
    });

    // Print Preview of Records
    console.log(`\n  -> [Records Preview: Top ${recordCount} record(s)]`);
    records.forEach((rec, idx) => {
      console.log(`\n     ---------------- [Record #${idx + 1}] ----------------`);
      console.log(`     _id             : ${rec._id}`);
      console.log(`     Agency Code     : ${rec['รหัสหน่วยงาน'] ?? 'N/A'}`);
      console.log(`     Agency Name     : ${rec['ชื่อหน่วยงาน'] ?? 'N/A'}`);
      console.log(`     Sub-Agency Code : ${rec['รหัสหน่วยงานย่อย'] ?? 'N/A'}`);
      console.log(`     Sub-Agency Name : ${rec['ชื่อหน่วยงานย่อย'] ?? 'N/A'}`);
      console.log(`     Project Count   : ${rec['จำนวนโครงการ'] ?? '0'}`);
      console.log(`     Budget (THB)    : ${rec['วงเงินงบประมาณ (บาท)'] !== null && rec['วงเงินงบประมาณ (บาท)'] !== undefined ? Number(rec['วงเงินงบประมาณ (บาท)']).toLocaleString('th-TH') : '0'}`);
    });
  } catch (err) {
    statusLog = 'ERROR';
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.error(`  [ERROR] data.go.th request timed out after ${REQUEST_TIMEOUT_MS}ms: ${err.message}`);
    } else if (err.response) {
      console.error(`  [ERROR] data.go.th HTTP Error ${err.response.status}: ${err.response.statusText}`);
    } else {
      console.error(`  [ERROR] data.go.th API query failed: ${err.message}`);
    }
  }

  summaryList.push({
    service: 'data.go.th REST',
    target: `datastore_search (limit=${limit})`,
    status: statusLog,
    encoding: encodingStatus,
    count: recordCount,
  });

  // Rate Limiter delay
  console.log(`  -> Rate Limiter: Waiting ${RATE_LIMIT_DELAY_MS}ms...`);
  await delay(RATE_LIMIT_DELAY_MS);
}

// ==========================================
// Main Execution Loop
// ==========================================

async function main() {
  const cliArgs = parseCliArgs();

  console.log('='.repeat(74));
  console.log(' GIPDP - Government IT Procurement Discovery Platform');
  console.log(' Dual Government Endpoint Connectivity & Verification Suite');
  console.log('='.repeat(74));
  console.log(`[Config] Execution Mode : ${cliArgs.isMock ? 'MOCK FIXTURE MODE' : 'LIVE NETWORK CALLS'}`);
  console.log(`[Config] Target Filter  : ${cliArgs.only.toUpperCase()}`);
  console.log(`[Config] User-Agent     : ${USER_AGENT}`);
  console.log(`[Config] Timeout        : ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`[Config] Rate Limit     : ${RATE_LIMIT_DELAY_MS}ms between requests`);
  console.log('='.repeat(74));

  const summaryList = [];

  // 1. Execute e-GP RSS XML Feed Test (unless --only datago is requested)
  if (cliArgs.only === 'all' || cliArgs.only === 'egp') {
    await testEgpRssFeed({
      deptId: cliArgs.deptId,
      isMock: cliArgs.isMock,
      summaryList,
    });
  }

  // 2. Execute data.go.th CKAN REST API Test (unless --only egp is requested)
  if (cliArgs.only === 'all' || cliArgs.only === 'datago') {
    await testOpenDataApi({
      resourceId: cliArgs.resourceId,
      limit: cliArgs.limit,
      isMock: cliArgs.isMock,
      summaryList,
    });
  }

  // ==========================================
  // Execution Summary Table
  // ==========================================
  console.log('\n' + '='.repeat(74));
  console.log(' COMPREHENSIVE EXECUTION SUMMARY');
  console.log('='.repeat(74));
  console.table(
    summaryList.map((s) => ({
      'Data Service': s.service,
      'Target / Query': s.target,
      'Status': s.status,
      'Encoding': s.encoding,
      'Items / Records': s.count,
    }))
  );

  const totalRetrieved = summaryList.reduce((acc, curr) => acc + (Number(curr.count) || 0), 0);
  console.log(`Total procurement items and records retrieved across all services: ${totalRetrieved}`);
  console.log('='.repeat(74));
}

main().catch((fatalErr) => {
  console.error('[FATAL] Uncaught error in main execution loop:', fatalErr);
  process.exit(1);
});
