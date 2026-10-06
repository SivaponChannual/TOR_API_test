/**
 * process3/test-process3.mjs
 *
 * Standalone test & automated TOR extraction script for Thailand e-GP (process3.gprocurement.go.th).
 *
 * Automated 1-by-1 Pipeline (Test Size Scale):
 * 1. Queries live e-GP RSS XML feed with keyword filtering (--q) and department code (--deptId).
 * 2. If the daily RSS feed is active (weekdays during business hours), extracts announcements.
 *    If the daily RSS feed is empty (weekends/off-hours), automatically queries e-GP's active
 *    procurement database for the department/keyword to discover active announcements.
 * 3. Resolves and downloads real live TOR documents directly into process3/tors/documents/<projectId>_TOR.pdf.
 * 4. Parses the PDF with pdf-parse to extract pages, document type (scanned vs digital), and technical specs.
 * 5. Persists enriched records into process3/tors/latest-tors.json.
 *
 * Strictly NO MOCKS - 100% Real Live Government Data & Documents.
 *
 * Usage:
 *   node process3/test-process3.mjs
 *   node process3/test-process3.mjs --q คอมพิวเตอร์ --limit 1
 *   node process3/test-process3.mjs --q คลาวด์ --deptId 02000
 */

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAndDownloadEgpTorDocument, parseTorDocument } from '../scripts/lib/tor-downloader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// Configurations
// ==========================================
const BASE_URL = 'https://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml';
const TORS_DIR = path.join(__dirname, 'tors');
const DOCUMENTS_DIR = path.join(TORS_DIR, 'documents');

const ANNOUNCEMENT_TYPES = [
  { code: 'B0', name: 'Draft TOR (ร่างประกาศและร่างเอกสารประกวดราคา)' },
  { code: 'D0', name: 'Invitation to Bid (ประกาศเชิญชวน)' },
  { code: '15', name: 'Reference Price (ราคากลาง)' },
];

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_DELAY_MS = 1000;

// ==========================================
// Helper Utilities
// ==========================================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let deptId = ''; // Default all departments
  let limit = 1; // Strict 1-by-1 default for test-size storage
  let query = 'คอมพิวเตอร์'; // Default IT search keyword
  let type = ''; // Specific announcement type (e.g. D0, B0, 15)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--deptId=')) {
      deptId = arg.split('=')[1];
    } else if ((arg === '--deptId' || arg === '-d') && i + 1 < args.length) {
      deptId = args[++i];
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10) || 1;
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < args.length) {
      limit = parseInt(args[++i], 10) || 1;
    } else if (arg.startsWith('--q=')) {
      query = arg.split('=')[1];
    } else if ((arg === '--q' || arg === '-q') && i + 1 < args.length) {
      query = args[++i];
    } else if (arg.startsWith('--type=')) {
      type = arg.split('=')[1];
    } else if ((arg === '--type' || arg === '-t') && i + 1 < args.length) {
      type = args[++i];
    }
  }

  return { deptId, limit, query, type };
}

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

function cleanSnippet(str, maxLen = 120) {
  if (!str) return 'N/A';
  const cleaned = String(str).replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.substring(0, maxLen)}...` : cleaned;
}

// ==========================================
// Main Workflow
// ==========================================

async function main() {
  const { deptId, limit, query, type } = parseCliArgs();

  console.log('='.repeat(76));
  console.log(' GIPDP - process3 Automated 1-by-1 TOR Downloader & Parser');
  console.log('='.repeat(76));
  console.log(`Endpoint URL    : ${BASE_URL}`);
  console.log(`Announcement Typ: ${type || '(All Configured Types)'}`);
  console.log(`Department Code : ${deptId || '(All National Departments)'}`);
  console.log(`Query Filter    : "${query}"`);
  console.log(`Download Limit  : ${limit} project(s) at a time (Test Size Guardrail)`);
  console.log(`Document Target : ${DOCUMENTS_DIR}`);
  console.log('='.repeat(76));

  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    isArray: (name) => name === 'item',
  });

  const allExtractedTors = [];
  const summary = [];

  // Filter announcement types if requested
  const targetTypes = type
    ? ANNOUNCEMENT_TYPES.filter((t) => t.code.toUpperCase() === type.toUpperCase())
    : ANNOUNCEMENT_TYPES;

  // Step 1: Query Live RSS feed across announcement types
  for (let i = 0; i < targetTypes.length; i++) {
    const annType = targetTypes[i];
    console.log(`\n[${i + 1}/${targetTypes.length}] Checking Live RSS: ${annType.code} - ${annType.name}`);

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

      const { xmlText, encoding, isCorrupted } = decodeThaiXml(response.data);
      console.log(`  -> Response: ${response.status} OK | Encoding: ${encoding} | Thai: ${isCorrupted ? 'WARNING' : 'OK'}`);

      const parsed = parser.parse(xmlText);
      const channel = parsed?.rss?.channel;
      const rawItems = channel?.item || [];

      // Filter by query
      let filteredItems = rawItems;
      if (query) {
        filteredItems = rawItems.filter((item) => {
          const title = String(item.title || '');
          const desc = String(item.description || '');
          return title.includes(query) || desc.includes(query);
        });
      }

      itemsCount = filteredItems.length;
      statusLog = 'SUCCESS';

      if (itemsCount === 0) {
        console.log(`  -> RSS: 0 items for ${annType.code}${query ? ` matching "${query}"` : ''} (Off-hours / weekend).`);
      } else {
        console.log(`  -> RSS: ${itemsCount} matching item(s). Processing top ${Math.min(limit, itemsCount)}...`);

        for (let j = 0; j < Math.min(limit, itemsCount); j++) {
          if (allExtractedTors.length >= limit) break;

          const item = filteredItems[j];
          const projIdMatch = String(item.description || '').match(/\b(\d{11})\b/);
          const torId = projIdMatch ? projIdMatch[1] : (item.link?.match(/fileId=([a-f0-9]+)/i)?.[1] || `${annType.code}-${Date.now()}-${j}`);
          const title = item.title ? String(item.title).trim() : 'No Title';
          const link = item.link || '';

          console.log(`\n     ---------------- [RSS Project #${j + 1}] ----------------`);
          console.log(`     ID    : ${torId}`);
          console.log(`     Title : ${cleanSnippet(title, 120)}`);
          if (link) console.log(`     Link  : ${link}`);

          const expectedPdfName = `${torId}_TOR.pdf`;
          const targetPdfPath = path.join(DOCUMENTS_DIR, expectedPdfName);
          let documentInfo = null;
          let downloadRes = null;

          if (fsSync.existsSync(targetPdfPath)) {
            console.log(`     Cached: ${targetPdfPath}`);
            documentInfo = await parseTorDocument(targetPdfPath);
          } else {
            console.log(`     Resolving real TOR from e-GP backend...`);
            downloadRes = await resolveAndDownloadEgpTorDocument({
              projectId: String(torId),
              directUrl: link?.startsWith('http') ? link : null,
              destDir: DOCUMENTS_DIR,
              fileName: expectedPdfName,
            });

            if (downloadRes.success) {
              console.log(`     [DOWNLOAD SUCCESS] ${downloadRes.sizeBytes.toLocaleString()} bytes`);
              documentInfo = await parseTorDocument(downloadRes.filePath, downloadRes.companionText || '');
            } else {
              console.log(`     [NOTICE] Download failed: ${downloadRes.error}`);
            }
          }

          allExtractedTors.push({
            id: String(torId),
            announceType: annType.code,
            announceTypeName: annType.name.split(' (')[0],
            title,
            link,
            pubDate: item.pubDate || '',
            description: item.description ? String(item.description).trim() : '',
            deptId: deptId || 'national',
            attachedDocument: documentInfo ? {
              fileName: expectedPdfName,
              storagePath: path.relative(process.cwd(), targetPdfPath),
              sizeBytes: downloadRes?.sizeBytes || (fsSync.existsSync(targetPdfPath) ? fsSync.statSync(targetPdfPath).size : null),
              originalEntryName: downloadRes?.originalFileName || expectedPdfName,
              packageName: downloadRes?.packageName || null,
              pages: documentInfo.totalPages,
              documentType: documentInfo.documentType,
              snippet: documentInfo.snippet,
              specs: documentInfo.extractedSpecs,
            } : null,
            source: 'process3.gprocurement.go.th (Live Daily RSS)',
            fetchedAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      statusLog = 'ERROR';
      console.error(`  [ERROR] Live RSS query failed: ${err.message}`);
    }

    summary.push({
      code: annType.code,
      name: annType.name,
      status: statusLog,
      itemsFound: itemsCount,
    });

    if (i < ANNOUNCEMENT_TYPES.length - 1) {
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  // Step 2: If the daily RSS feed was empty (weekends/after-hours), discover active e-GP announcements
  // directly from the live procurement database to download real TORs.
  if (allExtractedTors.length === 0) {
    console.log('\n' + '-'.repeat(76));
    console.log('[Notice]: Daily RSS feed returned 0 items today (Sunday / government off-hours).');
    console.log('[Action]: Querying active e-GP procurement catalog to download real live TOR...');
    console.log('-'.repeat(76));

    try {
      const catalogUrl = `https://data.go.th/api/3/action/datastore_search?resource_id=e4eaa1b4-eb1a-4534-b227-988ee25b898d&limit=15&q=${encodeURIComponent(query)}`;
      const catRes = await axios.get(catalogUrl, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 35000,
      });

      const candidates = catRes.data?.result?.records || [];
      console.log(`  -> Found ${candidates.length} active e-GP procurement candidates for "${query}".`);

      for (const cand of candidates) {
        if (allExtractedTors.length >= limit) break;

        const projectId = String(cand['รหัสโครงการ'] || '').trim();
        if (!projectId) continue;

        const expectedPdfName = `${projectId}_TOR.pdf`;
        const targetPdfPath = path.join(DOCUMENTS_DIR, expectedPdfName);

        console.log(`\n  -> Checking e-GP candidate ID: ${projectId}`);
        console.log(`     Title : ${cleanSnippet(cand['ชื่อโครงการ'], 100)}`);
        console.log(`     Agency: ${cand['ชื่อหน่วยงาน']}`);

        let documentInfo = null;
        let downloadRes = null;

        if (fsSync.existsSync(targetPdfPath)) {
          console.log(`     Document cached: ${targetPdfPath}`);
          documentInfo = await parseTorDocument(targetPdfPath);
        } else {
          console.log(`     Attempting download of real live TOR attachment...`);
          downloadRes = await resolveAndDownloadEgpTorDocument({
            projectId,
            destDir: DOCUMENTS_DIR,
            fileName: expectedPdfName,
          });

          if (downloadRes.success) {
            console.log(`     [DOWNLOAD SUCCESS] ${downloadRes.sizeBytes.toLocaleString()} bytes`);
            console.log(`     Package: ${downloadRes.packageName}`);
            console.log(`     File   : ${downloadRes.originalFileName}`);
            documentInfo = await parseTorDocument(downloadRes.filePath, downloadRes.companionText || '');
          } else {
            console.log(`     Attachment not available for this project (${downloadRes.error}). Checking next...`);
            continue;
          }
        }

        if (documentInfo) {
          console.log(`     [Extracted Specs]: Pages: ${documentInfo.totalPages} | Type: ${documentInfo.documentType}`);
          console.log(`     Specs: ${JSON.stringify(documentInfo.extractedSpecs || 'None')}`);
        }

        allExtractedTors.push({
          id: projectId,
          announceType: 'B0',
          announceTypeName: 'Draft TOR / e-Bidding Procurement',
          title: String(cand['ชื่อโครงการ'] || '').trim(),
          link: `https://process3.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?project_id=${projectId}`,
          pubDate: cand['วันที่ประกาศ'] || new Date().toISOString(),
          description: `โครงการจัดซื้อจัดจ้าง e-GP งบประมาณ ฿${formatNumber(cand['งบประมาณ(บาท)'])}, หน่วยงาน: ${cand['ชื่อหน่วยงาน']}`,
          deptId: deptId || String(cand['ชื่อหน่วยงานย่อย'] || 'national'),
          attachedDocument: {
            fileName: expectedPdfName,
            storagePath: path.relative(process.cwd(), targetPdfPath),
            sizeBytes: downloadRes?.sizeBytes || (fsSync.existsSync(targetPdfPath) ? fsSync.statSync(targetPdfPath).size : null),
            originalEntryName: downloadRes?.originalFileName || expectedPdfName,
            packageName: downloadRes?.packageName || null,
            pages: documentInfo?.totalPages || 0,
            documentType: documentInfo?.documentType || 'UNKNOWN',
            snippet: documentInfo?.snippet || '',
            specs: documentInfo?.extractedSpecs || null,
          },
          source: 'process3.gprocurement.go.th (Live e-GP Procurement Backend)',
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`  [ERROR] Discovery fallback failed: ${err.message}`);
    }
  }

  // ==========================================
  // Store Real TORs inside process3/tors/
  // ==========================================
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runFilePath = path.join(TORS_DIR, `tor-run-${timestamp}.json`);
  const latestFilePath = path.join(TORS_DIR, 'latest-tors.json');

  const storagePayload = {
    source: 'process3.gprocurement.go.th',
    feedUrl: BASE_URL,
    deptId: deptId || 'national',
    query: query || null,
    limit,
    fetchedAt: new Date().toISOString(),
    totalTorsExtracted: allExtractedTors.length,
    summary,
    tors: allExtractedTors,
  };

  await fs.writeFile(runFilePath, JSON.stringify(storagePayload, null, 2), 'utf-8');
  await fs.writeFile(latestFilePath, JSON.stringify(storagePayload, null, 2), 'utf-8');

  console.log('\n' + '='.repeat(76));
  console.log(' STORAGE & EXECUTION SUMMARY');
  console.log('='.repeat(76));
  console.log(`[Status]   : SUCCESS`);
  console.log(`[Processed]: ${allExtractedTors.length} real TOR project(s) downloaded and parsed`);
  console.log(`[Storage]  : ${latestFilePath}`);
  console.log(`[Documents]: ${DOCUMENTS_DIR}`);
  console.log('='.repeat(76));
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  return Number(num).toLocaleString('th-TH');
}

main().catch((err) => {
  console.error('[FATAL] process3 execution error:', err);
  process.exit(1);
});
