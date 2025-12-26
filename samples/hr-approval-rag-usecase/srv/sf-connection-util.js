'use strict';

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// ✅ FIX: declare it (no ReferenceError on deploy)
const AUTHORIZATION_HEADER =
  cds.env.requires?.SUCCESS_FACTORS_CREDENTIALS?.AUTHORIZATION_HEADER || '';

function extractXmlValue(xmlString, tagName) {
  if (!xmlString) return '';
  const text =
    typeof xmlString === 'string' ? xmlString : xmlString?.toString?.() || '';
  const regex = new RegExp(`<d:${tagName}>([\\s\\S]*?)<\\/d:${tagName}>`, 'i');
  const match = regex.exec(text);
  return match ? match[1].trim() : '';
}

function parsePdfStatusResponse(rawPayload) {
  let payload = rawPayload;

  if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');

  const normalizeJsonPayload = (data) => {
    const node = data?.d ?? data;
    return {
      status: node?.EStatus || node?.status || '',
      message: node?.EStatusMessage || node?.message || ''
    };
  };

  if (payload && typeof payload === 'object') {
    const { status, message } = normalizeJsonPayload(payload);
    if (status) return { status, message };
  }

  if (typeof payload === 'string') {
    const trimmedPayload = payload.trim();
    if (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')) {
      try {
        const parsedJson = JSON.parse(trimmedPayload);
        const { status, message } = normalizeJsonPayload(parsedJson);
        if (status) return { status, message };
      } catch (error) {
        cds?.log?.warn?.('Failed to parse invoice status JSON payload', error);
      }
    }

    const status = extractXmlValue(trimmedPayload, 'EStatus');
    const message = extractXmlValue(trimmedPayload, 'EStatusMessage');
    if (status) return { status, message };
    return {
      status: 'E',
      message: message || 'Unable to process the validation response.'
    };
  }

  return { status: 'E', message: 'Unable to process the validation response.' };
}

function normalizeDateToYyyymmdd(asOfDate) {
  if (!asOfDate && asOfDate !== 0) return '';
  const rawValue = `${asOfDate}`.trim();
  if (!rawValue) return '';

  const sanitizedValue = rawValue
    .replace(/\s*([-.\/])\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (/^\d{8}$/.test(sanitizedValue)) return sanitizedValue;
  if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(sanitizedValue))
    return sanitizedValue.replace(/[-./]/g, '');
  if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(sanitizedValue)) {
    const [day, month, year] = sanitizedValue.split(/[-.\/]/);
    return `${year}${month}${day}`;
  }

  const parsedDate = new Date(sanitizedValue);
  if (!isNaN(parsedDate.getTime())) {
    const year = parsedDate.getFullYear();
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const day = String(parsedDate.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  return '';
}

// ------------------ OTC INVOICE REST API SUPPORT ------------------
const OTC_DESTINATION = 'sthubsystem-qa';
const OTC_SYSTEM_ALIAS = 'AERO288';

function safeJsonPreview(data, maxChars = 2500) {
  try {
    const s = JSON.stringify(data);
    return s.length <= maxChars ? s : s.slice(0, maxChars) + '...[TRUNCATED]';
  } catch (e) {
    return '[UNSTRINGIFIABLE]';
  }
}

/**
 * Derive FiscalYear + CompanyCode from invoice number:
 * - 9 digits: 228033065  -> FY=2022, CC=803
 * - 10 digits with leading 0: 0228033065 -> FY=2022, CC=803
 */
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
    return {
      fiscalYear: fy,
      companyCode: cc,
      accountingDocument: digits.replace(/^0+/, '') || digits
    };
  }

  if (digits.length >= 5) {
    const fy = digits.length >= 2 ? `20${digits.slice(0, 2)}` : '';
    const cc = digits.length >= 5 ? digits.slice(2, 5) : '';
    return { fiscalYear: fy, companyCode: cc, accountingDocument: digits };
  }

  return { fiscalYear: '', companyCode: '', accountingDocument: digits };
}

// Legacy classifier string:
// InvoiceNo='0248013075'&InvoiceType='FI'&FiscalYear='2024'&DateFrom=''&DateTo=''&SalesOrder=''&CompanyCode='801'
function parseLegacyInvoiceQuery(filterQuery) {
  const q = (filterQuery || '').toString().trim();
  const result = {
    AccountingDocument: '',
    FiscalYear: '',
    CompanyCode: '',
    DateFrom: '',
    DateTo: '',
    OpenItem: ''
  };
  if (!q) return result;

  const pick = (name) => {
    const re = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i');
    const m = re.exec(q);
    return m ? (m[1] || '').trim() : '';
  };

  const invoiceNo = pick('InvoiceNo');
  const fiscalYear = pick('FiscalYear');
  const companyCode = pick('CompanyCode');
  const dateFrom = pick('DateFrom');
  const dateTo = pick('DateTo');
  const openItem = pick('OpenItem');

  if (invoiceNo) result.AccountingDocument = invoiceNo;
  if (fiscalYear) result.FiscalYear = fiscalYear;
  if (companyCode) result.CompanyCode = companyCode;
  if (dateFrom) result.DateFrom = dateFrom;
  if (dateTo) result.DateTo = dateTo;
  if (openItem) result.OpenItem = openItem;

  // Fix wrong/missing FY/CC derived from invoice number
  if (result.AccountingDocument) {
    const derived = deriveFromInvoiceNo(result.AccountingDocument);

    if (!/^\d{3}$/.test(result.CompanyCode || '') && derived.companyCode) {
      result.CompanyCode = derived.companyCode;
    }
    if (!/^\d{4}$/.test(result.FiscalYear || '') && derived.fiscalYear) {
      result.FiscalYear = derived.fiscalYear;
    }
    if (derived.accountingDocument) result.AccountingDocument = derived.accountingDocument;
  }

  return result;
}

function buildOtcInvoiceUrl({
  AccountingDocument,
  FiscalYear,
  CompanyCode,
  DateFrom,
  DateTo,
  OpenItem,
  top,
  skip,
  count
}) {
  const params = [];

  if (AccountingDocument) params.push(`AccountingDocument=${encodeURIComponent(AccountingDocument)}`);
  if (FiscalYear) params.push(`FiscalYear=${encodeURIComponent(FiscalYear)}`);
  if (CompanyCode) params.push(`CompanyCode=${encodeURIComponent(CompanyCode)}`);
  if (DateFrom) params.push(`DateFrom=${encodeURIComponent(DateFrom)}`);
  if (DateTo) params.push(`DateTo=${encodeURIComponent(DateTo)}`);

  params.push(`ISystemAlias=${encodeURIComponent(OTC_SYSTEM_ALIAS)}`);

  if (OpenItem) params.push(`OpenItem=${encodeURIComponent(OpenItem)}`);
  if (count) params.push(`count=X`);

  if (Number.isFinite(top)) params.push(`top=${encodeURIComponent(String(top))}`);
  if (Number.isFinite(skip)) params.push(`skip=${encodeURIComponent(String(skip))}`);

  return `/otc/invoice?${params.join('&')}`;
}

/**
 * getInvoicesFromOtc(filterQuery, userQueryText, options)
 * Returns:
 * {
 *   items: [...],
 *   totalCount: number|null,
 *   top: number,
 *   skip: number,
 *   debug: { url, countUrl }
 * }
 */
async function getInvoicesFromOtc(filterQuery, userQueryText, options = {}) {
  const top = Number.isFinite(options.top) ? options.top : 5;
  const skip = Number.isFinite(options.skip) ? options.skip : 0;
  const wantCount = options.wantCount !== false; // default true
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;

  const parsed = parseLegacyInvoiceQuery(filterQuery);

  // If user says "open items", set OpenItem=X
  const userText = (userQueryText || '').toString();
  const wantsOpenItems =
    /\bopen\s*item(s)?\b/i.test(userText) ||
    /\bonly\s+open\b/i.test(userText) ||
    /\bopen\b/i.test(userText);

  if (wantsOpenItems) parsed.OpenItem = 'X';

  // Must have FY + CC for list search
  if (!parsed.FiscalYear || !parsed.CompanyCode) {
    console.log('STE-GPT-WARN getInvoicesFromOtc missing FiscalYear/CompanyCode', {
      FiscalYear: parsed.FiscalYear,
      CompanyCode: parsed.CompanyCode
    });
    return { items: [], totalCount: null, top, skip, debug: { url: '', countUrl: '' } };
  }

  let totalCount = null;
  let countUrl = '';

  // 1) Count call
  if (wantCount) {
    countUrl = buildOtcInvoiceUrl({
      ...parsed,
      count: true,
      top: 0,
      skip: 0
    });

    try {
      console.log('STE-GPT-INFO OTC COUNT request', {
        destination: OTC_DESTINATION,
        url: countUrl
      });

      const countResp = await executeHttpRequest(
        { destinationName: OTC_DESTINATION },
        { method: 'GET', url: countUrl, timeout: timeoutMs }
      );

      const data = countResp?.data;

      if (typeof data?.count === 'number') totalCount = data.count;
      else if (typeof data?.['@odata.count'] === 'number') totalCount = data['@odata.count'];
      else if (typeof data?.totalCount === 'number') totalCount = data.totalCount;
      else if (typeof data?.TotalCount === 'number') totalCount = data.TotalCount;
      else if (typeof countResp?.headers?.['x-total-count'] !== 'undefined') {
        const n = parseInt(countResp.headers['x-total-count'], 10);
        if (!Number.isNaN(n)) totalCount = n;
      } else if (Array.isArray(data)) {
        totalCount = data.length;
      }

      console.log('STE-GPT-INFO OTC COUNT response', {
        url: countUrl,
        status: countResp?.status,
        derivedTotalCount: totalCount
      });
    } catch (e) {
      console.error('STE-GPT-ERROR OTC COUNT failed', e?.message || e);
      totalCount = null;
    }
  }

  // 2) Paged list call
  const url = buildOtcInvoiceUrl({
    ...parsed,
    count: false,
    top,
    skip
  });

  try {
    console.log('STE-GPT-INFO OTC LIST request', {
      destination: OTC_DESTINATION,
      url
    });

    const response = await executeHttpRequest(
      { destinationName: OTC_DESTINATION },
      { method: 'GET', url, timeout: timeoutMs }
    );

    const data = response?.data;

    let items = [];
    if (Array.isArray(data)) items = data;
    else if (Array.isArray(data?.data)) items = data.data;
    else if (Array.isArray(data?.value)) items = data.value;
    else if (data && typeof data === 'object') items = [data];

    // ✅ Mandatory response log (safe because top is small)
    console.log('STE-GPT-INFO OTC LIST response', {
      url,
      status: response?.status,
      itemsLength: items.length,
      preview: safeJsonPreview(items)
    });

    return { items, totalCount, top, skip, debug: { url, countUrl } };
  } catch (e) {
    console.error('STE-GPT-ERROR OTC LIST failed', {
      url,
      message: e?.message || e
    });
    return { items: [], totalCount, top, skip, debug: { url, countUrl } };
  }
}

// ---------------- EXISTING DATASPHERE / DOWNLOAD / SOA (UNCHANGED) ----------------

const DATASPHERE_CUSTOMER_PATH =
  "api/v1/datasphere/consumption/relational/GROUP_IT_SAP/4GV_FF_S_FI_OTCKPI_01/_4GV_FF_S_FI_OTCKPI_01";

function parseCustomerAnalyticsQuery(analyticsQuery) {
  const queryText = (analyticsQuery || '').toString().trim();

  const isBottomQuery = /(bottom|worst|bad|delayed)/i.test(queryText);
  const rankingType = isBottomQuery ? 'bottom' : 'top';
  const orderDirection = isBottomQuery ? 'desc' : 'asc';

  let limit = 5;
  const explicitTopMatch = queryText.match(/(?:top|bottom|best|worst|bad|delayed|on\s*-?time)\s*(\d{1,3})/i);
  const numericMentionMatch = queryText.match(/(\d{1,3})\s*customers?/i);
  const limitMatch = explicitTopMatch || numericMentionMatch;
  const limitProvided = Boolean(limitMatch);
  if (limitMatch) {
    const parsedLimit = parseInt(limitMatch[1], 10);
    if (!Number.isNaN(parsedLimit) && parsedLimit > 0) limit = parsedLimit;
  }

  const hasCrossLob =
    /(cross[-\s]*lob|across\s+all\s+(?:lines?\s+of\s+business|lobs?)|across\s+lobs?)/i.test(queryText);

  let clientFilter = 'Aerospace 288';
  if (hasCrossLob) clientFilter = '';
  else if (/(\belect\b|electronics?\s*288)/i.test(queryText)) clientFilter = 'Electronics 288';
  else if (/aero/i.test(queryText)) clientFilter = 'Aerospace 288';

  return { orderDirection, rankingType, limit, clientFilter, hasCrossLob, limitProvided };
}

function buildDatasphereQuery({ orderDirection, limit, clientFilter }) {
  const queryParts = [];
  if (clientFilter) queryParts.push(`$filter=${encodeURIComponent(`Client eq '${clientFilter}'`)}`);
  queryParts.push(`$orderby=${encodeURIComponent(`Average_Customer_Payment_Days ${orderDirection}`)}`);
  queryParts.push('$count=true');
  queryParts.push(`$top=${limit}`);
  queryParts.push('$skip=0');

  return `${DATASPHERE_CUSTOMER_PATH}?${queryParts.join('&')}`;
}

function extractCustomerInsights(data) {
  const records = Array.isArray(data?.value)
    ? data.value
    : Array.isArray(data?.d?.results)
      ? data.d.results
      : Array.isArray(data)
        ? data
        : [];

  return records.map((entry, index) => {
    const customerName =
      entry?.CustomerName ||
      entry?.Customer ||
      entry?.Customer_Name ||
      entry?.CUSTOMER ||
      entry?.CustomerDescription ||
      'Unknown Customer';

    const paymentDays =
      entry?.Average_Customer_Payment_Days ??
      entry?.AverageCustomerPaymentDays ??
      entry?.AvgPaymentDays ??
      entry?.AveragePaymentDays ??
      entry?.Averagecustomerpaymentdays ??
      null;

    return { position: index + 1, customerName, averageCustomerPaymentDays: paymentDays, raw: entry };
  });
}

async function getCustomerDataFromDatasphere(analyticsQuery) {
  const queryDetails = parseCustomerAnalyticsQuery(analyticsQuery);
  const formattedURL = buildDatasphereQuery(queryDetails);

  try {
    console.log('STE-GPT-INFO getCustomerDataFromDatasphere formattedURL ' + formattedURL);
    const response = await executeHttpRequest(
      { destinationName: 'datasphere_ap11_qas' },
      { method: 'GET', url: formattedURL }
    );

    const customerInsights = extractCustomerInsights(response?.data);
    const customerHighlights = customerInsights.map((item) => {
      const paymentText =
        item.averageCustomerPaymentDays === null || item.averageCustomerPaymentDays === undefined
          ? 'N/A'
          : `${item.averageCustomerPaymentDays} days`;
      return `${item.position}. ${item.customerName} - ${paymentText}`;
    });

    const scopeDescription = queryDetails.clientFilter
      ? `within the ${queryDetails.clientFilter} client`
      : 'across all lines of business';

    const rankingDescription = `${queryDetails.rankingType} ${queryDetails.limit}`;
    const customerWord = queryDetails.limit === 1 ? 'customer' : 'customers';
    const limitNote = queryDetails.limitProvided ? '' : ' (defaulted to 5 due to unspecified limit)';
    const summary = `Analyzed the ${rankingDescription} ${customerWord}${limitNote} ${scopeDescription} based on Average Customer Payment Days.`;

    return {
      data: response?.data,
      formattedURL,
      appliedParameters: queryDetails,
      analysis: {
        summary,
        scopeDescription,
        rankingDescription,
        rankingType: queryDetails.rankingType,
        orderDirection: queryDetails.orderDirection,
        limit: queryDetails.limit,
        clientFilter: queryDetails.clientFilter,
        limitProvided: queryDetails.limitProvided,
        customerInsights,
        customerHighlights
      }
    };
  } catch (e) {
    console.error('STE-GPT-ERROR getCustomerDataFromDatasphere' + e);
    throw e;
  }
}

// Returns the download link for the provided invoice number
async function getDownloadlink(invoiceNumber) {
  const trimmedInvoice = (invoiceNumber || '').toString().trim();
  let formattedURL = '';

  if (trimmedInvoice.length >= 5) {
    const fiscalYearPrefix = trimmedInvoice.substring(1, 3);
    const fiscalYear = `20${fiscalYearPrefix}`;
    const companyCode = trimmedInvoice.substring(3, 6);
    const docNumber = `${trimmedInvoice}`;

    formattedURL = `/sap/opu/odata/sap/ZFI_OTC_FORM_INVOICE_PDF_SRV/get_pdfSet(IBlart='RI',ICompany='${companyCode}',IDocno='${docNumber}',IFiscalYear='${fiscalYear}',ISystemAlias='AERO288')/$value`;
  }

  try {
    console.log('STE-GPT-INFO getDownloadlink formattedURL ' + formattedURL + ' invoiceNumber=' + invoiceNumber);
    await executeHttpRequest(
      { destinationName: 'sthubsystem-qa-new' },
      { method: 'GET', url: formattedURL, responseType: 'arraybuffer' }
    );
  } catch (e) {
    console.error('STE-GPT-ERROR getDownloadlink ' + e);
  }

  return { downloadUrl: formattedURL };
}

async function validateInvoiceAvailability(invoiceNumber) {
  const trimmedInvoice = (invoiceNumber || '').toString().trim();
  if (!trimmedInvoice) return { status: '', message: '', companyCode: '', fiscalYear: '' };

  if (trimmedInvoice.length < 6) {
    return {
      status: 'E',
      message: 'Unable to derive the required details from the provided invoice number.',
      companyCode: '',
      fiscalYear: ''
    };
  }

  const fiscalYearPrefix = trimmedInvoice.substring(1, 3);
  const fiscalYear = `20${fiscalYearPrefix}`;
  const companyCode = trimmedInvoice.substring(3, 6);
  const docNumber = `${trimmedInvoice}`;

  const formattedURL =
    `/sap/opu/odata/sap/ZFI_OTC_FORM_INVOICE_PDF_SRV/get_pdfstatusSet(IBlart='RI',ICompany='${companyCode}',IDocno='${docNumber}',IFiscalYear='${fiscalYear}',ISystemAlias='AERO288')`;

  try {
    console.log('STE-GPT-INFO validateInvoiceAvailability request', formattedURL);
    const response = await executeHttpRequest(
      { destinationName: 'sthubsystem-qa-new' },
      { method: 'GET', url: formattedURL, responseType: 'text' }
    );
    const parsed = parsePdfStatusResponse(response?.data);
    return { status: parsed.status, message: parsed.message, companyCode, fiscalYear };
  } catch (error) {
    console.error('STE-GPT-ERROR validateInvoiceAvailability', error);
    return {
      status: 'E',
      message: 'Unable to validate the invoice number at this time. Please try again later.',
      companyCode,
      fiscalYear
    };
  }
}

async function getStatementOfAccountLink(companyCode, customerCode, asOfDate) {
  const trimmedCompanyCode = (companyCode || '').toString().trim();
  const trimmedCustomerCode = (customerCode || '').toString().trim();
  const formattedDate = normalizeDateToYyyymmdd(asOfDate);

  let formattedURL = '';
  if (trimmedCompanyCode && trimmedCustomerCode && formattedDate) {
    formattedURL =
      `/sap/opu/odata/sap/ZFI_AR_SOA_FORM_SRV/get_pdfSet(ICompany='${trimmedCompanyCode}',ICustomer='${trimmedCustomerCode}',IOpendate='${formattedDate}',ISystemAlias='AERO288')/$value`;
    try {
      console.log('STE-GPT-INFO getStatementOfAccountLink formattedURL ' + formattedURL);
      await executeHttpRequest(
        { destinationName: 'sthubsystem-qa-new' },
        { method: 'GET', url: formattedURL, responseType: 'arraybuffer' }
      );
    } catch (e) {
      console.error('STE-GPT-ERROR getStatementOfAccountLink ' + e);
    }
  }

  return { downloadUrl: formattedURL, formattedDate };
}

async function validateStatementOfAccount(companyCode, customerCode, asOfDate) {
  const trimmedCompanyCode = (companyCode || '').toString().trim();
  const trimmedCustomerCode = (customerCode || '').toString().trim();
  const formattedDate = normalizeDateToYyyymmdd(asOfDate);

  if (!trimmedCompanyCode || !trimmedCustomerCode || !formattedDate) {
    return { status: '', message: '', formattedDate };
  }

  const formattedURL =
    `/sap/opu/odata/sap/ZFI_AR_SOA_FORM_SRV/get_pdfstatusSet(ICompany='${trimmedCompanyCode}',ICustomer='${trimmedCustomerCode}',IOpendate='${formattedDate}',ISystemAlias='AERO288')`;

  try {
    const response = await executeHttpRequest(
      { destinationName: 'sthubsystem-qa-new' },
      { method: 'GET', url: formattedURL, responseType: 'text' }
    );
    const parsed = parsePdfStatusResponse(response?.data);
    return { status: parsed.status, message: parsed.message, formattedDate };
  } catch (error) {
    console.error('STE-GPT-ERROR validateStatementOfAccount ' + error);
    return {
      status: 'E',
      message: 'Unable to validate the provided customer details at this time. Please try again later.',
      formattedDate
    };
  }
}

module.exports = {
  getInvoicesFromOtc,
  getCustomerDataFromDatasphere,
  getDownloadlink,
  getStatementOfAccountLink,
  validateInvoiceAvailability,
  validateStatementOfAccount
};
