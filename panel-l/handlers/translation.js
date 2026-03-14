const path = require("path");
const fs = require("fs");
const { db } = require("./db.js");

function loadTranslations(lang) {
  const filePath = path.join(__dirname, `../lang/${lang}/lang.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "../lang/en/lang.json"), "utf8")
  );
}

async function translationMiddleware(req, res, next) {
  try {
    // Priority: user cookie > admin default > "en"
    let lang = "en";
    if (req.cookies && req.cookies.lang) {
      lang = req.cookies.lang;
    } else {
      try {
        const settings = await db.get("settings");
        if (settings && settings.defaultLanguage) {
          lang = settings.defaultLanguage;
        }
      } catch (e) {}
    }
    req.lang = lang;
    req.translations = loadTranslations(lang);
    next();
  } catch (err) {
    req.lang = "en";
    req.translations = loadTranslations("en");
    next();
  }
}

module.exports = translationMiddleware;
