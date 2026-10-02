/**
 * scripts/test-api.mjs
 * 
 * Standalone test script for GIPDP (Government IT Procurement Discovery Platform).
 * Verifies data fetching and XML parsing from Thailand's e-GP RSS XML feed.
 *
 * Operational Constraints:
 * - Rate Limiting (PR-03): Minimum 1,000ms delay between requests
 * - Error Handling (NFR-02): Graceful try/catch, timeout resilience, non-crashing
 * - Thai Encoding: Decodes Windows-874/TIS-620 and UTF-8, logs if corrupted
 *
 * Usage:
 *   node scripts/test-api.mjs
 *   node scripts/test-api.mjs --deptId 02000
 *   node scripts/test-api.mjs --deptId 30501
 *   node scripts/test-api.mjs --mock   (Runs against sample e-GP XML fixture for offline validation)
 */

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

// ==========================================
// Configuration & Constants
// ==========================================
const BASE_URL = 'https://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml';

// Target Announcement Types
const ANNOUNCEMENT_TYPES = [
  { code: 'B0', name: 'Draft TOR (ร่างประกาศและร่างเอกสารประกวดราคา)' },
  { code: 'D0', name: 'Invitation to Bid (ประกาศเชิญชวน)' },
  { code: '15', name: 'Reference Price (ราคากลาง)' },
];

const USER_AGENT = 'GIPDP-DiscoveryBot/1.0 (+https://gipdp.local/bot; contact@gipdp.local)';
const REQUEST_TIMEOUT_MS = 10000;
const RATE_LIMIT_DELAY_MS = 1000;

// Realistic XML fixture for testing XML parsing & item previews even when live feeds return 0 items
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
    <item>
      <title>จ้างบำรุงรักษาระบบเครือข่ายและระบบสารสนเทศ ประจำปี 2569</title>
      <link>http://process.gprocurement.go.th/egp/project?id=69010011223</link>
      <description>จ้างเหมาบริการบำรุงรักษาระบบเครือข่ายคอมพิวเตอร์และอุปกรณ์ต่อพ่วง</description>
      <pubDate>Tue, 01 Sep 2026 10:00:00 +0700</pubDate>
    </item>
  </channel>
</rss>`;

// ==========================================
// Helper Utilities
// ==========================================

/**
 * Enforces rate limiting delay between consecutive HTTP requests.
 * @param {number} ms 
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses CLI arguments to extract deptId or mock flags.
 * Supports: --deptId=<value>, --deptId <value>, -d <value>, --mock
 */
function parseCliArgs() {
  const args = process.argv.slice(2);
  let deptId = '02000'; // Default sample department code (Office of the Permanent Secretary)
  let isMock = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mock') {
      isMock = true;
    } else if (arg.startsWith('--deptId=')) {
      deptId = arg.split('=')[1];
    } else if ((arg === '--deptId' || arg === '-d') && i + 1 < args.length) {
      deptId = args[++i];
    } else if (!arg.startsWith('-')) {
      deptId = arg;
    }
  }

  return { deptId, isMock };
}

/**
 * Smartly decodes raw XML buffer into string and checks for Thai character integrity.
 * 
 * Government e-GP endpoints typically deliver single-byte Windows-874 / TIS-620.
 * In UTF-8 mode, raw Windows-874 bytes fail UTF-8 validation (fatal: true).
 * This function cleanly tries UTF-8 first; if invalid, falls back to Windows-874.
 * It also checks for replacement characters (\uFFFD) or mojibake patterns to log corruption.
 * 
 * @param {ArrayBuffer|Buffer} buffer 
 * @returns {{ xmlText: string, encoding: string, isCorrupted: boolean }}
 */
function decodeThaiXml(buffer) {
  const rawBytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  
  let xmlText = '';
  let usedEncoding = 'utf-8';

  try {
    // Attempt strict UTF-8 decoding. If payload is Windows-874/TIS-620, fatal: true throws.
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    xmlText = utf8Decoder.decode(rawBytes);
    usedEncoding = 'utf-8';
  } catch {
    // Fall back to Windows-874 (standard Thai charset used by e-GP RSS)
    const win874Decoder = new TextDecoder('windows-874');
    xmlText = win874Decoder.decode(rawBytes);
    usedEncoding = 'windows-874';
  }

  // Corruption detection:
  // 1. Unicode replacement character (\uFFFD)
  // 2. Typical Mojibake sequence 'เธ' (0xE0 0xB8 mistakenly decoded as win-874)
  const hasReplacementChar = xmlText.includes('\uFFFD');
  const hasMojibakePattern = /เธ[ก-ฮ]/.test(xmlText);
  const isCorrupted = hasReplacementChar || hasMojibakePattern;

  return { xmlText, encoding: usedEncoding, isCorrupted };
}

/**
 * Truncates and cleans string snippets for readable console previews.
 * @param {string} str 
 * @param {number} maxLen 
 */
function cleanSnippet(str, maxLen = 120) {
  if (!str) return 'N/A';
  const cleaned = String(str).replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.substring(0, maxLen)}...` : cleaned;
}

// ==========================================
// Main Workflow
// ==========================================

async function main() {
  const { deptId, isMock } = parseCliArgs();

  console.log('='.repeat(72));
  console.log(' GIPDP - Government IT Procurement Discovery Platform');
  console.log(' e-GP RSS Feed Connectivity & Extraction Test Script');
  console.log('='.repeat(72));
  console.log(`[Config] Target Endpoint : ${BASE_URL}`);
  console.log(`[Config] Department Code : ${deptId || '(None - National Feed)'}`);
  console.log(`[Config] Mode            : ${isMock ? 'MOCK FIXTURE MODE' : 'LIVE HTTP FETCH'}`);
  console.log(`[Config] User-Agent      : ${USER_AGENT}`);
  console.log(`[Config] Request Timeout : ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`[Config] Rate Limit      : ${RATE_LIMIT_DELAY_MS}ms between queries`);
  console.log('='.repeat(72));

  // Initialize fast-xml-parser with required isArray constraint (Requirement 2)
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    // Ensures single and multiple <item> tags are both parsed as arrays
    isArray: (name) => name === 'item',
  });

  const summary = [];

  for (let i = 0; i < ANNOUNCEMENT_TYPES.length; i++) {
    const annType = ANNOUNCEMENT_TYPES[i];
    console.log(`\n[${i + 1}/${ANNOUNCEMENT_TYPES.length}] Querying Announcement Type: ${annType.code} - ${annType.name}`);

    // Build URL and parameters
    const requestUrl = new URL(BASE_URL);
    if (deptId) {
      requestUrl.searchParams.set('deptId', deptId);
    }
    requestUrl.searchParams.set('anounceType', annType.code);

    const fullUrlString = requestUrl.toString();
    console.log(`  -> Request URL: ${fullUrlString}`);

    let itemsCount = 0;
    let statusLog = 'FAILED';

    try {
      let xmlText = '';
      let encoding = 'utf-8';
      let isCorrupted = false;

      if (isMock) {
        // Mock fixture mode: useful for local verification of parsing and formatting
        console.log('  -> Response Status: 200 OK (Mock Fixture)');
        const simulatedBuffer = Buffer.from(SAMPLE_MOCK_XML, 'utf-8');
        const decoded = decodeThaiXml(simulatedBuffer);
        xmlText = decoded.xmlText;
        encoding = decoded.encoding;
        isCorrupted = decoded.isCorrupted;
      } else {
        // Requirement 2: axios GET with custom User-Agent, 10s timeout, raw arraybuffer
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

        // Requirement 3: Character encoding detection and Thai integrity validation
        const decoded = decodeThaiXml(response.data);
        xmlText = decoded.xmlText;
        encoding = decoded.encoding;
        isCorrupted = decoded.isCorrupted;
      }

      console.log(`  -> Encoding: ${encoding} | Thai Character Check: ${isCorrupted ? 'WARNING: Corrupted characters detected' : 'OK (Valid text)'}`);

      if (isCorrupted) {
        console.warn('  [WARN] Potential Thai character corruption detected in XML payload.');
      }

      // Requirement 2: fast-xml-parser parses XML into JSON
      const parsed = parser.parse(xmlText);
      const channel = parsed?.rss?.channel;

      if (!channel) {
        console.warn('  [WARN] XML payload received but <channel> root element was not found.');
      }

      // Requirement 2 & Output Specification: consistently access items
      const items = channel?.item || [];
      itemsCount = Array.isArray(items) ? items.length : 0;
      statusLog = 'SUCCESS';

      if (itemsCount === 0) {
        console.log(`  -> Result: 0 items found for announcement type ${annType.code}. Skipping to next type.`);
      } else {
        console.log(`  -> Result: ${itemsCount} items found!`);
        console.log(`  -> Showing preview of first ${Math.min(3, itemsCount)} item(s):`);

        // Output Specification 2: Structured preview of first 3 items
        const previewLimit = Math.min(3, itemsCount);
        for (let j = 0; j < previewLimit; j++) {
          const item = items[j];
          console.log(`\n     ---------------- [Item #${j + 1}] ----------------`);
          console.log(`     Title     : ${cleanSnippet(item.title, 140)}`);
          console.log(`     Link      : ${item.link || 'N/A'}`);
          console.log(`     PubDate   : ${item.pubDate || 'N/A'}`);
          console.log(`     Snippet   : ${cleanSnippet(item.description, 160)}`);
        }
      }
    } catch (err) {
      // Requirement 3 (NFR-02): Catch HTTP errors, timeouts, or parsing errors without crashing
      statusLog = 'ERROR';
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        console.error(`  [ERROR] Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${err.message}`);
      } else if (err.response) {
        console.error(`  [ERROR] HTTP Error ${err.response.status}: ${err.response.statusText}`);
      } else {
        console.error(`  [ERROR] Failed to fetch or parse RSS feed: ${err.message}`);
      }
    }

    summary.push({
      code: annType.code,
      name: annType.name,
      status: statusLog,
      totalItems: itemsCount,
    });

    // Requirement 3 (PR-03): Minimum 1,000ms delay between consecutive requests
    if (i < ANNOUNCEMENT_TYPES.length - 1) {
      console.log(`  -> Rate Limiter: Waiting ${RATE_LIMIT_DELAY_MS}ms before next request...`);
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  // ==========================================
  // Execution Summary (Output Specification 4)
  // ==========================================
  console.log('\n' + '='.repeat(72));
  console.log(' EXECUTION SUMMARY');
  console.log('='.repeat(72));
  console.table(
    summary.map((s) => ({
      'Announce Type': s.code,
      'Description': s.name.split(' (')[0],
      'Status': s.status,
      'Items Retrieved': s.totalItems,
    }))
  );

  const grandTotal = summary.reduce((acc, curr) => acc + curr.totalItems, 0);
  console.log(`Total procurement items retrieved across all types: ${grandTotal}`);
  console.log('='.repeat(72));
}

main().catch((fatalErr) => {
  console.error('[FATAL] Uncaught error in main execution loop:', fatalErr);
  process.exit(1);
});
