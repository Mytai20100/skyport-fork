const express = require("express");
const router = express.Router();
const WebSocket = require("ws");
const { db } = require("../../../handlers/db.js");
const { isUserAuthorizedForContainer } = require("../../../utils/authHelper");

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(data); } catch (e) {}
  }
}

router.ws("/stats/:id", async (ws, req) => {
  if (!req.user) return ws.close(1008, "Authorization required");

  const { id } = req.params;
  const instance = await db.get(id + "_instance");

  if (!instance || !id) return ws.close(1008, "Invalid instance or ID");

  // Remote proxy instances use /remote-stats/:id instead
  if (instance._remoteProxy) return ws.close(1008, "Use /remote-stats/:id for remote instances");

  const isAuthorized = await isUserAuthorizedForContainer(
    req.user.userId,
    instance.Id
  );
  if (!isAuthorized) {
    return ws.close(1008, "Unauthorized access");
  }

  const node = instance.Node;
  const volume = instance.VolumeId;
  let daemonSocket = null;
  let clientClosed = false;

  function connectToDaemon() {
    if (clientClosed) return;

    daemonSocket = new WebSocket(
      `ws://${node.address}:${node.port}/stats/${instance.ContainerId}/${volume}`
    );

    daemonSocket.onopen = () => {
      daemonSocket.send(JSON.stringify({ event: "auth", args: [node.apiKey] }));
    };

    daemonSocket.onmessage = (msg) => {
      safeSend(ws, msg.data);
    };

    daemonSocket.onerror = () => {
      safeSend(ws, JSON.stringify({ error: "Stats service is temporarily unavailable" }));
    };

    daemonSocket.onclose = () => {
      if (!clientClosed) {
        setTimeout(() => {
          if (!clientClosed) connectToDaemon();
        }, 4000);
      }
    };
  }

  connectToDaemon();

  ws.onmessage = (msg) => {
    if (daemonSocket && daemonSocket.readyState === WebSocket.OPEN) {
      try { daemonSocket.send(msg.data); } catch (e) {}
    }
  };

  ws.on("close", () => {
    clientClosed = true;
    if (daemonSocket) {
      try { daemonSocket.close(); } catch (e) {}
    }
  });
});

module.exports = router;
