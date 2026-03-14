const NodeHelper = require("node_helper");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const piexif = require("piexifjs");

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

const AXIOS_TIMEOUT = 60000;
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

    if (!isSubfolder) davUrl = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(username)}/${encodeURIComponent(baseFolderPath)}/`;
    else davUrl = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(username)}/${this.config.folder}/${encodeURIComponent(baseFolderPath)}/`;

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

      // Si c'est un dossier et qu'on est dans le dossier racine (pas un sous-dossier)
      // Vérifie si le dossier est dans la liste des albums autorisés
      if (!isSubfolder && props.resourcetype && Object.keys(props.resourcetype).includes("collection") && this.config.albums && this.config.albums.includes(rawName)) {
        const subFolderPhotos = await this.listPhotosInFolder(rawName, true);
        photos.push(...subFolderPhotos);
      }
      // Si c'est une image, on l'ajoute à la liste
      else if (contentType.startsWith("image/") || imageExtensions.test(safeName)) {
        photos.push({
          name: safeName,
          href: href,
          contentType: contentType,
          size: parseInt(props.getcontentlength, 10) || 0,
          lastModified: props.getlastmodified || "",
          folderName: baseFolderPath,
        });
      }
    }

    if (!isSubfolder) console.info(`[MMM-NextcloudPhotos2] ${photos.length} photos trouvées dans /${baseFolderPath}/.`);
    return photos;
  },

  /**
   * Convertit des coordonnées GPS en ville et pays via une API de géocodage.
   * @param {number} latitude - Latitude
   * @param {number} longitude - Longitude
   * @returns {Promise<{city: string, country: string}|null>} - Ville et pays, ou null en cas d'erreur
   */
  geocodeCoordinates: async function (latitude, longitude) {
    try {
      // Utilise Nominatim (OpenStreetMap) pour le géocodage inverse
      const geoApiUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`;
      const geoResponse = await axios.get(geoApiUrl, {
        timeout: AXIOS_TIMEOUT,
        headers: {
          'User-Agent': 'MMM-NextcloudPhotos/1.0' // Obligatoire pour Nominatim
        }
      });

      // Extrait la ville et le pays
      const address = geoResponse.data.address;
      return {
        city: address.city || address.town || address.village || address.hamlet,
        country: address.country,
      };
    } catch (e) {
      console.warn(`[MMM-NextcloudPhotos2] Impossible de géocoder les coordonnées (${latitude}, ${longitude}): ${e.message}`);
      return null;
    }
  },

  /**
 * Extrait les métadonnées EXIF d'un buffer ou d'un fichier.
 */
  extractExifData: async function (arrayBuffer) {
    try {
      const buffer = Buffer.from(arrayBuffer);
      const binaryString = buffer.toString("binary");
      const exifData = piexif.load(binaryString);

      if (!exifData) {
        throw new Error("Aucune donnée EXIF trouvée dans l'image");
      }

      const gps = exifData.GPS || {};
      const exif = exifData.Exif || {};

      return {
        dateTaken: exif[piexif.ExifIFD.DateTimeOriginal] || null,
        latitude: gps[piexif.GPSIFD.GPSLatitude] || null,
        longitude: gps[piexif.GPSIFD.GPSLongitude] || null,
        folderName: exif[piexif.ExifIFD.UserComment] || null,
        location: exif[piexif.ExifIFD.ImageDescription] || null,
        dateTaken2: exif[piexif.ExifIFD.DateTimeOriginal] ? exif[piexif.ExifIFD.DateTimeOriginal].replace(/:/g, '-').replace(' ', 'T') : null,
      };
    } catch (e) {
      console.warn("[WARNING] Impossible de lire les EXIF:", e.message);
      return { dateTaken: null, latitude: null, longitude: null, folderName: null, location: null };
    }
  },

  /**
   * Insère des métadonnées EXIF dans un buffer d'image.
   * @param {Buffer} imageBuffer - Buffer de l'image source.
   * @param {Object} exifData - Objet contenant les EXIF à insérer (dateTaken, latitude, longitude, folderName, location, etc.).
   * @returns {Buffer} - Nouveau buffer avec les EXIF mis à jour.
   */
  insertExifData: async function (imageBuffer, exifData) {
    // 1. Convertir en binary string (format attendu par piexifjs)
    const inputBuffer = Buffer.from(imageBuffer);
    const binaryString = inputBuffer.toString("binary");

    const exifObj = {
      "Exif": {},
    };

    if (exifData.folderName) exifObj["Exif"][piexif.ExifIFD.UserComment] = exifData.folderName;
    if (exifData.dateTaken) exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal] = exifData.dateTaken;

    if (exifData.latitude !== undefined && exifData.longitude !== undefined) {
      exifObj["GPS"] = {}; // Créer la clé GPS uniquement si nécessaire
      exifObj["GPS"][piexif.GPSIFD.GPSLatitude] = this._convertDecimalToDMS(exifData.latitude);
      exifObj["GPS"][piexif.GPSIFD.GPSLongitude] = this._convertDecimalToDMS(exifData.longitude);
      exifObj["GPS"][piexif.GPSIFD.GPSLatitudeRef] = exifData.latitude >= 0 ? "N" : "S";
      exifObj["GPS"][piexif.GPSIFD.GPSLongitudeRef] = exifData.longitude >= 0 ? "E" : "W";
      let geo = await this.geocodeCoordinates(this._convertDecimalToDMS(exifData.latitude), this._convertDecimalToDMS(exifData.longitude));
      console.warn("[WARN] Insertion GEO :", geo);
      //exifObj["Exif"][piexif.ExifIFD.ImageDescription] = await this.geocodeCoordinates(this._convertDecimalToDMS(exifData.latitude), this._convertDecimalToDMS(exifData.longitude));
    }


    try {
      const exifBytes = piexif.dump(exifObj);
      // 5. Injecter dans l'image et retourner un Buffer Node.js
      console.warn("[WARN] Insertion EXIF (piexif) :", exifObj);
      const updatedBinary = piexif.insert(exifBytes, binaryString);
      return Buffer.from(updatedBinary, "binary");
    } catch (exifError) {
      console.error("[ERROR] Échec de l'insertion EXIF (piexif) :", exifError.message);
      console.error("[DEBUG] Objet EXIF généré :", exifObj); // Log pour débogage
      return imageBuffer; // Retourne le buffer original en cas d'échec
    }
  },

  // Helper pour convertir les coordonnées décimales en DMS (degrés, minutes, secondes)
  _convertDecimalToDMS: function (decimal) {
    const absDecimal = Math.abs(decimal);
    const degrees = Math.floor(absDecimal);
    const minutes = Math.floor((absDecimal - degrees) * 60);
    const seconds = ((absDecimal - degrees - minutes / 60) * 3600).toFixed(2);
    return [[degrees, 1], [minutes, 1], [Number(seconds), 100]];
  },

  downloadPhoto: async function (photo) {
    const token = await this.getValidToken();
    const baseUrl = (this.config.nextcloudUrl || this.tokens.nextcloud_url).replace(/\/+$/, "");

    // SSRF protection
    const downloadUrl = `${baseUrl}${photo.href}`;
    const parsedDownload = new URL(downloadUrl);
    const parsedBase = new URL(baseUrl);
    if (parsedDownload.host !== parsedBase.host) {
      throw new Error(`URL host mismatch: ${parsedDownload.host} !== ${parsedBase.host}`);
    }

    // Chemin local
    const baseName = path.parse(photo.name).name;
    const localName = sharp ? baseName + ".jpg" : photo.name;
    const localPath = path.join(this.cacheDir, localName);

    // Vérification du chemin
    const resolvedPath = path.resolve(localPath);
    const resolvedCache = path.resolve(this.cacheDir);
    if (!resolvedPath.startsWith(resolvedCache + path.sep) && resolvedPath !== resolvedCache) {
      throw new Error(`Invalid filename, path traversal attempt: ${localName}`);
    }

    // Variables pour les métadonnées
    let exifData = { dateTaken: null, latitude: null, longitude: null, location: null, folderName: null };
    let imageBuffer = null;

    // --- 1. Téléchargement (si nécessaire => si non présent dans le dossier cache local) ---
    if (!fs.existsSync(localPath)) {
      const response = await axios.get(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "arraybuffer",
        timeout: AXIOS_TIMEOUT,
        maxRedirects: 0,
      });
      imageBuffer = response.data;

      // 1. Extraction des EXIF (distant)
      exifData = await this.extractExifData(imageBuffer);
      exifData.folderName = photo.folderName;

      // --- 2. Redimensionnement (si nécessaire) ---
      if (sharp) {
        const image = sharp(imageBuffer, {
          limitInputPixels: 80000000,
        }); // Force la conversion en JPEG

        // Traitement Sharp (redimensionnement, rotation, etc.)
        let processedBuffer = await image
          .rotate()
          .resize(this.config.maxWidth || 1920, this.config.maxHeight || 1080, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: this.config.imageQuality || 80,
            progressive: true,
          })
          .toBuffer(); // Récupère le buffer traité

        console.warn(`[DEBUG] EXIF distant pour ${localPath}:`, {
          dateTaken: exifData.dateTaken,
          date2 : exifData.dateTaken2,
          latitude: exifData.latitude,
          longitude: exifData.longitude,
          position: exifData.location,
          folder: exifData.folderName,
        });


        // 4. Insertion des EXIF sur le buffer
        processedBuffer = await this.insertExifData(processedBuffer, exifData);

        // Réécrit le fichier avec les EXIF
        fs.writeFileSync(localPath, processedBuffer);
        image.destroy();
        console.log(`[DEBUG] Image sauvegardée (redimensionnée + EXIF préservés): ${localPath}`);
        // --- 4. Retour des données ---
        return {
          localPath,
          localName,
          exifData,
        };
      } else {
        fs.writeFileSync(localPath, imageBuffer);
        console.log(`[DEBUG] Image sauvegardée (brute): ${localPath}`);
      }
    }
    else { // si fichier présent en local
      // Lit le fichier local si déjà en cache
      imageBuffer = fs.readFileSync(localPath);
    }

    // 1. Extraction des EXIF (local)
    exifData = await this.extractExifData(imageBuffer);
    // --- 2. Extraction des EXIF (une seule fois) ---


    console.warn(`[DEBUG] LOCAL EXIF pour ${photo.name}:`, {
      dateTaken: exifData.dateTaken,
      location: exifData.location,
      longitude: exifData.folderName,
    });

    // --- 4. Retour des données ---
    return {
      localPath,
      localName,
      exifData,
    };
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
          const { localPath, localName, exifData } = await this.downloadPhoto(photo);
          localPaths.push({
            name: localName,
            path: localPath,
            url: `/modules/MMM-NextcloudPhotos2/cache/${encodeURIComponent(localName)}`,
            folderName: exifData?.folderName,
            dateTaken: exifData?.dateTaken2, // Date de prise de vue
            location: exifData?.location,  // Ville et pays
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
      console.log("[DEBUG] Payload final (PHOTOS_UPDATED):", this.photoList);
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

