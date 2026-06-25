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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g., "whatsapp:+14155238886"
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const ACADEMYKIT_URL = (process.env.ACADEMYKIT_URL || "").replace(/\/$/, "");
const LESSON_LINK_SECRET =
  process.env.WHATSAPP_LINK_SECRET ||
  process.env.LESSON_LINK_SECRET ||
  WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Initialize shared modules
initWatermark(supabase);
initLessonSender({
  supabase,
  sendMessage: async (phone, text, keyboard) => sendWhatsAppMessage(phone, text, keyboard),
  config: {
    WHATSAPP_LINK_SECRET: LESSON_LINK_SECRET,
    LESSON_LINK_SECRET,
    ACADEMYKIT_URL,
  },
});
initQuizSender({
  supabase,
  sendMessage: async (phone, text, keyboard) => sendWhatsAppMessage(phone, text, keyboard),
  config: {},
});
initAssignmentSender({
  supabase,
  sendMessage: async (phone, text, keyboard) => sendWhatsAppMessage(phone, text, keyboard),
  config: {},
});

Object.entries({
  TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT_SID,
  TWILIO_WHATSAPP_NUMBER: TWILIO_WHATSAPP_NUMBER,
  ACADEMYKIT_URL: ACADEMYKIT_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
}).forEach(([key, value]) =>
  console.log(`${key}: ${value ? "loaded" : "MISSING"}`),
);

// Helper to send WhatsApp messages via Twilio
async function sendWhatsAppMessage(toPhone, text, keyboard) {
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  // Basic auth for Twilio
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  // Build Twilio message body
  const body = {
    From: TWILIO_WHATSAPP_NUMBER,
    To: toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`,
    Body: text,
  };

  // If we have a keyboard, add interactive buttons (Twilio WhatsApp doesn't natively support inline keyboards like Telegram,
  // so we'll use quick reply buttons or just send links as text)
  // For now, let's handle simple links and buttons by formatting them in the message
  if (keyboard && keyboard.inline_keyboard) {
    let buttonText = '\n\n';
    keyboard.inline_keyboard.forEach(row => {
      row.forEach(btn => {
        if (btn.url) {
          buttonText += `• ${btn.text}: ${btn.url}\n`;
        } else if (btn.callback_data) {
          // For callback data, we'll tell the user to send the text or we'll need to use Twilio's interactive buttons
          buttonText += `• ${btn.text} (send "${btn.callback_data}")\n`;
        }
      });
    });
    body.Body += buttonText;
  }

  try {
    await axios.post(twilioUrl, new URLSearchParams(body), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
      },
      timeout: 10000,
    });
  } catch (err) {
    console.error('[sendWhatsAppMessage] error:', err.response?.data || err.message);
    throw err;
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
      .eq("phone", String(phone))
      .order("enrolled_at", { ascending: false }),
  );
}

async function handleStart(phone, token) {
  if (!token) {
    await sendWhatsAppMessage(
      phone,
      "Welcome to Kurso! 👋\n\nOpen a course page and tap *Start on WhatsApp* to connect your course.",
    );
    return;
  }

  // 1. Find valid unused token
  const tokenRow = await firstRow(
    supabase
      .from("whatsapp_tokens")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString()),
  );

  if (!tokenRow) {
    await sendWhatsAppMessage(
      phone,
      "This WhatsApp link is invalid or has expired. Please open the course page and tap *Start on WhatsApp* again.",
    );
    return;
  }

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
    await sendWhatsAppMessage(phone, "This course is no longer available.");
    // Mark token used so it cannot be retried
    await supabase
      .from("whatsapp_tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("id", tokenRow.id);
    return;
  }

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
    const { data: inserted, error: insertErr } = await supabase
      .from("students")
      .insert({
        email: tokenRow.student_email || null,
        name: tokenRow.student_name || null,
        phone: tokenRow.student_phone || null,
      })
      .select("id")
      .single();
    if (insertErr) {
      console.error("[handleStart] student insert error:", insertErr.message);
      await sendWhatsAppMessage(
        phone,
        "Something went wrong linking your account. Please try the link again.",
      );
      return;
    }
    student = inserted;
  }

  // IMPORTANT: Always use the actual WhatsApp sender phone for the enrollment.
  // This ensures getEnrollment(phone) works correctly in all subsequent commands.
  // tokenRow.student_phone is only used to look up an existing student record.
  const isPaid = Boolean(tokenRow.payment_id);
  // Use actual WhatsApp phone as the enrollment identifier, fall back to email for free-only courses
  const phoneOrEmail = String(phone);

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
    console.error("[handleStart] enrollment upsert failed:", enrollError?.message);
    await sendWhatsAppMessage(
      phone,
      "Something went wrong saving your enrollment. Please tap the link again — your access token is still valid.",
    );
    return;
  }

  await supabase
    .from("whatsapp_tokens")
    .update({ used: true, used_at: now, student_id: student?.id })
    .eq("id", tokenRow.id);

  await sendWhatsAppMessage(
    phone,
    "✅ You're connected! Send /lesson to start learning!",
  );
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

  // Fetch the lesson for its resource links + quiz + assignment
  const lesson = await firstRow(
    supabase
      .from("lessons")
      .select("id, summary_url, notes_url, quiz_questions, assignment_prompt, assignment_required")
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

  let message = `✅ Lesson ${lessonNumber} marked complete.\n\nWhat would you like to do next?\n\n`;
  if (lesson?.summary_url) {
    message += `• 📄 Summary: ${signResourceUrl(lesson.id, 'summary', phone)}\n`;
  }
  if (lesson?.notes_url) {
    message += `• 📝 Notes: ${signResourceUrl(lesson.id, 'notes', phone)}\n`;
  }
  if (lesson?.quiz_questions && lesson.quiz_questions.length > 0) {
    message += `• 🧠 Take Quiz: send "quiz:${lessonNumber}"\n`;
  }
  message += `• 📊 Progress: send "progress"\n`;
  if (lessonNumber > 1) {
    message += `• ⬅ Previous Lesson: send "goto:${lessonNumber - 1}"\n`;
  }
  if (!assignmentBlocksNext) {
    message += `• ▶ Next Lesson: send "lesson"\n`;
  }

  await sendWhatsAppMessage(phone, message);

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
    `Progress: ${completed}/${total} lessons complete (${percent}%).\nCurrent lesson: ${enrollment.current_lesson || 1}\n\n• ▶ Continue: send "lesson"`,
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
        `🔒 Assignment required\n\nComplete the assignment for Lesson ${assignmentBlock.prevLessonNum} before continuing.\n\n• 📝 Submit Assignment: send "assign:${assignmentBlock.prevLessonNum}"`,
      );
      return;
    }
  }

  const { data: lessons } = await supabase
    .from('lessons')
    .select('id, title, order_num, quiz_questions')
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
      await sendWhatsAppMessage(phone, `🔒 This lesson is locked. Enroll to unlock the full course.\n\n• Pay and unlock course: ${courseUrlStr}`);
      return;
    }
  }

  const lessonUrl = signLessonPageUrl(enrollment.course_uuid, lesson.id, lesson.order_num, String(phone));
  const fp = encodeFingerprint(String(phone));

  const isWatchAgain = lesson.order_num < (enrollment.current_lesson || 1);
  const headerText = isWatchAgain
    ? `🔄 Watching Again: Lesson ${lesson.order_num}: ${escMd(lesson.title)}`
    : `📖 Lesson ${lesson.order_num}: ${escMd(lesson.title)}`;

  let message = `${headerText}\n\nTap the link to open the lesson. Access expires in 2 hours.\n\n• ▶ Open Lesson: ${lessonUrl}\n\n🔒 This link is personal. Do not share it.\n${fp}\n\n`;
  message += `• ✅ Mark Done: send "done:${lesson.order_num}"\n`;
  message += `• 📊 Progress: send "progress"\n`;
  if (lesson.order_num > 1) {
    message += `• ⬅ Lesson ${lesson.order_num - 1}: send "goto:${lesson.order_num - 1}"\n`;
  }
  // Check if next published lesson exists
  const { data: nextLessons } = await supabase
    .from('lessons')
    .select('order_num')
    .eq('course_id', enrollment.course_uuid)
    .eq('order_num', lesson.order_num + 1)
    .eq('is_published', true)
    .limit(1);
  if (nextLessons && nextLessons.length > 0) {
    message += `• Lesson ${lesson.order_num + 1} ➡: send "goto:${lesson.order_num + 1}"\n`;
  }

  await sendWhatsAppMessage(phone, message);

  await supabase
    .from('enrollments')
    .update({ last_accessed: new Date().toISOString() })
    .eq('id', enrollment.id)
    .then(() => {}).catch(() => {});
}

async function handleIncomingMessage(req) {
  try {
    // Twilio sends form data, let's parse it
    let body;
    if (req.is('urlencoded')) {
      body = req.body;
    } else {
      body = req.body;
    }

    const from = body.From; // e.g., "whatsapp:+1234567890"
    const to = body.To;
    const text = (body.Body || '').trim();
    const phone = from.replace('whatsapp:', '');

    console.log('[handleIncomingMessage] received message from:', phone, 'text:', text);

    if (hasPendingSubmission(phone)) {
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
    if (text === '/lesson' || text.toLowerCase() === 'lesson') {
      return sendLesson(phone);
    }
    if (text === '/progress' || text.toLowerCase() === 'progress') {
      return sendProgress(phone);
    }
    if (text === '/cancel' || text.toLowerCase() === 'cancel') {
      if (hasPendingSubmission(phone)) {
        cancelPending(phone);
        return sendWhatsAppMessage(phone, 'Assignment submission cancelled.');
      }
      return sendWhatsAppMessage(phone, 'Nothing to cancel.');
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

    // Default response
    return sendWhatsAppMessage(
      phone,
      'Welcome! Use these commands:\n• /lesson - Get your next lesson\n• /progress - Check your progress\n• /cancel - Cancel pending task',
    );
  } catch (err) {
    console.error('[handleIncomingMessage] unhandled error:', err.message, err.stack);
  }
}

// Webhook endpoint for Twilio — must match what you set in Twilio Console Sandbox Settings
app.post("/webhook/whatsapp", async (req, res) => {
  // Respond to Twilio immediately with 200 OK
  res.status(200).send('<Response></Response>');
  try {
    await handleIncomingMessage(req);
  } catch (err) {
    console.error("WhatsApp webhook error:", err.message);
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "AcademyKit WhatsApp bot running",
    time: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`WhatsApp bot running on port ${PORT}`));
