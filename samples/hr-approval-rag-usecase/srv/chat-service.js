'use strict';

const cds = require('@sap/cds');

const sf_connection_util = require('./sf-connection-util');
const { normalizeInvoiceNumber, extractInvoiceNumberFromText } = require('./chat-utils');

const PROJECT_NAME = 'HR_APPROVAL_RAG_USECASE';

// ---- RAG CONFIG (unchanged) ----
const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

// ---------------- SYSTEM PROMPT (classifier) ----------------
const systemPrompt = `Your task is to classify the user question into either of the four categories: invoice-request-query, download-invoice, customer-analytics or generic-query

 If the user wants to know the invoice related details with company code, invoice number, posting date ,Customer return the response as json
 with the following format:
 {
    "category" : "invoice-request-query"
    "query: "InvoiceNo='AccountingDocument'&InvoiceType='FI'&FiscalYear='year of invoice posting date'&DateFrom='fromDate'&DateTo='toDate'&SalesOrder=''&CompanyCode='companyCode'"
 }

 If the user wants to download, print or get a link for an invoice provide the response as json
 with the following format:
 {
    "category" : "download-invoice",
    "invoiceNumber" : "invoice digits provided by the user (never leave empty when digits are present)"
 }

 If the user wants to retrieve a Statement of Account (SOA) for a customer provide the response as json
 with the following format:
 {
    "category" : "soa-request",
    "companyCode" : "company code provided by the user",
    "customerCode" : "customer code provided by the user",
    "asOfDate" : "as-of date provided by the user in any recognizable date format"
 }

 For all other queries, return the response as json as follows
 {
    "category" : "generic-query"
 }

 If the user is asking about customer analytics, historical customer performance, payment history, or requests insight such as best or worst customers, return the response as json
 with the following format:
 {
    "category" : "customer-analytics",
    "analyticsQuery": "<restated customer analytics question from the user>"
 }

Rules:

1. If the user does not provide any invoice related information consider it as a generic category.
2. If the category of the user question is "invoice-request-query",
a. if the user does not input exact dates and only mentions year, fill the dates as "[start date of the year]-[end date of the year]".
b. if the user does not input exact dates and only mentions months, fill the dates as "[start date of the month]-[end date of the month]".
c. if the user does not input exact dates and only mentions week, fill the dates as "[start date of the week]-[end date of the week]".

3. If the category of the user question is "download-invoice",
a. always include the invoice number digits supplied by the user. You may add leading zeros to make it ten digits, but never omit the digits entirely.
b. if the user input includes any digits that could represent an invoice number, return those digits (even if fewer than ten) so the service can normalize them; only respond with an empty invoiceNumber when no digits are present.
c. Treat common misspellings of the word invoice (for example: inovice, invioce, invice) as referring to invoices when interpreting the user request.

4. If the category of the user question is "soa-request",
a. if the user does not provide the company code, customer code, or as-of date, set the respective value as an empty string in the response JSON.
b. Capture the as-of date exactly as provided by the user.

EXAMPLES:

EXAMPLE1:

user input: What kind of invoice details can provide ?
response:  {
    "category" : "generic-query"
 }

EXAMPLE2:

user input: Can get invoices between January 1 to January 10 and company code 898?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='10.01.2024'&SalesOrder=''&CompanyCode='898'"
}

EXAMPLE3:

user input:  Can I get invoices posted in in March 2024for company code 801 ?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.03.2024'&DateTo='31.03.2024'&SalesOrder=''&CompanyCode='801'"
 }

EXAMPLE4:

user input:  Can I get invoices posted or created this week ?

If user provides company code as 803 then
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='17.04.2024'&DateTo='24.04.2024'&SalesOrder=''&CompanyCode='803'"
 }

Rules: 
1. Ask follow up questions for company code  

 EXAMPLE5:

 user input:  Can I get invoices posted or created this year under 808 comapny code?
 response:  {
     "category" : "invoice-request-query"
     "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='31.12.2024'&SalesOrder=''&CompanyCode='808'"
    }

Rules: 
If the invoice search list {} or empty or undefined , then instruct the user to provide revised search criteria.

EXAMPLE6:

user input:  Can I get invoices posted or created last year ?
ask for follow up question on company code and feed user input company code in query.

Rules: 
1. Ask follow up questions for company code  
if the user proivdes 898 

response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2023'&DateFrom='01.01.2023'&DateTo='31.12.2023'&SalesOrder=''&CompanyCode='898'"
}

EXAMPLE8:

user input:  Can I get invoice details for invoice 248013075?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo='0248013075'&InvoiceType='FI'&FiscalYear='2024'&DateFrom=''&DateTo=''&SalesOrder=''&CompanyCode='801'"
}
Rules: 
1. Ask follow up questions if you need additional  
2. make InvoiceNo as 10 digit example in this case 0248013075 
3. in this invoiceNo , year will be 24 ( first two chars) which is 2024, company code wil be 801 (char 3 + char 4 +char 5) 

EXAMPLE9:
user input: Can get invoice search policy ?
response: {
    "category" : "generic-query"
 }

EXAMPLE10:

user input: Please share the download link for invoice 248013029.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : "0248013029"
}

EXAMPLE10A:

user input: Download invoice 123425231.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : "123425231"
}

EXAMPLE11:

user input: I need to download the invoice copy.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : ""
}

EXAMPLE12:

user input: Who has been our best customer in terms of revenue over the last quarter?
response:  {
    "category" : "customer-analytics",
    "analyticsQuery" : "Who has been our best customer in terms of revenue over the last quarter?"
 }

EXAMPLE13:

user input: Show me the payment history details for our top five customers.
response:  {
    "category" : "customer-analytics",
    "analyticsQuery" : "Show me the payment history details for our top five customers."
 }

EXAMPLE14:

user input: Please share the SOA for customer 100252 in company code 808 as of 2nd May 2017.
response:  {
    "category" : "soa-request",
    "companyCode" : "808",
    "customerCode" : "100252",
    "asOfDate" : "2nd May 2017"
 }
`;

// ---------------- CATEGORY PROMPTS (base system prompts) ----------------
const hrRequestPrompt = `You are a chatbot. Answer the user question based on the following information

1. Invoice search policy , delimited by triple backticks.  
2. If there are any invoice specific invoice detetais guidelies in the Invoice Policy , Consider the invoice details and check the invoice search list .

Invoice search list details 

{ 

Example object for invoice details : it should return in ths example format only. rules
remove any special symbols (*,_ etc) generate nice specified format only.
Invoice 1:
Invoice Number: "AccountingDocument" // 248013000
Document Date: "DocumentDate" // 02.01.2024
Posting Date: "PostingDate" // 02.01.2024
Customer: "Customer" // A200007-00
Currency: "Currency"//SGD
Reference Document: "ReferenceDocument"//DA8012312B001176 
}
Invoice 2:
Invoice Number: 248013000
Document Date: 02.01.2024
Posting Date: 02.01.2024
Customer: A200007-00
Currency: SGD
Reference Document: DA8012312B001176 
}
...

Rules:  
1. Ask follow up questions if you need additional information from user to answer the question. 
2. If the invoice search list {} or empty or undefined , then instruct the user to provide optimized search criteria.
3. Note that invoice and AccountDocument are alias names , always return response as invoice 
4. Be more formal in your response. 
5. Keep the answers concise. 
6. Alwasy return some response with proper instructions to user. 
`;

const genericRequestPrompt =
  'You are a chatbot. Answer the user question based only on the context, delimited by triple backticks.';

const downloadRequestPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to support invoice download requests.
Context includes:
1. invoiceNumber
2. downloadUrl
3. EStatus
4. EStatusMessage
Rules:
1. If invoiceNumber is empty ask the user to kindly provide the invoice number required for the download.
2. If EStatus equals 'E', respond using exactly the text in EStatusMessage with no additional commentary.
3. When EStatus equals 'S' and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:
<href>{invoiceNumber}</href>

<href-value>{downloadUrl}</href-value>
4. Keep the tone formal and concise.`;

const soaRequestPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to support Statement of Account (SOA) requests.
Context includes:
1. companyCode
2. customerCode
3. asOfDate
4. formattedDate
5. downloadUrl
6. EStatus
7. EStatusMessage
Rules:
1. If any of companyCode, customerCode, or formattedDate is empty, politely ask the user to provide the missing information.
2. If EStatus equals 'E', respond using exactly the text in EStatusMessage with no additional commentary.
3. When all required details are present, EStatus equals 'S', and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:
<href>StatementOfAccount</href>

<href-value>{downloadUrl}</href-value>
4. Keep the tone formal and concise.`;

const customerAnalyticsPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to answer customer analytics questions.
Context includes:
1. The original customer analytics question.
2. Customer analytics data retrieved from the Datasphere service.
Rules:
1. Summarize the returned analytics data in a clear and concise manner.
2. If the data is empty, inform the user that no customer analytics data is available and suggest refining the question.
3. Keep the tone formal and professional.`;

// Base prompts mapping (category → base system prompt)
const basePrompts = {
  'invoice-request-query': hrRequestPrompt,
  'generic-query': genericRequestPrompt,
  'download-invoice': downloadRequestPrompt,
  'customer-analytics': customerAnalyticsPrompt,
  'soa-request': soaRequestPrompt
};

// -----------------------------------------------------------------------------
// Intent Lock / Follow-up Router helpers (NEW)
// -----------------------------------------------------------------------------
function detectInvoiceFollowUpDelta(text = '') {
  const t = String(text || '').toLowerCase().trim();

  // pagination / navigation
  if (/^(next|more|show more|continue|next page)$/i.test(t)) return { type: 'next' };
  if (/^(prev|previous|back)$/i.test(t)) return { type: 'prev' };

  // open / all / cleared
  if (/(open items only|open only|only open|show open|open invoices)/i.test(t)) return { type: 'openOnly' };
  if (/(all items|all invoices|show all|include cleared|open and cleared)/i.test(t)) return { type: 'allItems' };
  if (/(cleared only|only cleared|show cleared)/i.test(t)) return { type: 'clearedOnly' }; // optional

  // reset
  if (/(start over|reset|clear filters)/i.test(t)) return { type: 'reset' };

  // refine hints (often follow-ups)
  if (/(company code|cc\b|fiscal year|fy\b|from|to|between|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) {
    return { type: 'refine' };
  }

  // invoice number typed alone
  if (/^\d{6,12}$/.test(t)) return { type: 'invoiceNumberOnly' };

  return null;
}

/**
 * Decide whether we should FORCE route to invoice handler
 * even if classifier returns generic-query.
 */
function shouldRouteToInvoiceFollowUp({ existingState, user_query, classifiedCategory }) {
  if (!existingState) return false;

  // must be in an active invoice flow
  if (existingState.activeIntent !== 'INVOICE' || existingState.intentLocked !== true) return false;

  // if user explicitly reset -> allow invoice handler to clear session
  const delta = detectInvoiceFollowUpDelta(user_query);
  if (delta) return true;

  // If classifier already says invoice, fine (we will route anyway)
  if (classifiedCategory === 'invoice-request-query') return true;

  // Generic but short follow-up phrases should still stay in invoice flow
  const t = String(user_query || '').trim();
  if (t.length <= 25) return true; // "open only", "next", "801", etc.

  return false;
}

// -----------------------------------------------------------------------------
// Option A: deterministic invoice list workflow with session state
// -----------------------------------------------------------------------------
const PAGE_SIZE = 5;
const REFINE_THRESHOLD = 50;

// In-memory session store (per app instance). If you need persistence across restarts,
// later you can store this in DB keyed by conversationId.
const invoiceSessionState = new Map(); // conversationId -> state
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 mins

function nowMs() {
  return Date.now();
}

function cleanupInvoiceSessions() {
  const t = nowMs();
  for (const [cid, st] of invoiceSessionState.entries()) {
    if (!st?.lastTouched || (t - st.lastTouched) > SESSION_TTL_MS) {
      invoiceSessionState.delete(cid);
    }
  }
}

function userWantsNextPage(text) {
  const q = (text || '').toLowerCase().trim();
  return (
    q === 'next' ||
    q === 'more' ||
    q.includes('next ') ||
    q.includes('show next') ||
    q.includes('next page') ||
    q.includes('continue')
  );
}

function userWantsReset(text) {
  const q = (text || '').toLowerCase();
  return q.includes('start over') || q.includes('reset') || q.includes('clear filters');
}

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? `0${s}` : s;
}

// Accepts: YYYYMMDD, YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY, Date string
// Returns: DD.MM.YYYY (for UI display)
function formatDateForDisplay(val) {
  if (!val && val !== 0) return '';
  const s = String(val).trim();
  if (!s) return '';

  // YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    const yyyy = s.slice(0, 4);
    const mm = s.slice(4, 6);
    const dd = s.slice(6, 8);
    return `${dd}.${mm}.${yyyy}`;
  }

  // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(s)) {
    const [yyyy, mm, dd] = s.split(/[-/.]/);
    return `${dd}.${mm}.${yyyy}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split(/[-/.]/);
    return `${dd}.${mm}.${yyyy}`;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  return s;
}

// Returns: DD.MM.YYYY (for API query format used in your classifier examples)
function normalizeDateToDdMmYyyy(val) {
  return formatDateForDisplay(val);
}

function toNumberOrNull(x) {
  const n = parseInt(String(x), 10);
  return Number.isFinite(n) ? n : null;
}

// Extract FY + Company from invoice number pattern you shared
function deriveFromInvoiceNo(invoiceNoRaw) {
  const digits = (invoiceNoRaw || '').toString().trim().replace(/\D/g, '');
  if (!digits) return { fiscalYear: '', companyCode: '', accountingDocument: '' };

  if (digits.length === 9) {
    const fy = `20${digits.slice(0, 2)}`;
    const cc = digits.slice(2, 5);
    return { fiscalYear: fy, companyCode: cc, accountingDocument: digits };
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    const fy = `20${digits.slice(1, 3)}`;
    const cc = digits.slice(3, 6);
    const doc = digits.replace(/^0+/, '') || digits;
    return { fiscalYear: fy, companyCode: cc, accountingDocument: doc };
  }

  return { fiscalYear: '', companyCode: '', accountingDocument: digits };
}

function buildLegacyFilterQueryFromState(st) {
  const invNo = st.accountingDocument ? String(st.accountingDocument) : '';
  const fy = st.fiscalYear ? String(st.fiscalYear) : '';
  const df = st.dateFrom ? String(st.dateFrom) : '';
  const dt = st.dateTo ? String(st.dateTo) : '';
  const cc = st.companyCode ? String(st.companyCode) : '';
  const open = st.openItem === 'X' ? "OpenItem='X'&" : '';

  return `InvoiceNo='${invNo}'&InvoiceType='FI'&FiscalYear='${fy}'&DateFrom='${df}'&DateTo='${dt}'&SalesOrder=''&${open}CompanyCode='${cc}'`;
}

function summarizeStateForUser(st) {
  const parts = [];
  if (st.companyCode) parts.push(`Company Code ${st.companyCode}`);
  if (st.fiscalYear) parts.push(`Fiscal Year ${st.fiscalYear}`);
  if (st.dateFrom && st.dateTo) parts.push(`Date ${st.dateFrom} to ${st.dateTo}`);
  if (st.openItem === 'X') parts.push('OPEN items only');
  return parts.length ? parts.join(', ') : 'no filters';
}

function formatAmount(val) {
  if (val === null || val === undefined || val === '') return '';
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Make invoice block similar to your screenshot
function formatInvoiceBlock(inv) {
  const invoiceNumber =
    inv.InvoiceNumber || inv.invoiceNumber || inv.AccountingDocument || inv.accountingDocument || '';
  const documentDate = formatDateForDisplay(inv.DocumentDate || inv.documentDate || inv.BLDAT || inv.bldat || '');
  const postingDate = formatDateForDisplay(inv.PostingDate || inv.postingDate || inv.BUDAT || inv.budat || '');
  const invoiceDate = formatDateForDisplay(inv.InvoiceDate || inv.invoiceDate || inv.Invoice_Date || '');
  const dueDate = formatDateForDisplay(inv.DueDate || inv.dueDate || inv.NETDT || inv.netdt || '');
  const customer = inv.Customer || inv.customerName || inv.CustomerName || inv.customer || '';
  const currency = inv.Currency || inv.currency || inv.WAERS || inv.waers || '';
  const invoiceAmount = formatAmount(inv.InvoiceAmount || inv.invoiceAmount || inv.Amount || inv.amount || inv.WRBTR || inv.wrbtr || '');
  const openAmount = formatAmount(inv.OpenAmount || inv.openAmount || inv.Open_Amt || inv.openAmt || '');
  const clearedAmount = formatAmount(inv.ClearedAmount || inv.clearedAmount || inv.Cleared_Amt || inv.clearedAmt || '');
  const status = inv.InvoiceStatus || inv.invoiceStatus || inv.Status || inv.clearStatus || '';
  const reference = inv.ReferenceDocument || inv.referenceDocument || inv.XBLNR || inv.xblnr || inv.Reference || '';

  const lines = [];
  if (invoiceNumber) lines.push(`Invoice Number: ${invoiceNumber}`);
  if (documentDate) lines.push(`Document Date: ${documentDate}`);
  if (postingDate) lines.push(`Posting Date: ${postingDate}`);
  if (invoiceDate) lines.push(`Invoice Date: ${invoiceDate}`);
  if (dueDate) lines.push(`Due Date: ${dueDate}`);
  if (customer) lines.push(`Customer: ${customer}`);
  if (currency) lines.push(`Currency: ${currency}`);
  if (invoiceAmount) lines.push(`Invoice Amount: ${invoiceAmount}`);
  if (openAmount) lines.push(`Open Amount: ${openAmount}`);
  if (clearedAmount) lines.push(`Cleared Amount: ${clearedAmount}`);
  if (status) lines.push(`Invoice Status: ${status}`);
  if (reference) lines.push(`Reference Document: ${reference}`);

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// LOCAL intent + deltas extraction (NO AI engine call)
// Returns: { intent: 'INVOICE'|'SOA'|'DOWNLOAD'|'UNKNOWN', deltas: {...} }
// -----------------------------------------------------------------------------
async function extractIntentAndDeltas(req, { userText, currentState }) {
  const text = (userText || '').toString().trim();
  const state = currentState || {};

  const monthMap = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12'
  };

  const pad2local = (n) => String(n).padStart(2, '0');

  const isNext =
    /\b(next|more|show\s*more|next\s*\d+)\b/i.test(text) ||
    /\bcontinue\b/i.test(text);

  const wantsOpen =
    /\bopen\s*items?\b/i.test(text) ||
    /\bonly\s+open\b/i.test(text);

  const wantsAll =
    /\ball\b/i.test(text) ||
    /\binclude\s+cleared\b/i.test(text) ||
    /\bopen\s+and\s+cleared\b/i.test(text);

  const intent =
    /\bstatement\s+of\s+account\b|\bsoa\b/i.test(text) ? 'SOA' :
    /\bdownload\b|\bpdf\b/i.test(text) ? 'DOWNLOAD' :
    /\binvoice\b|\binvoices\b/i.test(text) || wantsOpen ? 'INVOICE' :
    'UNKNOWN';

  // company code
  let companyCode = '';
  const ccMatch =
    text.match(/\bcompany\s*code\s*[:=]?\s*(\d{3})\b/i) ||
    text.match(/\bcc\s*[:=]?\s*(\d{3})\b/i);
  if (ccMatch) companyCode = ccMatch[1];

  // fiscal year
  let fiscalYear = '';
  const fyMatch =
    text.match(/\b(fy|fiscal\s*year)\s*[:=]?\s*(20\d{2})\b/i) ||
    text.match(/\b(20\d{2})\b/);
  if (fyMatch) fiscalYear = fyMatch[2] || fyMatch[1] || '';

  // date range
  let dateFrom = '';
  let dateTo = '';

  // 01–15 Jan 2024
  const range1 = text.match(
    /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s*(20\d{2})\b/i
  );
  if (range1) {
    const d1 = pad2local(range1[1]);
    const d2 = pad2local(range1[2]);
    const mm = monthMap[range1[3].toLowerCase()];
    const yyyy = range1[4];
    dateFrom = `${d1}.${mm}.${yyyy}`;
    dateTo = `${d2}.${mm}.${yyyy}`;
    fiscalYear = fiscalYear || yyyy;
  }

  // 01–15 Jan (infer year from state or current year)
  if (!dateFrom || !dateTo) {
    const range1NoYear = text.match(
      /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i
    );
    if (range1NoYear) {
      const d1 = pad2local(range1NoYear[1]);
      const d2 = pad2local(range1NoYear[2]);
      const mm = monthMap[range1NoYear[3].toLowerCase()];
      const yyyy = fiscalYear || state?.fiscalYear || String(new Date().getFullYear());
      dateFrom = `${d1}.${mm}.${yyyy}`;
      dateTo = `${d2}.${mm}.${yyyy}`;
      fiscalYear = fiscalYear || yyyy;
    }
  }

  // 01.01.2024 to 15.01.2024
  if (!dateFrom || !dateTo) {
    const range2 = text.match(
      /\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\s*(to|[-–])\s*(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/i
    );
    if (range2) {
      const d1 = pad2local(range2[1]);
      const m1 = pad2local(range2[2]);
      const y1 = range2[3];
      const d2 = pad2local(range2[5]);
      const m2 = pad2local(range2[6]);
      const y2 = range2[7];
      dateFrom = `${d1}.${m1}.${y1}`;
      dateTo = `${d2}.${m2}.${y2}`;
      fiscalYear = fiscalYear || y1;
    }
  }

  // January 2024
  if (!dateFrom || !dateTo) {
    const m = text.match(
      /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s*(20\d{2})\b/i
    );
    if (m) {
      const mm = monthMap[m[1].toLowerCase()];
      const yyyy = m[2];
      const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
      dateFrom = `01.${mm}.${yyyy}`;
      dateTo = `${pad2local(lastDay)}.${mm}.${yyyy}`;
      fiscalYear = fiscalYear || yyyy;
    }
  }

  // open item merge
  let openItem = state?.openItem || '';
  if (wantsOpen) openItem = 'X';
  if (wantsAll) openItem = '';

  const deltas = {
    companyCode: companyCode || state?.companyCode || '',
    fiscalYear: fiscalYear || state?.fiscalYear || '',
    dateFrom: dateFrom || state?.dateFrom || '',
    dateTo: dateTo || state?.dateTo || '',
    openItem,
    isNext: !!isNext
  };

  console.log('STE-GPT-CTX-DELTAS', {
    intent,
    deltas,
    sample: text.slice(0, 140)
  });

  return { intent, deltas };
}

// Helper: seed state from classifier JSON (NEW fix)
function seedInvoiceStateFromDetermination(state, determinationJson, user_query) {
  const dj = determinationJson || {};
  const uq = (user_query || '').toString();

  // companyCode
  if (!state.companyCode && dj.companyCode) state.companyCode = String(dj.companyCode).trim();

  // fiscalYear (if classifier provides)
  if (!state.fiscalYear && (dj.fiscalYear || dj.FiscalYear)) state.fiscalYear = String(dj.fiscalYear || dj.FiscalYear).trim();

  // openItem (if classifier provides)
  if (dj.openItem === 'X' || dj.openItem === '') state.openItem = dj.openItem;

  // dateRange patterns from classifier (ex: "January 2024")
  if ((!state.dateFrom || !state.dateTo) && dj.dateRange) {
    const s = String(dj.dateRange).trim();
    // reuse extractor on dateRange text so it becomes dateFrom/dateTo
    // (no async required here, quick parse using the same extractor logic pattern)
    const m = s.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s*(20\d{2})\b/i);
    if (m) {
      const monthMap = {
        jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
        apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
        aug: '08', august: '08', sep: '09', sept: '09', september: '09', oct: '10', october: '10',
        nov: '11', november: '11', dec: '12', december: '12'
      };
      const mm = monthMap[m[1].toLowerCase()];
      const yyyy = m[2];
      const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
      state.dateFrom = `01.${mm}.${yyyy}`;
      state.dateTo = `${pad2(lastDay)}.${mm}.${yyyy}`;
      state.fiscalYear = state.fiscalYear || yyyy;
    }
  }

  // explicit dateFrom/dateTo if classifier gives
  if (!state.dateFrom && dj.dateFrom) state.dateFrom = normalizeDateToDdMmYyyy(dj.dateFrom);
  if (!state.dateTo && dj.dateTo) state.dateTo = normalizeDateToDdMmYyyy(dj.dateTo);

  // also allow user query to drive OPEN item seeding on first turn
  if (!state.openItem && /\bopen\s*items?\b/i.test(uq)) state.openItem = 'X';
}

// -----------------------------------------------------------------------------
// CATEGORY HANDLERS
// -----------------------------------------------------------------------------
const categoryHandlers = {
  // ---------------------------------------------------------------------------
  // INVOICE SEARCH (Option A: deterministic output + stateful follow ups)
  // ---------------------------------------------------------------------------
  'invoice-request-query': async ({ req, conversationId, user_query, determinationJson }) => {
    cleanupInvoiceSessions();

    if (userWantsReset(user_query)) {
      invoiceSessionState.delete(conversationId);
    }

    const existing = invoiceSessionState.get(conversationId) || null;
    const wantsNext = userWantsNextPage(user_query);

    // 1) Start / restore state
  let state = existing
  ? { ...existing }
  : {
      // NEW: intent lock fields
      activeIntent: 'INVOICE',
      intentLocked: true,

      companyCode: '',
      fiscalYear: '',
      dateFrom: '',
      dateTo: '',
      openItem: '',
      accountingDocument: '',
      skip: 0,
      pageSize: PAGE_SIZE,
      lastKey: '',
      lastTouched: nowMs(),
      totalCount: null
    };

// If session existed from older version, ensure lock is present
state.activeIntent = 'INVOICE';
state.intentLocked = true;


    // ✅ NEW: seed from classifier output even if it doesn't provide "query"
    if (!existing) {
      seedInvoiceStateFromDetermination(state, determinationJson, user_query);

      // If classifier returned legacy query, still support it
      const filterQuery = determinationJson?.query || '';
      if (filterQuery) {
        const pick = (name) => {
          const re = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i');
          const m = re.exec(filterQuery);
          return m ? (m[1] || '').trim() : '';
        };

        const invNo = pick('InvoiceNo');
        const fy = pick('FiscalYear');
        const cc = pick('CompanyCode');
        const df = pick('DateFrom');
        const dt = pick('DateTo');
        const open = pick('OpenItem');

        if (invNo) state.accountingDocument = invNo;
        if (fy) state.fiscalYear = fy;
        if (cc) state.companyCode = cc;
        if (df) state.dateFrom = normalizeDateToDdMmYyyy(df);
        if (dt) state.dateTo = normalizeDateToDdMmYyyy(dt);
        if (open === 'X') state.openItem = 'X';
      }

      // derive FY/CC from invoice if present
      if (state.accountingDocument) {
        const derived = deriveFromInvoiceNo(state.accountingDocument);
        if (!state.companyCode && derived.companyCode) state.companyCode = derived.companyCode;
        if (!state.fiscalYear && derived.fiscalYear) state.fiscalYear = derived.fiscalYear;
        if (derived.accountingDocument) state.accountingDocument = derived.accountingDocument;
      }
    }

    // 2) Apply follow-up deltas (LOCAL extractor)
    let intentResult;
    try {
      intentResult = await extractIntentAndDeltas(req, {
        userText: user_query,
        currentState: {
          companyCode: state.companyCode,
          fiscalYear: state.fiscalYear,
          dateFrom: state.dateFrom,
          dateTo: state.dateTo,
          openItem: state.openItem
        }
      });
    } catch (e) {
      console.warn('STE-GPT-WARN extractIntentAndDeltas failed', e?.message || e);
      intentResult = { intent: 'UNKNOWN', deltas: {} };
    }

    const deltas =
      intentResult?.deltas && typeof intentResult.deltas === 'object'
        ? intentResult.deltas
        : {};

    // Merge deltas
    if (deltas.companyCode) state.companyCode = String(deltas.companyCode).trim();
    if (deltas.fiscalYear) state.fiscalYear = String(deltas.fiscalYear).trim();
    if (deltas.openItem === 'X' || deltas.openItem === '') state.openItem = deltas.openItem;
    if (deltas.dateFrom) state.dateFrom = normalizeDateToDdMmYyyy(deltas.dateFrom);
    if (deltas.dateTo) state.dateTo = normalizeDateToDdMmYyyy(deltas.dateTo);

    // 3) Pagination logic
    const key = `FY=${state.fiscalYear}|CC=${state.companyCode}|DF=${state.dateFrom}|DT=${state.dateTo}|OPEN=${state.openItem}`;
    const keyChanged = state.lastKey && state.lastKey !== key;

    if (keyChanged) {
      state.skip = 0;
    } else if (wantsNext || deltas.isNext) {
      state.skip = Math.max(0, (toNumberOrNull(state.skip) || 0) + PAGE_SIZE);
    } else {
      // keep current skip
      state.skip = Math.max(0, toNumberOrNull(state.skip) || 0);
    }

    state.lastKey = key;
    state.lastTouched = nowMs();

    // 4) Validate minimum filters (now should work correctly)
    const missing = [];
    if (!state.companyCode) missing.push('Company Code (e.g., 801)');
    if (!state.fiscalYear) missing.push('Fiscal Year (e.g., 2024)');
    if (!state.dateFrom || !state.dateTo) missing.push('Date range (e.g., 01.01.2024 to 31.01.2024)');

    invoiceSessionState.set(conversationId, state);

    if (missing.length > 0) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            `I can help with that, but I need the following details:\n` +
            missing.map((m) => `- ${m}`).join('\n') +
            `\n\nCurrent context: ${summarizeStateForUser(state)}.`,
          additionalContents: []
        }
      };
    }

    // 5) Call OTC: top=5 only, with skip (safe)
    const legacyFilterQuery = buildLegacyFilterQueryFromState(state);

    const apiResult = await sf_connection_util.getInvoicesFromOtc(legacyFilterQuery, user_query, {
      top: PAGE_SIZE,
      skip: state.skip,
      wantCount: true,
      timeoutMs: 30000
    });

    const items = Array.isArray(apiResult?.items) ? apiResult.items : [];
    const totalCount = Number.isFinite(apiResult?.totalCount) ? apiResult.totalCount : items.length;
    const returnedCount = items.length;

    state.totalCount = totalCount;
    invoiceSessionState.set(conversationId, state);

    console.log('STE-GPT-INVOICE_SESSION', {
      conversationId,
      key,
      skip: state.skip,
      totalCount,
      returnedCount,
      apiUrl: apiResult?.url || apiResult?.debug?.url || ''
    });

    // 6) Format response
    if (!items.length) {
      const msg =
        `No invoices were found for the current criteria: ${summarizeStateForUser(state)}.\n\n` +
        `Try a smaller date range, or provide Invoice Number / Reference Document / Customer Code.`;
      return {
        deterministic: { role: 'assistant', content: msg, additionalContents: [] }
      };
    }

    const needsRefine = totalCount > REFINE_THRESHOLD;
    const shownSoFar = Math.min(totalCount, state.skip + returnedCount);
    const hasMore = shownSoFar < totalCount;

    let header = `Found ${totalCount} invoices. Showing ${returnedCount}.\n`;
    if (state.openItem === 'X') header = `Found ${totalCount} OPEN invoices. Showing ${returnedCount}.\n`;
    if (needsRefine) header += `Result set is large, please refine.\n\n`;

    const blocks = items.map((inv, idx) => `${state.skip + idx + 1}. ${formatInvoiceBlock(inv)}`);

    let footer = '';
    if (needsRefine) {
      footer =
        `Here are some follow-up questions to help narrow down your search:\n` +
        `1. Can you narrow down by a smaller date range (e.g., 01–15 Jan 2024)?\n` +
        `2. Do you have an Invoice Number / Reference Document / Customer Code to filter?\n` +
        `3. Do you want OPEN items only or ALL invoices?\n` +
        (hasMore ? `\nIf you still want to continue, reply "next" to see the next ${PAGE_SIZE}.\n` : '');
    } else if (hasMore) {
      footer = `Would you like to see the next ${PAGE_SIZE} invoices? (Reply: "next")\n`;
    } else {
      footer = `End of results for the current criteria.\n`;
    }

    return {
      deterministic: {
        role: 'assistant',
        content: `${header}${blocks.join('\n\n')}\n\n${footer}`.trim(),
        additionalContents: []
      }
    };
  },

  // ---------------------------------------------------------------------------
  // DOWNLOAD INVOICE (same logic you had; deterministic)
  // ---------------------------------------------------------------------------
  'download-invoice': async ({ determinationJson, user_query }) => {
    const inferredInvoiceDigits = extractInvoiceNumberFromText(user_query);
    const inferredInvoiceNumber = normalizeInvoiceNumber(inferredInvoiceDigits);
    const classifierInvoiceNumber = normalizeInvoiceNumber(determinationJson?.invoiceNumber);

    const invoiceNumber = inferredInvoiceNumber || classifierInvoiceNumber || '';

    let EStatus = '';
    let EStatusMessage = '';
    let downloadUrl = '';

    if (invoiceNumber) {
      const precheck = await sf_connection_util.validateInvoiceAvailability(invoiceNumber);
      EStatus = precheck?.status || '';
      EStatusMessage = precheck?.message || '';
      if (EStatus === 'S') {
        const dl = await sf_connection_util.getDownloadlink(invoiceNumber);
        downloadUrl = dl?.downloadUrl || dl?.url || '';
      }
    }

    if (!invoiceNumber) {
      return { deterministic: { role: 'assistant', content: 'Kindly provide the invoice number required for the download.', additionalContents: [] } };
    }
    if (EStatus === 'E') {
      return { deterministic: { role: 'assistant', content: EStatusMessage || 'Invoice not found.', additionalContents: [] } };
    }
    if (EStatus === 'S' && downloadUrl) {
      return { deterministic: { role: 'assistant', content: `<href>${invoiceNumber}</href>\n\n<href-value>${downloadUrl}</href-value>`, additionalContents: [] } };
    }

    return { deterministic: { role: 'assistant', content: 'Invoice download service is temporarily unavailable. Please try again in a few minutes.', additionalContents: [] } };
  },

  // ---------------------------------------------------------------------------
  // SOA (keep as-is)
  // ---------------------------------------------------------------------------
  'soa-request': async ({ determinationJson }) => {
    const companyCode = determinationJson?.companyCode ? `${determinationJson.companyCode}`.trim() : '';
    const customerCode = determinationJson?.customerCode ? `${determinationJson.customerCode}`.trim() : '';
    const asOfDate = determinationJson?.asOfDate ? `${determinationJson.asOfDate}`.trim() : '';

    let downloadUrl = '';
    let formattedDate = '';
    let EStatus = '';
    let EStatusMessage = '';

    if (companyCode && customerCode && asOfDate) {
      const pre = await sf_connection_util.validateStatementOfAccount(companyCode, customerCode, asOfDate);
      formattedDate = pre?.formattedDate || '';
      EStatus = pre?.status || '';
      EStatusMessage = pre?.message || '';

      if (EStatus === 'S') {
        const link = await sf_connection_util.getStatementOfAccountLink(companyCode, customerCode, asOfDate);
        formattedDate = link?.formattedDate || formattedDate;
        downloadUrl = link?.downloadUrl || '';
      }
    }

    if (!companyCode || !customerCode || !asOfDate || !formattedDate) {
      return { deterministic: { role: 'assistant', content: 'Kindly provide Company Code, Customer Code, and As-Of Date to generate the SOA.', additionalContents: [] } };
    }

    if (EStatus === 'E') {
      return { deterministic: { role: 'assistant', content: EStatusMessage || 'Unable to generate SOA at this time.', additionalContents: [] } };
    }

    if (EStatus === 'S' && downloadUrl) {
      return { deterministic: { role: 'assistant', content: `<href>StatementOfAccount</href>\n\n<href-value>${downloadUrl}</href-value>`, additionalContents: [] } };
    }

    return { deterministic: { role: 'assistant', content: 'SOA service is temporarily unavailable. Please try again later.', additionalContents: [] } };
  },

  // ---------------------------------------------------------------------------
  // CUSTOMER ANALYTICS (safe deterministic summary)
  // ---------------------------------------------------------------------------
  'customer-analytics': async ({ determinationJson, user_query }) => {
    const analyticsQuery = determinationJson?.analyticsQuery || user_query;
    try {
      const res = await sf_connection_util.getCustomerDataFromDatasphere(analyticsQuery);
      const highlights = res?.analysis?.customerHighlights || [];
      if (!highlights.length) {
        return { deterministic: { role: 'assistant', content: 'No customer analytics data was returned. Please refine your question (client, period, metric).', additionalContents: [] } };
      }
      return { deterministic: { role: 'assistant', content: `Customer analytics summary:\n${highlights.join('\n')}`, additionalContents: [] } };
    } catch (e) {
      return { deterministic: { role: 'assistant', content: 'Unable to retrieve customer analytics at this time. Please try again later.', additionalContents: [] } };
    }
  }
};
// -----------------------------------------------------------------------------
// SAFE Classification Wrapper (prevents 502 when AI_ENGINE returns non-JSON)
// -----------------------------------------------------------------------------
function localFallbackClassify(user_query = '') {
  const q = String(user_query || '').toLowerCase();

  // keep conservative fallbacks
  if (q.includes('statement of account') || /\bsoa\b/.test(q)) {
    return { category: 'soa-request', determinationJson: '{}' };
  }
  if (q.includes('download') || q.includes('pdf')) {
    return { category: 'download-invoice', determinationJson: '{}' };
  }
  if (q.includes('invoice') || q.includes('invoices') || q.includes('open items')) {
    return { category: 'invoice-request-query', determinationJson: '{}' };
  }
  if (q.includes('top') || q.includes('analytics') || q.includes('payment days')) {
    return { category: 'customer-analytics', determinationJson: '{}' };
  }

  return { category: 'generic-query', determinationJson: '{}' };
}

// Adds strict JSON contract WITHOUT forcing you to change your big systemPrompt
function buildStrictSystemPrompt(basePrompt) {
  const strictSuffix = `
IMPORTANT:
- Respond with ONLY valid JSON (no markdown, no explanation).
- Output must be a single JSON object with:
  { "category": "<one of: invoice-request-query|download-invoice|customer-analytics|soa-request|generic-query>", "determinationJson": "<stringified JSON>" }
- determinationJson MUST be a JSON STRING (e.g. "{}" or "{\\"companyCode\\":\\"801\\"}").

If unsure, return:
{ "category": "generic-query", "determinationJson": "{}" }
`.trim();

  return `${basePrompt}\n\n${strictSuffix}`;
}

async function safeClassifyUserQuery(req, aiEngine, user_query, systemPrompt) {
  const strictPrompt = buildStrictSystemPrompt(systemPrompt);

  try {
    const classifyResult = await aiEngine.tx(req).send({
      method: 'POST',
      path: '/classifyUserQuery',
      data: { user_query, systemPrompt: strictPrompt }
    });

    // Validate minimal structure
    const category = classifyResult?.category;
    const detStr = classifyResult?.determinationJson;

    // determinationJson must be parseable JSON string (or at least a string)
    if (!category || typeof detStr !== 'string') {
      console.warn('STE-GPT-WARN classifyUserQuery invalid shape, fallback', {
        categoryType: typeof category,
        detType: typeof detStr
      });
      return localFallbackClassify(user_query);
    }

    // Ensure determinationJson is valid JSON (string)
    try {
      JSON.parse(detStr || '{}');
    } catch (e) {
      console.warn('STE-GPT-WARN classifyUserQuery returned non-JSON determinationJson, fallback', {
        detPreview: String(detStr).slice(0, 200)
      });
      return localFallbackClassify(user_query);
    }

    return { category, determinationJson: detStr };
  } catch (e) {
    console.warn('STE-GPT-WARN classifyUserQuery call failed, fallback', e?.message || e);
    return localFallbackClassify(user_query);
  }
}


// ---------------------- CAP SERVICE ----------------------
module.exports = function () {
  this.on('getChatRagResponse', async (req) => {
    const startTime = Date.now();

    try {
      const { conversationId, messageId, message_time, user_id, user_query } = req.data;

      // 1) CLASSIFICATION (AI_ENGINE)
      

  const aiEngine = await cds.connect.to('AI_ENGINE');

const safe = await safeClassifyUserQuery(req, aiEngine, user_query, systemPrompt);
let category = safe.category; // <-- CHANGED const -> let

let determinationJson = {};
try {
  determinationJson = JSON.parse(safe.determinationJson || '{}');
} catch (e) {
  determinationJson = {};
}

// NEW: clean stale sessions + apply Intent Lock follow-up routing
cleanupInvoiceSessions();
const existingInvoiceState = invoiceSessionState.get(conversationId) || null;

if (shouldRouteToInvoiceFollowUp({
  existingState: existingInvoiceState,
  user_query,
  classifiedCategory: category
})) {
  console.log('STE-GPT-ROUTER forcing invoice-request-query due to active invoice session', {
    conversationId,
    previousCategory: category,
    userQueryPreview: String(user_query || '').slice(0, 80)
  });
  category = 'invoice-request-query';
  // determinationJson can stay {}, invoice handler will use session + deltas extractor
}


      console.log('STE-GPT-CLASSIFY', {
        conversationId,
        query: String(user_query || '').substring(0, 160),
        category,
        determinationJson
      });

      if (!basePrompts[category]) {
        return {
          role: 'assistant',
          content: 'I could not classify your request. Please rephrase.',
          messageTime: new Date().toISOString(),
          messageId: messageId || null,
          additionalContents: JSON.stringify([])
        };
      }

      // 2) Deterministic handlers first
      if (categoryHandlers[category]) {
        const handled = await categoryHandlers[category]({
          req,
          conversationId,
          messageId,
          message_time,
          user_id,
          user_query,
          determinationJson
        });

        if (handled?.deterministic) {
          await logUsageToAiEngine(req, {
            category,
            startTime,
            isDeterministic: true,
            conversationId,
            messageId,
            userId: user_id
          });

          return {
            role: handled.deterministic.role,
            content: handled.deterministic.content,
            messageTime: new Date().toISOString(),
            messageId: messageId || null,
            additionalContents: JSON.stringify(handled.deterministic.additionalContents || [])
          };
        }
      }

      // 3) Otherwise do your existing RAG flow
      const ragResult = await aiEngine.tx(req).send({
        method: 'POST',
        path: '/ragWithSdk',
        data: {
          conversationId,
          messageId,
          message_time,
          user_id,
          userQuery: user_query,
          appId: 'OTC-CHATBOT',
          tableName,
          embeddingColumn,
          contentColumn,
          prompt: basePrompts[category],
          topK: 30
        }
      });

      let completionObj;
      if (typeof ragResult?.completion === 'string') {
        try {
          completionObj = JSON.parse(ragResult.completion);
        } catch {
          completionObj = { role: 'assistant', content: ragResult?.completion || '' };
        }
      } else {
        completionObj = ragResult?.completion || { role: 'assistant', content: ragResult?.content || '' };
      }

      let additionalContentsArr = [];
      if (typeof ragResult?.additionalContents === 'string') {
        try {
          additionalContentsArr = JSON.parse(ragResult.additionalContents);
        } catch {
          additionalContentsArr = [];
        }
      } else {
        additionalContentsArr = ragResult?.additionalContents || [];
      }

      await logUsageToAiEngine(req, {
        category,
        startTime,
        isDeterministic: false,
        conversationId,
        messageId,
        userId: user_id
      });

      return {
        role: completionObj.role,
        content: completionObj.content,
        messageTime: new Date().toISOString(),
        messageId: messageId || null,
        additionalContents: JSON.stringify(additionalContentsArr)
      };
    } catch (error) {
      console.error('STE-GPT-ERROR getChatRagResponse', error);
      throw error;
    }
  });

  async function logUsageToAiEngine(req, { category, startTime, isDeterministic, conversationId, messageId, userId }) {
    try {
      const aiEngine = await cds.connect.to('AI_ENGINE');
      const durationMs = Date.now() - startTime;

      await aiEngine.tx(req).send({
        method: 'POST',
        path: '/logUsage',
        data: {
          sourceService: 'HR_APPROVAL',
          category,
          isDeterministic,
          durationMs,
          conversationId,
          messageId,
          userId,
          tenantId: req.tenant || ''
        }
      });
    } catch (e) {
      console.warn('STE-GPT-WARN logUsage failed', e?.message || e);
    }
  }

  this.on('getConversationHistoryFromEngine', async (req) => {
    const aiEngine = await cds.connect.to('AI_ENGINE');
    return aiEngine.tx(req).send({
      method: 'POST',
      path: '/getConversationHistory',
      data: { conversationId: req.data.conversationId }
    });
  });

  this.on('deleteChatData', async (req) => {
    const aiEngine = await cds.connect.to('AI_ENGINE');
    await aiEngine.tx(req).send({ method: 'POST', path: '/deleteAllChatData' });
    return 'Success!';
  });
};
