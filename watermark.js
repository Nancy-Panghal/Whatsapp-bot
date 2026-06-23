/**
 * whatsapp-bot/watermark.js
 *
 * WhatsApp-side watermark helpers.
 *
 * Usage in index.js:
 *   const { initWatermark } = require('./watermark')
 *   initWatermark(supabase)
 */

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

// Default supabase instance — will be overridden by init()
let _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

/**
 * Initialize watermark module with the shared Supabase instance.
 * Call this once from index.js after creating supabase.
 */
function initWatermark(supabase) {
  _supabase = supabase
}

// ── Rate limit store (in-memory; swap for Redis in production) ───────────────
const rateLimitStore = new Map()
const RATE_WINDOW_MS = 10 * 60 * 1000  // 10 minutes
const RATE_MAX_LESSONS = 5             // max 5 lesson requests per 10 min

/**
 * Returns true if this phone number is requesting lessons too fast.
 * @param {string|number} phone
 * @returns {{ limited: boolean, retryAfterSeconds: number }
 */
function checkRateLimit(phone) {
  const key = String(phone)
  const now = Date.now()
  const entry = rateLimitStore.get(key) || { count: 0, windowStart: now, firstRequest: now }

  if (now - entry.windowStart > RATE_WINDOW_MS) {
    // New window
    rateLimitStore.set(key, { count: 1, windowStart: now, firstRequest: now })
    return { limited: false, retryAfterSeconds: 0 }
  }

  entry.count += 1
  rateLimitStore.set(key, entry)

  if (entry.count > RATE_MAX_LESSONS) {
    const retryAfterMs = RATE_WINDOW_MS - (now - entry.windowStart)
    return {
      limited: true,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    }
  }

  return { limited: false, retryAfterSeconds: 0 }
}

/**
 * Encodes a string as zero-width Unicode characters.
 * These survive copy-paste and are invisible to readers.
 * If shared content leaks, we can decode the phone from the text.
 *
 * Zero-width space (U+200B) = 0 bit
 * Zero-width non-joiner (U+200C) = 1 bit
 *
 * @param {string} text - text to encode (phone as string)
 * @returns {string} invisible encoded string
 */
function encodeFingerprint(text) {
  const ZWS = '\u200B'  // 0
  const ZWNJ = '\u200C' // 1

  let result = ''
  for (let i = 0; i < Math.min(text.length, 12); i++) {
    const code = text.charCodeAt(i)
    for (let bit = 7; bit >= 0; bit--) {
      result += (code >> bit) & 1 ? ZWNJ : ZWS
    }
  }
  return result
}

/**
 * Decodes a zero-width fingerprint back to the original string.
 * Use this if leaked content is found to identify the source.
 *
 * @param {string} encoded - string containing zero-width chars
 * @returns {string} decoded phone
 */
function decodeFingerprint(encoded) {
  const ZWS = '\u200B'
  const ZWNJ = '\u200C'

  const zwChars = encoded.split('').filter(c => c === ZWS || c === ZWNJ)
  let result = ''

  for (let i = 0; i < zwChars.length; i += 8) {
    let code = 0
    for (let bit = 0; bit < 8; bit++) {
      if (zwChars[i + bit] === ZWNJ) code |= (1 << (7 - bit))
    }
    if (code > 0) result += String.fromCharCode(code)
  }

  return result
}

/**
 * Logs lesson access to Supabase for audit trail.
 * Detects if the same course is being accessed from multiple WhatsApp accounts (piracy signal).
 *
 * @param {string|number} phone
 * @param {string} lessonId
 * @param {string} courseId
 */
async function logLessonAccess(phone, lessonId, courseId) {
  try {
    // Insert access log
    await _supabase.from('lesson_access_logs').insert({
      chat_id: String(phone),
      lesson_id: lessonId,
      course_id: courseId,
      source: 'whatsapp',
      accessed_at: new Date().toISOString(),
    })

    // Check for suspicious multi-account access (same course, 3+ different chat_ids in 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: recentAccess } = await _supabase
      .from('lesson_access_logs')
      .select('chat_id')
      .eq('course_id', courseId)
      .eq('source', 'whatsapp')
      .gte('accessed_at', since)

    if (recentAccess) {
      const uniquePhones = new Set(recentAccess.map(r => r.chat_id))
      if (uniquePhones.size >= 3 && !uniquePhones.has(String(phone))) {
        console.warn(
          `[watermark] ⚠️ Suspicious: course ${courseId} accessed from ${uniquePhones.size + 1} WhatsApp accounts in 24h. Phones: ${[...uniquePhones, String(phone)].join(', ')}`
        )
        // In production: alert creator via email/notification
      }
    }
  
  
  } catch (err) {
    // Non-critical — don't let logging failure break lesson delivery
    console.error('[watermark] Log error:', err.message)
  }
}

module.exports = {
  initWatermark,
  checkRateLimit,
  logLessonAccess,
  encodeFingerprint,
  decodeFingerprint,
}
