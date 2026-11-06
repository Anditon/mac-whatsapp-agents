// n8n Code node "Extract & Validate" from the workflow "Automation 2 — QR Walk-In".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

const body = $input.first().json;
const firstName = (body['First Name / Voornaam'] || '').trim();
const lastName = (body['Last Name / Achternaam'] || '').trim();
const rawPhone = (body['Phone / Telefoon (incl. country code, e.g. +31612345678)'] || '').trim();
const email = (body['Email'] || '').trim().toLowerCase();
const interestRaw = (body["What are you interested in? / Wat interesseert je?"] || '').trim();
const languageRaw = (body['Language / Taal'] || '').trim();

// Phone normalization — same rules as the /addlead endpoint.
// This node used to THROW when the number didn't start with "+", which lost the whole
// walk-in (no Airtable contact, no WhatsApp) for anyone typing the normal Dutch local
// form 06xxxxxxxx (real case: 2026-08-06, exec 666995). Now we normalize instead.
// Order matters: drop the "(0)" trunk-zero notation FIRST — a plain separator strip
// keeps that 0 and produces an undialable +3106... number.
// Phones/iOS wrap a copied number in INVISIBLE bidi marks (U+202A...U+202C) and use
// non-breaking spaces. JS \s strips the nbsp but NOT the bidi marks, so "+49 176 ..."
// survived as an invalid number, was stored raw, and could never be messaged from the
// inbox ("Send Template" appeared broken, reported 2026-09-13). Strip them FIRST.
let phone = rawPhone.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim()
  .replace(/\(0\)/g, '').replace(/[\s().\-]/g, '');
if (/^00\d+$/.test(phone)) phone = '+' + phone.slice(2);          // 0031... -> +31...
if (/^\+310\d+$/.test(phone)) phone = '+31' + phone.slice(4);     // repair kept NL trunk zero
if (/^06\d{8}$/.test(phone)) phone = '+31' + phone.slice(1);      // 06xxxxxxxx -> +316xxxxxxxx
if (/^6\d{8}$/.test(phone)) phone = '+31' + phone;                // 6xxxxxxxx -> NL mobile, trunk 0 omitted
if (/^[1-9]\d{9,14}$/.test(phone)) phone = '+' + phone;           // bare international, no +
const phoneValid = /^\+[1-9]\d{7,14}$/.test(phone);

const interestMap = {
  'General Fitness / Algemene fitness': 'Group Lessons',
  'Classes / Lessen': 'Group Lessons',
  'Yoga': 'Yoga',
  'Aerial Yoga': 'Aerial Yoga',
  'Personal Training': 'Personal Coaching'
};
const airtableClass = interestMap[interestRaw] || '';

// Never throw on a bad number: a foreign local format has no safely guessable country
// code, but the lead is still worth keeping. Store what they typed and flag it in the
// Interest field the front desk reads, so it can be corrected by hand.
let interest = interestRaw;
if (!phoneValid) {
  phone = rawPhone;
  interest = '⚠️ Telefoonnummer ongeldig / zonder landcode: "' + rawPhone + '" — handmatig controleren'
    + (interestRaw ? ' | ' + interestRaw : '');
}

const language = languageRaw === 'Nederlands' ? 'nl' : 'en';
const languageCode = language === 'nl' ? 'nl' : 'en_US';
const languageAirtable = language === 'nl' ? 'NL' : 'EN';

return [{ json: { firstName, lastName, phone, phoneValid, phoneOriginal: rawPhone, email, interest, airtableClass, language, languageCode, languageAirtable, source: 'QR Walk-In', status: 'Lead' } }];

