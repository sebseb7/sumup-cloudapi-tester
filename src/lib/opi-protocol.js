export const OPI_NS = 'http://www.nrf-arts.org/IXRetail/namespace';

export function encodeMessage(xml) {
  const body = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createFrameReader(onMessage, onError) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) {
        return;
      }

      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);

      try {
        onMessage(body);
      } catch (err) {
        if (onError) onError(err);
      }
    }
  };
}

function attrValue(xml, name) {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function tagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

export function detectRequest(xml) {
  const rootMatch = xml.match(/<(\w+)/);
  const root = rootMatch ? rootMatch[1] : 'Unknown';
  const requestType = attrValue(xml, 'RequestType');

  return {
    root,
    requestType,
    requestId: attrValue(xml, 'RequestID'),
    workstationId: attrValue(xml, 'WorkstationID') || '1',
    applicationSender: attrValue(xml, 'ApplicationSender'),
    popId: attrValue(xml, 'POPID') || '001',
    receiptNumber: tagText(xml, 'ReceiptNumber'),
    transactionId: tagText(xml, 'TransactionID'),
    cashierId: tagText(xml, 'CashierID'),
    amount: tagText(xml, 'TotalAmount'),
    currency: (xml.match(/<TotalAmount[^>]*Currency="([^"]*)"/i) || [])[1] || 'EUR',
    raw: xml,
  };
}

export function serviceResponse({ requestId, requestType, workstationId, overallResult = 'Success' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceResponse xmlns="${OPI_NS}"
  ApplicationSender="SUMUP-BRIDGE"
  OverallResult="${overallResult}"
  RequestID="${requestId}"
  RequestType="${requestType}"
  WorkstationID="${workstationId}">
  <Terminal TerminalID="12345678" STAN="${String(Date.now()).slice(-6)}"/>
</ServiceResponse>`;
}

export function cardServiceResponse({
  requestId,
  requestType,
  workstationId,
  overallResult,
  amount,
  currency = 'EUR',
  message = '',
  stan,
  approvalCode,
}) {
  const txStan = stan || String(Date.now()).slice(-6);
  const approval = approvalCode || String(Math.floor(100000 + Math.random() * 900000));
  const cardPan = '************4242';
  const cardCircuit = 'VISA';

  if (overallResult === 'Success') {
    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<CardServiceResponse xmlns="${OPI_NS}"
  ApplicationSender="SUMUP-BRIDGE"
  OverallResult="Success"
  RequestID="${requestId}"
  RequestType="${requestType}"
  WorkstationID="${workstationId}">
  <Terminal TerminalID="12345678" STAN="${txStan}"/>
  <Tender>
    <TotalAmount Currency="${currency}">${amount}</TotalAmount>
    <Authorisation AuthorisationType="OnlineAuth"
      CardCircuit="${cardCircuit}"
      CardPAN="${cardPan}"
      ApprovalCode="${approval}"/>
  </Tender>
</CardServiceResponse>`;
  }

  const privateData = message
    ? `\n  <PrivateData>answer-txt=${message}</PrivateData>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<CardServiceResponse xmlns="${OPI_NS}"
  ApplicationSender="SUMUP-BRIDGE"
  OverallResult="${overallResult}"
  RequestID="${requestId}"
  RequestType="${requestType}"
  WorkstationID="${workstationId}">${privateData}
</CardServiceResponse>`;
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function deviceRequest({
  applicationSender,
  requestId,
  workstationId,
  text,
  target = 'CashierDisplay',
  sequenceId = '0',
}) {
  const lines = String(text).split('\n').map((line) => `    <TextLine>${escapeXml(line)}</TextLine>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<DeviceRequest xmlns="${OPI_NS}"
  ApplicationSender="${applicationSender}"
  RequestID="${requestId}"
  RequestType="Output"
  SequenceID="${sequenceId}"
  WorkstationID="${workstationId}">
  <Output OutDeviceTarget="${target}">
${lines}
  </Output>
</DeviceRequest>`;
}

export function buildReceiptText({ stan, approvalCode, amount, currency, cardCircuit, cardPan, requestId }) {
  return [
    `Transaktionsnummer: ${stan}`,
    `Karte: ${cardCircuit}`,
    `PAN: ${cardPan}`,
  ].join('\n');
}
