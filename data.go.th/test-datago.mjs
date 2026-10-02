/**
 * data.go.th/test-datago.mjs
 *
 * Standalone test & automated TOR extraction script for Open Government Data CKAN REST API (data.go.th).
 *
 * Automated 1-by-1 Pipeline (Test Size Scale):
 * 1. Queries live project-level procurement dataset (egp-contact-2568) with keyword filtering (--q).
 * 2. Picks real projects and checks e-GP document services for official TOR attachments.
 * 3. Downloads real live TOR document into data.go.th/tors/documents/<projectId>_TOR.pdf.
 * 4. Parses the PDF with pdf-parse to extract pages, document type (scanned vs digital), and technical specs.
 * 5. Persists enriched records into data.go.th/tors/latest-tors.json.
 *
 * Strictly NO MOCKS - 100% Real Live Government Data & Documents.
 *
 * Usage:
 *   node data.go.th/test-datago.mjs
 *   node data.go.th/test-datago.mjs --q คอมพิวเตอร์ --limit 1
 *   node data.go.th/test-datago.mjs --q คลาวด์ --limit 1
 */

import axios from 'axios';
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
const BASE_URL = 'https://data.go.th/api/3/action';
const DEFAULT_RESOURCE_ID = 'e4eaa1b4-eb1a-4534-b227-988ee25b898d'; // egp-contact-2568
const TORS_DIR = path.join(__dirname, 'tors');
const DOCUMENTS_DIR = path.join(TORS_DIR, 'documents');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 35000;

// ==========================================
// Helper Utilities
// ==========================================

function parseCliArgs() {
  const args = process.argv.slice(2);
  let limit = 1; // Strict 1-by-1 default for test-size storage
  let resourceId = DEFAULT_RESOURCE_ID;
  let query = 'คอมพิวเตอร์'; // Default IT search keyword

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10) || 1;
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < args.length) {
      limit = parseInt(args[++i], 10) || 1;
    } else if (arg.startsWith('--resourceId=')) {
      resourceId = arg.split('=')[1];
    } else if (arg === '--resourceId' && i + 1 < args.length) {
      resourceId = args[++i];
    } else if (arg.startsWith('--q=')) {
      query = arg.split('=')[1];
    } else if ((arg === '--q' || arg === '-q') && i + 1 < args.length) {
      query = args[++i];
    }
  }

  return { limit, resourceId, query };
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  return Number(num).toLocaleString('th-TH');
}

// ==========================================
// Main Workflow
// ==========================================

async function main() {
  const { limit, resourceId, query } = parseCliArgs();

  console.log('='.repeat(76));
  console.log(' GIPDP - data.go.th Automated 1-by-1 TOR Downloader & Parser');
  console.log('='.repeat(76));
  console.log(`Action Endpoint : ${BASE_URL}/datastore_search`);
  console.log(`Target Dataset  : egp-contact-2568 (Live e-GP Procurement Projects 2568)`);
  console.log(`Query Filter    : "${query}"`);
  console.log(`Target Limit    : ${limit} TOR(s) at a time (Test Size Guardrail)`);
  console.log(`Document Target : ${DOCUMENTS_DIR}`);
  console.log('='.repeat(76));

  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });

  // Query up to 20 candidate projects from data.go.th to find ones with active TOR attachments
  const fetchLimit = Math.max(limit * 5, 15);
  const urlObj = new URL(`${BASE_URL}/datastore_search`);
  urlObj.searchParams.set('resource_id', resourceId);
  urlObj.searchParams.set('limit', String(fetchLimit));
  if (query) {
    urlObj.searchParams.set('q', query);
  }

  const datastoreUrl = urlObj.toString();
  console.log(`  -> Querying Live Catalog: ${datastoreUrl}`);

  let payload = null;
  try {
    const response = await axios.get(datastoreUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    payload = response.data;
    if (!payload?.success) {
      throw new Error(`data.go.th API query failed: ${JSON.stringify(payload?.error || 'Unknown error')}`);
    }
  } catch (err) {
    console.error(`  [ERROR] data.go.th API query failed: ${err.message}`);
    process.exit(1);
  }

  const result = payload.result || {};
  const rawRecords = result.records || [];

  console.log(`  -> Total Matching : ${result.total !== undefined ? result.total.toLocaleString('th-TH') : 'N/A'} projects`);
  console.log(`  -> Candidate Pool : ${rawRecords.length} project(s) inspected for live TOR attachments`);

  const processedTors = [];

  for (let i = 0; i < rawRecords.length; i++) {
    if (processedTors.length >= limit) {
      break;
    }

    const rec = rawRecords[i];
    const projectId = String(rec['รหัสโครงการ'] || '').trim();
    if (!projectId) continue;

    const budget = Number(rec['งบประมาณ(บาท)']) || 0;
    const medianPrice = Number(rec['ราคากลาง(บาท)']) || 0;
    const agreedPrice = Number(rec['ราคาตกลงซื้อ/จ้าง']) || 0;

    // Detect if column shift exists in this record
    const hasColumnShift = /^\d{13}$/.test(String(rec['พิกัดของโครงการ'] || ''));
    const winnerName = hasColumnShift 
      ? String(rec['ละติจูดโครงการ'] || '').trim() 
      : String(rec['ชื่อผู้ชนะ'] || '').trim();
    const winnerTaxId = hasColumnShift 
      ? String(rec['พิกัดของโครงการ'] || '').trim() 
      : String(rec['เลขนิติบุคคล'] || '').trim();
    const contractNo = hasColumnShift 
      ? String(rec['ลองจิจูดโครงการ'] || '').trim() 
      : String(rec['เลขที่สัญญา'] || '').trim();
    const contractSignDate = hasColumnShift ? (rec['เลขนิติบุคคล'] || null) : (rec['วันที่ลงนามสัญญา'] || null);
    const contractEndDate = hasColumnShift ? (rec['ชื่อผู้ชนะ'] || null) : (rec['วันที่สิ้นสุดสัญญา'] || null);
    const projectStatus = hasColumnShift 
      ? String(rec['วันที่ลงนามสัญญา'] || '').trim() 
      : String(rec['สถานะโครงการ'] || '').trim();

    const egpProjectUrl = `https://process3.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?project_id=${projectId}`;

    console.log(`\n----------------------------------------------------------------------------`);
    console.log(`[Candidate ${i + 1}/${rawRecords.length}] Project ID: ${projectId}`);
    console.log(`Title  : ${rec['ชื่อโครงการ']}`);
    console.log(`Agency : ${rec['ชื่อหน่วยงาน']} (${rec['จังหวัด'] || 'N/A'})`);
    console.log(`Budget : ฿${formatNumber(budget)}`);

    // ==========================================
    // Real Live TOR Download Step
    // ==========================================
    const expectedPdfFileName = `${projectId}_TOR.pdf`;
    const targetPdfPath = path.join(DOCUMENTS_DIR, expectedPdfFileName);

    let documentInfo = null;
    let downloadResult = null;

    if (fsSync.existsSync(targetPdfPath)) {
      console.log(`  -> Document already cached on disk: ${targetPdfPath}`);
      documentInfo = await parseTorDocument(targetPdfPath);
    } else {
      console.log(`  -> Resolving real live TOR from e-GP backend for project ${projectId}...`);
      downloadResult = await resolveAndDownloadEgpTorDocument({
        projectId,
        destDir: DOCUMENTS_DIR,
        fileName: expectedPdfFileName,
      });

      if (downloadResult.success) {
        console.log(`  -> [DOWNLOAD SUCCESS] ${downloadResult.sizeBytes.toLocaleString()} bytes`);
        console.log(`     Original Name: ${downloadResult.originalFileName}`);
        console.log(`     Saved To     : ${downloadResult.filePath}`);
        documentInfo = await parseTorDocument(downloadResult.filePath, downloadResult.companionText || '');
      } else {
        console.log(`  -> Notice: ${downloadResult.error}`);
        console.log(`  -> Skipping candidate to find project with attached document...`);
        continue;
      }
    }

    if (documentInfo) {
      console.log(`  -> [Document Specifications]:`);
      console.log(`     Pages   : ${documentInfo.totalPages}`);
      console.log(`     Type    : ${documentInfo.documentType}`);
      console.log(`     Specs   : ${JSON.stringify(documentInfo.extractedSpecs || 'None detected')}`);
      console.log(`     Snippet : ${documentInfo.snippet.slice(0, 150)}...`);
    }

    processedTors.push({
      projectId,
      projectName: String(rec['ชื่อโครงการ'] || '').trim(),
      projectType: String(rec['ชื่อประเภทโครงการ'] || '').trim(),
      fiscalYear: rec['ปีงบประมาณ'] || 2568,
      agencyName: String(rec['ชื่อหน่วยงาน'] || '').trim(),
      subAgencyName: String(rec['ชื่อหน่วยงานย่อย'] || '').trim(),
      province: String(rec['จังหวัด'] || '').trim(),
      district: String(rec['เขต/อำเภอ'] || '').trim(),
      procurementMethod: String(rec['กลุ่มวิธีจัดซื้อฯ'] || rec['วิธีจัดซื้อฯ'] || '').trim(),
      announceDate: rec['วันที่ประกาศ'] || null,
      transactionDate: rec['วันที่เกิดรายการ'] || null,
      budgetTHB: budget,
      medianPriceTHB: medianPrice,
      agreedPriceTHB: agreedPrice,
      winnerName: winnerName || null,
      winnerTaxId: winnerTaxId || null,
      contractNo: contractNo || null,
      contractSignDate: contractSignDate || null,
      contractEndDate: contractEndDate || null,
      projectStatus: projectStatus || 'N/A',
      egpProjectUrl,
      attachedDocument: {
        fileName: expectedPdfFileName,
        storagePath: path.relative(process.cwd(), targetPdfPath),
        sizeBytes: downloadResult?.sizeBytes || (fsSync.existsSync(targetPdfPath) ? fsSync.statSync(targetPdfPath).size : null),
        originalEntryName: downloadResult?.originalFileName || expectedPdfFileName,
        packageName: downloadResult?.packageName || null,
        pages: documentInfo?.totalPages || 0,
        documentType: documentInfo?.documentType || 'UNKNOWN',
        snippet: documentInfo?.snippet || '',
        specs: documentInfo?.extractedSpecs || null,
      },
      source: 'data.go.th (egp-contact-2568)',
      fetchedAt: new Date().toISOString(),
    });
  }

  // ==========================================
  // Store Real Rich TORs inside data.go.th/tors/
  // ==========================================
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runFilePath = path.join(TORS_DIR, `tor-run-${timestamp}.json`);
  const latestFilePath = path.join(TORS_DIR, 'latest-tors.json');

  const storagePayload = {
    source: 'data.go.th',
    dataset: 'egp-contact-2568 (ข้อมูลโครงการจัดซื้อจัดจ้างจากระบบ e-GP ปีงบประมาณ 2568)',
    query,
    limit,
    totalMatchingProjects: result.total || null,
    retrievedCount: processedTors.length,
    fetchedAt: new Date().toISOString(),
    tors: processedTors,
  };

  await fs.writeFile(runFilePath, JSON.stringify(storagePayload, null, 2), 'utf-8');
  await fs.writeFile(latestFilePath, JSON.stringify(storagePayload, null, 2), 'utf-8');

  console.log('\n' + '='.repeat(76));
  console.log(' STORAGE & EXECUTION SUMMARY');
  console.log('='.repeat(76));
  console.log(`[Status]   : SUCCESS`);
  console.log(`[Processed]: ${processedTors.length} real TOR project(s) downloaded and parsed`);
  console.log(`[Storage]  : ${latestFilePath}`);
  console.log(`[Documents]: ${DOCUMENTS_DIR}`);
  console.log('='.repeat(76));
}

main().catch((err) => {
  console.error('[FATAL] Execution error:', err);
  process.exit(1);
});
