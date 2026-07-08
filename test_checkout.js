import { createCheckout } from './src/lib/readers.js';
import 'dotenv/config';

async function test() {
  try {
    const res = await createCheckout(process.env.SUMUP_READER_ID || 'rdr_1YV5VX1PVY8VV8GMT5DJ43HQCV', {
      value: 100,
      currency: 'EUR',
      tipRates: [0.01],
      tipTimeout: 30
    });
    console.log("Success:", res);
  } catch (err) {
    console.error("Error with [0.01]:", err.message);
  }

  try {
    const res = await createCheckout(process.env.SUMUP_READER_ID || 'rdr_1YV5VX1PVY8VV8GMT5DJ43HQCV', {
      value: 100,
      currency: 'EUR',
      tipRates: [0.1, 0.15, 0.2],
      tipTimeout: 30
    });
    console.log("Success:", res);
  } catch (err) {
    console.error("Error with [0.1, 0.15, 0.2]:", err.message);
  }
}
test();
