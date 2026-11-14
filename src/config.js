require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const config = {
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  sheets: {
    webAppUrl: required('SHEETS_WEBAPP_URL'),
    secret: required('SHEETS_WEBAPP_SECRET'),
  },

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD || 'dash123',
  },

  // Instagram DM bot (Meta's official Instagram API). Optional - if these are
  // unset the app runs exactly as before, with the Instagram section showing
  // as "not configured" on the dashboard instead of failing to boot.
  instagram: {
    // Who carries the messages between us and Instagram:
    //   "meta"      - our own Meta app. Free, full control, but Instagram
    //                 only forwards real DMs once Meta approves the app.
    //   "instantdm" - InstantDM's approved app acts as the pipe, so no App
    //                 Review is needed. Their API is a paid tier.
    // The AI, the conversation history and the dashboard are ours either way.
    provider: (process.env.IG_PROVIDER || 'meta').toLowerCase(),

    // InstantDM only: the API key, and the webhook secret shown beside it.
    instantdmApiKey: process.env.INSTANTDM_API_KEY || '',
    instantdmWebhookSecret: process.env.INSTANTDM_WEBHOOK_SECRET || '',

    appId: process.env.IG_APP_ID || '',
    appSecret: process.env.IG_APP_SECRET || '',
    accessToken: process.env.IG_ACCESS_TOKEN || '',
    accountId: process.env.IG_ACCOUNT_ID || '',
    // We invent this one; it just has to match what you type into Meta's
    // "Verify token" box when saving the callback URL.
    verifyToken: process.env.IG_VERIFY_TOKEN || '',
  },

  business: {
    name: process.env.BUSINESS_NAME || 'KSC Carpets',
    googleReviewLink: process.env.BUSINESS_GOOGLE_REVIEW_LINK || '',
    website: process.env.BUSINESS_WEBSITE || '',
    // Shown to a customer only when both are set - never invented if empty.
    address: process.env.BUSINESS_ADDRESS || '',
    phone: process.env.BUSINESS_PHONE || '',
    // Pulled from ksc-carpets.com/services - keep this in sync if the
    // client adds/removes a service on the website.
    services: [
      'Carpets - wool & synthetic, stair runners, bedrooms',
      'LVT Flooring - luxury vinyl tile, wood & stone effects',
      'Laminate - hard-wearing, easy to live with',
      'Vinyl - sheet vinyl for kitchens & bathrooms',
      'Astroturf - artificial grass, gardens & play areas',
      'Commercial Flooring - offices, retail, hospitality contracts',
      'Underlay & Accessories - grippers, thresholds, premium underlay',
      'Screeding & Sub-floor Preparation - screed floors and all sub-prep work',
      'Safety & Anti-Slip flooring - healthcare, education, care homes',
    ],
    serviceAreas: [
      'Swansea', 'Bridgend', 'Carmarthen', 'Cardiff', 'Neath',
      'Port Talbot', 'Llanelli', 'Pontypridd', 'Merthyr Tydfil',
    ],
  },

  // Where the WhatsApp session (login) is stored. On Render, point this at
  // the persistent disk (e.g. /var/data/auth_info) so a redeploy doesn't
  // force a fresh QR scan every time.
  authDir: process.env.AUTH_DIR || 'auth_info',

  port: Number(process.env.PORT || 3000),
};

module.exports = config;
