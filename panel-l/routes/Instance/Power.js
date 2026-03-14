const express = require("express");
const router = express.Router();
const {
  isUserAuthorizedForContainer,
  isInstanceSuspended,
} = require("../../utils/authHelper");
const { db } = require("../../handlers/db.js");

router.post("/instance/:id/power", async (req, res) => {
  if (!req.user) return res.redirect("/");
  const { id } = req.params;
  const instance = await db.get(id + "_instance");

  if (!instance || !id) return res.redirect("../instances");

  // ── Remote proxy instance: forward to remote panel ──────────────────────────
  if (instance._remoteProxy) {
    const axios = require("axios");
    const proxy = instance._remoteProxy;
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === proxy.remoteId);
    if (!remote) return res.status(404).send("Remote panel not found");

    const action = req.body.action || "stop"; // start | stop | restart | kill
    const headers = { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
    let url, body;

    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      url  = `${remote.panelUrl}/api/client/servers/${proxy.serverId}/power`;
      body = { signal: action };
    } else if (remote.panelType === "skyport") {
      url  = `${remote.panelUrl}/api/v1/instances/${proxy.serverId}/power`;
      body = { action };
    } else {
      url  = `${remote.panelUrl}/api/client/servers/${proxy.serverId}/power`;
      body = { signal: action };
    }

    try {
      const r = await axios.post(url, body, { headers, timeout: 10000, validateStatus: () => true });
      if (r.status >= 200 && r.status < 300) {
        return res.json({ success: true });
      } else {
        return res.json({ success: false, error: `HTTP ${r.status}` });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  const isAuthorized = await isUserAuthorizedForContainer(
    req.user.userId,
    instance.Id
  );
  if (!isAuthorized) {
    return res.status(403).send("Unauthorized access to this instance.");
  }

  const suspended = await isInstanceSuspended(req.user.userId, instance, id);
  if (suspended === true) {
    return res.render("instance/suspended", { req, user: req.user });
  }

  const action = req.body.action;
  if (!["start", "stop", "restart"].includes(action)) {
    return res.status(400).json({ error: "Invalid action. Use start, stop, or restart." });
  }

  const axios = require("axios");

  try {
    const nodeBase = `http://${instance.Node.address}:${instance.Node.port}`;
    const auth = { username: "Skyport", password: instance.Node.apiKey };
    const headers = { "Content-Type": "application/json" };

    let response;
    if (action === "stop") {
      response = await axios.post(
        `${nodeBase}/instances/${instance.ContainerId}/stop`,
        { command: instance.StopCommand },
        { auth, headers, validateStatus: () => true }
      );
    } else if (action === "start") {
      response = await axios.post(
        `${nodeBase}/instances/${instance.ContainerId}/start`,
        {},
        { auth, headers, validateStatus: () => true }
      );
    } else if (action === "restart") {
      response = await axios.post(
        `${nodeBase}/instances/${instance.ContainerId}/restart`,
        { command: instance.StopCommand },
        { auth, headers, validateStatus: () => true }
      );
    }

    if (response.status >= 200 && response.status < 400) {
      return res.json({ success: true });
    } else {
      return res.status(response.status).json({ error: response.data || "Node returned an error" });
    }
  } catch (error) {
    const errorMessage =
      error.response && error.response.data
        ? error.response.data.message
        : "Connection to node failed.";
    res.status(500).json({ error: errorMessage });
  }
});

module.exports = router;
