import net from 'node:net';
import { encodeMessage, createFrameReader, deviceRequest, buildReceiptText } from './opi-protocol.js';

const DEVICE_TIMEOUT_MS = 5000;

export function normalizeHost(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '#CASHBOXNAME#') return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0];
}

export function sendDeviceOutput({ posHost, posPort, applicationSender, workstationId, text, target, requestId, sequenceId }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const xml = deviceRequest({
      applicationSender,
      requestId: requestId || String(Date.now()).slice(-8),
      workstationId,
      text,
      target,
      sequenceId,
    });

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`DeviceRequest timeout (${posHost}:${posPort}, ${target})`));
    }, DEVICE_TIMEOUT_MS);

    socket.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.connect(posPort, posHost, () => {
      socket.write(encodeMessage(xml));
    });

    const onData = createFrameReader(
      () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      },
      (err) => {
        clearTimeout(timeout);
        socket.destroy();
        reject(err);
      },
    );

    socket.on('data', onData);
  });
}

export async function sendPaymentDeviceRequests({ posHost, posPort, workstationId, payment }) {
  const sender = 'SUMUP-BRIDGE';
  const baseId = payment.requestId || '1';
  const stan = payment.stan || String(Date.now()).slice(-6);
  const approvalCode = payment.approvalCode || String(Math.floor(100000 + Math.random() * 900000));
  const receipt = buildReceiptText({
    stan,
    approvalCode,
    amount: payment.amount,
    currency: payment.currency,
    cardCircuit: 'VISA',
    cardPan: '************4242',
    requestId: baseId,
  });

  const steps = [
    {
      target: 'PrinterReceipt',
      requestId: `${baseId}-r1`,
      sequenceId: '2',
      text: receipt,
    },
  ];

  const results = [];
  for (const step of steps) {
    try {
      await sendDeviceOutput({
        posHost,
        posPort,
        applicationSender: sender,
        workstationId,
        target: step.target,
        requestId: step.requestId,
        sequenceId: step.sequenceId,
        text: step.text,
      });
      results.push({ target: step.target, ok: true, text: step.text });
    } catch (err) {
      results.push({ target: step.target, ok: false, error: err.message, text: step.text });
    }
  }

  return { stan, approvalCode, results };
}
