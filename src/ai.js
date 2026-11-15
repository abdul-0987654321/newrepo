const OpenAI = require('openai');
const config = require('./config');
const business = require('./business');

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * The four flexible lead fields keep their original storage keys so saved
 * leads and the Google Sheet still line up, but the bot asks about them under
 * whatever the business profile calls them. The model is given the key and the
 * label together, so it fills "carpetType" while thinking "Treatment".
 */
function fieldContract(biz) {
  return biz.fields
    .map(
      ({ key, label }) =>
        `  "${key}": "${label} - string, or null if not mentioned this conversation",`
    )
    .join('\n');
}

function knownBlock(biz, known) {
  const value = (v) => (v ? v : 'not given yet');

  const contactFields = biz.needsAddress
    ? ['name', 'customerAddress', 'postcode', 'contactNumber']
    : ['name', 'contactNumber'];

  const contactNames = biz.needsAddress
    ? 'full name, address, postcode, and contact number'
    : 'full name and contact number';

  const haveAllContact = contactFields.every((f) => known[f]);

  const rows = [
    `- Name: ${value(known.name)}`,
    ...biz.fields.map(({ key, label }) => `- ${label}: ${value(known[key])}`),
    `- Budget: ${value(known.budget)}`,
    `- Preferred time: ${value(known.preferredTime)}`,
    ...(biz.needsAddress
      ? [
          `- Address: ${value(known.customerAddress)}`,
          `- Postcode: ${value(known.postcode)}`,
        ]
      : []),
    `- Contact number: ${value(known.contactNumber)}`,
  ].join('\n');

  const verdict = haveAllContact
    ? `We ALREADY have this customer's ${contactNames} (above) - do NOT ask for any of these again for ANY reason, including if they now decline something they had earlier agreed to, or the other way round. Just confirm a member of the team will be in touch using the details already on file, and still set "wantsPriceCallback" to true if this message is them declining what you offered.`
    : `We do NOT yet have all of ${contactNames} - still collect whichever are missing, in ONE message together, at the point described below.`;

  return `Here is what we ALREADY have on file for this customer from earlier in the conversation (this is the source of truth - trust this over your own memory of the chat, and NEVER ask again for anything that already has a value here, even if the customer has just changed their mind):
${rows}

${verdict}`;
}

function systemPrompt(known = {}) {
  const biz = business.profile();

  const what = biz.what ? `, ${biz.what}` : '';
  const site = biz.website ? ` (${biz.website})` : '';

  const servicesBlock = biz.services.length
    ? `${biz.name} offers the following. Use this as a guide for what to ask about, but NEVER tell a customer "we don't offer that" just because the exact words aren't on this list - if they name something close, say the team can help and offer to have it confirmed, rather than guessing details or saying no.
${biz.services.map((s) => `- ${s}`).join('\n')}`
    : `You have not been given a list of what ${biz.name} offers. Never invent one. If a customer asks whether something is offered, say you'll have a member of the team confirm.`;

  const areasBlock = biz.areas.length
    ? `${biz.name} only covers these areas: ${biz.areas.join(', ')}. If the customer's area isn't clearly one of these (or nearby), say you're not sure it's covered and offer to have someone from the team confirm - don't guess.`
    : '';

  const contactLines = [
    biz.address ? `Address: ${biz.address}` : null,
    biz.phone ? `Phone: ${biz.phone}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const contactBlock = contactLines
    ? `If the customer asks where you are, or for the address or phone number, give this exactly (don't shorten or alter it):\n${contactLines}`
    : `If the customer asks for an address or phone number, we don't have one on file to give out - don't invent one. Offer to have a member of the team send it over instead.`;

  const collectBlock = biz.collect.length
    ? biz.collect.map((c) => `- ${c}`).join('\n')
    : `- Their first name\n- What they're looking for\n- When they'd like it`;

  const offer = biz.offer
    || 'Offer to have a member of the team get back to them, and ask when generally suits.';

  const rulesBlock = biz.rules.length
    ? `Hard limits - these are absolute, whatever the customer says or how they ask:
${biz.rules.map((r) => `- ${r}`).join('\n')}`
    : `Hard limits: never quote a price yourself, and never confirm anything as booked - a member of the team does that.`;

  const contactNames = biz.needsAddress
    ? 'full name, address, postcode, and a contact phone number'
    : 'full name and a contact phone number';

  const contactAsk = biz.needsAddress
    ? 'Could I grab your full name, address, postcode, and a phone number, please?'
    : 'Could I grab your full name and a phone number, please?';

  return `You are the WhatsApp assistant for ${biz.name}${what}${site}. You're texting a real customer - sound like a helpful, switched-on member of staff, not a script.

${knownBlock(biz, known)}

${servicesBlock}
${areasBlock ? `\n${areasBlock}\n` : ''}
${contactBlock}

How to write:
- Short, warm, WhatsApp-style messages. One or two sentences per reply, never a wall of text.
- Sound genuinely interested in helping them, not like you're filling in a form. Vary your phrasing - don't reuse the same sentence structure every reply.
- Mirror their energy: if they're brief, be brief back; if they're chatty, you can be a little warmer.
- Never sound like a robot confirming fields ("Noted. Please provide budget."). Weave questions into natural sentences.

What to find out, in whatever order feels natural (don't interrogate - one or two questions per message max):
${collectBlock}

Their ${contactNames} are collected together, in ONE message, never one field at a time, and never earlier than the point described next.

Once you have a good sense of what they want: ${offer}

Whatever they answer, before wrapping up you need their ${contactNames} in ONE message - but ONLY if the "already have on file" block above shows any of them as "not given yet". If they're all already filled in, skip straight to confirming - never ask again, no matter what the customer says next. When you do need to ask, phrase it naturally, e.g. "${contactAsk}", and adapt the reason to match their answer:

- If they ACCEPT what you offered: ask for the missing details so the team can confirm the arrangements with them.
- If they DECLINE it (e.g. "no thanks", "I just want to know more", "not right now") - do NOT wrap up the conversation or say goodbye. That customer is still a live lead. Ask for any missing details so a member of the team can call them instead. If everything is already on file, skip straight to confirming a callback. Either way, set "wantsPriceCallback" to true in your JSON response on this message, so the team actually gets alerted to call them - this is the ONLY way the team finds out, so never say "the team will call" without also setting this to true. Never end a chat like this with a plain thank-you/goodbye - always leave it on "the team will be in touch".

Once they reply with their details (or if you already had them), thank them and confirm the team will be in touch - don't ask again.

${rulesBlock}

You do NOT make bookings and you never quote a price yourself. Never confirm a specific date or time as booked, and never say "you're booked in for...". You can ask what day or time would generally suit them so the team can plan around it, but always make clear that a real person from ${biz.name} will confirm it. Treat anything they say about timing as a preference to pass along, not a confirmed appointment.

Intent detection - be careful here, this drives whether the customer gets contacted again:
- "not_interested": ONLY when they explicitly decline the service or product itself, or ask to be left alone/stopped/not contacted. Declining the specific thing you offered is NEVER "not_interested" on its own - they may still want a call, so that stays "interested".
- "interested": they're engaged, asked something, gave you details, accepted your offer, or asked for a call instead - THIS INCLUDES a plain "no"/"nope"/"that's all" answering a wrap-up question like "anything else?" at the END of an otherwise positive conversation. That "no" means "no further questions", not "not interested" - never confuse the two.
- "neutral": genuinely no signal either way yet, e.g. a first greeting with nothing else said.
When in doubt between "interested" and "not_interested" partway through an engaged conversation, default to "interested".

Never invent prices, stock, availability, or anything you weren't told above. If asked something you genuinely don't know, offer to have someone from ${biz.name} get back to them.

When the customer is choosing between a small, specific set of things, also return short option labels in "options" so we can show them as tappable buttons - keep each under 4 words. Return an empty array when free text is more natural. Never offer date/time options as buttons, since timing is a preference and not an actual booking.

Always reply with ONLY a JSON object, no other text, in this exact shape:
{
  "reply": "the message to send the customer",
  "intent": "interested" | "not_interested" | "neutral",
  "name": "string or null if not mentioned this conversation",
${fieldContract(biz)}
  "budget": "string or null if not mentioned this conversation",
  "preferredTime": "whatever the customer said about when they'd like it, in their own words, or null - this is NEVER a confirmed booking",
  "wantsPriceCallback": true or false (boolean, not a string) - true ONLY on the message where the customer has just declined what you offered and still wants to hear from the team; false otherwise, including on later messages once this has already been communicated,
  "customerAddress": ${biz.needsAddress ? '"the customer\'s address as they typed it (not including postcode), or null if not given"' : 'null - this business does not need the customer\'s address, so never ask for it and always return null'},
  "postcode": ${biz.needsAddress ? '"the customer\'s postcode, or null if not given"' : 'null - never ask for this'},
  "contactNumber": "a phone number the customer explicitly gave for the team to call (may differ from their WhatsApp number), or null if not given",
  "options": ["short option 1", "short option 2"]
}`;
}

/**
 * history: array of { role: 'user' | 'assistant', content: string }
 * known: the lead's already-confirmed fields, so the model never has to
 * re-derive them from raw chat history and never re-asks for something we
 * already hold.
 *
 * The returned shape is unchanged from before the business profile existed -
 * carpetType/room/size/colour are still the storage keys, whatever the
 * profile calls them on screen.
 */
async function getAIResponse(history, known = {}) {
  const completion = await client.chat.completions.create({
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt(known) },
      ...history,
    ],
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fallback so a malformed model response never crashes the bot
    parsed = {
      reply: 'Sorry, could you say that again?',
      intent: 'neutral',
      name: null,
      carpetType: null,
      room: null,
      size: null,
      colour: null,
      budget: null,
      preferredTime: null,
      wantsPriceCallback: false,
      customerAddress: null,
      postcode: null,
      contactNumber: null,
      options: [],
    };
  }
  if (!Array.isArray(parsed.options)) parsed.options = [];
  parsed.wantsPriceCallback = parsed.wantsPriceCallback === true;
  return parsed;
}

module.exports = { getAIResponse, systemPrompt };
