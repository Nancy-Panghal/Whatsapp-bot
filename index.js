if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const { sendLesson, signLessonPageUrl, encodeFingerprint, escMd, init: initLessonSender } = require("./lessonSender");
const { initWatermark } = require("./watermark");
const { initQuizSender, sendQuiz } = require("./quizSender");
const {
  initAssignmentSender,
  sendAssignmentPrompt,
  beginAssignmentSubmit,
  submitAssignmentText,
  getRequiredAssignmentBlock,
  cancelPending,
  hasPendingSubmission,
} = require("./assignmentSender");

const app = express();

// DIAGNOSTIC — logs the bare fact that a request arrived, before any body
// parsing, signature checks, or routing. If a request from Meta doesn't
// show up here, it never reached this server at all — the problem is
// upstream (Meta not sending it, Render not routing it), not in this code.
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.originalUrl} | content-type: ${req.get("content-type") || "none"}`);
  next();
});

app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v22.0";
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const INTERNAL_BOT_SECRET = process.env.INTERNAL_BOT_SECRET || "";
const META_LIVE_REMINDER_TEMPLATE = process.env.META_LIVE_REMINDER_TEMPLATE_NAME || "live_class_reminder";
const META_TEMPLATE_LANG = process.env.META_TEMPLATE_LANG || "en";
const ACADEMYKIT_URL = (process.env.ACADEMYKIT_URL || "").replace(/\/$/, "");
const LESSON_LINK_SECRET =
  process.env.WHATSAPP_LINK_SECRET ||
  process.env.LESSON_LINK_SECRET ||
  WEBHOOK_SECRET;

// Mirrors course-web/src/lib/phone.ts — always normalize before reading OR
// writing the `phone` column on enrollments/students/whatsapp_tokens.
// Meta's Cloud API already sends `message.from` as digits only, no "+" and
// no "whatsapp:" prefix (e.g. "919306385029"), matching what course-web's
// payment webhook stores. This normalizer is kept anyway as a defensive
// guard — some call sites still pass in identity strings built elsewhere
// (signed lesson URLs, /start tokens) that may carry stray formatting.
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits || null;
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Initialize shared modules
initWatermark(supabase);
initLessonSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) => sendWhatsAppMessage(phone, text, keyboard, opts),
  buildLessonMenuKeyboard,
  config: {
    WHATSAPP_LINK_SECRET: LESSON_LINK_SECRET,
    LESSON_LINK_SECRET,
    ACADEMYKIT_URL,
  },
});
initQuizSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) => sendWhatsAppMessage(phone, text, keyboard, opts),
  config: {
    WHATSAPP_LINK_SECRET: LESSON_LINK_SECRET,
    LESSON_LINK_SECRET,
    ACADEMYKIT_URL,
  },
});
initAssignmentSender({
  supabase,
  sendMessage: async (phone, text, keyboard, opts) => sendWhatsAppMessage(phone, text, keyboard, opts),
  config: {},
});

Object.entries({
  META_WHATSAPP_TOKEN: META_WHATSAPP_TOKEN,
  META_PHONE_NUMBER_ID: META_PHONE_NUMBER_ID,
  META_APP_SECRET: META_APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: META_WEBHOOK_VERIFY_TOKEN,
  ACADEMYKIT_URL: ACADEMYKIT_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
}).forEach(([key, value]) =>
  console.log(`${key}: ${value ? "loaded" : "MISSING"}`),
);

// Maps the existing Telegram-style { inline_keyboard: [...] } shape (used
// unchanged by lessonSender/quizSender/assignmentSender) onto WhatsApp's
// interactive message types. WhatsApp can't mix a URL button with tappable
// reply buttons in one message like Telegram can — so any url buttons become
// plain links appended to the text, and callback_data buttons become real
// tappable buttons (Reply Buttons if ≤3, List Message if more).
//
// opts.forceList — always render as a List Message (the "dropdown" look)
// even when there are ≤3 callback buttons. Used for the Activities menu,
// which must always look like a dropdown, never like 3 reply buttons.
function buildWhatsAppPayload(toPhone, text, keyboard, opts) {
  const to = toPhone.replace(/\D/g, ""); // Meta wants digits only, no "+", no "whatsapp:" prefix
  const forceList = Boolean(opts?.forceList);
  const listButtonLabel = opts?.listButtonLabel || "Choose";
  const listSectionTitle = opts?.listSectionTitle || "Options";

  if (!keyboard || !keyboard.inline_keyboard?.length) {
    return { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
  }

  const flat = keyboard.inline_keyboard.flat();
  const urlButtons = flat.filter((b) => b.url);
  const callbackButtons = flat.filter((b) => b.callback_data);

  let bodyText = text;
  urlButtons.forEach((b) => { bodyText += `\n\n${b.text}: ${b.url}`; });

  if (callbackButtons.length === 0) {
    return { messaging_product: "whatsapp", to, type: "text", text: { body: bodyText } };
  }

  if (!forceList && callbackButtons.length <= 3) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: callbackButtons.map((b) => ({
            type: "reply",
            reply: { id: b.callback_data, title: b.text.slice(0, 20) },
          })),
        },
      },
    };
  }

  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: listButtonLabel,
        sections: [
          {
            title: listSectionTitle,
            rows: callbackButtons.slice(0, 10).map((b, i) => ({
              id: b.callback_data || `opt_${i}`,
              title: b.text.slice(0, 24),
            })),
          },
        ],
      },
    },
  };
}

async function sendWhatsAppMessage(toPhone, text, keyboard, opts) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
  const payload = buildWhatsAppPayload(toPhone, text, keyboard, opts);

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${META_WHATSAPP_TOKEN}`,
      },
      timeout: 10000,
    });
    console.log("[sendWhatsAppMessage] ✅ sent to", toPhone, "| status:", resp.status, "| id:", resp.data?.messages?.[0]?.id);
  } catch (err) {
    // Log full Meta error but NEVER rethrow — a failed reply must not crash
    // the handler or roll back enrollment operations
    const errData = err.response?.data;
    console.error("[sendWhatsAppMessage] ❌ FAILED to", toPhone);
    console.error("[sendWhatsAppMessage] Meta error:", JSON.stringify(errData?.error || err.message));
  }
}

// Proactive messages (the student hasn't necessarily messaged the bot in
// the last 24 hours) MUST use a pre-approved Meta Message Template —
// freeform text gets rejected outside that window. Used for live-class
// reminders sent by the cron job, never for anything reply-driven.
//
// Template must be created + approved in Meta Business Manager first with
// exactly this many body variables, in this order:
//   {{1}} lesson title   {{2}} course name   {{3}} time label   {{4}} join URL
// Returns true/false so the caller (the /internal/send-reminder route) can
// report failures back to the cron job instead of silently swallowing them.
async function sendWhatsAppTemplate(toPhone, bodyParams) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
  const to = String(toPhone).replace(/\D/g, "");

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: META_LIVE_REMINDER_TEMPLATE,
      language: { code: META_TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters: bodyParams.map((p) => ({ type: "text", text: String(p) })),
        },
      ],
    },
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${META_WHATSAPP_TOKEN}`,
      },
      timeout: 10000,
    });
    console.log("[sendWhatsAppTemplate] ✅ sent to", to, "| status:", resp.status, "| id:", resp.data?.messages?.[0]?.id);
    return true;
  } catch (err) {
    const errData = err.response?.data;
    console.error("[sendWhatsAppTemplate] ❌ FAILED to", to, "| template:", META_LIVE_REMINDER_TEMPLATE);
    console.error("[sendWhatsAppTemplate] Meta error:", JSON.stringify(errData?.error || err.message));
    return false;
  }
}



function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function maxFreeLessons(config) {
  if (config === "lesson 1 free") return 1;
  if (config === "2 lessons free") return 2;
  if (config === "3 lessons free") return 3;
  if (config === "module 1 free") return 3;
  if (config === "2 modules free") return 6;
  return 0;
}

async function firstRow(query) {
  const { data, error } = await query.limit(1);
  if (error) {
    console.error("Supabase error:", error.message);
    return null;
  }
  return data?.[0] || null;
}

function courseUrl(course) {
  return `${ACADEMYKIT_URL}/course/${slugify(course.host_name || "creator")}/${slugify(course.name || course.slug || "course")}/${course.id}`;
}

function lessonAllowed(enrollment, lessonNumber) {
  if (enrollment.payment_status === "paid") return true;
  return (
    lessonNumber <=
    maxFreeLessons(enrollment.courses?.free_preview_config || "nothing free")
  );
}

// A lesson has "activities" if it carries anything beyond its main
// video/pdf/live content — notes, a summary, a quiz, or an assignment.
// NOTE: this is independent of content_type — a normal video lesson can
// have a quiz attached, and a content_type === 'quiz' lesson (the quiz
// IS the lesson) is handled the same way the video/pdf lesson is; this
// flag is only about whether the *extra* Activities dropdown should show.
function lessonHasActivities(lesson) {
  if (!lesson) return false;
  const hasNotes = Boolean(lesson.notes_url || lesson.summary_url);
  const hasQuiz = Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0;
  const hasAssignment = Boolean(lesson.assignment_prompt || lesson.assignment_file_url);
  return hasNotes || hasQuiz || hasAssignment;
}

// Shared button layout used everywhere a lesson menu is shown (sendLesson,
// sendSpecificLesson, markDone). WhatsApp allows max 3 reply buttons per
// message, so the 3rd slot is always EITHER Activities OR My Courses,
// never both — Activities takes priority whenever this lesson has any.
//   Row 1: ▶ Next Lesson   (only if a next published lesson exists)
//   Row 2: ⬅ Previous Lesson (only if order_num > 1)
//   Row 3: 🎯 Activities (if lesson has notes/quiz/assignment) else 📚 My Courses
async function buildLessonMenuKeyboard(supabase, enrollment, lesson) {
  const buttons = [];

  const { data: nextLessons } = await supabase
    .from("lessons")
    .select("order_num")
    .eq("course_id", enrollment.course_uuid)
    .eq("order_num", lesson.order_num + 1)
    .eq("is_published", true)
    .limit(1);

  if (nextLessons && nextLessons.length > 0) {
    buttons.push({ text: "▶ Next Lesson", callback_data: `goto:${lesson.order_num + 1}` });
  }

  if (lesson.order_num > 1) {
    buttons.push({ text: "⬅ Previous Lesson", callback_data: `goto:${lesson.order_num - 1}` });
  }

  if (lessonHasActivities(lesson)) {
    buttons.push({ text: "🎯 Activities", callback_data: `activities:${lesson.order_num}` });
    return { inline_keyboard: buttons.map((b) => [b]) };
  }

  // No activities on this lesson — 3rd slot becomes My Courses, a real
  // website page (not an in-chat summary) so it matches "route to the
  // my-courses page" rather than replying with text.
  const keyboard = { inline_keyboard: buttons.map((b) => [b]) };
  keyboard.inline_keyboard.push([
    { text: "📚 My Courses", url: signMyCoursesUrl(String(enrollment.phone)) },
  ]);
  return keyboard;
}

// Sends the Activities dropdown (always a List Message, never reply
// buttons, even when there's only one activity) for a given lesson.
async function sendActivitiesMenu(supabase, phone, enrollment, lessonOrderNum) {
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select("id, title, order_num, notes_url, summary_url, quiz_questions, assignment_prompt, assignment_file_url, assignment_required")
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonOrderNum)
      .eq("is_published", true),
  );

  if (!lesson || !lessonHasActivities(lesson)) {
    await sendWhatsAppMessage(phone, `No extra activities for Lesson ${lessonOrderNum}.`);
    return;
  }

  const rows = [];
  if (lesson.notes_url || lesson.summary_url) {
    rows.push({ text: "📝 Notes", callback_data: `notes:${lessonOrderNum}` });
  }
  if (Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0) {
    rows.push({ text: "🧠 Quiz", callback_data: `quiz:${lessonOrderNum}` });
  }
  if (lesson.assignment_prompt || lesson.assignment_file_url) {
    rows.push({ text: "📋 Assignment", callback_data: `assign:${lessonOrderNum}` });
  }

  await sendWhatsAppMessage(
    phone,
    `🎯 Activities for Lesson ${lessonOrderNum}: ${lesson.title}\n\nChoose one:`,
    { inline_keyboard: rows.map((b) => [b]) },
    { forceList: true, listButtonLabel: "Choose", listSectionTitle: "Activities" },
  );
}

async function sendNotesForLesson(supabase, phone, enrollment, lessonOrderNum) {
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select("id, title, summary_url, notes_url")
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonOrderNum)
      .eq("is_published", true),
  );

  if (!lesson || (!lesson.summary_url && !lesson.notes_url)) {
    await sendWhatsAppMessage(phone, `No notes for Lesson ${lessonOrderNum} yet.`);
    return;
  }

  const lines = [`📝 Notes — Lesson ${lessonOrderNum}: ${lesson.title}`, ""];
  if (lesson.summary_url) lines.push(`• 📄 Summary: ${signResourceUrl(lesson.id, "summary", phone)}`);
  if (lesson.notes_url) lines.push(`• 📝 Notes: ${signResourceUrl(lesson.id, "notes", phone)}`);

  await sendWhatsAppMessage(phone, lines.join("\n"));
}

// Matches course-web/src/lib/signer.ts's signMyCoursesUrl/verifyMyCoursesUrl —
// same secret, same payload shape.
function signMyCoursesUrl(phone) {
  const exp = Date.now() + 2 * 60 * 60 * 1000;
  const payload = `mycourses.${phone}.${exp}`;
  const sig = crypto.createHmac("sha256", LESSON_LINK_SECRET).update(payload).digest("hex");
  const params = new URLSearchParams({ identity: String(phone), exp: String(exp), sig });
  return `${ACADEMYKIT_URL}/wa/my-courses?${params.toString()}`;
}

function signResourceUrl(lessonId, type, phone) {
  const exp = Date.now() + 2 * 60 * 60 * 1000;
  const payload = `resource.${lessonId}.${type}.${phone}.${exp}`;
  const sig = crypto
    .createHmac("sha256", LESSON_LINK_SECRET)
    .update(payload)
    .digest("hex");
  const params = new URLSearchParams({
    type,
    identity: String(phone),
    exp: String(exp),
    sig,
  });
  return `${ACADEMYKIT_URL}/resource/${lessonId}?${params.toString()}`;
}

async function getEnrollment(phone) {
  return firstRow(
    supabase
      .from("enrollments")
      .select("*, courses:course_uuid(*)")
      .eq("phone", normalizePhone(phone) || String(phone))
      .order("enrolled_at", { ascending: false }),
  );
}

async function handleStart(phone, token) {
  console.log('[handleStart] called | phone:', phone, '| token:', token ? token.slice(0, 16) + '...' : '(none)');

  if (!token) {
    await sendWhatsAppMessage(
      phone,
      "Welcome to Kurso! 👋\n\nOpen a course page and tap *Start on WhatsApp* to connect your course.",
    );
    return;
  }

  // 1. Find valid unused token
  console.log('[handleStart] step 1 — looking up token in whatsapp_tokens');
  const tokenRow = await firstRow(
    supabase
      .from("whatsapp_tokens")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString()),
  );

  if (!tokenRow) {
    console.warn('[handleStart] ❌ token not found or already used or expired:', token.slice(0, 16));
    await sendWhatsAppMessage(
      phone,
      "This WhatsApp link is invalid or has expired. Please open the course page and tap *Start on WhatsApp* again.",
    );
    return;
  }
  console.log('[handleStart] ✅ token found | course_slug:', tokenRow.course_slug, '| creator_id:', tokenRow.creator_id, '| used:', tokenRow.used, '| expires_at:', tokenRow.expires_at);

  const courseSlugOrId = tokenRow.course_slug;

  // 2. Verify course still exists
  let course;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseSlugOrId)) {
    const { data: courseRows } = await supabase.from("courses").select("*").eq("id", courseSlugOrId).limit(1);
    course = courseRows?.[0];
  } else {
    const { data: courseRows } = await supabase.from("courses").select("*").eq("slug", courseSlugOrId).limit(1);
    course = courseRows?.[0];
  }

  if (!course) {
    console.warn('[handleStart] ❌ course not found for:', courseSlugOrId);
    await sendWhatsAppMessage(phone, "This course is no longer available.");
    await supabase
      .from("whatsapp_tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("id", tokenRow.id);
    return;
  }
  console.log('[handleStart] ✅ course found:', course.name, '| id:', course.id);

  // 3. Upsert student record
  let student = null;

  if (tokenRow.student_id) {
    const { data } = await supabase.from("students").select("id").eq("id", tokenRow.student_id).limit(1);
    student = data?.[0] || null;
  } else if (tokenRow.student_email) {
    const { data } = await supabase.from("students").select("id").eq("email", tokenRow.student_email).limit(1);
    student = data?.[0] || null;
  } else if (tokenRow.student_phone) {
    const { data } = await supabase.from("students").select("id").eq("phone", tokenRow.student_phone).limit(1);
    student = data?.[0] || null;
  }

  if (!student) {
    console.log('[handleStart] step 3 — inserting new student | email:', tokenRow.student_email);
    const { data: inserted, error: insertErr } = await supabase
      .from("students")
      .insert({
        email: tokenRow.student_email || null,
        name: tokenRow.student_name || null,
        phone: tokenRow.student_phone || null,
      })
      .select("id")
      .single();

    if (insertErr?.code === "23505") {
      // Race with the website (razorpay/verify or webhook) inserting a
      // student with this same phone/email moments earlier. Use that row
      // instead of failing the whole /start flow over it.
      console.warn("[handleStart] student insert raced — re-fetching existing row | phone:", tokenRow.student_phone, "| email:", tokenRow.student_email);
      let raced = null;
      if (tokenRow.student_phone) {
        const { data } = await supabase.from("students").select("id").eq("phone", tokenRow.student_phone).limit(1);
        raced = data?.[0] || null;
      }
      if (!raced && tokenRow.student_email) {
        const { data } = await supabase.from("students").select("id").eq("email", tokenRow.student_email).limit(1);
        raced = data?.[0] || null;
      }
      if (!raced) {
        await sendWhatsAppMessage(phone, "Something went wrong linking your account. Please try the link again.");
        return;
      }
      student = raced;
    } else if (insertErr) {
      console.error("[handleStart] ❌ student insert error:", insertErr.message, '| code:', insertErr.code);
      await sendWhatsAppMessage(
        phone,
        "Something went wrong linking your account. Please try the link again.",
      );
      return;
    } else {
      student = inserted;
    }
  }

  const isPaid = Boolean(tokenRow.payment_id);
  const phoneOrEmail = normalizePhone(phone) || String(phone);
  console.log('[handleStart] step 4 — student id:', student?.id, '| isPaid:', isPaid, '| phoneOrEmail:', phoneOrEmail);

  // 4. Find existing enrollment by every identifier before inserting
  let existingEnrollment = null;

  if (student?.id) {
    const { data } = await supabase
      .from("enrollments")
      .select("id, payment_status, completed_lessons, current_lesson, quiz_results")
      .eq("course_uuid", course.id)
      .eq("student_id", student.id)
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  if (!existingEnrollment && phoneOrEmail) {
    const { data } = await supabase
      .from("enrollments")
      .select("id, payment_status, completed_lessons, current_lesson, quiz_results")
      .eq("course_uuid", course.id)
      .eq("phone", phoneOrEmail)
      .limit(1);
    existingEnrollment = data?.[0] || null;
  }

  const now = new Date().toISOString();

  // 5. Update or create enrollment — never downgrade payment_status from paid to free
  let enrollmentId = null;
  let enrollError = null;

  if (existingEnrollment) {
    const newPaymentStatus =
      existingEnrollment.payment_status === "paid"
        ? "paid"
        : isPaid
          ? "paid"
          : "free";

    const { error } = await supabase
      .from("enrollments")
      .update({
        student_id: student?.id || existingEnrollment.student_id || null,
        phone: phoneOrEmail,
        payment_status: newPaymentStatus,
        payment_id: tokenRow.payment_id || existingEnrollment.payment_id || null,
        last_accessed: now,
      })
      .eq("id", existingEnrollment.id);

    enrollError = error;
    enrollmentId = existingEnrollment.id;
  } else {
    const { data: inserted, error } = await supabase
      .from("enrollments")
      .insert({
        phone: phoneOrEmail,
        course_uuid: course.id,
        creator_id: tokenRow.creator_id,
        student_id: student?.id || null,
        current_lesson: 1,
        payment_id: tokenRow.payment_id || null,
        payment_status: isPaid ? "paid" : "free",
        completed_lessons: [],
        quiz_results: [],
        amount_paid: 0,
        last_accessed: now,
      })
      .select("id")
      .single();

    enrollError = error;
    enrollmentId = inserted?.id || null;
  }

  // 6. Only mark token used AFTER enrollment is confirmed
  if (enrollError || !enrollmentId) {
    console.error("[handleStart] ❌ enrollment upsert FAILED | error:", enrollError?.message, '| code:', enrollError?.code, '| details:', enrollError?.details);
    console.error("[handleStart] ❌ was this an existing enrollment update?", Boolean(existingEnrollment), '| enrollmentId:', enrollmentId);
    await sendWhatsAppMessage(
      phone,
      "Something went wrong saving your enrollment. Please tap the link again — your access token is still valid.",
    );
    return;
  }
  console.log('[handleStart] ✅ enrollment upserted | id:', enrollmentId);

  await supabase
    .from("whatsapp_tokens")
    .update({ used: true, used_at: now, student_id: student?.id })
    .eq("id", tokenRow.id);

  console.log('[handleStart] ✅ all done — sending success message to', phone);
  await sendWhatsAppMessage(
    phone,
    "✅ You're connected! Send /lesson to start learning!",
  );
  console.log('[handleStart] ✅ success message dispatched');
}

async function markDone(phone, lessonNumber) {
  const enrollment = await getEnrollment(phone);
  if (!enrollment || !enrollment.courses) {
    await sendWhatsAppMessage(phone, "No course connected yet.");
    return;
  }

  // Call the web API so both platforms write progress the same way
  try {
    const res = await fetch(`${ACADEMYKIT_URL}/api/lesson/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: String(phone),
        lessonNum: lessonNumber,
        courseId: enrollment.course_uuid,
        source: "whatsapp",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("[markDone] API error:", err);
    }
  } catch (err) {
    console.error("[markDone] fetch error:", err.message);
  }

  // Fetch the lesson for its order_num + resource/quiz/assignment flags
  // (needed by buildLessonMenuKeyboard to decide Activities vs My Courses)
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select("id, order_num, summary_url, notes_url, quiz_questions, assignment_prompt, assignment_file_url, assignment_required")
      .eq("course_id", enrollment.course_uuid)
      .eq("order_num", lessonNumber)
      .eq("is_published", true),
  );

  let assignmentBlocksNext = false;
  if (lesson?.assignment_required && lesson?.assignment_prompt) {
    const { data: existingAssignment } = await supabase
      .from("assignments")
      .select("id")
      .eq("enrollment_id", enrollment.id)
      .eq("lesson_id", lesson.id)
      .maybeSingle();
    assignmentBlocksNext = !existingAssignment;
  }

  const message = `✅ Lesson ${lessonNumber} marked complete!`;

  if (lesson) {
    const keyboard = await buildLessonMenuKeyboard(supabase, enrollment, lesson);
    if (assignmentBlocksNext) {
      // Required assignment not yet submitted — drop the Next Lesson row so
      // the student isn't misled into thinking they can skip ahead; the
      // Submit Assignment prompt below is the actual next step.
      keyboard.inline_keyboard = keyboard.inline_keyboard.filter(
        (row) => row[0]?.callback_data !== `goto:${lessonNumber + 1}`,
      );
    }
    await sendWhatsAppMessage(phone, message, keyboard);
  } else {
    await sendWhatsAppMessage(phone, message);
  }

  await sendAssignmentPrompt(phone, lessonNumber);
}

async function sendProgress(phone) {
  const enrollment = await getEnrollment(phone);
  if (!enrollment || !enrollment.courses) {
    await sendWhatsAppMessage(phone, "No course is connected yet.");
    return;
  }

  const completed = (enrollment.completed_lessons || []).length;
  const total = enrollment.courses.total_lessons || 0;
  const percent = total > 0 ? Math.min(Math.round((completed / total) * 100), 100) : 0;

  await sendWhatsAppMessage(
    phone,
    `Progress: ${completed}/${total} lessons complete (${percent}%).\nCurrent lesson: ${enrollment.current_lesson || 1}`,
    { inline_keyboard: [[{ text: '▶ Continue', callback_data: 'lesson' }]] },
  );
}

async function sendSpecificLesson(phone, lessonOrderNum) {
  const enrollment = await getEnrollment(phone);
  if (!enrollment) {
    await sendWhatsAppMessage(phone, 'No course connected. Open the course page first.');
    return;
  }

  const currentLesson = enrollment.current_lesson || 1;
  if (lessonOrderNum > currentLesson) {
    const assignmentBlock = await getRequiredAssignmentBlock(enrollment, lessonOrderNum);
    if (assignmentBlock) {
      await sendWhatsAppMessage(
        phone,
        `🔒 Assignment required\n\nComplete the assignment for Lesson ${assignmentBlock.prevLessonNum} before continuing.`,
        { inline_keyboard: [[{ text: '📝 Submit HW', callback_data: `assign:${assignmentBlock.prevLessonNum}` }]] },
      );
      return;
    }
  }

  const { data: lessons } = await supabase
    .from('lessons')
    .select('id, title, order_num, notes_url, summary_url, quiz_questions, assignment_prompt, assignment_file_url, assignment_required')
    .eq('course_id', enrollment.course_uuid)
    .eq('order_num', lessonOrderNum)
    .eq('is_published', true)
    .limit(1);

  const lesson = lessons?.[0];
  if (!lesson) {
    await sendWhatsAppMessage(phone, `Lesson ${lessonOrderNum} is not available yet.`);
    return;
  }

  // Check access
  const isPaid = enrollment.payment_status === 'paid';
  if (!isPaid) {
    const config = enrollment.courses?.free_preview_config || 'nothing free';
    const maxFree = { 'lesson 1 free': 1, '2 lessons free': 2, '3 lessons free': 3, 'module 1 free': 3, '2 modules free': 6 };
    const limit = maxFree[config] || 0;
    if (lessonOrderNum > limit) {
      const course = enrollment.courses;
      const courseUrlStr = `${ACADEMYKIT_URL}/about-course/${slugify(course?.host_name || 'creator')}/${slugify(course?.name || 'course')}/${enrollment.course_uuid}`;
      await sendWhatsAppMessage(
        phone,
        `🔒 This lesson is locked.\n\nYou've completed your free preview — pay to unlock the full course and keep going.`,
        { inline_keyboard: [[{ text: 'Pay Now', url: courseUrlStr }]] },
      );
      return;
    }
  }

  const lessonUrl = signLessonPageUrl(enrollment.course_uuid, lesson.id, lesson.order_num, String(phone));
  const fp = encodeFingerprint(String(phone));

  const isWatchAgain = lesson.order_num < (enrollment.current_lesson || 1);
  const headerText = isWatchAgain
    ? `🔄 Watching Again: Lesson ${lesson.order_num}: ${escMd(lesson.title)}`
    : `📖 Lesson ${lesson.order_num}: ${escMd(lesson.title)}`;

  const message = `${headerText}\n\nTap the link to open the lesson. Access expires in 2 hours.\n\n• ▶ Open Lesson: ${lessonUrl}\n\n🔒 This link is personal. Do not share it.\n${fp}`;

  const keyboard = await buildLessonMenuKeyboard(supabase, enrollment, lesson);
  await sendWhatsAppMessage(phone, message, keyboard);

  await supabase
    .from('enrollments')
    .update({ last_accessed: new Date().toISOString() })
    .eq('id', enrollment.id)
    .then(() => {}).catch(() => {});
}

async function handleIncomingMessage(metaMessage) {
  try {
    const phone = metaMessage.from; // Meta sends digits only, e.g. "919306385029"
    let text = '';
    if (metaMessage.type === 'text') {
      text = (metaMessage.text?.body || '').trim();
    } else if (metaMessage.type === 'interactive') {
      const interactive = metaMessage.interactive;
      if (interactive?.type === 'button_reply') {
        text = interactive.button_reply.id;
      } else if (interactive?.type === 'list_reply') {
        text = interactive.list_reply.id;
      }
    }

    console.log('[handleIncomingMessage] received message from:', phone, 'text:', text);

    const hasPending = await hasPendingSubmission(phone);
    if (hasPending) {
      if (text && !text.startsWith('/')) {
        return submitAssignmentText(phone, text);
      }
    }

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const token = parts[1] || '';
      if (token.startsWith('done_')) {
        const lessonNumber = Number(token.replace('done_', ''));
        return markDone(phone, lessonNumber);
      }
      return handleStart(phone, token);
    }
    if (text === '/lesson' || text.toLowerCase() === 'lesson' || text.toLowerCase() === 'next lesson') {
      return sendLesson(phone);
    }
    if (text === '/progress' || text.toLowerCase() === 'progress') {
      return sendProgress(phone);
    }
    if (text === '/cancel' || text.toLowerCase() === 'cancel') {
      if (hasPending) {
        await cancelPending(phone);
      } else {
        await sendWhatsAppMessage(phone, 'Nothing to cancel.');
      }
      return;
    }
    if (text.startsWith('done:')) {
      const lessonNumber = Number(text.replace('done:', ''));
      return markDone(phone, lessonNumber);
    }
    if (text.startsWith('quiz:')) {
      const lessonNumber = Number(text.replace('quiz:', ''));
      return sendQuiz(phone, lessonNumber);
    }
    if (text.startsWith('assign:')) {
      const lessonNumber = Number(text.replace('assign:', ''));
      return beginAssignmentSubmit(phone, lessonNumber);
    }
    if (text.startsWith('goto:')) {
      const targetNum = Number(text.replace('goto:', ''));
      return sendSpecificLesson(phone, targetNum);
    }
    if (text.startsWith('activities:')) {
      const lessonNumber = Number(text.replace('activities:', ''));
      const enrollment = await getEnrollment(phone);
      if (!enrollment) { await sendWhatsAppMessage(phone, 'No course connected yet.'); return; }
      return sendActivitiesMenu(supabase, phone, enrollment, lessonNumber);
    }
    if (text.startsWith('notes:')) {
      const lessonNumber = Number(text.replace('notes:', ''));
      const enrollment = await getEnrollment(phone);
      if (!enrollment) { await sendWhatsAppMessage(phone, 'No course connected yet.'); return; }
      return sendNotesForLesson(supabase, phone, enrollment, lessonNumber);
    }
    if (text === 'mycourses' || text.toLowerCase() === 'my courses') {
      const enrollment = await getEnrollment(phone);
      if (!enrollment) { await sendWhatsAppMessage(phone, 'No course connected yet.'); return; }
      await sendWhatsAppMessage(
        phone,
        '📚 My Courses',
        { inline_keyboard: [[{ text: '📚 Open My Courses', url: signMyCoursesUrl(String(enrollment.phone)) }]] },
      );
      return;
    }

    // Default response
    return sendWhatsAppMessage(
      phone,
      'Welcome! Use these commands:\n• /lesson - Get your next lesson\n• /progress - Check your progress\n• my courses - See all your enrolled courses\n• /cancel - Cancel pending task',
    );
  } catch (err) {
    console.error('[handleIncomingMessage] unhandled error:', err.message, err.stack);
  }
}

// Validate Meta's webhook signature — HMAC-SHA256 over the raw request
// body, sent in the X-Hub-Signature-256 header. Needs the raw bytes
// (captured via express.json's verify hook above), not the re-serialized
// parsed body, since re-serializing can change key order/whitespace and
// silently break the signature check.
function validateMetaSignature(req, appSecret) {
  const signatureHeader = req.get('X-Hub-Signature-256');
  if (!signatureHeader || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch → definitely invalid, not a crash
  }
}

// One-time (and periodic) verification handshake Meta sends as a GET
// request when you configure the webhook URL in Meta App Dashboard.
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
    console.log('[webhook/whatsapp] ✅ verify handshake OK');
    return res.status(200).send(challenge);
  }
  console.error('[webhook/whatsapp] ❌ verify handshake failed');
  return res.sendStatus(403);
});

// Webhook endpoint for Meta — must match what's configured in
// Meta App Dashboard > WhatsApp > Configuration > Webhook URL.
app.post("/webhook/whatsapp", async (req, res) => {
  console.log("[webhook/whatsapp] POST received | rawBody present:", Boolean(req.rawBody), "| rawBody length:", req.rawBody?.length || 0);
  try {
    if (META_APP_SECRET) {
      const isValid = validateMetaSignature(req, META_APP_SECRET);
      console.log("[webhook/whatsapp] signature check:", isValid ? "✅ valid" : "❌ INVALID");
      if (!isValid) {
        console.error('[webhook/whatsapp] ❌ Invalid Meta signature — X-Hub-Signature-256 header present:', Boolean(req.get('X-Hub-Signature-256')));
        return res.status(403).send('Forbidden');
      }
    } else {
      console.warn("[webhook/whatsapp] ⚠️ META_APP_SECRET not set — skipping signature check entirely");
    }

    res.sendStatus(200); // ack immediately — Meta retries hard on non-200/timeout

    console.log("[webhook/whatsapp] payload:", JSON.stringify(req.body).slice(0, 2000));

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      console.log("[webhook/whatsapp] no message in payload — likely a status callback (sent/delivered/read), or a Meta test payload with a different shape");
      return;
    }
    console.log("[webhook/whatsapp] message extracted, id:", message.id, "| type:", message.type, "| from:", message.from);

    // Idempotency check — WAMID plays the same role Twilio's MessageSid did
    const messageId = message.id;
    if (messageId) {
      const { data: existing } = await supabase
        .from('webhook_processed_messages')
        .select('message_sid')
        .eq('message_sid', messageId)
        .maybeSingle();

      if (existing) {
        console.log('[webhook/whatsapp] ℹ️ Already processed message ID:', messageId);
        return;
      }
      await supabase.from('webhook_processed_messages').insert({ message_sid: messageId });
    }

    await handleIncomingMessage(message);
  } catch (err) {
    console.error("[webhook/whatsapp] ❌ unhandled error:", err.message, err.stack);
  }
});

// Called by course-web's /api/cron/live-session-reminders (the daily-on-
// Hobby-tier 24h advance reminder) — not a WhatsApp webhook, just an
// internal service-to-service call, so it's protected by a shared bearer
// secret instead of the Meta signature check. The 30-minute reminder does
// NOT come through here — see pollLiveClassReminders below, which runs
// entirely inside this process on its own timer.
app.post("/internal/send-reminder", async (req, res) => {
  const auth = req.get("Authorization") || "";
  if (!INTERNAL_BOT_SECRET || auth !== `Bearer ${INTERNAL_BOT_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { phone, lessonTitle, courseName, timeLabel, joinUrl } = req.body || {};
  if (!phone || !lessonTitle || !courseName || !timeLabel || !joinUrl) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const ok = await sendWhatsAppTemplate(phone, [lessonTitle, courseName, timeLabel, joinUrl]);
  if (!ok) {
    return res.status(502).json({ error: "Meta rejected the template send — check template name/approval status" });
  }
  return res.status(200).json({ ok: true });
});

app.get("/", (req, res) => {
  res.json({
    status: "Kurso WhatsApp bot running",
    time: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════════
// 30-MINUTE LIVE CLASS REMINDER — self-scheduled, runs on the bot itself
// ═══════════════════════════════════════════════════════════════════
// This does NOT depend on course-web's Vercel cron at all — Railway runs
// this process continuously, so it can poll on its own timer with no
// "once a day" ceiling the way Vercel Hobby's cron has. The 24-hour
// advance reminder still comes from course-web's daily cron (it only
// needs to run once a day anyway), but this one needs real 5-minute
// precision to hand the join link over right before class starts, so it
// lives here instead.
async function pollLiveClassReminders() {
  try {
    const windowStart = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 35 * 60 * 1000).toISOString();

    const { data: dueLessons, error: lessonsError } = await supabase
      .from("lessons")
      .select("id, title, course_id, order_num, live_join_url, live_scheduled_at, courses:course_id(name)")
      .eq("content_type", "live")
      .eq("is_published", true)
      .is("reminder_30m_sent_at", null)
      .not("live_join_url", "is", null)
      .gte("live_scheduled_at", windowStart)
      .lte("live_scheduled_at", windowEnd);

    if (lessonsError) {
      console.error("[pollLiveClassReminders] lesson query failed:", lessonsError.message);
      return;
    }
    if (!dueLessons || dueLessons.length === 0) return;

    for (const lesson of dueLessons) {
      const { data: students, error: studentsError } = await supabase
        .from("enrollments")
        .select("phone, students(reminder_channel)")
        .eq("course_uuid", lesson.course_id)
        .eq("current_lesson", lesson.order_num)
        .eq("payment_status", "paid");

      if (studentsError) {
        console.error("[pollLiveClassReminders] enrollment query failed for lesson", lesson.id, studentsError.message);
        continue;
      }

      const courseName = lesson.courses?.name || "your course";

      for (const s of students || []) {
        const channel = s.students?.reminder_channel;
        if (channel !== "whatsapp" || !s.phone) continue;

        const ok = await sendWhatsAppTemplate(s.phone, [lesson.title, courseName, "in 30 minutes", lesson.live_join_url]);
        console.log(`[pollLiveClassReminders] 30m reminder to ${s.phone} for lesson ${lesson.id}: ${ok ? "sent" : "FAILED"}`);
      }

      await supabase.from("lessons").update({ reminder_30m_sent_at: new Date().toISOString() }).eq("id", lesson.id);
    }
  } catch (err) {
    console.error("[pollLiveClassReminders] unhandled error:", err.message);
  }
}

setInterval(pollLiveClassReminders, 5 * 60 * 1000);
pollLiveClassReminders(); // also run once at startup instead of waiting 5 min for the first check

const PORT = process.env.PORT || 3003;

// DIAGNOSTIC — catches any request that didn't match a real route above.
// If Meta is somehow hitting a slightly different path (trailing slash,
// typo in the Callback URL, etc.), this logs it instead of just returning
// a silent 404 with nothing in the logs.
app.use((req, res) => {
  console.log(`[404] No route matched: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not found" });
});

// DIAGNOSTIC — global error handler, must be defined last and take 4 args
// for Express to recognize it as an error handler. Catches anything that
// throws outside an individual route's own try/catch (e.g. in middleware)
// so it shows up in logs instead of Express silently sending its default
// error page.
app.use((err, req, res, next) => {
  console.error(`[UNHANDLED ERROR] ${req.method} ${req.originalUrl}:`, err.message, err.stack);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => console.log(`WhatsApp bot running on port ${PORT}`));