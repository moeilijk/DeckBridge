'use strict';
const WebSocket = require('ws');
const WS_PORT = 42809;
const CONTEXT = '481b4da4-1fac-43cc-adcb-72fc7f3e5f07';
const ACTION  = 'com.moeilijk.lhm.composite';

const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
ws.on('open', () => ws.send(JSON.stringify({ event: 'registerPropertyInspector', uuid: CONTEXT })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.event !== 'sendToPropertyInspector') return;
  const pl = msg.payload || {};
  if (pl.compositeSettings) {
    console.log('[compositeSettings] received');
    // add threshold
    setTimeout(() => {
      console.log('[send] slot0_addThreshold');
      ws.send(JSON.stringify({
        event: 'sendToPlugin', context: CONTEXT, action: ACTION,
        payload: { sdpi_collection: { key: 'slot0_addThreshold', value: 'Test' } }
      }));
    }, 300);
  }
  if (pl.slotThresholds !== undefined) {
    console.log('[slotThresholds RAW payload]:', JSON.stringify(pl, null, 2));
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
