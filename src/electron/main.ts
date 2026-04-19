import { app, BrowserWindow, Menu, shell } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'

let mainWindow: BrowserWindow | null = null
let coreProcess: ChildProcess | null = null
let coreExitTimer: NodeJS.Timeout | null = null
let isQuitting = false

const repoRoot = join(__dirname, '..', '..')
const coreEntry = join(repoRoot, 'dist', 'index.js')

function loadingHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeckBridge</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #111315;
      color: #eef2f5;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: grid;
      place-items: center;
    }
    main {
      width: min(680px, calc(100vw - 48px));
      border: 1px solid #303841;
      border-radius: 8px;
      background: #181c20;
      padding: 22px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .28);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 16px;
      color: #8d98a5;
      line-height: 1.45;
    }
    pre {
      margin: 0;
      height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      border-radius: 7px;
      border: 1px solid #303841;
      background: #0f1113;
      padding: 12px;
      color: #c8d1da;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
  <main>
    <h1>DeckBridge</h1>
    <p>Starting the core daemon and waiting for the local configuration UI.</p>
    <pre id="log"></pre>
  </main>
  <script>
    window.deckBridgeLog = function(line) {
      var log = document.getElementById('log');
      log.textContent += line + '\\n';
      log.scrollTop = log.scrollHeight;
    };
  </script>
</body>
</html>`
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    title: 'DeckBridge',
    backgroundColor: '#111315',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(console.error)
    return { action: 'deny' }
  })

  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`).catch(console.error)
  return window
}

function appendLog(line: string): void {
  console.log(line)
  mainWindow?.webContents.executeJavaScript(
    `window.deckBridgeLog && window.deckBridgeLog(${JSON.stringify(line)})`,
  ).catch(() => {})
}

function showFatal(message: string): void {
  appendLog(message)
  const html = loadingHtml().replace(
    'Starting the core daemon and waiting for the local configuration UI.',
    message.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] ?? char),
  )
  mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(console.error)
}

function startCore(): void {
  if (coreProcess) return

  const proc = spawn(process.env.DECKBRIDGE_NODE ?? 'node', [coreEntry], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  coreProcess = proc

  appendLog(`Starting core: node ${coreEntry}`)

  const dashboardPattern = /Dashboard:\s+(http:\/\/127\.0\.0\.1:\d+\/dashboard\?wsPort=\d+)/
  if (!proc.stdout || !proc.stderr) {
    showFatal('DeckBridge core did not expose stdout/stderr.')
    return
  }

  const stdout = createInterface({ input: proc.stdout })
  const stderr = createInterface({ input: proc.stderr })

  stdout.on('line', (line) => {
    appendLog(line)
    const match = line.match(dashboardPattern)
    if (match) {
      mainWindow?.loadURL(match[1]).catch((err) => showFatal(`Could not load dashboard: ${err.message}`))
    }
  })

  stderr.on('line', (line) => appendLog(line))

  proc.on('error', (err) => {
    coreProcess = null
    showFatal(`Could not start DeckBridge core: ${err.message}`)
  })

  proc.on('exit', (code, signal) => {
    coreProcess = null
    if (!isQuitting) {
      showFatal(`DeckBridge core stopped unexpectedly. Exit code: ${code ?? 'none'}, signal: ${signal ?? 'none'}.`)
    }
  })
}

function stopCore(): void {
  if (!coreProcess) return

  const proc = coreProcess
  coreProcess = null
  proc.kill('SIGINT')

  coreExitTimer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM')
  }, 4000)

  proc.once('exit', () => {
    if (coreExitTimer) {
      clearTimeout(coreExitTimer)
      coreExitTimer = null
    }
  })
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'DeckBridge',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]))
}

app.whenReady().then(() => {
  installMenu()
  mainWindow = createWindow()
  startCore()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      startCore()
    }
  })
}).catch(console.error)

app.on('before-quit', () => {
  isQuitting = true
  stopCore()
})

app.on('window-all-closed', () => {
  app.quit()
})
