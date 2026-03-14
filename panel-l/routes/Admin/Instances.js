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
const { isAdmin } = require("../../utils/isAdmin.js");

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

router.get(["/instances", "/admin/instances"], isAuthenticated, async (req, res) => {
  if (!req.user) return res.redirect("/");
  let instances = [];

  const isAdminView = req.path.startsWith("/admin");

  // On /admin/instances, admins see all instances by default
  if (req.query.see === "other" || (isAdminView && req.user.admin && req.query.see !== "mine")) {
    let allInstances = (await db.get("instances")) || [];
    instances = req.query.see === "other"
      ? allInstances.filter((instance) => instance.User !== req.user.userId)
      : allInstances;
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

    // Append live remote servers, but skip any whose serverId is already synced as _remoteProxy
    const allRemote = (await db.get("remote_instances")) || [];
    const userRemotes = req.user.admin
      ? allRemote
      : allRemote.filter((r) => r.ownerId === userId);
    const remoteServerArrays = await Promise.all(userRemotes.map(fetchRemoteServers));

    // Collect set of already-synced (remoteId, serverId) pairs
    const syncedKeys = new Set(
      instances
        .filter((i) => i._remoteProxy)
        .map((i) => i._remoteProxy.remoteId + ":" + i._remoteProxy.serverId)
    );

    remoteServerArrays.forEach((arr) => {
      arr.forEach((srv) => {
        const key = srv._remoteId + ":" + srv.Id;
        if (!syncedKeys.has(key)) {
          instances.push(srv);
        }
      });
    });
  }

  // Final dedup by Id (in case accessTo added duplicates)
  const seen = new Set();
  instances = instances.filter((i) => {
    if (!i.Id) return true;
    if (seen.has(i.Id)) return false;
    seen.add(i.Id);
    return true;
  });

  const viewName = req.path.startsWith("/admin") ? "admin/instances" : "instances";
  res.render(viewName, {
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

  const suspended = await isInstanceSuspended(req.user.userId, instance, id);
  if (suspended === true) {
    return res.render("instance/suspended", { req, user: req.user });
  }

  // ── Remote proxy instance (synced from Pterodactyl/Pelican/Skyport) ────────
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

  if (instance.InternalState !== "READY") {
    return res.redirect("/instances?err=NOTACTIVEYET");
  }

  const config = require("../../config.json");
  const { port, domain } = config;

  const allPluginData = Object.values(plugins).map((plugin) => plugin.config);
  let files = [];
  try {
    if (instance.Node && instance.Node.address && instance.Node.port) {
      files = await fetchFiles(instance, "");
    }
  } catch (err) {
    // Node config invalid, files will remain empty
  }


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

module.exports = router;