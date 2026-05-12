// Phase 3 test: #40 composite per-slot thresholds + #43 EMA smoothing
// Payload structure: pl.slotThresholds = { slotIndex: N, thresholds: [...] }
// add/remove/reorder get an immediate slotThresholds response.
// value/color updates are fire-and-forget; verify via reconnect + compositeSettings.
'use strict';
const WebSocket = require('ws');

const WS_PORT = 46535;
const CONTEXT  = '481b4da4-1fac-43cc-adcb-72fc7f3e5f07';
const ACTION   = 'com.moeilijk.lhm.composite';

function pass(msg) { console.log('[PASS]', msg); }
function fail(msg) { console.error('[FAIL]', msg); process.exit(1); }

function connectAndGetSettings() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    const timer = setTimeout(() => reject(new Error('timeout waiting for compositeSettings')), 8000);
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('open', () => ws.send(JSON.stringify({ event: 'registerPropertyInspector', uuid: CONTEXT })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.event !== 'sendToPropertyInspector') return;
      const pl = msg.payload || {};
      if (pl.error) { clearTimeout(timer); reject(new Error('plugin error: ' + JSON.stringify(pl))); return; }
      if (pl.compositeSettings) { clearTimeout(timer); resolve({ ws, settings: pl.compositeSettings }); }
    });
  });
}

function sdpi(ws, key, value, thresholdId) {
  const col = { key, value };
  if (thresholdId !== undefined) col.thresholdId = thresholdId;
  ws.send(JSON.stringify({ event: 'sendToPlugin', context: CONTEXT, action: ACTION, payload: { sdpi_collection: col } }));
}

function waitSlotThresholds(ws, expectedSlotIdx, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for slotThresholds slotIdx=${expectedSlotIdx}`)), timeoutMs);
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.event !== 'sendToPropertyInspector') return;
      const pl = msg.payload || {};
      if (pl.slotThresholds !== undefined && pl.slotThresholds.slotIndex === expectedSlotIdx) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve({ slotIdx: pl.slotThresholds.slotIndex, thresholds: pl.slotThresholds.thresholds || [] });
      }
    };
    ws.on('message', handler);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  let ws, settings;

  // ── cleanup: remove leftover thresholds from prior test runs ──────────────
  console.log('[cleanup] removing leftover thresholds on slots 0+1');
  ({ ws, settings } = await connectAndGetSettings());
  for (let slotIdx = 0; slotIdx <= 1; slotIdx++) {
    const thresholds = settings.slots?.[slotIdx]?.thresholds || [];
    for (const t of thresholds) {
      const p = waitSlotThresholds(ws, slotIdx);
      sdpi(ws, `slot${slotIdx}_removeThreshold`, '', t.id);
      await p;
    }
  }
  ws.close();
  await sleep(200);

  // ── #43: smoothingAlpha save ───────────────────────────────────────────────
  console.log('[step 0] get compositeSettings');
  ({ ws, settings } = await connectAndGetSettings());
  pass('step 0 — compositeSettings received, slots: ' + settings.slots?.length + ', smoothingAlpha: ' + settings.smoothingAlpha);
  if (!('smoothingAlpha' in settings)) fail('smoothingAlpha field missing');
  ws.close();
  await sleep(200);

  console.log('[step 1] write smoothingAlpha=0.5');
  ({ ws } = await connectAndGetSettings());
  sdpi(ws, 'smoothingAlpha', '0.5');
  await sleep(500);
  ws.close();
  await sleep(200);

  ({ ws, settings } = await connectAndGetSettings());
  if (Math.abs(settings.smoothingAlpha - 0.5) > 0.001) {
    fail('step 1 — smoothingAlpha not persisted, got ' + settings.smoothingAlpha);
  }
  pass('step 1 — smoothingAlpha saved as ' + settings.smoothingAlpha);
  sdpi(ws, 'smoothingAlpha', '1'); // reset to 1
  await sleep(200);

  // ── #40: threshold CRUD on slot 0 ─────────────────────────────────────────
  console.log('[step 2] add threshold to slot 0');
  const add0P = waitSlotThresholds(ws, 0);
  sdpi(ws, 'slot0_addThreshold', 'TestThreshold');
  const add0 = await add0P;
  if (add0.thresholds.length !== 1) fail('step 2 — expected 1 threshold, got ' + add0.thresholds.length);
  const tid0 = add0.thresholds[0].id;
  pass('step 2 — threshold added to slot 0, id=' + tid0);

  // update value + color (fire-and-forget; verify via reconnect)
  console.log('[step 3] update threshold value=75 + backgroundColor=#ff0000');
  sdpi(ws, 'slot0_thresholdValue', '75', tid0);
  sdpi(ws, 'slot0_thresholdBackgroundColor', '#ff0000', tid0);
  await sleep(500);
  ws.close();
  await sleep(200);

  ({ ws, settings } = await connectAndGetSettings());
  const t3 = settings.slots?.[0]?.thresholds?.find(x => x.id === tid0);
  if (!t3) fail('step 3 — threshold not found after reconnect');
  if (Math.abs(t3.value - 75) > 0.001) fail('step 3 — value not persisted, got ' + t3.value);
  if (t3.backgroundColor !== '#ff0000') fail('step 3 — backgroundColor not persisted, got ' + t3.backgroundColor);
  pass('step 3 — value=' + t3.value + ' backgroundColor=' + t3.backgroundColor + ' persisted');

  // ── #40: threshold on slot 1 ───────────────────────────────────────────────
  console.log('[step 4] add threshold to slot 1');
  const add1P = waitSlotThresholds(ws, 1);
  sdpi(ws, 'slot1_addThreshold', 'Slot1Threshold');
  const add1 = await add1P;
  if (add1.slotIdx !== 1 || add1.thresholds.length !== 1) {
    fail('step 4 — expected 1 threshold on slot 1, got slotIdx=' + add1.slotIdx + ' len=' + add1.thresholds.length);
  }
  const tid1 = add1.thresholds[0].id;
  pass('step 4 — threshold added to slot 1, id=' + tid1);

  // ── #40: remove slot 0 threshold ──────────────────────────────────────────
  console.log('[step 5] remove slot 0 threshold');
  const rem0P = waitSlotThresholds(ws, 0);
  sdpi(ws, 'slot0_removeThreshold', '', tid0);
  const rem0 = await rem0P;
  if (rem0.slotIdx !== 0 || rem0.thresholds.length !== 0) {
    fail('step 5 — slot 0 not empty, slotIdx=' + rem0.slotIdx + ' len=' + rem0.thresholds.length);
  }
  pass('step 5 — slot 0 empty after remove');

  // ── #40: remove slot 1 threshold ──────────────────────────────────────────
  console.log('[step 6] remove slot 1 threshold');
  const rem1P = waitSlotThresholds(ws, 1);
  sdpi(ws, 'slot1_removeThreshold', '', tid1);
  const rem1 = await rem1P;
  if (rem1.slotIdx !== 1 || rem1.thresholds.length !== 0) {
    fail('step 6 — slot 1 not empty, slotIdx=' + rem1.slotIdx + ' len=' + rem1.thresholds.length);
  }
  pass('step 6 — slot 1 empty after remove');

  ws.close();
  console.log('');
  console.log('=== ALL TESTS PASSED ===');
  process.exit(0);
}

run().catch(e => fail(e.message));
