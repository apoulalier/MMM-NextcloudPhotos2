const NodeHelper = require("node_helper");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");

let sharp;
try {
  sharp = require("sharp");
  // Limit sharp concurrency to 1 on low-memory devices (RP3)
  sharp.concurrency(1);
  // Limit sharp cache to reduce memory footprint
  sharp.cache({ memory: 50, files: 5, items: 20 });
} catch (err) {
  console.warn("[MMM-NextcloudPhotos2] sharp n'est pas disponible, les images seront sauvegardées sans redimensionnement.");
  sharp = null;
}

const AXIOS_TIMEOUT = 30000;
const MAX_RETRY_COUNT = 1;

module.exports = NodeHelper.create({
  config: null,
  tokens: null,
  photoList: [],
  syncTimer: null,
  retryCount: 0,

  start: function () {
    console.log("[MMM-NextcloudPhotos2] Node helper started.");
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "SET_CONFIG") {
      this.config = payload;
      this.cacheDir = path.join(__dirname, "cache");

      // Validate tokenFile path stays within module directory
      const tokenFileName = path.basename(this.config.tokenFile || "tokens.json");
      this.tokenFile = path.join(__dirname, tokenFileName);

      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      this.loadTokens();
      this.startSync();
    }
  },

  // ─── Token Management ─────────────────────────────────────────

  loadTokens: function () {
    try {
      const data = fs.readFileSync(this.tokenFile, "utf8");
      this.tokens = JSON.parse(data);
      console.log("[MMM-NextcloudPhotos2] Token load.");
    } catch (err) {
      console.error("[MMM-NextcloudPhotos2] Impossible de charger les tokens :", err.message);
      console.error("[MMM-NextcloudPhotos2] Exécute le script setup_oauth.js !");
      this.sendSocketNotification("AUTH_ERROR", "Tokens introuvables. Exécute : node setup_oauth.js");
    }
  },

  saveTokens: function () {
    try {
      fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), "utf8");
    } catch (err) {
      console.error("[MMM-NextcloudPhotos2] Erreur lors de la sauvegarde du token :", err.message);
    }
  },

  isTokenExpired: function () {
    if (!this.tokens || !this.tokens.expires_at) return true;
    return Date.now() > this.tokens.expires_at - 60000;
  },

  refreshAccessToken: async function () {
    if (!this.tokens || !this.tokens.refresh_token) {
      throw new Error("Pas de refresh token. Relance le script setup_oauth.js !");
    }

    const ncUrl = (this.tokens.nextcloud_url || this.config.nextcloudUrl).replace(/\/+$/, "");
    const tokenUrl = `${ncUrl}/index.php/apps/oauth2/api/v1/token`;
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", this.tokens.refresh_token);
    params.append("client_id", this.tokens.client_id);
    params.append("client_secret", this.tokens.client_secret);

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: AXIOS_TIMEOUT,
    });

    this.tokens.access_token = response.data.access_token;
    this.tokens.refresh_token = response.data.refresh_token || this.tokens.refresh_token;
    this.tokens.expires_in = response.data.expires_in || 3600;
    this.tokens.expires_at = Date.now() + (response.data.expires_in || 3600) * 1000;

    this.saveTokens();
    console.log("[MMM-NextcloudPhotos2] Access token refresh OK.");
  },

  getValidToken: async function () {
    if (this.isTokenExpired()) {
      await this.refreshAccessToken();
    }
    return this.tokens.access_token;
  },

  // ─── Filename Sanitization ────────────────────────────────────

  sanitizeFilename: function (name) {
    // Strip path separators and traversal sequences
    let safe = path.basename(name);
    safe = safe.replace(/\.\./g, "_");
    safe = safe.replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_");
    if (!safe || safe === "." || safe === "..") {
      safe = "unnamed_" + Date.now();
    }
    return safe;
  },

  // ─── Nextcloud API - File Listing ─────────────────────────────
listPhotosInFolder: async function (folderPath = null, isSubfolder = false) {
  const token = await this.getValidToken();
  const baseFolderPath = folderPath || this.config.folder || "mirror";
  const username = this.config.username || (this.tokens && this.tokens.username);
  const baseUrl = (this.config.nextcloudUrl || this.tokens.nextcloud_url).replace(/\/+$/, "");

  const davUrl = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(username)}/${encodeURIComponent(baseFolderPath)}/`;

  const propfindBody = `<?xml version="1.0" encoding="UTF-8"?>
  <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
    <d:prop>
      <d:displayname/>
      <d:getcontenttype/>
      <d:getcontentlength/>
      <d:getlastmodified/>
      <oc:fileid/>
      <d:resourcetype/>
    </d:prop>
  </d:propfind>`;

  const response = await axios({
    method: "PROPFIND",
    url: davUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/xml",
      Depth: "1",
    },
    data: propfindBody,
    timeout: AXIOS_TIMEOUT,
  });

  const parsed = await xml2js.parseStringPromise(response.data, {
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });

  const responses = parsed.multistatus.response;
  const items = Array.isArray(responses) ? responses : [responses];

  const imageExtensions = /\.(jpg|jpeg|png|webp|gif|bmp|tiff)$/i;
  const photos = [];

  for (const item of items) {
    const href = item.href;
    const props = item.propstat?.prop || item.propstat?.[0]?.prop;
    if (!props) continue;

    const contentType = props.getcontenttype || "";
    const rawName = props.displayname || path.basename(decodeURIComponent(href));
    const safeName = this.sanitizeFilename(rawName);
console.log(`[MMM-NextcloudPhotos2] Check SubFolder before ${this.config.albums} `);
    // Si c'est un dossier et qu'on est dans le dossier racine (pas un sous-dossier)
    if (!isSubfolder && props.resourcetype?.collection) {
      console.log(`[MMM-NextcloudPhotos2] Check SubFolder`);
      // Vérifie si le dossier est dans la liste des albums autorisés
      if (this.config.albums && this.config.albums.includes(rawName)) {
        
        const subFolderPath = path.join(baseFolderPath, rawName);
        console.log(`[MMM-NextcloudPhotos2] ${subFolderPath} / ${rawName}`);
        const subFolderPhotos = await this.listPhotosInFolder(subFolderPath, true);
        photos.push(...subFolderPhotos);
      }
    }
    // Si c'est une image, on l'ajoute à la liste
    else if (contentType.startsWith("image/") || imageExtensions.test(safeName)) {
      photos.push({
        name: safeName,
        href: href,
        contentType: contentType,
        size: parseInt(props.getcontentlength, 10) || 0,
        lastModified: props.getlastmodified || "",
      });
    }
  }

  console.log(`[MMM-NextcloudPhotos2] ${photos.length} photos trouvées dans /${baseFolderPath}/.`);
  return photos;
},


  // ─── Nextcloud API - File Download ────────────────────────────

  downloadPhoto: async function (photo) {
    const token = await this.getValidToken();
    const baseUrl = (this.config.nextcloudUrl || this.tokens.nextcloud_url).replace(/\/+$/, "");

    // Validate that href stays on the same host (SSRF protection)
    const downloadUrl = `${baseUrl}${photo.href}`;
    const parsedDownload = new URL(downloadUrl);
    const parsedBase = new URL(baseUrl);
    if (parsedDownload.host !== parsedBase.host) {
      throw new Error(`Letöltési URL host mismatch: ${parsedDownload.host} !== ${parsedBase.host}`);
    }

    // Use .jpg extension for resized cache files
    const baseName = path.parse(photo.name).name;
    const localName = sharp ? baseName + ".jpg" : photo.name;
    const localPath = path.join(this.cacheDir, localName);

    // Verify resolved path is within cache directory (path traversal protection)
    const resolvedPath = path.resolve(localPath);
    const resolvedCache = path.resolve(this.cacheDir);
    if (!resolvedPath.startsWith(resolvedCache + path.sep) && resolvedPath !== resolvedCache) {
      throw new Error(`Érvénytelen fájlnév, path traversal kísérlet: ${localName}`);
    }

    // Skip if already cached
    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      const remoteDate = new Date(photo.lastModified).getTime();
      const localDate = stat.mtimeMs;
      if (localDate >= remoteDate && stat.size > 0) {
        return { localPath, localName };
      }
    }

    const response = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 0,
    });

    // Resize and compress with sharp if available
    if (sharp) {
      const maxWidth = this.config.maxWidth || 1920;
      const maxHeight = this.config.maxHeight || 1080;
      const quality = this.config.imageQuality || 80;

      const resized = await sharp(response.data)
        .rotate() // auto-rotate based on EXIF
        .resize(maxWidth, maxHeight, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: quality, progressive: true })
        .toBuffer();

      fs.writeFileSync(localPath, resized);
      const origKB = Math.round(response.data.length / 1024);
      const newKB = Math.round(resized.length / 1024);
      console.log(`[MMM-NextcloudPhotos2] Letöltve+átméretezve: ${photo.name} (${origKB}KB → ${newKB}KB)`);
    } else {
      fs.writeFileSync(localPath, response.data);
      console.log(`[MMM-NextcloudPhotos2] Letöltve: ${photo.name}`);
    }

    return { localPath, localName };
  },

  // ─── Sync Logic ───────────────────────────────────────────────

  startSync: function () {
    this.doSync();

    const interval = this.config.syncInterval || 10 * 60 * 1000;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      this.doSync();
    }, interval);
  },

  doSync: async function (isRetry) {
    if (!this.tokens) {
      this.sendSocketNotification("AUTH_ERROR", "No token.");
      return;
    }

    try {
      if (!isRetry) {
        console.log("[MMM-NextcloudPhotos2] Synchro beginning...");
        this.retryCount = 0;
      }

      const remotePhotos = await this.listPhotosInFolder();

      const localPaths = [];
      for (const photo of remotePhotos) {
        try {
          const { localPath, localName } = await this.downloadPhoto(photo);
          localPaths.push({
            name: localName,
            path: localPath,
            url: `/modules/MMM-NextcloudPhotos2/cache/${encodeURIComponent(localName)}`,
          });
        } catch (dlErr) {
          console.error(`[MMM-NextcloudPhotos2] Error (${photo.name}):`, dlErr.message);
        }
      }

      // Clean up: remove cached files that no longer exist remotely
      const remoteNames = new Set(localPaths.map((p) => p.name));
      const cachedFiles = fs.readdirSync(this.cacheDir);
      for (const file of cachedFiles) {
        if (!remoteNames.has(file)) {
          const filePath = path.join(this.cacheDir, file);
          // Only delete regular files, skip symlinks
          const stat = fs.lstatSync(filePath);
          if (stat.isFile()) {
            fs.unlinkSync(filePath);
            console.log(`[MMM-NextcloudPhotos2] Erase from cache: ${file}`);
          }
        }
      }

      this.photoList = localPaths;
      this.sendSocketNotification("PHOTOS_UPDATED", this.photoList);
      console.log(`[MMM-NextcloudPhotos2] Update ending. ${localPaths.length} pictures available.`);
    } catch (err) {
      console.error("[MMM-NextcloudPhotos2] Synchro error:", err.message);

      if (err.response?.status === 401 && this.retryCount < MAX_RETRY_COUNT) {
        this.retryCount++;
        try {
          await this.refreshAccessToken();
          await this.doSync(true);
        } catch (refreshErr) {
          this.sendSocketNotification("AUTH_ERROR", "Echec du rafraîchissement du token. Relance : node setup_oauth.js");
        }
      }
    }
  },
});
