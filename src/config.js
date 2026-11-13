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

  // Instagram DM bot (igramapi - unofficial, no Meta app). Optional: if these
  // are unset the app runs exactly as before, with the Instagram section
  // showing as "not configured" on the dashboard instead of failing to boot.
  instagram: {
    username: process.env.IG_USERNAME || '',
    password: process.env.IG_PASSWORD || '',
    // Where the logged-in session is stored. On Render this MUST point at the
    // persistent disk - a fresh login on every deploy is what gets an account
    // checkpointed. e.g. /var/data/ig
    sessionDir: process.env.IG_SESSION_DIR || 'ig_session',
    // Strongly recommended. Instagram treats logins from datacentre IPs
    // (Render, AWS) as suspicious; a residential proxy is the difference
    // between a bot that runs for months and one banned in a week.
    // Format: http://user:pass@host:port
    proxyUrl: process.env.IG_PROXY || '',
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
