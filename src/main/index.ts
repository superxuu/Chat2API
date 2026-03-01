import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { writeFileSync, appendFileSync } from 'fs'
import { createWindow, getMainWindow, loadUrl, loadFile, openDevTools } from './window/manager'
import { createTray, updateTrayIcon, destroyTray } from './tray'
import { registerIpcHandlers } from './ipc/handlers'
import { initializeStore } from './store'

// Simple file logger for debugging startup issues
const logPath = join(homedir(), 'chat2api_startup.log')
function log(message: string) {
  try {
    const timestamp = new Date().toISOString()
    appendFileSync(logPath, `[${timestamp}] ${message}\n`)
  } catch (e) {
    // ignore
  }
}

// Clear log on startup
try {
  writeFileSync(logPath, '')
} catch (e) {}

log('App starting...')

// Automatically add --no-sandbox flag when running as root user
if (process.getuid && process.getuid() === 0) {
  console.log('Detected running as root user, sandbox settings have been automatically handled')
}

declare module 'electron' {
  interface App {
    isQuitting?: boolean
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  initializeApp()
}

async function initializeApp(): Promise<void> {
  app.on('ready', async () => {
    log('App ready event received')
    try {
      // Initialize store before doing anything else
      log('Initializing store...')
      await initializeStore()
      log('Store initialized')
      
      log('Setting up app...')
      await setupApp()
      log('App setup complete')
    } catch (error) {
      log(`Failed to initialize app: ${error}`)
      console.error('Failed to initialize app:', error)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      createWindow()
    } else {
      mainWindow.show()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    destroyTray()
  })

  app.on('will-quit', () => {
    cleanup()
  })
}

async function setupApp(): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'
  
  const mainWindow = createWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Chat2API',
    show: true, // Force show window to debug
  })

  await registerIpcHandlers(mainWindow)

  createTray(mainWindow)

  await loadAppContent(mainWindow)

  if (isDev) {
    openDevTools()
  }
}

async function loadAppContent(mainWindow: BrowserWindow): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    try {
      await loadUrl('http://localhost:5173')
    } catch (error) {
      console.error('Failed to load development server:', error)
    }
  } else {
    try {
      await loadFile(join(__dirname, '../renderer/index.html'))
    } catch (error) {
      console.error('Failed to load production files:', error)
    }
  }
}

function cleanup(): void {
  console.log('Application is exiting, performing cleanup...')
}

export function restartApp(): void {
  app.relaunch()
  app.quit()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function isAppQuitting(): boolean {
  return app.isQuitting ?? false
}

export { getMainWindow }
