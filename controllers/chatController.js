function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function privacyHttpPayload(privacy) {
  if (!privacy) return null;
  return {
    ...privacy,
    statusUrl: `/api/chat/privacy-operations/${privacy.operationId}`,
  };
}

function createChatController({ chatModule, memory, config, logger, withRequestContext } = {}) {
  if (!chatModule?.sendMessage || !chatModule?.editMessage || !chatModule?.presets || !chatModule?.sessions) {
    throw new Error("Chat module is required");
  }
  if (typeof memory?.markRecoveryNotificationsDelivered !== "function") throw new Error("Chat Memory port is required");
  if (!config?.rag) throw new Error("Chat HTTP config is required");
  if (typeof logger?.error !== "function" || typeof logger?.warn !== "function") throw new Error("Chat logger is required");
  if (typeof withRequestContext !== "function") throw new Error("Request context adapter is required");

  function sendFailure(req, res, event, error, detail = {}, { exposeInternal = false } = {}) {
    const status = Number(error?.status) || 500;
    if (status >= 500) logger.error(event, withRequestContext(req, { error, ...detail }));
    const message = status < 500 || exposeInternal ? error?.message : "Internal Server Error";
    return res.status(status).json({ error: message || "Internal Server Error" });
  }

  function getRagSources(context) {
    return (Array.isArray(context?.rag?.sources) ? context.rag.sources : []).filter(Boolean);
  }

  function attachRagSources(message, context) {
    const sources = getRagSources(context);
    const debug = config.rag.enabled && config.rag.debugIncludeContent && context?.rag
      ? { enabled: Boolean(context.rag.enabled), stats: context.rag.stats || null, sources }
      : null;
    if (!message || (!sources.length && !debug)) return message;
    return { ...message, ...(sources.length ? { rag_sources: sources } : {}), ...(debug ? { rag_debug: debug } : {}) };
  }

  function attachContextHealth(payload, context, res) {
    const notifications = Array.isArray(context?.memoryRecoveryNotifications) ? context.memoryRecoveryNotifications : [];
    const next = { ...payload };
    if (context?.memoryHealth) next.memory_health = context.memoryHealth;
    if (context?.rag?.stats?.degraded) {
      next.rag_health = {
        status: "degraded",
        reason: context.rag.stats.reason,
        failure: context.rag.stats.failure,
      };
    }
    if (notifications.length) next.memory_recovery_notifications = notifications;
    const ids = notifications.map((entry) => Number(entry.id)).filter(Number.isSafeInteger);
    if (ids.length) {
      res.once("finish", () => {
        void memory.markRecoveryNotificationsDelivered(ids)
          .catch((error) => logger.warn("memory_recovery_notification_delivery_mark_failed", { error, ids }));
      });
    }
    return next;
  }

  return Object.freeze({
    async getPrivacyOperation(req, res) {
      try {
        const privacy = await chatModule.getPrivacyOperation({
          userId: req.user?.id,
          operationId: req.params.operationId,
        });
        return res.status(200).json({ privacy: privacyHttpPayload(privacy) });
      } catch (error) {
        return sendFailure(req, res, "chat_privacy_operation_get_failed", error);
      }
    },

    async getMeta(req, res) {
      try {
        return res.status(200).json(await chatModule.getMeta());
      } catch (error) {
        return sendFailure(req, res, "chat_meta_failed", error);
      }
    },

    async listPresets(req, res) {
      try {
        return res.status(200).json({ presets: await chatModule.presets.list({ userId: req.user?.id }) });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_list_failed", error);
      }
    },

    async listTrashedPresets(req, res) {
      try {
        return res.status(200).json({ presets: await chatModule.presets.listTrashed({ userId: req.user?.id }) });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_trash_list_failed", error);
      }
    },

    async createPreset(req, res) {
      try {
        const preset = await chatModule.presets.create({
          userId: req.user?.id,
          id: req.body?.id,
          name: req.body?.name,
          systemPrompt: req.body?.systemPrompt,
        });
        return res.status(201).json({ preset });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_create_failed", error);
      }
    },

    async updatePreset(req, res) {
      try {
        const preset = await chatModule.presets.update({
          userId: req.user?.id,
          presetId: req.params.presetId,
          changes: req.body,
        });
        return res.status(200).json({ preset });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_update_failed", error, { presetId: req.params.presetId });
      }
    },

    async rebuildPresetMemory(req, res) {
      try {
        const result = await chatModule.presets.rebuildMemory({
          userId: req.user?.id,
          presetId: req.params.presetId,
        });
        return res.status(202).json({ presetId: result.presetId, memory: { version: 2, ...result.rebuild } });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_memory_rebuild_failed", error, { presetId: req.params.presetId });
      }
    },

    async deletePreset(req, res) {
      try {
        await chatModule.presets.trash({ userId: req.user?.id, presetId: req.params.presetId });
        return res.status(204).send();
      } catch (error) {
        return sendFailure(req, res, "chat_preset_delete_failed", error, { presetId: req.params.presetId });
      }
    },

    async restorePreset(req, res) {
      try {
        const preset = await chatModule.presets.restore({ userId: req.user?.id, presetId: req.params.presetId });
        return res.status(200).json({ preset });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_restore_failed", error, { presetId: req.params.presetId });
      }
    },

    async deletePresetPermanently(req, res) {
      try {
        const result = await chatModule.presets.removePermanently({
          userId: req.user?.id,
          presetId: req.params.presetId,
        });
        return res.status(202).json({ presetId: result.presetId, privacy: privacyHttpPayload(result.privacy) });
      } catch (error) {
        return sendFailure(req, res, "chat_preset_delete_permanent_failed", error, { presetId: req.params.presetId });
      }
    },

    async uploadPresetAvatar(req, res) {
      try {
        const preset = await chatModule.presets.uploadAvatar({
          userId: req.user?.id,
          presetId: req.params.presetId,
          file: req.file,
        });
        return res.status(200).json({ preset });
      } catch (error) {
        return sendFailure(
          req,
          res,
          "chat_preset_avatar_upload_failed",
          error,
          { presetId: req.params.presetId },
          { exposeInternal: true },
        );
      }
    },

    async listSessions(req, res) {
      try {
        return res.status(200).json({ sessions: await chatModule.sessions.list({ userId: req.user?.id }) });
      } catch (error) {
        return sendFailure(req, res, "chat_session_list_failed", error);
      }
    },

    async listTrashedSessions(req, res) {
      try {
        return res.status(200).json({ sessions: await chatModule.sessions.listTrashed({ userId: req.user?.id }) });
      } catch (error) {
        return sendFailure(req, res, "chat_session_trash_list_failed", error);
      }
    },

    async createSession(req, res) {
      try {
        const session = await chatModule.sessions.create({
          userId: req.user?.id,
          title: req.body?.title,
          rawSettings: req.body?.settings,
          explicitPresetId: req.body?.presetId,
        });
        return res.status(201).json({ session });
      } catch (error) {
        return sendFailure(req, res, "chat_session_create_failed", error);
      }
    },

    async deleteSession(req, res) {
      try {
        await chatModule.sessions.trash({ userId: req.user?.id, sessionId: req.params.sessionId });
        return res.status(204).send();
      } catch (error) {
        return sendFailure(req, res, "chat_session_delete_failed", error, { sessionId: req.params.sessionId });
      }
    },

    async restoreSession(req, res) {
      try {
        const session = await chatModule.sessions.restore({ userId: req.user?.id, sessionId: req.params.sessionId });
        return res.status(200).json({ session });
      } catch (error) {
        return sendFailure(req, res, "chat_session_restore_failed", error, { sessionId: req.params.sessionId });
      }
    },

    async deleteSessionPermanently(req, res) {
      try {
        const result = await chatModule.sessions.removePermanently({
          userId: req.user?.id,
          sessionId: req.params.sessionId,
        });
        return res.status(202).json({ sessionId: result.sessionId, privacy: privacyHttpPayload(result.privacy) });
      } catch (error) {
        return sendFailure(req, res, "chat_session_delete_permanent_failed", error, { sessionId: req.params.sessionId });
      }
    },

    async listMessages(req, res) {
      try {
        const messages = await chatModule.sessions.listMessages({
          userId: req.user?.id,
          sessionId: req.params.sessionId,
        });
        return res.status(200).json({ messages });
      } catch (error) {
        return sendFailure(req, res, "chat_messages_list_failed", error, { sessionId: req.params.sessionId });
      }
    },

    async editMessage(req, res) {
      try {
        const result = await chatModule.editMessage({
          userId: req.user?.id,
          sessionId: req.params.sessionId,
          messageId: req.params.messageId,
          content: req.body?.content,
          regenerate: req.body?.regenerate,
          truncate: req.body?.truncate,
          rawSettings: req.body?.settings,
        });
        if (result.kind === "privacy_pending") {
          return res.status(202).json({
            session: result.session,
            user_message: result.userMessage,
            privacy: privacyHttpPayload(result.privacy),
            regeneration: result.regeneration ? {
              status: "blocked_until_privacy_completed",
              resumeAfterStatus: "completed",
              method: "POST",
              url: `/api/chat/sessions/${req.params.sessionId}/messages`,
              idempotencyKey: result.regeneration.idempotencyKey,
            } : undefined,
          });
        }
        if (result.kind === "regeneration_required") {
          return res.status(409).json({
            error: "Regeneration must resume through the send endpoint after the privacy operation completes",
            regeneration: {
              method: "POST",
              url: `/api/chat/sessions/${req.params.sessionId}/messages`,
              idempotencyKey: result.regeneration.idempotencyKey,
            },
          });
        }
        return res.status(200).json({ session: result.session, user_message: result.userMessage });
      } catch (error) {
        return sendFailure(
          req,
          res,
          "chat_message_edit_failed",
          error,
          { sessionId: req.params.sessionId, messageId: req.params.messageId },
          { exposeInternal: true },
        );
      }
    },

    async sendMessage(req, res) {
      const clientAbort = new AbortController();
      const onResponseClose = () => {
        if (!res.writableEnded) clientAbort.abort(new Error("Client disconnected"));
      };
      res.once("close", onResponseClose);
      try {
        const idempotencyKey = req.get?.("Idempotency-Key") ?? req.body?.idempotencyKey;
        const result = await chatModule.sendMessage({
          userId: req.user?.id,
          sessionId: req.params.sessionId,
          content: req.body?.content,
          idempotencyKey,
          rawSettings: req.body?.settings,
          signal: clientAbort.signal,
          onStreamStart({ sessionId, userMessage }) {
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders?.();
            writeSse(res, { type: "start", session_id: sessionId, user_message: userMessage });
          },
          onStreamDelta(delta) {
            writeSse(res, { type: "delta", delta });
          },
        });
        const payload = attachContextHealth({
          session: result.session,
          user_message: result.userMessage,
          assistant_message: attachRagSources(result.assistantMessage, result.context),
          ...(result.kind === "idempotent_replay" ? { idempotent_replay: true } : {}),
        }, result.context, res);
        if (result.stream) {
          writeSse(res, { type: "done", ...payload });
          res.end();
          return;
        }
        return res.status(200).json(payload);
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        const message = error?.message || "Internal Server Error";
        if (res.headersSent && res.getHeader("Content-Type")?.toString().includes("text/event-stream")) {
          try {
            if (message !== "Client disconnected") writeSse(res, { type: "error", error: message });
            res.end();
          } catch {
            // Ignore a second transport failure while closing an SSE response.
          }
          return;
        }
        logger.error("chat_message_send_failed", withRequestContext(req, { error, sessionId: req.params.sessionId }));
        const payload = { error: message };
        if (error?.session) payload.session = error.session;
        if (error?.userMessage) payload.user_message = error.userMessage;
        return res.status(Number(error?.status) || 500).json(payload);
      } finally {
        res.removeListener("close", onResponseClose);
      }
    },
  });
}

module.exports = { createChatController };
