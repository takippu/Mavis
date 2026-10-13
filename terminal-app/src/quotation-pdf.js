'use strict';
const document = require('./quotation-document');
async function createPDF(record, template = document) {
  template.checkRecord?.(record);
  template.ready(record.values);
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let timer;
  try {
    return await Promise.race([(async () => {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(template.render(record)));
      return win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: template.footer(record), margins: { top: .71, bottom: .71, left: .71, right: .71 } });
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PDF generation timed out. Try exporting again.')), 30000); })]);
  } finally { clearTimeout(timer); if (!win.isDestroyed()) win.destroy(); }
}
module.exports = { createPDF };
