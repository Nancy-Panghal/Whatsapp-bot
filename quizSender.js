/**
 * whatsapp-bot/quizSender.js
 * Sends lesson quiz questions as messages with options.
 * Each question is a message with interactive buttons.
 */

const axios = require('axios')

let _supabase, _sendMessage, _config

/**
 * Call once from index.js after creating supabase.
 * @param {{ supabase, sendMessage, config }} deps
 */
function initQuizSender({ supabase, sendMessage, config }) {
  _supabase = supabase
  _sendMessage = sendMessage
  _config = config
}

function escMd(text) {
  return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getEnrollment(phone) {
  const { data: enrollments, error: enrollErr } = await _supabase
    .from('enrollments')
    .select('*, courses:course_uuid(*)')
    .eq('phone', String(phone))
    .order('enrolled_at', { ascending: false })
    .limit(1)

  if (enrollErr || !enrollments?.length || !enrollments[0].courses) return null
  return enrollments[0]
}

/**
 * Fetches the lesson for the given order number and sends quiz questions.
 * @param {string|number} phone
 * @param {number} lessonOrderNum
 */
async function sendQuiz(phone, lessonOrderNum) {
  // 1. Get enrollment + course
  const enrollment = await getEnrollment(phone)
  if (!enrollment) {
    await _sendMessage(phone, 'No course connected yet. Open your course page and tap *Start on WhatsApp* first.')
    return
  }

  const courseId = enrollment.course_uuid

  // 2. Fetch the lesson
  const { data: lessons, error: lessonErr } = await _supabase
    .from('lessons')
    .select('id, title, order_num, quiz_questions')
    .eq('course_id', courseId)
    .eq('order_num', lessonOrderNum)
    .eq('is_published', true)
    .limit(1)

  if (lessonErr || !lessons?.length) {
    await _sendMessage(phone, 'Lesson not found.')
    return
  }

  const lesson = lessons[0]
  const questions = Array.isArray(lesson.quiz_questions) ? lesson.quiz_questions : []

  if (questions.length === 0) {
    await _sendMessage(phone, `No quiz available for *${escMd(lesson.title)}* yet.`)
    return
  }

  // 3. Intro message
  await _sendMessage(
    phone,
    `📝 *Quiz: ${escMd(lesson.title)}*\n\n${questions.length} question${questions.length !== 1 ? 's' : ''} — here are the questions!`
  )

  // Small delay so intro is read before first question
  await sleep(800)

  // 4. Send each question as a message
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]

    // Validate question has required fields
    if (!q.question || !Array.isArray(q.options) || q.options.length < 2) continue

    const safeQuestion = String(q.question).slice(0, 300)
    const safeOptions = q.options.map(opt => String(opt).slice(0, 100)).filter(Boolean).slice(0, 10)

    // Build keyboard with options as buttons
    const keyboard = {
      inline_keyboard: safeOptions.map((opt, idx) => [{ text: opt, callback_data: `quiz_answer:${lessonOrderNum}:${i}:${idx}` }])
    }

    await _sendMessage(
      phone,
      `❓ *Question ${i + 1}*\n\n${safeQuestion}`,
      keyboard
    )

    // Stagger questions so they don't all appear at once
    if (i < questions.length - 1) await sleep(600)
  }

  // 5. Final message with next steps
  await sleep(1000)
  const keyboard = [
    [{ text: '▶ Next Lesson', callback_data: 'lesson' }],
  ]
  if (lessonOrderNum > 1) {
    keyboard.push([{ text: '⬅ Previous Lesson', callback_data: `goto:${lessonOrderNum - 1}` }])
  }
  keyboard.push([{ text: '📊 My Progress', callback_data: 'progress' }])

  await _sendMessage(
    phone,
    `✅ *Quiz sent!*\n\nAnswer each question above!`,
    { inline_keyboard: keyboard }
  )
}

module.exports = { initQuizSender, sendQuiz }
