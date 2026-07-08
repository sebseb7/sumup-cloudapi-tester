import net from 'node:net';
import 'dotenv/config';
import crypto from 'node:crypto';
import {
  encodeMessage,
  createFrameReader,
  detectRequest,
  serviceResponse,
  cardServiceResponse,
} from './lib/opi-protocol.js';
import { listReaders, createCheckout, terminateCheckout, getReaderStatus } from './lib/readers.js';
import { sendDeviceOutput, normalizeHost, sendPaymentDeviceRequests } from './lib/device-client.js';

import { startWebhookServer, waitForPaymentResult } from './lib/waiter.js';

const OPI_PORT = 4102;
const DEVICE_PORT = parseInt(process.env.OPI_PORT_DEVICE || '4100', 10);

let activeReaderId = process.env.SUMUP_READER_ID;
let webhookUrl = process.env.WEBHOOK_URL;

async function getTargetReader() {
  if (activeReaderId) return activeReaderId;
  const readers = await listReaders();
  const paired = readers.find((r) => r.status === 'PAIRED' || r.status === 'PROCESSING');
  if (paired) {
    activeReaderId = paired.id;
    return activeReaderId;
  }
  throw new Error('No PAIRED reader found and SUMUP_READER_ID is not set in .env');
}

export function startOpiServer() {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[OPI] POS connected (${remote})`);

    const onData = createFrameReader(
      (xml) => handleMessage(socket, xml, remote),
      (err) => console.error(`[OPI] Frame error: ${err.message}`)
    );

    socket.on('data', onData);
    socket.on('close', () => console.log(`[OPI] POS disconnected (${remote})`));
    socket.on('error', (err) => console.error(`[OPI] Socket error: ${err.message}`));
  });

  server.listen(OPI_PORT, '0.0.0.0', () => {
    console.log(`[OPI] Listening on 0.0.0.0:${OPI_PORT}`);
  });
}

const SERVICE_TYPES = new Set(['Login', 'Reconciliation', 'ReconciliationWithClosure', 'Logout']);
const CARD_TYPES = new Set(['CardPayment', 'PaymentRefund']);

// Map request IDs to AbortControllers and Reader IDs
const activePayments = new Map();

async function handleMessage(socket, xml, remote) {
  const req = detectRequest(xml);
  const { raw, ...reqDump } = req; // Omit the raw XML from the console dump
  console.log(`\n[OPI] --- Incoming Request ---`);
  console.log(reqDump);
  console.log(`------------------------------\n`);
  console.log(`[OPI] Received ${req.requestType} (ReqID: ${req.requestId}) from ${remote}`);

  let posHost = normalizeHost(req.applicationSender);
  if (posHost === '10.0.2.15' || posHost === '127.0.0.1') {
    const remoteIp = socket.remoteAddress;
    posHost = remoteIp.includes(':') ? remoteIp.split(':').pop() : remoteIp;
  }

  let batteryPrefix = '';

  try {
    if (SERVICE_TYPES.has(req.requestType)) {
      const response = serviceResponse({
        requestId: req.requestId,
        requestType: req.requestType,
        workstationId: req.workstationId,
      });
      socket.write(encodeMessage(response));
      return;
    }

    if (req.requestType === 'AbortRequest') {
      const paymentInfo = activePayments.get(req.requestId) || Array.from(activePayments.values())[0];
      if (paymentInfo) {
        try {
          console.log(`[OPI] Terminating checkout for reader ${paymentInfo.readerId}...`);
          await terminateCheckout(paymentInfo.readerId);
        } catch (e) {
          console.error(`[OPI] Failed to terminate checkout: ${e.message}`);
        }
      }
      const response = cardServiceResponse({
        requestId: req.requestId,
        requestType: 'AbortRequest',
        workstationId: req.workstationId,
        overallResult: 'Aborted',
        amount: req.amount || '0.00',
        currency: req.currency || 'EUR',
        message: 'Vorgang abgebrochen',
      });
      socket.write(encodeMessage(response));
      return;
    }

    if (CARD_TYPES.has(req.requestType)) {
      const readerId = await getTargetReader();

      try {
        const status = await getReaderStatus(readerId);
        if (status && status.battery_level !== undefined) {
          batteryPrefix = `[Bat: ${status.battery_level}%] `;
        }
      } catch (err) {
        console.error(`[OPI] Failed to get reader status for battery: ${err.message}`);
      }

      const amountValue = parseFloat(req.amount);
      if (isNaN(amountValue)) {
        throw new Error(`Invalid amount: ${req.amount}`);
      }
      
      const minorUnit = 2;
      const value = Math.round(amountValue * Math.pow(10, minorUnit));
      
      console.log(`[OPI] Starting Checkout on reader ${readerId} for ${req.amount} ${req.currency}`);

      let descParts = [];
      if (req.receiptNumber) descParts.push(`Receipt: ${req.receiptNumber}`);
      if (req.transactionId) descParts.push(`TX: ${req.transactionId}`);
      if (req.cashierId) descParts.push(`Cashier: ${req.cashierId}`);
      if (descParts.length === 0) descParts.push(`POS-ReqID-${req.requestId}`);
      const checkoutDesc = descParts.join(' | ');

      const checkoutRes = await createCheckout(readerId, {
        value,
        currency: req.currency || 'EUR',
        minorUnit,
        description: checkoutDesc,
        returnUrl: webhookUrl,
      });

      const clientTxId = checkoutRes.client_transaction_id;
      
      if (posHost) {
        try {
          await sendDeviceOutput({
            posHost,
            posPort: DEVICE_PORT,
            applicationSender: 'SUMUP-BRIDGE',
            workstationId: req.workstationId,
            target: 'CashierDisplay',
            requestId: `${req.requestId}-d0`,
            sequenceId: '0',
            text: `${batteryPrefix}Verbinde mit Kartenleser...\nTX: ${clientTxId.split('-')[0]}`,
          });
          console.log(`[OPI] Display updated on POS (${posHost}) with TX: ${clientTxId}`);
        } catch (e) {
          console.log(`[OPI] Failed to update POS display: ${e.message}`);
        }
      }

      activePayments.set(req.requestId, { readerId, clientTxId });

      try {
        const { winner } = await waitForPaymentResult(
          clientTxId, 
          webhookUrl, 
          () => new Date().toISOString(), // dummy elapsed function
          (attempt, status) => {
            console.log(`[OPI] Poll attempt ${attempt}: ${status}`);
            const remaining = 45 - (attempt * 5); // Attempt 1 -> 40, Attempt 9 -> 0
            if (remaining <= 0) {
              console.log(`[OPI] Countdown reached 0. Aborting checkout on reader ${readerId}...`);
              terminateCheckout(readerId).catch(() => {});
              if (posHost) {
                sendDeviceOutput({
                  posHost,
                  posPort: DEVICE_PORT,
                  applicationSender: 'SUMUP-BRIDGE',
                  workstationId: req.workstationId,
                  target: 'CashierDisplay',
                  requestId: `${req.requestId}-d0`,
                  sequenceId: '0',
                  text: `${batteryPrefix}Abbruch...`,
                }).catch(() => {});
              }
            } else if (posHost) {
              sendDeviceOutput({
                posHost,
                posPort: DEVICE_PORT,
                applicationSender: 'SUMUP-BRIDGE',
                workstationId: req.workstationId,
                target: 'CashierDisplay',
                requestId: `${req.requestId}-d0`,
                sequenceId: '0',
                text: `${batteryPrefix}Warte ${remaining} ...`,
              }).catch(() => {});
            }
          }
        );

        const status = winner.data.status || 'FAILED';
        let overallResult = 'Failure';
        let message = '';
        let stan = winner.data.transaction_code;
        let approvalCode = winner.data.auth_code;
        
        if (status === 'SUCCESSFUL') {
          overallResult = 'Success';
          
          if (posHost) {
            try {
              const deviceRes = await sendPaymentDeviceRequests({
                posHost,
                posPort: DEVICE_PORT,
                workstationId: req.workstationId,
                payment: {
                  requestId: req.requestId,
                  amount: req.amount,
                  currency: req.currency,
                  stan,
                  approvalCode,
                },
              });
              console.log(`[OPI] POS receipt sent. (${deviceRes.results.map(r => r.ok ? 'OK' : 'ERR').join(', ')})`);
            } catch (err) {
              console.error(`[OPI] POS receipt push failed: ${err.message}`);
            }
          }
        } else if (status === 'CANCELLED') {
          overallResult = 'Aborted';
          message = 'Vorgang abgebrochen';
        } else {
          overallResult = 'Failure';
          message = 'Zahlung fehlgeschlagen';
        }

        const response = cardServiceResponse({
          requestId: req.requestId,
          requestType: req.requestType,
          workstationId: req.workstationId,
          overallResult,
          amount: req.amount,
          currency: req.currency,
          message,
          stan,
          approvalCode,
        });

        socket.write(encodeMessage(response));
        console.log(`[OPI] Payment ${status} -> ${overallResult}`);

      } finally {
        activePayments.delete(req.requestId);
      }

      return;
    }

    const fallback = serviceResponse({
      requestId: req.requestId,
      requestType: req.requestType || 'Unknown',
      workstationId: req.workstationId,
      overallResult: 'Failure',
    });
    socket.write(encodeMessage(fallback));

  } catch (err) {
    console.error(`[OPI] Error processing request ${req.requestId}:`, err.message);

    let displayText = 'Ein Fehler ist aufgetreten.';
    if (err.message.includes('pending checkout') || err.message.includes('Reader Busy')) {
      displayText = 'Leser ist belegt.\nBitte warten...';
    }

    if (posHost) {
      sendDeviceOutput({
        posHost,
        posPort: DEVICE_PORT,
        applicationSender: 'SUMUP-BRIDGE',
        workstationId: req.workstationId,
        target: 'CashierDisplay',
        requestId: `${req.requestId}-err`,
        sequenceId: '0',
        text: batteryPrefix + displayText,
      }).catch(() => {});
    }

    const errResp = cardServiceResponse({
      requestId: req.requestId,
      requestType: req.requestType || 'Unknown',
      workstationId: req.workstationId,
      overallResult: 'Failure',
      amount: req.amount || '0.00',
      message: displayText.replace('\n', ' '),
    });
    socket.write(encodeMessage(errResp));
  }
}

// Start immediately if run directly
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startWebhookServer();
  startOpiServer();
}
