Module.register("MMM-NextcloudPhotos2", {
  defaults: {
    // Nextcloud settings
    nextcloudUrl: "",
    username: "",
    folder: "mirror",

    // Token file (credentials are stored in tokens.json by setup_oauth.js)
    tokenFile: "tokens.json",

    // Display settings
    updateInterval: 30 * 1000,       // Image rotation: 30 seconds
    syncInterval: 10 * 60 * 1000,    // Nextcloud sync: 10 minutes
    transitionDuration: 2000,         // Crossfade duration in ms
    backgroundSize: "cover",          // cover | contain
    order: "random",                  // random | sequential
    opacity: 1.0,                     // Background opacity

    // Image optimization (for low-memory devices like RP3)
    maxWidth: 1920,                  // Max image width in pixels
    maxHeight: 1080,                 // Max image height in pixels
    imageQuality: 80,               // JPEG quality (1-100)
    albums: ["TESTAX"],
    timeFormat: "DD/MM/YYYY HH:mm",
  },

  photos: [],
  currentIndex: -1,
  activeLayer: 0,
  rotationTimer: null,
  errorMessage: null,
  layers: [],

  start: function () {
    Log.info("[MMM-NextcloudPhotos2] Module loading...");
    this.sendSocketNotification("SET_CONFIG", this.config);
  },

  getStyles: function () {
    return ["MMM-NextcloudPhotos2.css"];
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "mmm-ncp-wrapper";
    let back = document.createElement("div");
    back.id = "GPHOTO_BACK";
    let info = document.createElement("div");
    info.id = "GPHOTO_INFO";
    info.innerHTML = "Loading...";
    // Make body background transparent so our wrapper shows through
    document.body.style.background = "transparent";

    if (this.errorMessage) {
      var errorDiv = document.createElement("div");
      errorDiv.className = "mmm-ncp-error";
      errorDiv.textContent = this.errorMessage;
      wrapper.appendChild(errorDiv);
      return wrapper;
    }

    if (this.photos.length === 0) {
      var loadingDiv = document.createElement("div");
      loadingDiv.className = "mmm-ncp-loading";
      loadingDiv.textContent = "Loading...";
      wrapper.appendChild(loadingDiv);
      return wrapper;
    }

    // Two image layers for crossfade - all styles inline
    this.layers = [];
    for (var i = 0; i < 2; i++) {
      var layer = document.createElement("div");
      layer.className = "mmm-ncp-layer mmm-ncp-layer-" + i;
      wrapper.appendChild(layer);
      this.layers.push(layer);
    }
    wrapper.appendChild(back);
    wrapper.appendChild(info);

    return wrapper;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "PHOTOS_UPDATED") {
      Log.info("[MMM-NextcloudPhotos2] " + payload.length + " photos update.");
      this.errorMessage = null;
      this.photos = payload;

      if (this.photos.length > 0 && this.currentIndex === -1) {
        this.updateDom(0);
        setTimeout(() => {
          this.showNextPhoto();
          this.startRotation();
        }, 500);
      }
    }

    if (notification === "AUTH_ERROR") {
      Log.error("[MMM-NextcloudPhotos2] Auth error: " + payload);
      this.errorMessage = payload;
      this.updateDom();
    }
  },

  getNextIndex: function () {
    if (this.photos.length === 0) return -1;

    if (this.config.order === "random") {
      if (this.photos.length === 1) return 0;
      var next;
      do {
        next = Math.floor(Math.random() * this.photos.length);
      } while (next === this.currentIndex);
      return next;
    }

    return (this.currentIndex + 1) % this.photos.length;
  },

  showNextPhoto: function () {
    if (this.photos.length === 0 || this.layers.length < 2) {
      Log.warn("[MMM-NextcloudPhotos2] showNextPhoto: zero photo.");
      return;
    }

    var nextIndex = this.getNextIndex();
    if (nextIndex === -1) return;

    this.currentIndex = nextIndex;
    var photo = this.photos[this.currentIndex];
    var self = this;
    var back = document.getElementById("GPHOTO_BACK");
    var nextLayer = this.activeLayer === 0 ? 1 : 0;

    // Clean up previous preload image to free memory
    if (this._preloadImg) {
      this._preloadImg.onload = null;
      this._preloadImg.onerror = null;
      this._preloadImg.src = "";
      this._preloadImg = null;
    }

    var img = new Image();
    this._preloadImg = img;
    img.onload = function () {
      // Use stored layer references instead of querySelectorAll
      self.layers[nextLayer].style.backgroundImage = "url('" + photo.url + "')";
      //self.layers[nextLayer].style.backgroundSize = self.config.backgroundSize;

      // Crossfade using inline opacity (avoids CSS class vs inline style conflict)
      self.layers[nextLayer].style.opacity = String(self.config.opacity);
      self.layers[self.activeLayer].style.opacity = "0";
      
      back.style.backgroundImage = "url('" + photo.url + "')";
      self.activeLayer = nextLayer;

      // Release preload image memory
      img.onload = null;
      img.onerror = null;
      self._preloadImg = null;

      const info = document.getElementById("GPHOTO_INFO");
      info.innerHTML = "";
      let albumTitle = document.createElement("div");
      albumTitle.classList.add("albumTitle");
      albumTitle.innerHTML = '<i class="fas fa-folder"></i>&nbsp;' + photo.folderName;
      let photoTime = document.createElement("div");
      photoTime.classList.add("photoTime");
      photoTime.innerHTML = self.config.timeFormat === "relative" ? moment(photo.dateTaken).fromNow() : moment(photo.dateTaken).format(self.config.timeFormat);
      let infoText = document.createElement("div");
      infoText.classList.add("infoText");
      let fileLocation = document.createElement("div");
      fileLocation.classList.add("fileLocation");
      fileLocation.innerHTML = '<i class="fas fa-map"></i>&nbsp;' + photo.location;

      infoText.appendChild(albumTitle);
      if(photo.dateTaken) infoText.appendChild(photoTime);
      if(photo.location) infoText.appendChild(fileLocation);
      info.appendChild(infoText);
    };
    img.onerror = function () {
      Log.error("[MMM-NextcloudPhotos2] Error from loading : " + photo.url);
      img.onload = null;
      img.onerror = null;
      self._preloadImg = null;
    };
    img.src = photo.url;
  },

  startRotation: function () {
    if (this.rotationTimer) clearInterval(this.rotationTimer);

    var self = this;
    this.rotationTimer = setInterval(function () {
      self.showNextPhoto();
    }, this.config.updateInterval);
  },
});
