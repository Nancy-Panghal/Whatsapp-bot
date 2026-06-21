// whatsapp-bot/decode.js
// Run this ONLY when you find leaked lesson content somewhere
// Usage: node decode.js
const { decodeFingerprint } = require("./watermark");

const leaked = `paste the leaked message text here
including all invisible characters`;

const phone = decodeFingerprint(leaked);
console.log("Content leaked by WhatsApp phone:", phone);

// It prints the phone of whoever shared it. You then ban that enrollment in Supabase.
