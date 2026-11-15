'use strict';
/**
 * The business the bot thinks it works for.
 *
 * The bot used to be hard-wired to one flooring shop: its trade, its towns,
 * its "free measure visit", even its field names lived inside the prompt. That
 * made the dashboard a demo of exactly one business.
 *
 * Everything that made it that shop now lives in settings, editable from the
 * dashboard. Each field falls back to config.business (the env vars) when it
 * is blank, so a deploy that has never opened the new screen behaves exactly
 * as it did before.
 *
 * The four flexible lead fields keep their original storage keys
 * (carpetType/room/size/colour) so existing Google Sheets and saved leads
 * still line up. Only their labels change.
 */

const config = require('./config');
const store = require('./store');

/** Storage keys for the four flexible fields, in label order. */
const FIELD_KEYS = ['carpetType', 'room', 'size', 'colour'];

/** Labels used when the profile doesn't set its own. */
const DEFAULT_FIELD_LABELS = ['Type', 'Area', 'Size', 'Preference'];

function lines(value) {
  return String(value || '')
    .split('\n')
    .map((s) => s.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Ready-made profiles. The dashboard offers these as a starting point; once
 * applied they are ordinary settings the owner can edit freely.
 */
const PRESETS = {
  clinic: {
    label: 'Beauty / cosmetics clinic',
    bizName: 'Alpha Kosmetik',
    bizWhat: 'a beauty and cosmetics clinic',
    bizServices: [
      'Facials and skin treatments',
      'Laser hair removal',
      'Anti-wrinkle and filler treatments',
      'Microneedling and skin needling',
      'Chemical peels',
      'Lash and brow treatments',
      'Body treatments and massage',
      'Skin consultations',
    ].join('\n'),
    bizAreas: '',
    bizCollect: [
      'Their first name',
      'Which treatment they are interested in',
      'Whether they have had this treatment before',
      'Which days and times generally suit them',
    ].join('\n'),
    bizOffer: 'Offer to book them a consultation or an appointment, and ask which days and times generally suit them.',
    bizRules: [
      'Never give medical advice, a diagnosis, or an opinion on whether a treatment is safe for them',
      'Never quote a price for a treatment',
      'Never confirm an appointment as booked - a member of the team confirms it',
      'Never discuss another client or anything said in another conversation',
    ].join('\n'),
    bizFieldLabels: 'Treatment, Area of concern, Sessions, Preference',
    // Clients come to the clinic, so a home address is not needed.
    bizNeedsAddress: false,
  },

  flooring: {
    label: 'Flooring / carpet shop',
    bizName: 'KSC Carpets',
    bizWhat: 'a family-run flooring retailer',
    bizServices: [
      'Carpets - wool & synthetic, stair runners, bedrooms',
      'LVT Flooring - luxury vinyl tile, wood & stone effects',
      'Laminate - hard-wearing, easy to live with',
      'Vinyl - sheet vinyl for kitchens & bathrooms',
      'Astroturf - artificial grass, gardens & play areas',
      'Commercial Flooring - offices, retail, hospitality contracts',
      'Underlay & Accessories - grippers, thresholds, premium underlay',
      'Screeding & Sub-floor Preparation',
      'Safety & Anti-Slip flooring - healthcare, education, care homes',
    ].join('\n'),
    bizAreas: 'Swansea, Bridgend, Carmarthen, Cardiff, Neath, Port Talbot, Llanelli, Pontypridd, Merthyr Tydfil',
    bizCollect: [
      'Their first name',
      'What kind of flooring they want, and which room',
      'Roughly what size the room is',
      'What colour they are interested in',
      'Roughly what budget they have in mind (fine if they would rather not say)',
    ].join('\n'),
    bizOffer: 'Offer a free measure and quote visit, and ask what day or time would generally suit them.',
    bizRules: [
      'Never quote a price yourself',
      'Never confirm a visit as booked - a member of the team confirms it',
      'Never invent stock or availability',
    ].join('\n'),
    bizFieldLabels: 'Flooring type, Room, Size, Colour',
    bizNeedsAddress: true,
  },

  generic: {
    label: 'General business (start blank)',
    bizName: '',
    bizWhat: 'a local business',
    bizServices: '',
    bizAreas: '',
    bizCollect: [
      'Their first name',
      'What they are looking for',
      'When they would like it',
    ].join('\n'),
    bizOffer: 'Offer to have a member of the team get back to them, and ask when suits.',
    bizRules: [
      'Never quote a price yourself',
      'Never confirm anything as booked - a member of the team confirms it',
    ].join('\n'),
    bizFieldLabels: 'Interest, Details, Amount, Preference',
    bizNeedsAddress: false,
  },
};

/**
 * The profile the bot should use right now: settings first, env second.
 * @returns {{
 *   name: string, what: string, services: string[], areas: string[],
 *   address: string, phone: string, website: string,
 *   collect: string[], offer: string, rules: string[],
 *   fieldLabels: string[], fields: {key: string, label: string}[],
 *   needsAddress: boolean
 * }}
 */
function profile() {
  const s = store.getSettings();
  const b = config.business || {};

  /* The env vars describe whatever business this deploy was first set up for.
   * They are the right fallback only while nobody has filled the profile in.
   * Once someone has, an empty box means empty - otherwise a clinic in Zürich
   * inherits the old shop's towns, address and price list, which is worse than
   * saying nothing. So every env fallback is gated on this. */
  const custom = isCustomised();
  const fromEnv = (value) => (custom ? undefined : value);

  const services = lines(s.bizServices);
  const areas = csv(s.bizAreas);

  const labels = csv(s.bizFieldLabels);
  const fieldLabels = FIELD_KEYS.map(
    (_, i) => labels[i] || DEFAULT_FIELD_LABELS[i]
  );

  return {
    name: (s.bizName || fromEnv(b.name) || 'the business').trim(),
    what: (s.bizWhat || '').trim(),
    services: services.length ? services : (fromEnv(b.services) || []),
    areas: areas.length ? areas : (fromEnv(b.serviceAreas) || []),
    address: (s.bizAddress || fromEnv(b.address) || '').trim(),
    phone: (s.bizPhone || fromEnv(b.phone) || '').trim(),
    website: (fromEnv(b.website) || '').trim(),
    collect: lines(s.bizCollect),
    offer: (s.bizOffer || '').trim(),
    rules: lines(s.bizRules),
    fieldLabels,
    fields: FIELD_KEYS.map((key, i) => ({ key, label: fieldLabels[i] })),
    needsAddress: s.bizNeedsAddress !== false,
  };
}

/** True once someone has actually filled the profile in from the dashboard. */
function isCustomised() {
  const s = store.getSettings();
  return Boolean(s.bizName || s.bizWhat || s.bizServices || s.bizCollect);
}

module.exports = { profile, isCustomised, PRESETS, FIELD_KEYS, DEFAULT_FIELD_LABELS };
