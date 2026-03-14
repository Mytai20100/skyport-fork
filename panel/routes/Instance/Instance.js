const express = require("express");
const router = express.Router();
const { db } = require("../../handlers/db.js");
const {
  isUserAuthorizedForContainer,
  isInstanceSuspended,
} = require("../../utils/authHelper");
const { loadPlugins } = require("../../plugins/loadPls.js");
const path = require("path");
const { fetchFiles, fetchFileContent } = require("../../utils/fileHelper");
const { isAuthenticated } = require("../../handlers/auth.js");

const plugins = loadPlugins(path.join(__dirname, "../../plugins"));

// Helper: fetch servers from a remote panel via API
async function fetchRemoteServers(remote) {
  const axios = require("axios");
  const headers = {
    Authorization: `Bearer ${remote.apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  let servers = [];
  try {
    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      let page = 1, totalPages = 1;
      do {
        const r = await axios.get(`${remote.panelUrl}/api/client?page=${page}`, {
          headers, timeout: 8000, validateStatus: () => true,
        });
        if (r.status !== 200) break;
        const items = (r.data.data || []).map((s) => ({
          _isRemote: true,
          _remoteId: remote.id,
          _remoteName: remote.displayName,
          _remoteType: remote.panelType,
          Id: s.attributes.identifier,
          Name: s.attributes.name,
          status: s.attributes.status || (s.attributes.is_suspended ? "suspended" : "unknown"),
          node: s.attributes.node,
          limits: {
            memory: s.attributes.limits && s.attributes.limits.memory,
            cpu: s.attributes.limits && s.attributes.limits.cpu,
          },
        }));
        servers = servers.concat(items);
        totalPages = r.data.meta && r.data.meta.pagination ? r.data.meta.pagination.total_pages : 1;
        page++;
      } while (page <= totalPages && page <= 10);

    } else if (remote.panelType === "skyport") {
      let page = 1;
      while (true) {
        const r = await axios.get(`${remote.panelUrl}/api/v1/instances?page=${page}`, {
          headers, timeout: 8000, validateStatus: () => true,
        });
        if (r.status !== 200) break;
        const items = (r.data.instances || []).map((s) => ({
          _isRemote: true,
          _remoteId: remote.id,
          _remoteName: remote.displayName,
          _remoteType: remote.panelType,
          Id: s.ContainerId || s.Id,
          Name: s.Name || s.name,
          status: s.State || s.status || "unknown",
          node: s.Node && s.Node.name,
          limits: {
            memory: s.Memory || (s.limits && s.limits.memory),
            cpu: s.Cpu || (s.limits && s.limits.cpu),
          },
        }));
        servers = servers.concat(items);
        if (!r.data.nextPage || items.length === 0 || page >= 10) break;
        page++;
      }
    } else {
      const r = await axios.get(`${remote.panelUrl}/api/client`, {
        headers, timeout: 8000, validateStatus: () => true,
      });
      if (r.status === 200 && r.data.data) {
        servers = (r.data.data || []).map((s) => ({
          _isRemote: true,
          _remoteId: remote.id,
          _remoteName: remote.displayName,
          _remoteType: remote.panelType,
          Id: s.attributes.identifier,
          Name: s.attributes.name,
          status: s.attributes.status || "unknown",
          node: s.attributes.node,
          limits: {
            memory: s.attributes.limits && s.attributes.limits.memory,
            cpu: s.attributes.limits && s.attributes.limits.cpu,
          },
        }));
      }
    }
  } catch (e) {
    // silent fail — remote panel unreachable
  }
  return servers;
}

router.get("/instances", isAuthenticated, async (req, res) => {
  if (!req.user) return res.redirect("/");
  let instances = [];

  if (req.query.see === "other") {
    let allInstances = (await db.get("instances")) || [];
    instances = allInstances.filter(
      (instance) => instance.User !== req.user.userId
    );
  } else {
    const userId = req.user.userId;
    const users = (await db.get("users")) || [];
    const authenticatedUser = users.find((user) => user.userId === userId);
    instances = (await db.get(req.user.userId + "_instances")) || [];
    const subUserInstances = authenticatedUser.accessTo || [];
    for (const instanceId of subUserInstances) {
      const instanceData = await db.get(`${instanceId}_instance`);
      if (instanceData) {
        instances.push(instanceData);
      }
    }

    // Append servers from remote panels assigned to this user
    const allRemote = (await db.get("remote_instances")) || [];
    const userRemotes = req.user.admin
      ? allRemote
      : allRemote.filter((r) => r.ownerId === userId);
    const remoteServerArrays = await Promise.all(userRemotes.map(fetchRemoteServers));
    remoteServerArrays.forEach((arr) => { instances = instances.concat(arr); });
  }

  res.render("instances", {
    req,
    user: req.user,
    instances,
    config: require("../../config.json"),
  });
});

router.get("/instance/:id", async (req, res) => {
  if (!req.user) return res.redirect("/");

  const { id } = req.params;
  if (!id) return res.redirect("/");

  let instance = await db.get(id + "_instance");
  if (!instance) return res.redirect("../instances");

  const isAuthorized = await isUserAuthorizedForContainer(
    req.user.userId,
    instance.Id
  );
  if (!isAuthorized) {
    return res.status(403).send("Unauthorized access to this instance.");
  }

  // ── Remote proxy instance ──────────────────────────────────────────────────
  if (instance._remoteProxy) {
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === instance._remoteProxy.remoteId);
    const config = require("../../config.json");
    return res.render("instance/remote-instance", {
      req,
      user: req.user,
      instance,
      remote: remote || null,
      port: config.port,
      domain: config.domain,
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  const suspended = await isInstanceSuspended(req.user.userId, instance, id);
  if (suspended === true) {
    return res.render("instance/suspended", { req, user: req.user });
  }

  if (instance.InternalState !== "READY") {
    return res.redirect("/instances?err=NOTACTIVEYET");
  }

  const config = require("../../config.json");
  const { port, domain } = config;

  const allPluginData = Object.values(plugins).map((plugin) => plugin.config);
  const files = await fetchFiles(instance, "");


  res.render("instance/instance", {
    req,
    user: req.user,
    ContainerId: instance.ContainerId,
    instance,
    port,
    domain,
    files,

    addons: {
      plugins: allPluginData,
    },
  });
});

// ── Remote instance: send console command via HTTP ─────────────────────────────
router.post("/instance/:id/remote-command", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { id } = req.params;
  const instance = await db.get(id + "_instance");
  if (!instance || !instance._remoteProxy) return res.status(404).json({ error: "Not a remote instance" });

  const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
  if (!isAuthorized) return res.status(403).json({ error: "Forbidden" });

  const axios = require("axios");
  const proxy = instance._remoteProxy;
  const remoteInstances = (await db.get("remote_instances")) || [];
  const remote = remoteInstances.find((r) => r.id === proxy.remoteId);
  if (!remote) return res.status(404).json({ error: "Remote panel not found" });

  const { command } = req.body;
  if (!command) return res.status(400).json({ error: "command required" });

  const headers = { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  let url;
  if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
    url = `${remote.panelUrl}/api/client/servers/${proxy.serverId}/command`;
  } else if (remote.panelType === "skyport") {
    url = `${remote.panelUrl}/api/v1/instances/${proxy.serverId}/command`;
  } else {
    url = `${remote.panelUrl}/api/client/servers/${proxy.serverId}/command`;
  }

  try {
    const r = await axios.post(url, { command }, { headers, timeout: 10000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300) return res.json({ success: true });
    return res.json({ success: false, error: `HTTP ${r.status}` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Remote File Manager routes ─────────────────────────────────────────────

async function getRemoteAndProxy(id) {
  const { db } = require("../../handlers/db.js");
  const instance = await db.get(id + "_instance");
  if (!instance || !instance._remoteProxy) return null;
  const remoteInstances = (await db.get("remote_instances")) || [];
  const remote = remoteInstances.find((r) => r.id === instance._remoteProxy.remoteId);
  if (!remote) return null;
  return { instance, remote, proxy: instance._remoteProxy };
}

router.get("/instance/:id/remote-files", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const dir = req.query.dir || "/";
  try {
    const axios = require("axios");
    const r = await axios.get(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/list?directory=${encodeURIComponent(dir)}`,
      { headers: { Authorization: `Bearer ${remote.apiKey}`, Accept: "application/json" }, timeout: 10000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/instance/:id/remote-file-content", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const file = req.query.file || "/";
  try {
    const axios = require("axios");
    const r = await axios.get(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/contents?file=${encodeURIComponent(file)}`,
      { headers: { Authorization: `Bearer ${remote.apiKey}`, Accept: "text/plain" }, timeout: 15000, responseType: "text" }
    );
    res.send(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/instance/:id/remote-file-write", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const file = req.query.file || req.body.file;
  const content = req.body.content || "";
  try {
    const axios = require("axios");
    await axios.post(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/write?file=${encodeURIComponent(file)}`,
      content,
      { headers: { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "text/plain" }, timeout: 15000 }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/instance/:id/remote-file-delete", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const { root, files } = req.body;
  try {
    const axios = require("axios");
    await axios.post(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/delete`,
      { root: root || "/", files: files || [] },
      { headers: { Authorization: `Bearer ${remote.apiKey}`, Accept: "application/json", "Content-Type": "application/json" }, timeout: 10000 }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/instance/:id/remote-file-rename", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const { root, files } = req.body; // files = [{from, to}]
  try {
    const axios = require("axios");
    await axios.put(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/rename`,
      { root: root || "/", files: files || [] },
      { headers: { Authorization: `Bearer ${remote.apiKey}`, Accept: "application/json", "Content-Type": "application/json" }, timeout: 10000 }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Create folder ─────────────────────────────────────────────────────────────
router.post("/instance/:id/remote-file-mkdir", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const { name, dir } = req.body;
  const folderPath = ((dir || "/").replace(/\/$/, "") + "/" + name + "/.gitkeep").replace(/\/\//g, "/");
  try {
    const axios = require("axios");
    await axios.post(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/write?file=${encodeURIComponent(folderPath)}`,
      "",
      { headers: { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "text/plain" }, timeout: 10000 }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Upload file ───────────────────────────────────────────────────────────────
const multer = require("multer");
const uploadRemote = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.post("/instance/:id/remote-file-upload", uploadRemote.single("file"), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const dir = req.body.dir || "/";
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = (dir.replace(/\/$/, "") + "/" + req.file.originalname).replace(/\/\//g, "/");
  try {
    const axios = require("axios");
    await axios.post(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/write?file=${encodeURIComponent(filePath)}`,
      req.file.buffer,
      { headers: { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/octet-stream" }, timeout: 30000, maxBodyLength: Infinity }
    );
    res.json({ success: true, name: req.file.originalname });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Compress ──────────────────────────────────────────────────────────────────
router.post("/instance/:id/remote-file-compress", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const { root, files } = req.body;
  try {
    const axios = require("axios");
    await axios.post(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/compress`,
      { root: root || "/", files: files || [] },
      { headers: { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Decompress ────────────────────────────────────────────────────────────────
router.post("/instance/:id/remote-file-decompress", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const data = await getRemoteAndProxy(req.params.id);
  if (!data) return res.status(404).json({ error: "Not a remote instance" });
  const { remote, proxy } = data;
  const { root, file } = req.body;
  try {
    const axios = require("axios");
    await axios.post(
      `${remote.panelUrl}/api/client/servers/${proxy.serverId}/files/decompress`,
      { root: root || "/", file },
      { headers: { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────

module.exports = router;
