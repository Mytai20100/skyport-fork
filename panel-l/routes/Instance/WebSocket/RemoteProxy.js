const express = require("express");
const router = express.Router();
const WebSocket = require("ws");
const { db } = require("../../../handlers/db.js");
const { isUserAuthorizedForContainer } = require("../../../utils/authHelper.js");

// Pterodactyl/Pelican WebSocket console proxy
// GET /remote-console/:id  (id = local skyport instance id that has _remoteProxy)
router.ws("/remote-console/:id", async (ws, req) => {
  if (!req.user) return ws.close(1008, "Authorization required");

  const { id } = req.params;
  const instance = await db.get(id + "_instance");
  if (!instance || !instance._remoteProxy) return ws.close(1008, "Not a remote instance");

  const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
  if (!isAuthorized) return ws.close(1008, "Unauthorized");

  const proxy = instance._remoteProxy;
  const remoteInstances = (await db.get("remote_instances")) || [];
  const remote = remoteInstances.find((r) => r.id === proxy.remoteId);
  if (!remote) return ws.close(1008, "Remote panel not found");

  const axios = require("axios");

  if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
    // Step 1: get WebSocket credentials from Pterodactyl API
    try {
      const resp = await axios.get(
        `${remote.panelUrl}/api/client/servers/${proxy.serverId}/websocket`,
        {
          headers: {
            Authorization: `Bearer ${remote.apiKey}`,
            Accept: "application/json",
          },
          timeout: 8000,
        }
      );
      const wsData = resp.data && resp.data.data;
      if (!wsData || !wsData.socket || !wsData.token) {
        ws.send("\x1b[31;1mFailed to get WebSocket credentials from remote panel.\r\n\x1b[0m");
        return ws.close();
      }

      const remoteWs = new WebSocket(wsData.socket, {
        headers: { Origin: remote.panelUrl },
      });

      remoteWs.onopen = () => {
        remoteWs.send(JSON.stringify({ event: "auth", args: [wsData.token] }));
      };

      remoteWs.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // Forward console output lines
          if (data.event === "console output" && data.args) {
            ws.send(data.args.join("\n") + "\r\n");
          } else if (data.event === "auth success") {
            // After auth, request recent log history
            remoteWs.send(JSON.stringify({ event: "send logs", args: [] }));
          } else if (data.event === "token expiring") {
            // Refresh token
            axios.get(`${remote.panelUrl}/api/client/servers/${proxy.serverId}/websocket`, {
              headers: { Authorization: `Bearer ${remote.apiKey}`, Accept: "application/json" },
              timeout: 8000,
            }).then((r) => {
              if (r.data && r.data.data && r.data.data.token) {
                remoteWs.send(JSON.stringify({ event: "auth", args: [r.data.data.token] }));
              }
            }).catch(() => {});
          }
        } catch (e) {
          // non-JSON, forward raw
          if (typeof msg.data === "string") ws.send(msg.data);
        }
      };

      remoteWs.onerror = () => {
        ws.send("\x1b[31;1mRemote console connection error.\r\n\x1b[0m");
      };

      remoteWs.onclose = () => {
        try { ws.close(); } catch (e) {}
      };

      // Commands from user → forward as Pterodactyl "send command" event
      ws.onmessage = (msg) => {
        try {
          const d = JSON.parse(msg.data);
          if (d.event === "send command" && d.args) {
            remoteWs.send(JSON.stringify({ event: "send command", args: d.args }));
          } else if (d.event === "power:start" || d.event === "power:stop" || d.event === "power:restart" || d.event === "power:kill") {
            const signal = d.event.replace("power:", "");
            remoteWs.send(JSON.stringify({ event: "set state", args: [signal] }));
          } else {
            remoteWs.send(msg.data);
          }
        } catch (e) {
          remoteWs.send(msg.data);
        }
      };

      ws.on("close", () => {
        try { remoteWs.close(); } catch (e) {}
      });

    } catch (err) {
      ws.send(`\x1b[31;1mError: ${err.message}\r\n\x1b[0m`);
      ws.close();
    }

  } else if (remote.panelType === "skyport") {
    // Skyport remote: proxy raw WebSocket
    try {
      const remoteWs = new WebSocket(
        `ws://${new URL(remote.panelUrl).host}/console/${proxy.serverId}`,
        { headers: { Cookie: `token=${remote.apiKey}` } }
      );

      remoteWs.onmessage = (msg) => { try { ws.send(msg.data); } catch (e) {} };
      remoteWs.onerror = () => { ws.send("\x1b[31;1mRemote Skyport connection error.\r\n\x1b[0m"); };
      remoteWs.onclose = () => { try { ws.close(); } catch (e) {} };

      ws.onmessage = (msg) => { try { remoteWs.send(msg.data); } catch (e) {} };
      ws.on("close", () => { try { remoteWs.close(); } catch (e) {} });
    } catch (err) {
      ws.send(`\x1b[31;1mError: ${err.message}\r\n\x1b[0m`);
      ws.close();
    }
  } else {
    ws.send("\x1b[33mConsole proxy not supported for this panel type.\r\n\x1b[0m");
    ws.close();
  }
});

// Stats polling for remote instances (returns fake WS stats stream)
router.ws("/remote-stats/:id", async (ws, req) => {
  if (!req.user) return ws.close(1008, "Authorization required");

  const { id } = req.params;
  const instance = await db.get(id + "_instance");
  if (!instance || !instance._remoteProxy) return ws.close(1008, "Not a remote instance");

  const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
  if (!isAuthorized) return ws.close(1008, "Unauthorized");

  const proxy = instance._remoteProxy;
  const remoteInstances = (await db.get("remote_instances")) || [];
  const remote = remoteInstances.find((r) => r.id === proxy.remoteId);
  if (!remote) return ws.close(1008, "Remote panel not found");

  const axios = require("axios");
  let interval;
  let alive = true;

  async function fetchStats() {
    if (!alive) return;
    try {
      let statsUrl;
      let headers = { Authorization: `Bearer ${remote.apiKey}`, Accept: "application/json" };

      if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
        statsUrl = `${remote.panelUrl}/api/client/servers/${proxy.serverId}/resources`;
      } else if (remote.panelType === "skyport") {
        statsUrl = `${remote.panelUrl}/api/v1/instances/${proxy.serverId}/stats`;
      } else {
        statsUrl = `${remote.panelUrl}/api/client/servers/${proxy.serverId}/resources`;
      }

      const r = await axios.get(statsUrl, { headers, timeout: 6000, validateStatus: () => true });
      if (!alive) return;

      if (r.status === 200 && r.data) {
        let memUsage = 0, memLimit = 0, cpuUsage = 0, diskUsage = 0, netRxBytes = 0, netTxBytes = 0;

        if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
          const attr = r.data.attributes || {};
          const resources = attr.resources || {};
          memUsage    = (resources.memory_bytes || 0) / 1024;   // KB
          memLimit    = (proxy.limits && proxy.limits.memory ? proxy.limits.memory * 1024 * 1024 : 0) / 1024;
          cpuUsage    = resources.cpu_absolute || 0;
          diskUsage   = resources.disk_bytes || 0;
          netRxBytes  = resources.network_rx_bytes || 0;
          netTxBytes  = resources.network_tx_bytes || 0;
        } else {
          // generic / skyport
          const s = r.data.stats || r.data;
          memUsage  = (s.memory_bytes || s.memoryUsage || 0) / 1024;
          memLimit  = (proxy.limits && proxy.limits.memory ? proxy.limits.memory * 1024 * 1024 : 0) / 1024;
          cpuUsage  = s.cpu_absolute || s.cpuUsage || 0;
          diskUsage = s.disk_bytes   || s.diskUsage || 0;
        }

        // Format like skyportd stats so instance.ejs JS can reuse
        const fakeStats = {
          memory_stats: {
            usage: memUsage * 1024,   // bytes
            limit: memLimit * 1024,
          },
          cpu_stats: {
            cpu_usage: { total_usage: cpuUsage * 1e9 },
            system_cpu_usage: 1e11,
          },
          precpu_stats: {
            cpu_usage: { total_usage: 0 },
            system_cpu_usage: 0,
          },
          _remote: true,
          _cpuPercent: cpuUsage,
          _diskBytes: diskUsage,
          _netRxBytes: netRxBytes,
          _netTxBytes: netTxBytes,
        };
        try { ws.send(JSON.stringify(fakeStats)); } catch (e) {}
      }
    } catch (err) {
      // send empty stats so it doesn't break the UI
      try { ws.send(JSON.stringify({ memory_stats: { usage: 0, limit: 0 }, cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 1e11 }, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 } })); } catch (e) {}
    }
  }

  interval = setInterval(fetchStats, 3000);
  fetchStats();

  ws.on("close", () => {
    alive = false;
    clearInterval(interval);
  });
});

module.exports = router;
