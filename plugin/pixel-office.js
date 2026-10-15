import path from "node:path";
import fs from "node:fs";

const DEFAULT_PORT = 5100;

const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
const globalDistDir = path.join(homeDir, ".opencode", "pixel-office");

const getConfiguredPort = () => {
  try {
    const configPath = path.join(globalDistDir, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data.port === "number") {
        return data.port;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_PORT;
};

const resolveEndpoint = () => {
  const port = process.env.PIXEL_OFFICE_PORT || getConfiguredPort();
  const raw = process.env.PIXEL_OFFICE_URL || `http://localhost:${port}/events`;
  return raw.endsWith("/events") ? raw : `${raw.replace(/\/$/, "")}/events`;
};

const post = async (endpoint, payload) => {
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, source: "opencode" }),
    });
  } catch {
    // Pixel Office server not running, silently ignore.
  }
};

// OpenCode 2.x emits a different event envelope ({ id, created, type, location, data })
// and different event names than 1.x. The Pixel Office server still speaks the legacy
// shape ({ type, properties }), so translate each V2 event into its closest V1 equivalent.
const translateV2Event = (event, sessionMeta = new Map()) => {
  const type = event?.type;
  const data = event?.data || {};
  const sessionID = data.sessionID || "";
  const messageInfo = { sessionID, id: data.assistantMessageID || "" };

  // Only session.step.started carries the agent name + model. Cache them per session so later
  // tool events reuse them; otherwise the server creates a phantom agent keyed by the bare
  // session id (name "ses_...", model "unknown") alongside the real one.
  if (type === "session.step.started" && sessionID && (data.agent || data.model)) {
    sessionMeta.set(sessionID, { agent: data.agent, model: data.model });
  }
  const meta = sessionMeta.get(sessionID) || {};
  const agentInfo = {
    agent: meta.agent || "opencode",
    model: {
      modelID: meta.model?.id || "",
      providerID: meta.model?.providerID || "",
    },
  };

  switch (type) {
    // A new agent step started: register/refresh the agent and mark it working.
    case "session.step.started": {
      return [
        {
          type: "tool.execute.before",
          properties: {
            sessionID,
            info: {
              agent: data.agent || "opencode",
              sessionID,
              model: {
                modelID: data.model?.id || "",
                providerID: data.model?.providerID || "",
              },
            },
            tool: { name: "step" },
          },
        },
      ];
    }

    // A tool was invoked: "working" + tool name.
    case "session.tool.called": {
      return [
        {
          type: "tool.execute.before",
          properties: {
            sessionID,
            info: { ...messageInfo, ...agentInfo },
            tool: { name: data.name || "tool", input: data.input },
          },
        },
      ];
    }

    // A tool finished: "thinking".
    case "session.tool.success": {
      return [
        {
          type: "tool.execute.after",
          properties: {
            sessionID,
            info: { ...messageInfo, ...agentInfo },
            tool: { output: data.content },
          },
        },
      ];
    }

    // Streamed assistant text: message part update, drives the live snippet.
    case "session.text.delta":
    case "session.reasoning.delta": {
      const delta = data.delta || "";
      if (!delta) {
        return [];
      }
      return [
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            info: messageInfo,
            part: {
              id: `${data.assistantMessageID || "msg"}:${data.ordinal ?? 0}`,
              messageID: data.assistantMessageID || "",
              sessionID,
              type: type === "session.reasoning.delta" ? "reasoning" : "text",
              text: delta,
              delta,
            },
          },
        },
      ];
    }

    // The turn finished with no pending tool calls: idle.
    case "session.step.ended": {
      if (data.finish && data.finish !== "tool-calls") {
        return [{ type: "session.idle", properties: { sessionID } }];
      }
      return [];
    }

    // The user's prompt was queued: surface it as the "boss message".
    case "session.inbox.enqueued": {
      const item = data.item || {};
      const text = item.type === "user" ? item.payload?.text || "" : "";
      if (!text) {
        return [];
      }
      const messageID = data.inboxID || `${sessionID}:user`;
      return [
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            info: { role: "user", sessionID },
            part: {
              id: `${messageID}:user`,
              messageID,
              sessionID,
              type: "user",
              text,
            },
          },
        },
      ];
    }

    default:
      return [];
  }
};

const plugin = {
  id: "pixel-office",

  // OpenCode 2.x entrypoint.
  async setup(ctx) {
    const endpoint = resolveEndpoint();
    const controller = new AbortController();
    const sessionMeta = new Map();

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!event || !event.type) {
            continue;
          }
          for (const mapped of translateV2Event(event, sessionMeta)) {
            await post(endpoint, mapped);
          }
        }
      } catch {
        // Stream aborted on dispose.
      }
    })();

    return () => controller.abort();
  },
};

// Backwards compatibility with OpenCode 1.18.x (V1 plugin API). V1 events already use
// the legacy { type, properties } shape, so they are forwarded as-is.
plugin.server = async () => {
  const endpoint = resolveEndpoint();
  return {
    event: async ({ event }) => {
      if (event) {
        await post(endpoint, event);
      }
    },
  };
};

export default plugin;

// Exported for unit testing of the V2 -> V1 event translation.
export { translateV2Event };
