/**
 * Deploy as a Google Apps Script web app for Career applications.
 * Set the deployed URL in GOOGLE_SHEETS_WEBHOOK_URL.
 *
 * Sheet columns (row 1 headers):
 * Full Name | Email | Phone | Position | CV File Name | CV URL | Submitted At
 *
 * Google Sheets treats values starting with +, =, -, or @ as formulas (#ERROR!).
 * Always prefix phone numbers with a single quote before writing to the sheet.
 */

function formatPhoneForSheet(phone) {
  const str = String(phone || '').trim();
  if (!str) return '';
  return str.charAt(0) === "'" ? str : "'" + str;
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1') ||
      SpreadsheetApp.getActiveSheet();

    sheet.appendRow([
      data.fullName || '',
      data.email || '',
      formatPhoneForSheet(data.phone),
      data.position || '',
      data.cvOriginalFileName || data.cvFileName || '',
      data.cvUrl || '',
      new Date(),
    ]);

    return ContentService.createTextOutput(
      JSON.stringify({ success: true })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: error.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
