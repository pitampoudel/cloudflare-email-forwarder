export default {
    async email(message, env, ctx) {
        const routes = safeJson(env.ROUTES_JSON, {});
        let routeConfig = routes[message.to];
        if (!routeConfig) {
            routeConfig = routes["fallback"];
        }
        const forwardTo = routeConfig?.forwardTo;

        if (forwardTo == null) message.setReject("Unknown address");

        await fetch("https://webhook.slack/notification", {
            body: `Got an email from ${message.from}, subject: ${message.headers.get('subject')}`,
        });
        try {
            message.forward(forwardTo);

        } catch (e) {
            // send using different from address
        }

    }
}

function safeJson(str, fallback) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
}


async function slackApiForm(token, method, fields) {
    const url = `https://slack.com/api/${method}`;
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const res = await fetch(url, {
        method: "POST",
        headers: {Authorization: `Bearer ${token}`},
        body: form,
    });

    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return {ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 300)};
    }
}