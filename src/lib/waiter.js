import http from 'node:http';
import chalk from 'chalk';
import { getTransaction } from './transactions.js';

const pendingWebhooks = new Map();
let globalWebhookServer = null;

export function startWebhookServer() {
  if (globalWebhookServer) return;
  const port = parseInt(process.env.WEBHOOK_PORT ?? '58180', 10);
  globalWebhookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
      let data;
      try { data = JSON.parse(body); } catch { data = { raw: body }; }
      
      const ctid = data?.payload?.client_transaction_id;
      if (ctid && pendingWebhooks.has(ctid)) {
        const resolve = pendingWebhooks.get(ctid);
        resolve({ source: 'webhook', data });
      }
    });
  });
  globalWebhookServer.listen(port, '127.0.0.1', () => {});
  // Unref the server so it doesn't keep the Node event loop alive if everything else exits
  globalWebhookServer.unref();
}

/**
 * Wait for the global webhook server to receive a POST for this clientTransactionId.
 */
export function waitForWebhook(clientTxId, elapsed, signal, timeoutMs = 5 * 60 * 1000) {
  startWebhookServer();

  return new Promise((resolve, reject) => {
    pendingWebhooks.set(clientTxId, (result) => {
      pendingWebhooks.delete(clientTxId);
      clearTimeout(timer);
      if (elapsed) {
        console.log(`  ${chalk.gray(elapsed())}  ${chalk.magenta('webhook')}  →  ${chalk.bold('received')}`);
      }
      resolve(result);
    });

    const timer = setTimeout(() => {
      pendingWebhooks.delete(clientTxId);
      reject(new Error('Timed out waiting for webhook'));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        pendingWebhooks.delete(clientTxId);
        clearTimeout(timer);
      });
    }
  });
}

/**
 * Poll the Transactions API every 10 seconds until a terminal status is reached.
 */
export function pollTransaction(clientTransactionId, onAttempt, signal, timeoutMs = 5 * 60 * 1000) {
  const TERMINAL = new Set(['SUCCESSFUL', 'FAILED', 'CANCELLED', 'REFUNDED']);
  let forcePoll;
  const promise = new Promise((resolve, reject) => {
    let interval;
    let attempt = 0;
    const attemptFetch = async () => {
      attempt++;
      try {
        const tx = await getTransaction({ clientTransactionId });
        if (aborted) return; // Prevent logging if aborted while the request was in-flight
        
        const status = String(tx?.status ?? 'unknown');
        if (onAttempt) onAttempt(attempt, status);
        
        if (TERMINAL.has(status.toUpperCase())) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve({ source: 'poll', data: tx });
        }
      } catch (err) {
        if (aborted) return; // Prevent error logging if aborted in-flight
        if (onAttempt) onAttempt(attempt, `error: ${err.message}`);
      }
    };

    let aborted = false;

    interval = setInterval(attemptFetch, 5_000);
    forcePoll = () => {
      if (aborted) return;
      clearInterval(interval);
      attemptFetch();
      interval = setInterval(attemptFetch, 5_000);
    };

    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Polling timed out'));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
        clearInterval(interval);
        clearTimeout(timer);
      });
    }
  });

  // Attach the manual trigger to the promise
  promise.force = forcePoll;
  return promise;
}

export async function waitForPaymentResult(clientTxId, webhookUrl, elapsed, onPollAttempt) {
  const abortController = new AbortController();
  const webhookPromise = webhookUrl ? waitForWebhook(clientTxId, elapsed, abortController.signal) : null;
  const pollPromise = pollTransaction(clientTxId, onPollAttempt, abortController.signal);

  const raceable = [pollPromise];
  if (webhookPromise) raceable.push(webhookPromise);

  try {
    let winner = await Promise.race(raceable);
    abortController.abort(); // Cancel the loser

    // Webhook arrived first — enrich with full TX details from the API
    if (winner.source === 'webhook') {
      const webhookPayload = winner.data;
      const ctid = webhookPayload?.payload?.client_transaction_id ?? clientTxId;
      try {
        const tx = await getTransaction({ clientTransactionId: ctid });
        winner = { source: 'webhook', data: tx }; // preserve original source for the UI
      } catch {
        // TX lookup failed — fall back to webhook envelope display
      }
    }

    return { winner, forcePoll: pollPromise.force, abortController };
  } catch (err) {
    abortController.abort();
    throw err;
  }
}
