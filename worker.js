export default {
  async email(message, env, ctx) {
    const token = env.SLACK_BOT_TOKEN;          // xoxb-...
    const channelId = env.SLACK_CHANNEL_ID;     // C... or G...

    if (!token || !channelId) {
      console.error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID");
      return;
    }

    // 1) Get raw email bytes
    const rawBytes = await getRawEmailBytes(message);
    const length = rawBytes.byteLength;

    const subject = message.headers.get("subject") || "no-subject";
    const from = message.from || "unknown";

    const safeSubject = subject
      .slice(0, 80)
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();

    const filename = `email-${Date.now()}-${safeSubject || "no_subject"}.eml`;

    // 2) Ask Slack for an upload URL + file_id
    const getUrlRes = await slackForm("files.getUploadURLExternal", token, {
      filename,
      length: String(length), // bytes
    });

    if (!getUrlRes.ok) {
      console.error("files.getUploadURLExternal failed:", getUrlRes);
      return;
    }

    const uploadUrl = getUrlRes.upload_url;
    const fileId = getUrlRes.file_id;

    // 3) Upload bytes to Slack’s upload URL (NO Bearer token on this request)
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: rawBytes,
    });

    if (!uploadRes.ok) {
      const t = await uploadRes.text().catch(() => "");
      console.error("Upload to upload_url failed:", uploadRes.status, t.slice(0, 500));
      return;
    }

    // 4) Complete upload + share to channel with initial_comment
    const completeRes = await slackForm("files.completeUploadExternal", token, {
      // Slack expects a JSON string array: [{ id, title }]
      files: JSON.stringify([{ id: fileId, title: filename }]),
      channel_id: channelId,
      initial_comment: `📧 New email from *${from}*\n*Subject:* ${subject}`,
    });

    if (!completeRes.ok) {
      console.error("files.completeUploadExternal failed:", completeRes);
      return;
    }

    // Done ✅
  },
};

// ---------- helpers ----------

async function slackForm(method, token, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) };
  }
  if (!json.ok) return { ok: false, error: json.error, httpStatus: res.status, response: json };
  return json;
}

async function getRawEmailBytes(message) {
  const raw = message.raw;

  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);

  // ReadableStream
  if (raw && typeof raw.getReader === "function") {
    const reader = raw.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  // String
  if (typeof raw === "string") return new TextEncoder().encode(raw);

  // Fallback
  const ab = await new Response(raw).arrayBuffer();
  return new Uint8Array(ab);
}
