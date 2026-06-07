import 'server-only';

import { google } from 'googleapis';

// Server-side only — this module must never be imported from client components.

function getCredentials(): object {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (!raw) {
    throw new Error(
      'Missing env var: GOOGLE_SERVICE_ACCOUNT_KEY_JSON. ' +
        'Set it to the minified JSON of your service account key file.'
    );
  }
  try {
    return JSON.parse(raw) as object;
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not valid JSON. ' +
        'Ensure the value is the raw (minified) contents of the key file.'
    );
  }
}

function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SHEETS_ID;
  if (!id) {
    throw new Error(
      'Missing env var: GOOGLE_SHEETS_ID. ' +
        'Set it to the spreadsheet ID from the Google Sheets URL.'
    );
  }
  return id;
}

// Singleton auth + sheets client — created once per server process.
let sheetsClient: ReturnType<typeof google.sheets> | null = null;

function getSheetsClient(): ReturnType<typeof google.sheets> {
  if (sheetsClient) return sheetsClient;

  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/**
 * Reads all data rows from a named sheet tab.
 * Returns a 2-D array of strings; the header row is skipped.
 * Missing cells in a row are returned as empty strings.
 */
export async function getRows(tab: string): Promise<string[][]> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tab,
  });

  const rows = response.data.values ?? [];
  // Skip header row (index 0).
  return rows.slice(1).map((row) =>
    // Ensure every element is a string (Sheets can return numbers, etc.).
    (row as unknown[]).map((cell) =>
      cell === null || cell === undefined ? '' : String(cell)
    )
  );
}

/**
 * Appends one row to the end of a named sheet tab.
 */
export async function appendRow(tab: string, values: unknown[]): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: tab,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [values],
    },
  });
}

/**
 * Updates the row at the given 1-based data row index (i.e. rowIndex 1 is the
 * first data row, which lives at spreadsheet row 2 because row 1 is the header).
 */
export async function updateRow(
  tab: string,
  rowIndex: number,
  values: unknown[]
): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  // Spreadsheet row = rowIndex + 1 (offset for the header row).
  const spreadsheetRow = rowIndex + 1;
  const range = `${tab}!A${spreadsheetRow}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [values],
    },
  });
}
