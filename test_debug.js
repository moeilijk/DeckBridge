const WebSocket = require('ws');
const WS_PORT = 42809;
const CONTEXT = '481b4da4-1fac-43cc-adcb-72fc7f3e5f07';
const ACTION  = 'com.moeilijk.lhm.composite';
const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

ws.on('open', () => {
  console.log('[open] registering PI');
  ws.send(JSON.stringify({ event: 'registerPropertyInspector', uuid: CONTEXT }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.event === 'sendToPropertyInspector') {
    const pl = msg.payload || {};
    if (pl.compositeSettings) {
      console.log('[compositeSettings] smoothingAlpha:', pl.compositeSettings.smoothingAlpha);
    }
  }
});

// After 1s, send smoothingAlpha=0.5
setTimeout(() => {
  console.log('[send] smoothingAlpha=0.5');
  ws.send(JSON.stringify({
    event: 'sendToPlugin',
    context: CONTEXT,
    action: ACTION,
    payload: { sdpi_collection: { key: 'smoothingAlpha', value: '0.5' } }
  }));
}, 1000);

// After 3s, re-register PI
setTimeout(() => {
  console.log('[re-register] PI');
  ws.send(JSON.stringify({ event: 'registerPropertyInspector', uuid: CONTEXT }));
}, 3000);

setTimeout(() => { ws.close(); process.exit(0); }, 6000);
