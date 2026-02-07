import PostalMime from "postal-mime";

const FALLBACK_CHANNEL_NAME = "fallback-email-inbox"; // hardcoded catch-all

export default {
    async email(message, env, ctx) {
        const token = env.SLACK_BOT_TOKEN;
        if (!token) {
            console.error("Missing SLACK_BOT_TOKEN");
            return; // NEVER reject email
        }

        const routes = safeJson(env.ROUTES_JSON, {});
        const rcpt = getPrimaryRecipient(message);

        let route = routes[rcpt];
        if (!route) {
            route = { type: "channel", name: FALLBACK_CHANNEL_NAME };
            console.warn("No route found; using fallback channel", { rcpt, fallback: FALLBACK_CHANNEL_NAME });
        }

        ctx.waitUntil(handleSlackForward(message, token, rcpt, route));
    },
};

async function handleSlackForward(message, token, rcpt, route) {
    try {
        let targetId = null;

        if (route.type === "dm") {
            targetId = await openDmChannel(token, route.user);
            if (!targetId) {
                console.error("Failed to open DM", { rcpt, user: route.user });
                return;
            }
        } else if (route.type === "channel") {
            targetId = await resolveChannelTarget(token, route);
            if (!targetId) {
                console.error(
                    "Failed to resolve channel target. If this is a private channel, invite the bot and/or set route.id (channel ID).",
                    { rcpt, route }
                );
                return;
            }
        } else {
            console.error("Invalid route type:", route.type);
            return;
        }

        const rawBytes = await getRawEmailBytes(message);
        const subject = message.headers.get("subject") || "no-subject";
        const from = message.from || message.headers.get("from") || "unknown";
        const toHeader = message.headers.get("to") || rcpt;

        // ✅ Parse MIME so we can show it in Slack
        const parsed = await new PostalMime().parse(rawBytes);

        const bodyText =
            (parsed.text && parsed.text.trim()) ||
            (parsed.html && htmlToText(parsed.html).trim()) ||
            "";

        const bodyPreview = clampSlackText(bodyText, 2800) || "_(No readable body found.)_";

        // ✅ 1) Post an in-Slack readable message (no download required)
        const blocks = [
            {
                type: "header",
                text: { type: "plain_text", text: "📧 New email", emoji: true },
            },
            {
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*To:*\n${escapeMrkdwn(toHeader)}` },
                    { type: "mrkdwn", text: `*From:*\n${escapeMrkdwn(from)}` },
                    { type: "mrkdwn", text: `*Subject:*\n${escapeMrkdwn(subject)}` },
                ],
            },
            { type: "divider" },
            {
                type: "section",
                text: { type: "mrkdwn", text: `*Preview:*\n${bodyPreview}` },
            },
        ];

        // include attachment summary (if any)
        if (Array.isArray(parsed.attachments) && parsed.attachments.length) {
            const attLines = parsed.attachments
                .slice(0, 10)
                .map((a, i) => `• ${i + 1}. ${a.filename || "attachment"} (${a.mimeType || "unknown"}, ${a.size || "?"} bytes)`)
                .join("\n");

            blocks.push({ type: "divider" });
            blocks.push({
                type: "section",
                text: { type: "mrkdwn", text: `*Attachments (${parsed.attachments.length}):*\n${escapeMrkdwn(attLines)}` },
            });
        }

        const postRes = await slackJson("chat.postMessage", token, {
            channel: targetId,
            text: `New email: ${subject}`, // fallback text
            blocks,
            unfurl_links: false,
            unfurl_media: false,
        });

        if (!postRes.ok) {
            console.error("chat.postMessage failed:", postRes);
            // keep going; we can still upload files
        }

        // ✅ 2) Upload full body as .txt so Slack shows an inline preview (no download)
        if (bodyText && bodyText.trim()) {
            const bodyFilename = `email-body-${Date.now()}.txt`;
            const bodyBytes = new TextEncoder().encode(bodyText);

            await uploadBytesToSlack(token, targetId, bodyFilename, bodyBytes, {
                initial_comment: "Full email body (viewable in Slack):",
            });
        }

        // ✅ 3) Optional: also upload the raw .eml as an archive
        // If you don't want .eml at all, remove this block.
        const emlFilename = buildFilename(subject); // ends with .eml
        await uploadBytesToSlack(token, targetId, emlFilename, rawBytes, {
            initial_comment: "Raw email archive (.eml):",
        });

        console.log("email forwarded", { rcpt, targetId });
    } catch (e) {
        console.error("handleSlackForward crashed", e);
    }
}


async function uploadBytesToSlack(token, channelId, filename, bytes, { initial_comment } = {}) {
    const length = bytes.byteLength;

    const getUrlRes = await slackForm("files.getUploadURLExternal", token, {
        filename,
        length: String(length),
    });
    if (!getUrlRes.ok) {
        console.error("files.getUploadURLExternal failed:", getUrlRes);
        return false;
    }

    const uploadRes = await fetch(getUrlRes.upload_url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
    });
    if (!uploadRes.ok) {
        const t = await uploadRes.text().catch(() => "");
        console.error("Upload failed:", uploadRes.status, t.slice(0, 500));
        return false;
    }

    const completeRes = await slackForm("files.completeUploadExternal", token, {
        files: JSON.stringify([{ id: getUrlRes.file_id, title: filename }]),
        channel_id: channelId,
        ...(initial_comment ? { initial_comment } : {}),
    });

    if (!completeRes.ok) {
        console.error("files.completeUploadExternal failed:", completeRes);
        return false;
    }

    return true;
}

// ---------- NEW: channel target resolver ----------

async function resolveChannelTarget(token, route) {
    if (route.id && /^[CG][A-Z0-9]+$/.test(route.id)) return route.id;

    const name = sanitizeChannelName(route.name || route.channel || route.slug || "");
    if (!name) {
        console.error("Channel route missing name or valid id", { route });
        return null;
    }

    return await ensureChannelByName(token, name);
}

// ---------- Slack helpers ----------

async function openDmChannel(token, userId) {
    const res = await slackJson("conversations.open", token, { users: userId });
    if (!res.ok) {
        console.error("conversations.open failed:", res);
        return null;
    }
    return res.channel?.id || null;
}

async function ensureChannelByName(token, name) {
    const existing = await findChannelByName(token, name);
    if (existing) return existing;

    const created = await slackJson("conversations.create", token, { name });
    if (!created.ok) {
        console.error("conversations.create failed (maybe restricted perms):", created);
        return null;
    }
    return created.channel?.id || null;
}

async function findChannelByName(token, name) {
    let cursor;

    while (true) {
        const res = await slackJson("conversations.list", token, {
            limit: 200,
            cursor,
            types: "public_channel,private_channel",
            exclude_archived: true,
        });

        if (!res.ok) {
            console.error("conversations.list failed:", res);
            return null;
        }

        const ch = (res.channels || []).find((c) => c?.name === name);
        if (ch?.id) return ch.id;

        cursor = res.response_metadata?.next_cursor;
        if (!cursor) break;
    }

    return null;
}

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
    return { ok: true, ...json };
}

async function slackJson(method, token, bodyObj) {
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(bodyObj ?? {}),
    });

    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) };
    }

    if (!json.ok) return { ok: false, error: json.error, httpStatus: res.status, response: json };
    return { ok: true, ...json };
}

// ---------- routing helpers ----------

function getPrimaryRecipient(message) {
    const to = message.to;
    const raw = Array.isArray(to) ? to[0] : to;

    if (typeof raw === "string") {
        const m = raw.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
        if (m) return m[1].toLowerCase();
    }

    const h = message.headers?.get?.("to");
    if (h) {
        const m = h.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
        if (m) return m[1].toLowerCase();
    }

    return "unknown@unknown";
}

function sanitizeChannelName(name) {
    return (name || "")
        .toLowerCase()
        .trim()
        .replace(/^#/, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-_]/g, "")
        .slice(0, 80);
}

function buildFilename(subject) {
    const safeSubject = (subject || "no-subject")
        .slice(0, 80)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();

    return `email-${Date.now()}-${safeSubject || "no_subject"}.eml`;
}

function safeJson(str, fallback) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
}

async function getRawEmailBytes(message) {
    const raw = message.raw;

    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);

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

    if (typeof raw === "string") return new TextEncoder().encode(raw);

    const ab = await new Response(raw).arrayBuffer();
    return new Uint8Array(ab);
}

// ---------- text utilities ----------

function clampSlackText(text, maxChars) {
    const t = (text || "").trim();
    if (!t) return "";
    if (t.length <= maxChars) return escapeMrkdwn(t);
    return escapeMrkdwn(t.slice(0, maxChars - 1)) + "…";
}

function escapeMrkdwn(s) {
    // Minimal escaping; Slack mrkdwn is forgiving but these prevent weird formatting
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlToText(html) {
    // Simple HTML -> text conversion (good enough for email previews)
    return String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}