const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("node:fs");
const { db } = require("../../handlers/db.js");
const { logAudit } = require("../../handlers/auditLog.js");
const { sendTestEmail } = require("../../handlers/email.js");
const { isAdmin } = require("../../utils/isAdmin.js");
const log = new (require("cat-loggr"))();

// ── Sync remote panel servers into local DB as proxy instances ─────────────────
async function syncRemoteServers(remote) {
  const axios = require("axios");
  const { v4: uuidv4 } = require("uuid");
  const headers = { Authorization: `Bearer ${remote.apiKey}`, Accept: "application/json", "Content-Type": "application/json" };
  let servers = [];

  try {
    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      let page = 1, totalPages = 1;
      do {
        const r = await axios.get(`${remote.panelUrl}/api/client?page=${page}&include=allocations`, { headers, timeout: 12000, validateStatus: () => true });
        if (r.status !== 200) break;
        for (const s of (r.data.data || [])) {
          const allocs = s.relationships && s.relationships.allocations && s.relationships.allocations.data || [];
          const primaryAlloc = allocs.find(a => a.attributes && a.attributes.is_default) || allocs[0];
          servers.push({
            id: s.attributes.identifier,
            uuid: s.attributes.uuid,
            name: s.attributes.name,
            status: s.attributes.status || (s.attributes.is_suspended ? "suspended" : "unknown"),
            node: s.attributes.node,
            egg: s.attributes.egg,
            limits: { memory: s.attributes.limits && s.attributes.limits.memory, cpu: s.attributes.limits && s.attributes.limits.cpu, disk: s.attributes.limits && s.attributes.limits.disk },
            allocation: primaryAlloc ? { ip: primaryAlloc.attributes.ip_alias || primaryAlloc.attributes.ip, port: primaryAlloc.attributes.port, alias: primaryAlloc.attributes.ip_alias } : null,
          });
        }
        totalPages = r.data.meta && r.data.meta.pagination ? r.data.meta.pagination.total_pages : 1;
        page++;
      } while (page <= totalPages && page <= 20);

    } else if (remote.panelType === "skyport") {
      let page = 1;
      while (true) {
        const r = await axios.get(`${remote.panelUrl}/api/v1/instances?page=${page}`, { headers, timeout: 12000, validateStatus: () => true });
        if (r.status !== 200) break;
        for (const s of (r.data.instances || [])) {
          servers.push({ id: s.ContainerId || s.Id, name: s.Name || s.name, status: s.State || "unknown", limits: { memory: s.Memory, cpu: s.Cpu } });
        }
        if (!r.data.nextPage || page >= 20) break;
        page++;
      }
    } else {
      const r = await axios.get(`${remote.panelUrl}/api/client`, { headers, timeout: 12000, validateStatus: () => true });
      if (r.status === 200 && r.data.data) {
        for (const s of (r.data.data || [])) {
          servers.push({ id: s.attributes.identifier, name: s.attributes.name, status: s.attributes.status || "unknown", limits: { memory: s.attributes.limits && s.attributes.limits.memory, cpu: s.attributes.limits && s.attributes.limits.cpu } });
        }
      }
    }
  } catch (err) {
    log.error("syncRemoteServers fetch error:", err.message);
    return;
  }

  // Load existing instances for this remote to track which to remove
  const existingMap = (await db.get("remote_" + remote.id + "_localIds")) || {};

  // Upsert each server into DB
  const newMap = {};
  for (const srv of servers) {
    // Determine local ID: use server's own id if no collision, else prefix
    let localId = "r_" + remote.id.slice(0, 6) + "_" + srv.id;
    // Clamp to safe length
    if (localId.length > 32) localId = localId.slice(0, 32);

    // Check collision with real instance
    const conflict = await db.get(localId + "_instance");
    if (conflict && !conflict._remoteProxy) {
      // Real local instance with same ID — add extra prefix
      localId = "rem_" + uuidv4().slice(0, 8) + "_" + srv.id.slice(0, 8);
    }

    // Use existing localId if we already synced this server before
    const existingLocalId = existingMap[srv.id];
    if (existingLocalId) localId = existingLocalId;

    newMap[srv.id] = localId;

    const instanceRecord = {
      Id: localId,
      Name: srv.name,
      _remoteProxy: {
        remoteId: remote.id,
        serverId: srv.id,
        panelType: remote.panelType,
        panelUrl: remote.panelUrl,
        limits: srv.limits,
        allocation: srv.allocation || null,
      },
      // Fake fields expected by authHelper / views
      InternalState: "READY",
      suspended: false,
      Node: { name: remote.displayName, address: new URL(remote.panelUrl).hostname },
      Image: remote.panelType,
      Primary: "",
      Memory: srv.limits && srv.limits.memory ? srv.limits.memory : 0,
      Cpu: srv.limits && srv.limits.cpu ? srv.limits.cpu : 0,
      Disk: srv.limits && srv.limits.disk ? srv.limits.disk : 0,
    };

    await db.set(localId + "_instance", instanceRecord);

    // Add to owner's instance list
    const ownerId = remote.ownerId;
    if (ownerId) {
      let userInstances = (await db.get(ownerId + "_instances")) || [];
      // Remove old entry if exists, then add
      userInstances = userInstances.filter((i) => i.Id !== localId);
      userInstances.push({ Id: localId, Name: srv.name });
      await db.set(ownerId + "_instances", userInstances);
      // Also add to user's accessTo
      const users = (await db.get("users")) || [];
      const userIdx = users.findIndex((u) => u.userId === ownerId);
      if (userIdx !== -1) {
        if (!users[userIdx].accessTo) users[userIdx].accessTo = [];
        if (!users[userIdx].accessTo.includes(localId)) {
          users[userIdx].accessTo.push(localId);
          await db.set("users", users);
        }
      }
    }
  }

  // Remove servers that are no longer in remote panel
  for (const [serverId, localId] of Object.entries(existingMap)) {
    if (!newMap[serverId]) {
      await db.delete(localId + "_instance");
      if (remote.ownerId) {
        let userInstances = (await db.get(remote.ownerId + "_instances")) || [];
        userInstances = userInstances.filter((i) => i.Id !== localId);
        await db.set(remote.ownerId + "_instances", userInstances);
      }
    }
  }

  // Save mapping for next sync
  await db.set("remote_" + remote.id + "_localIds", newMap);
  log.info(`Synced ${servers.length} servers from remote panel "${remote.displayName}"`);
}
// ─────────────────────────────────────────────────────────────────────────────

// Configure multer for file upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = path.join(__dirname, "..", "..", "public", "assets");
      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      cb(null, "logo.png");
    },
  }),
  fileFilter: (req, file, cb) => {
    cb(
      null,
      file.mimetype.startsWith("image/") ||
        new Error("Not an image! Please upload an image file.")
    );
  },
});

async function fetchCommonSettings(req) {
  const settings = (await db.get("settings")) || {};
  return {
    req,
    user: req.user,
    settings,
  };
}

router.get("/admin/settings", isAdmin, async (req, res) => {
  const settings = await fetchCommonSettings(req);
  res.render("admin/settings/appearance", settings);
});

router.get("/admin/settings/smtp", isAdmin, async (req, res) => {
  try {
    const settings = await fetchCommonSettings(req);
    const smtpSettings = (await db.get("smtp_settings")) || {};
    res.render("admin/settings/smtp", { ...settings, smtpSettings });
  } catch (error) {
    log.error("Error fetching SMTP settings:", error);
    res
      .status(500)
      .send("Failed to fetch SMTP settings. Please try again later.");
  }
});

router.get("/admin/settings/theme", isAdmin, async (req, res) => {
  const settings = await fetchCommonSettings(req);
  res.render("admin/settings/theme", settings);
});

router.post(
  "/admin/settings/toggle/force-verify",
  isAdmin,
  async (req, res) => {
    try {
      const settings = (await db.get("settings")) || {};
      settings.forceVerify = !settings.forceVerify;
      await db.set("settings", settings);
      logAudit(req.user.userId, req.user.username, "force-verify:edit", req.ip);
      res.redirect("/admin/settings");
    } catch (err) {
      log.error("Error toggling force verify:", err);
      res.status(500).send("Internal Server Error");
    }
  }
);

router.post("/admin/settings/change/name", isAdmin, async (req, res) => {
  const { name } = req.body;
  try {
    const settings = (await db.get("settings")) || {};
    settings.name = name;
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "name:edit", req.ip);
    res.redirect(`/admin/settings?changednameto=${name}`);
  } catch (err) {
    log.error("Error changing name:", err);
    res.status(500).send("Database error");
  }
});

router.post("/admin/settings/change/theme/color", isAdmin, async (req, res) => {
  const { buttoncolor, paneltheme, sidebardirection } = req.body;
  let theme = require("../../storage/theme.json");
  try {
    if (buttoncolor) theme["button-color"] = buttoncolor;
    if (paneltheme) theme["paneltheme-color"] = paneltheme;
    if (sidebardirection) {
      theme["sidebar-direction"] =
        theme["sidebar-direction"] === "left" ? "right" : "left";
    }
    await fs.promises.writeFile(
      "./storage/theme.json",
      JSON.stringify(theme, null, 2)
    );
    logAudit(req.user.userId, req.user.username, "theme:edit", req.ip);
    res.redirect(
      "/admin/settings/theme?changed=" +
        (buttoncolor || paneltheme || sidebardirection)
    );
  } catch (err) {
    log.error("Error updating theme:", err);
    res.status(500).send("File writing error");
  }
});

router.post(
  "/admin/settings/toggle/theme/footer",
  isAdmin,
  async (req, res) => {
    try {
      const settings = (await db.get("settings")) || {};
      settings.footer = !settings.footer;
      await db.set("settings", settings);
      logAudit(
        req.user.userId,
        req.user.username,
        `footer:${settings.footer ? "enabled" : "disabled"}`,
        req.ip
      );
      res.redirect("/admin/settings/theme");
    } catch (err) {
      log.error("Error toggling footer:", err);
      res.status(500).send("Internal Server Error");
    }
  }
);

router.post("/admin/settings/saveSmtpSettings", isAdmin, async (req, res) => {
  const {
    smtpServer,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFromName,
    smtpFromAddress,
  } = req.body;

  try {
    await db.set("smtp_settings", {
      server: smtpServer,
      port: smtpPort,
      username: smtpUser,
      password: smtpPass,
      fromName: smtpFromName,
      fromAddress: smtpFromAddress,
    });
    logAudit(req.user.userId, req.user.username, "SMTP:edit", req.ip);
    res.redirect("/admin/settings/smtp?msg=SmtpSaveSuccess");
  } catch (error) {
    log.error("Error saving SMTP settings:", error);
    res.redirect("/admin/settings/smtp?err=SmtpSaveFailed");
  }
});

router.post("/sendTestEmail", isAdmin, async (req, res) => {
  try {
    const { recipientEmail } = req.body;
    await sendTestEmail(recipientEmail);
    res.redirect("/admin/settings/smtp?msg=TestemailSentsuccess");
  } catch (error) {
    log.error("Error sending test email:", error);
    res.redirect("/admin/settings/smtp?err=TestemailSentfailed");
  }
});

// Update logo handling to store it in settings
router.post(
  "/admin/settings/change/logo",
  isAdmin,
  upload.single("logo"),
  async (req, res) => {
    const { type } = req.body;

    try {
      const settings = (await db.get("settings")) || {};

      if (type === "image" && req.file) {
        settings.logo = true; // Set logo to true in settings
        await db.set("settings", settings); // Save settings with logo
        res.redirect("/admin/settings");
      } else if (type === "none") {
        const logoPath = path.join(
          __dirname,
          "..",
          "..",
          "public",
          "assets",
          "logo.png"
        );
        if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
        settings.logo = false; // Set logo to false in settings
        await db.set("settings", settings); // Save settings without logo
        logAudit(req.user.userId, req.user.username, "logo:edit", req.ip);
        res.redirect("/admin/settings");
      } else {
        res.status(400).send("Invalid request");
      }
    } catch (err) {
      log.error("Error processing logo change:", err);
      res.status(500).send("Error processing logo change: " + err.message);
    }
  }
);

router.post("/admin/settings/toggle/register", isAdmin, async (req, res) => {
  try {
    const settings = (await db.get("settings")) || {};
    settings.register = !settings.register;
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "register:edit", req.ip);
    res.redirect("/admin/settings");
  } catch (err) {
    log.error("Error toggling registration:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Default language setting
router.post("/admin/settings/change/language", isAdmin, async (req, res) => {
  const { defaultLanguage } = req.body;
  try {
    const settings = (await db.get("settings")) || {};
    settings.defaultLanguage = defaultLanguage || "en";
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "language:edit", req.ip);
    res.redirect("/admin/settings?saved=1");
  } catch (err) {
    log.error("Error changing default language:", err);
    res.status(500).send("Database error");
  }
});

// Background music setting
router.post("/admin/settings/change/music", isAdmin, async (req, res) => {
  const { musicUrl, musicEnabled } = req.body;
  try {
    const settings = (await db.get("settings")) || {};
    settings.backgroundMusic = {
      enabled: musicEnabled === "on",
      url: musicUrl || "",
    };
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "music:edit", req.ip);
    res.redirect("/admin/settings?saved=1");
  } catch (err) {
    log.error("Error changing background music:", err);
    res.status(500).send("Database error");
  }
});


// Particle effects settings
router.post("/admin/settings/change/particles", isAdmin, async (req, res) => {
  const { particlesEnabled, particlesSeasonal, particleCount, particleSize } = req.body;
  try {
    const settings = (await db.get("settings")) || {};
    const prev = settings.particles || {};
    settings.particles = {
      enabled:  particlesEnabled === "on",
      seasonal: particlesSeasonal === "on",
      count: Math.min(500, Math.max(10, parseInt(particleCount) || prev.count || 80)),
      size:  Math.min(20,  Math.max(2,  parseFloat(particleSize) || prev.size || 5)),
    };
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "particles:edit", req.ip);
    res.redirect("/admin/settings?saved=1");
  } catch (err) {
    log.error("Error changing particles:", err);
    res.status(500).send("Database error");
  }
});

// Test connection to a remote panel (before adding)
router.post("/remote-instances/test-connection", isAdmin, async (req, res) => {
  try {
    const axios = require("axios");
    const { panelUrl, apiKey, panelType } = req.body;
    if (!panelUrl || !apiKey) return res.status(400).json({ error: "panelUrl and apiKey required" });

    let pingUrl;
    if (panelType === "pterodactyl" || panelType === "pelican") {
      pingUrl = `${panelUrl}/api/client`;
    } else if (panelType === "skyport") {
      pingUrl = `${panelUrl}/api/v1/users`;
    } else {
      pingUrl = `${panelUrl}/api/client`;
    }

    const start = Date.now();
    try {
      const response = await axios.get(pingUrl, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        timeout: 8000,
        validateStatus: () => true,
      });
      const latency = Date.now() - start;
      res.json({
        online: response.status < 500,
        status: response.status,
        latency,
        tokenValid: response.status === 200 || response.status === 201,
      });
    } catch (axiosErr) {
      res.json({ online: false, latency: Date.now() - start, error: axiosErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle user remote instances permission
router.post("/admin/settings/toggle/user-remote-instances", isAdmin, async (req, res) => {
  try {
    const settings = (await db.get("settings")) || {};
    settings.allowUserRemoteInstances = !settings.allowUserRemoteInstances;
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "user-remote-instances:edit", req.ip);
    res.redirect("/admin/settings?saved=1");
  } catch (err) {
    log.error("Error toggling user remote instances:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Remote instances list
router.get("/remote-instances", isAdmin, async (req, res) => {
  try {
    const settings = (await db.get("settings")) || {};
    const users = (await db.get("users")) || [];
    const remoteInstances = (await db.get("remote_instances")) || [];
    const apiKeyGroups = (await db.get("remote_apikey_groups")) || [];
    // Enrich groups with owner name
    const enrichedGroups = apiKeyGroups.map((g) => {
      const owner = users.find((u) => u.userId === g.ownerId);
      return { ...g, ownerName: owner ? owner.username : g.ownerId };
    });
    res.render("admin/remote-instances", { req, user: req.user, settings, users, remoteInstances, apiKeyGroups: enrichedGroups });
  } catch (err) {
    log.error("Error fetching remote instances:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Remote instance detail page
router.get("/remote-instances/:id", isAdmin, async (req, res) => {
  try {
    const settings = (await db.get("settings")) || {};
    const users = (await db.get("users")) || [];
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.id);
    if (!remote) return res.redirect("/remote-instances");
    res.render("admin/remote-instance-detail", { req, user: req.user, settings, users, remote });
  } catch (err) {
    log.error("Error fetching remote instance detail:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Add remote instance
router.post("/remote-instances/add", isAdmin, async (req, res) => {
  const { panelUrl, apiKey, ownerId, panelType, displayName } = req.body;
  try {
    const remoteInstances = (await db.get("remote_instances")) || [];
    const newEntry = {
      id: Date.now().toString(36),
      panelUrl: panelUrl.replace(/\/$/, ""),
      apiKey,
      ownerId,
      panelType: panelType || "pterodactyl",
      displayName: displayName || panelUrl,
      createdAt: new Date().toISOString(),
    };
    remoteInstances.push(newEntry);
    await db.set("remote_instances", remoteInstances);
    logAudit(req.user.userId, req.user.username, "remote-instance:add", req.ip);
    // Sync servers in background
    syncRemoteServers(newEntry).catch((e) => log.error("Sync error:", e.message));
    res.redirect("/remote-instances?added=1");
  } catch (err) {
    log.error("Error adding remote instance:", err);
    res.status(500).send("Database error");
  }
});

// Edit remote instance
router.post("/remote-instances/edit/:id", isAdmin, async (req, res) => {
  const { panelUrl, apiKey, ownerId, panelType, displayName } = req.body;
  try {
    const remoteInstances = (await db.get("remote_instances")) || [];
    const idx = remoteInstances.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.redirect("/remote-instances");
    remoteInstances[idx] = {
      ...remoteInstances[idx],
      panelUrl: panelUrl.replace(/\/$/, ""),
      apiKey: apiKey || remoteInstances[idx].apiKey,
      ownerId,
      panelType: panelType || "pterodactyl",
      displayName: displayName || panelUrl,
    };
    await db.set("remote_instances", remoteInstances);
    logAudit(req.user.userId, req.user.username, "remote-instance:edit", req.ip);
    // Re-sync servers in background
    syncRemoteServers(remoteInstances[idx]).catch((e) => log.error("Sync error:", e.message));
    res.redirect("/remote-instances/" + req.params.id + "?saved=1");
  } catch (err) {
    log.error("Error editing remote instance:", err);
    res.status(500).send("Database error");
  }
});

// Delete remote instance
router.post("/remote-instances/delete/:id", isAdmin, async (req, res) => {
  try {
    const remoteId = req.params.id;
    let remoteInstances = (await db.get("remote_instances")) || [];
    const target = remoteInstances.find((r) => r.id === remoteId);
    remoteInstances = remoteInstances.filter((r) => r.id !== remoteId);
    await db.set("remote_instances", remoteInstances);
    logAudit(req.user.userId, req.user.username, "remote-instance:delete", req.ip);

    // Clean up synced instances
    if (target) {
      const existingMap = (await db.get("remote_" + remoteId + "_localIds")) || {};
      for (const [, localId] of Object.entries(existingMap)) {
        await db.delete(localId + "_instance").catch(() => {});
        if (target.ownerId) {
          let userInstances = (await db.get(target.ownerId + "_instances")) || [];
          userInstances = userInstances.filter((i) => i.Id !== localId);
          await db.set(target.ownerId + "_instances", userInstances);
          // Remove from accessTo
          const users = (await db.get("users")) || [];
          const userIdx = users.findIndex((u) => u.userId === target.ownerId);
          if (userIdx !== -1 && users[userIdx].accessTo) {
            users[userIdx].accessTo = users[userIdx].accessTo.filter((x) => x !== localId);
            await db.set("users", users);
          }
        }
      }
      await db.delete("remote_" + remoteId + "_localIds").catch(() => {});
    }

    res.redirect("/remote-instances?deleted=1");
  } catch (err) {
    log.error("Error deleting remote instance:", err);
    res.status(500).send("Database error");
  }
});

// Manual sync endpoint
router.post("/remote-instances/sync/:id", isAdmin, async (req, res) => {
  try {
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.id);
    if (!remote) return res.status(404).json({ error: "Remote not found" });
    await syncRemoteServers(remote);
    res.json({ success: true, message: "Sync complete" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ping check — test connectivity + token validity
router.get("/remote-instances/ping/:id", isAdmin, async (req, res) => {
  try {
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.id);
    if (!remote) return res.status(404).json({ error: "Remote not found" });

    const axios = require("axios");
    const start = Date.now();

    let pingUrl;
    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      pingUrl = `${remote.panelUrl}/api/client`;
    } else if (remote.panelType === "skyport") {
      pingUrl = `${remote.panelUrl}/api/v1/users`;
    } else {
      pingUrl = `${remote.panelUrl}/api/client`;
    }

    try {
      const response = await axios.get(pingUrl, {
        headers: {
          "Authorization": `Bearer ${remote.apiKey}`,
          "Accept": "application/json",
        },
        timeout: 8000,
        validateStatus: () => true,
      });
      const latency = Date.now() - start;
      res.json({
        online: response.status < 500,
        status: response.status,
        latency,
        tokenValid: response.status === 200 || response.status === 201,
        panelType: remote.panelType,
        serverHeader: response.headers["x-powered-by"] || response.headers["server"] || null,
        pagination: response.data && response.data.meta ? response.data.meta.pagination : null,
      });
    } catch (axiosErr) {
      res.json({ online: false, latency: Date.now() - start, error: axiosErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API proxy for remote instances
router.get("/remote/:remoteId/*", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.remoteId);
    if (!remote) return res.status(404).json({ error: "Remote not found" });

    const isOwnerOrAdmin = req.user.admin || remote.ownerId === req.user.userId;
    if (!isOwnerOrAdmin) return res.status(403).json({ error: "Forbidden" });

    const axios = require("axios");
    const subPath = req.params[0] || "";
    const targetUrl = `${remote.panelUrl}/api/${subPath}`;
    const response = await axios.get(targetUrl, {
      headers: {
        "Authorization": `Bearer ${remote.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      params: req.query,
      timeout: 10000,
    });
    res.json(response.data);
  } catch (err) {
    log.error("Remote instance proxy error:", err.message);
    res.status(502).json({ error: "Failed to reach remote panel", details: err.message });
  }
});

// ── Background image multer ───────────────────────────────────────────────────
const uploadBg = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = path.join(__dirname, "..", "..", "public", "assets");
      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".png";
      cb(null, "bg" + ext);
    },
  }),
  fileFilter: (req, file, cb) => { cb(null, file.mimetype.startsWith("image/")); },
});

// ── API Key Groups ─────────────────────────────────────────────────────────────
router.post("/remote-instances/apikey-groups/create", isAdmin, async (req, res) => {
  try {
    const { name, key, panelType, ownerId } = req.body;
    if (!name || !key) return res.status(400).json({ error: "name and key required" });
    const { v4: uuidv4 } = require("uuid");
    const groups = (await db.get("remote_apikey_groups")) || [];
    groups.push({ id: uuidv4(), name, key, panelType: panelType || "any", ownerId, createdAt: new Date().toISOString() });
    await db.set("remote_apikey_groups", groups);
    logAudit(req.user.userId, req.user.username, "apikey-group:create", req.ip);
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/remote-instances/apikey-groups/delete/:id", isAdmin, async (req, res) => {
  try {
    let groups = (await db.get("remote_apikey_groups")) || [];
    groups = groups.filter((g) => g.id !== req.params.id);
    await db.set("remote_apikey_groups", groups);
    logAudit(req.user.userId, req.user.username, "apikey-group:delete", req.ip);
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Theme: background image ───────────────────────────────────────────────────
router.post("/admin/settings/change/background", isAdmin, uploadBg.single("backgroundImage"), async (req, res) => {
  try {
    const { backgroundUrl, backgroundType } = req.body;
    let theme = JSON.parse(fs.readFileSync("./storage/theme.json", "utf8"));
    if (req.file) {
      theme["background-image"] = "/assets/" + req.file.filename;
      theme["background-type"] = "image";
    } else if (backgroundUrl) {
      theme["background-image"] = backgroundUrl;
      theme["background-type"] = backgroundType || "image";
    } else {
      delete theme["background-image"];
      delete theme["background-type"];
    }
    fs.writeFileSync("./storage/theme.json", JSON.stringify(theme, null, 2));
    logAudit(req.user.userId, req.user.username, "theme:background", req.ip);
    res.redirect("/admin/settings/theme?saved=1");
  } catch (err) {
    log.error("Error updating background:", err);
    res.status(500).send("File writing error");
  }
});

// ── Turnstile settings ────────────────────────────────────────────────────────
router.post("/admin/settings/toggle/turnstile", isAdmin, async (req, res) => {
  try {
    const settings = (await db.get("settings")) || {};
    settings.turnstile = settings.turnstile || {};
    settings.turnstile.enabled = !settings.turnstile.enabled;
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "turnstile:toggle", req.ip);
    res.redirect("/admin/settings/theme?saved=1");
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/settings/change/turnstile", isAdmin, async (req, res) => {
  try {
    const { siteKey, secretKey } = req.body;
    const settings = (await db.get("settings")) || {};
    settings.turnstile = settings.turnstile || {};
    if (siteKey) settings.turnstile.siteKey = siteKey;
    if (secretKey) settings.turnstile.secretKey = secretKey;
    await db.set("settings", settings);
    logAudit(req.user.userId, req.user.username, "turnstile:config", req.ip);
    res.redirect("/admin/settings/theme?saved=1");
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;

// ── Remote: list servers ───────────────────────────────────────────────────────
router.get("/remote-instances/servers/:id", isAdmin, async (req, res) => {
  try {
    const axios = require("axios");
    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.id);
    if (!remote) return res.status(404).json({ error: "Remote not found" });

    const headers = {
      Authorization: `Bearer ${remote.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    let servers = [];

    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      // Pterodactyl/Pelican: paginated /api/client
      let page = 1, totalPages = 1;
      do {
        const r = await axios.get(`${remote.panelUrl}/api/client?page=${page}`, {
          headers, timeout: 12000, validateStatus: () => true,
        });
        if (r.status !== 200) {
          return res.json({ error: `API error HTTP ${r.status}`, servers: [] });
        }
        const items = (r.data.data || []).map((s) => ({
          id:     s.attributes.identifier,
          uuid:   s.attributes.uuid,
          name:   s.attributes.name,
          status: s.attributes.status || (s.attributes.is_suspended ? "suspended" : "unknown"),
          node:   s.attributes.node,
          limits: {
            memory: s.attributes.limits && s.attributes.limits.memory,
            cpu:    s.attributes.limits && s.attributes.limits.cpu,
            disk:   s.attributes.limits && s.attributes.limits.disk,
          },
        }));
        servers = servers.concat(items);
        totalPages = r.data.meta && r.data.meta.pagination ? r.data.meta.pagination.total_pages : 1;
        page++;
      } while (page <= totalPages && page <= 20);

    } else if (remote.panelType === "skyport") {
      // Skyport: /api/v1/instances
      let page = 1;
      while (true) {
        const r = await axios.get(`${remote.panelUrl}/api/v1/instances?page=${page}`, {
          headers, timeout: 12000, validateStatus: () => true,
        });
        if (r.status !== 200) break;
        const items = (r.data.instances || []).map((s) => ({
          id:     s.ContainerId || s.Id,
          name:   s.Name || s.name,
          status: s.State || s.status || "unknown",
          node:   s.Node && s.Node.name,
          limits: {
            memory: s.Memory || (s.limits && s.limits.memory),
            cpu:    s.Cpu    || (s.limits && s.limits.cpu),
          },
        }));
        servers = servers.concat(items);
        if (!r.data.nextPage || items.length === 0 || page >= 20) break;
        page++;
      }

    } else {
      // Generic: try pterodactyl-style
      const r = await axios.get(`${remote.panelUrl}/api/client`, {
        headers, timeout: 12000, validateStatus: () => true,
      });
      if (r.status === 200 && r.data.data) {
        servers = (r.data.data || []).map((s) => ({
          id:     s.attributes.identifier,
          name:   s.attributes.name,
          status: s.attributes.status || "unknown",
          node:   s.attributes.node,
          limits: { memory: s.attributes.limits && s.attributes.limits.memory, cpu: s.attributes.limits && s.attributes.limits.cpu },
        }));
      }
    }

    // Enrich each server with its localId (if it has been synced)
    const localIdsMap = (await db.get("remote_" + req.params.id + "_localIds")) || {};
    servers = servers.map((s) => ({
      ...s,
      localId: localIdsMap[s.id] || null,
    }));

    res.json({ servers, total: servers.length });
  } catch (err) {
    log.error("Remote servers list error:", err.message);
    res.status(500).json({ error: err.message, servers: [] });
  }
});

// ── Remote: power action ───────────────────────────────────────────────────────
router.post("/remote-instances/power/:remoteId/:serverId", isAdmin, async (req, res) => {
  try {
    const axios = require("axios");
    const { action } = req.body; // start | stop | restart | kill
    if (!action) return res.status(400).json({ error: "action required" });

    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.remoteId);
    if (!remote) return res.status(404).json({ error: "Remote not found" });

    const headers = { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
    const sid = req.params.serverId;
    let url, body;

    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      url  = `${remote.panelUrl}/api/client/servers/${sid}/power`;
      body = { signal: action };
    } else if (remote.panelType === "skyport") {
      url  = `${remote.panelUrl}/api/v1/instances/${sid}/power`;
      body = { action };
    } else {
      url  = `${remote.panelUrl}/api/client/servers/${sid}/power`;
      body = { signal: action };
    }

    const r = await axios.post(url, body, { headers, timeout: 10000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300) {
      logAudit(req.user.userId, req.user.username, `remote-power:${action}:${sid}`, req.ip);
      res.json({ success: true });
    } else {
      res.json({ success: false, error: `HTTP ${r.status}` });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Remote: send command ───────────────────────────────────────────────────────
router.post("/remote-instances/command/:remoteId/:serverId", isAdmin, async (req, res) => {
  try {
    const axios = require("axios");
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: "command required" });

    const remoteInstances = (await db.get("remote_instances")) || [];
    const remote = remoteInstances.find((r) => r.id === req.params.remoteId);
    if (!remote) return res.status(404).json({ error: "Remote not found" });

    const headers = { Authorization: `Bearer ${remote.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
    const sid = req.params.serverId;
    let url;

    if (remote.panelType === "pterodactyl" || remote.panelType === "pelican") {
      url = `${remote.panelUrl}/api/client/servers/${sid}/command`;
    } else if (remote.panelType === "skyport") {
      url = `${remote.panelUrl}/api/v1/instances/${sid}/command`;
    } else {
      url = `${remote.panelUrl}/api/client/servers/${sid}/command`;
    }

    const r = await axios.post(url, { command }, { headers, timeout: 10000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: `HTTP ${r.status}` });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
