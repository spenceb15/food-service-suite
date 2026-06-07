# Google Sheets Setup Guide

Follow these steps to connect the app to Google Sheets as the v0 datastore.

---

## 1. Create a GCP Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click "Select a project" > "New Project".
3. Give it a name (e.g. `food-service-suite`) and click "Create".

---

## 2. Enable the Google Sheets API

1. In the GCP Console, navigate to "APIs & Services" > "Library".
2. Search for "Google Sheets API" and click it.
3. Click "Enable".

---

## 3. Create a Service Account and Download the Key

1. Navigate to "APIs & Services" > "Credentials".
2. Click "Create Credentials" > "Service account".
3. Enter a name (e.g. `sheets-writer`) and click "Create and Continue".
4. Skip role assignment for now (the sheet will be shared directly with this account). Click "Done".
5. Find the new service account in the list, click on it, go to the "Keys" tab.
6. Click "Add Key" > "Create new key" > JSON > "Create".
7. A `.json` file downloads automatically. **Keep it secret — never commit it.**

---

## 4. Set GOOGLE_SERVICE_ACCOUNT_KEY_JSON

Copy the full contents of the downloaded JSON key file and minify it to a single line (you can use `jq -c . key-file.json` or an online JSON minifier).

In your `.env.local` file:

```
GOOGLE_SERVICE_ACCOUNT_KEY_JSON={"type":"service_account","project_id":"..."}
```

The value must be the entire JSON object as a single string (no line breaks inside the value).

---

## 5. Create the Google Spreadsheet and Share It

1. Go to [Google Sheets](https://sheets.google.com/) and create a new blank spreadsheet.
2. Name it (e.g. `Food Service Suite — v0`).
3. Click "Share" (top right).
4. In the "Add people and groups" field, paste the `client_email` from your service account JSON key (e.g. `sheets-writer@your-project.iam.gserviceaccount.com`).
5. Set the permission to **Editor** and click "Send" (no notification needed).

---

## 6. Create Sheet Tabs with the Correct Column Headers

Add one tab per entity below. The first row of each tab must be the header row in the exact order shown. The app maps columns by position, not by name.

| Tab name | Column headers (in order) |
|---|---|
| `Items` | item_id, name, category, item_type, base_unit, barcode_sku, default_unit_cost, usda_commodity, allergens, nutrition_ref, default_vendor_id, active |
| `UnitConversions` | conversion_id, item_id, from_unit, base_qty_per_unit, label |
| `Recipes` | recipe_id, produced_item_id, yield_qty, yield_unit, serving_size |
| `RecipeComponents` | recipe_id, component_item_id, qty, unit |
| `Vendors` | vendor_id, name, type, contact, active |
| `Orders` | order_id, vendor_id, destination_location_id, order_date, expected_date, status |
| `OrderLines` | line_id, order_id, item_id, qty, unit, unit_cost |
| `Locations` | location_id, name, client_type, address, active |
| `Lots` | lot_id, item_id, location_id, received_date, expiration_date, original_qty, remaining_qty, unit_cost, source_ref |
| `Transactions` | txn_id, timestamp, item_id, location_id, lot_id, qty_base, txn_type, ref_type, ref_id, unit_cost, user_id, note |
| `Transfers` | transfer_id, from_location_id, to_location_id, status, requested_by, approved_by, received_by, request_date, ship_date, receive_date |
| `TransferLines` | line_id, transfer_id, item_id, qty, unit |
| `Receipts` | receipt_id, order_id, source, location_id, receipt_date, received_by |
| `ReceiptLines` | line_id, receipt_id, item_id, qty_received, unit, unit_cost, expiration_date |
| `LaborHours` | labor_id, location_id, date, hours, entered_by |
| `Users` | user_id, name, email, role, assigned_location_ids |

---

## 7. Set GOOGLE_SHEETS_ID

The spreadsheet ID is the long string of letters and numbers in the URL:

```
https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit
```

Add it to `.env.local`:

```
GOOGLE_SHEETS_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
```

---

## 8. Verify the Connection

Run the dev server:

```bash
npm run dev
```

If the credentials and spreadsheet ID are correct, API routes that read from Sheets will return data (or empty arrays for empty tabs) without throwing auth errors.

---

## Security Notes

- `.env.local` is git-ignored. Never commit it.
- The service account key file itself should also never be committed. Add it to `.gitignore` if you save it locally.
- The service account only has access to sheets you explicitly share with it — it cannot access anything else in your Google account.
