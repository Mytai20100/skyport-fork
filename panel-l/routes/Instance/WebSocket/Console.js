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

router.ws("/console/:id", async (ws, req) => {
  if (!req.user) return ws.close(1008, "Authorization required");

  const { id } = req.params;
  const instance = await db.get(id + "_instance");

  if (!instance || !id) return ws.close(1008, "Invalid instance or ID");

  const isAuthorized = await isUserAuthorizedForContainer(
    req.user.userId,
    instance.Id
  );
  if (!isAuthorized) {
    return ws.close(1008, "Unauthorized access");
  }

  const node = instance.Node;

  // Validate node and container data before proceeding
  if (!node || !node.address || !node.port) {
    safeSend(ws, "\x1b[31;1mConfiguration error: Node address or port is missing.\x1b[0m\n");
    return ws.close(1011, "Invalid node configuration");
  }
  if (!instance.ContainerId) {
    safeSend(ws, "\x1b[31;1mConfiguration error: Container ID is not set. The instance may still be installing.\x1b[0m\n");
    return ws.close(1011, "Missing ContainerId");
  }

  let daemonSocket = null;
  let clientClosed = false;

  function connectToDaemon() {
    if (clientClosed) return;

    daemonSocket = new WebSocket(
      `ws://${node.address}:${node.port}/exec/${instance.ContainerId}`
    );

    daemonSocket.onopen = () => {
      daemonSocket.send(JSON.stringify({ event: "auth", args: [node.apiKey] }));
    };

    daemonSocket.onmessage = (msg) => {
      safeSend(ws, msg.data);
    };

    daemonSocket.onerror = () => {
      safeSend(
        ws,
        "\x1b[31;1mThis instance is unavailable! \n\x1b[0mThe skyportd instance appears to be down. Retrying...\n"
      );
    };

    daemonSocket.onclose = () => {
      if (!clientClosed) {
        safeSend(
          ws,
          "\x1b[33;1m[panel] \x1b[0mConnection to daemon lost. Reconnecting...\n"
        );
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
