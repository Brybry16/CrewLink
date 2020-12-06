'use strict'

import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { format as formatUrl } from 'url';
import './hook';

const isDevelopment = process.env.NODE_ENV !== 'production';

// global reference to mainWindow (necessary to prevent window from being garbage collected)
let mainWindow: BrowserWindow | null;

if (isDevelopment) {
	app.commandLine.appendSwitch('remote-debugging-port', '9222');
	app.commandLine.appendSwitch('userDataDir', 'true');
}
app.commandLine.appendSwitch('disable-pinch');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	// app.disableHardwareAcceleration();
	//autoUpdater.checkForUpdatesAndNotify();
	app.on('second-instance', (event, commandLine, workingDirectory) => {
		// Someone tried to run a second instance, we should focus our window.
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});

	let defaultWidth = /*250*/275/*300*/;
	let defaultHeight = /*350*/396;

	function createMainWindow() {
		const window = new BrowserWindow({
			width: defaultWidth,
			height: defaultHeight,
			resizable: false,
			/*minWidth:250,
			maxWidth: 250,
			minHeight: 350,
			resizable: true,*/
			frame: false,
			fullscreenable: false,
			maximizable: false,
			transparent: true,
			backgroundColor: '#00FFFFFF', // Needs to be specified so that dev tools won't revert background color to white and break transparency.
			webPreferences: {
				nodeIntegration: true,
				enableRemoteModule: true,
				webSecurity: false
			}
		});

		if (isDevelopment) {
			window.webContents.openDevTools();

			window.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=${autoUpdater.currentVersion.version}`);
		}
		else {
			window.loadURL(formatUrl({
				pathname: path.join(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: autoUpdater.currentVersion.version
				},
				slashes: true
			}));
		}

		window.on('closed', () => {
			mainWindow = null
		});

		window.webContents.on('devtools-opened', () => {
			window.focus();
			setImmediate(() => {
				window.focus();
			});
		});

		return window
	}

	// quit application when all windows are closed
	app.on('window-all-closed', () => {
		// on macOS it is common for applications to stay open until the user explicitly quits
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});

	app.on('activate', () => {
		// on macOS it is common to re-create a window even after all windows have been closed
		if (mainWindow === null) {
			mainWindow = createMainWindow();
		}
	});

	// create main BrowserWindow when electron is ready
	app.on('ready', () => {
		mainWindow = createMainWindow();
	});

	ipcMain.on('toggleOverlay', (_: any, on: boolean) => {
		if (!mainWindow) return;
		
		let height = on ? defaultHeight + 241 : defaultHeight;

		if (height === mainWindow.getContentSize()[1]) return;

		mainWindow.setContentSize(defaultWidth, height);
	});
}