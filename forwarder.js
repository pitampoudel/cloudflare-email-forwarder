
export default {
    async email(message, env, ctx) {
        const routes = safeJson(env.ROUTES_JSON, {});
        const routeConfig = routes?.[message.to];
        const forwardTo = routeConfig?.forwardTo;

        if (forwardTo == null) message.setReject("Unknown address");

        await fetch("https://webhook.slack/notification", {
            body: `Got a marketing email from ${message.from}, subject: ${message.headers.get('subject')}`,
        });
        message.forward(forwardTo);

    }
}

function safeJson(str, fallback) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
}
