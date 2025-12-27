'use strict';

const assert = require('assert');
const { buildInvoiceUrl } = require('./sf-connection-util');

const urlForMonth = buildInvoiceUrl({
  FiscalYear: '2024',
  CompanyCode: '801',
  DateFrom: '01.01.2024',
  DateTo: '31.01.2024',
  ISystemAlias: 'AERO288',
  top: 5,
  skip: 0
});
assert.ok(!urlForMonth.includes('AccountingDocument='), 'AccountingDocument should be omitted for month query');

const urlWithInvoice = buildInvoiceUrl({
  AccountingDocument: '0248013000',
  FiscalYear: '2024',
  CompanyCode: '801',
  ISystemAlias: 'AERO288',
  top: 5,
  skip: 0
});
assert.ok(urlWithInvoice.includes('AccountingDocument=0248013000'), 'AccountingDocument should include invoice number');
assert.ok(!urlWithInvoice.includes('AccountingDocument=2024'), 'AccountingDocument must not be set to fiscal year');

const urlWithEmptyInvoice = buildInvoiceUrl({
  AccountingDocument: '',
  FiscalYear: '2024',
  CompanyCode: '801',
  ISystemAlias: 'AERO288',
  top: 5,
  skip: 0
});
assert.ok(
  !urlWithEmptyInvoice.includes('AccountingDocument='),
  'Empty AccountingDocument must not be included'
);
